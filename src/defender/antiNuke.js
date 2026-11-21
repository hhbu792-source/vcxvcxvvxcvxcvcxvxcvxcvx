const { AuditLogEvent } = require("discord.js");
const {
  DANGEROUS_PERMISSIONS,
  DANGEROUS_PERMISSION_BITFIELD,
} = require("./constants");
const { ActionWindowTracker } = require("./windowTracker");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAddedDangerousPermNames(oldBitfield, newBitfield) {
  const oldBits = BigInt(oldBitfield ?? 0n);
  const newBits = BigInt(newBitfield ?? 0n);
  const added = newBits & ~oldBits;
  if ((added & DANGEROUS_PERMISSION_BITFIELD) === 0n) return [];
  return DANGEROUS_PERMISSIONS.filter((p) => (added & p.flag) !== 0n).map(
    (p) => p.name
  );
}

class AntiNukeEngine {
  /**
   * @param {import('./store').DefenderStore} store
   * @param {import('./snapshotManager').SnapshotManager} snapshotManager
   * @param {import('./punishmentEngine').PunishmentEngine} punishmentEngine
   * @param {object} options
   */
  constructor(store, snapshotManager, punishmentEngine, options = {}) {
    this.store = store;
    this.snapshotManager = snapshotManager;
    this.punishmentEngine = punishmentEngine;
    this.tracker = new ActionWindowTracker();
    this.auditLogDelayMs = options.auditLogDelayMs ?? 250;
    this.logger = options.logger || console;
  }

  _isActive(guild) {
    if (!guild) return false;
    const g = this.store.getGuild(guild.id);
    return Boolean(g.enabled && g.modules.antiNuke);
  }

  async findAuditEntry(guild, eventType, targetId = null, maxAgeMs = 15_000) {
    if (!guild || typeof guild.fetchAuditLogs !== "function") return null;

    if (this.auditLogDelayMs > 0) {
      await sleep(this.auditLogDelayMs);
    }

    try {
      const logs = await guild.fetchAuditLogs({ type: eventType, limit: 6 });
      if (!logs?.entries) return null;

      const now = Date.now();
      for (const entry of logs.entries.values()) {
        if (now - entry.createdTimestamp > maxAgeMs) continue;
        if (targetId && entry.targetId && entry.targetId !== targetId) {
          continue;
        }
        return entry;
      }
    } catch {
      // Missing ViewAuditLog permission or transient error
    }
    return null;
  }

  // 1. CHANNEL DELETE FLOOD + AUTO-RESTORE + LOG CHANNEL SELF-DEFENSE
  async onChannelDelete(channel) {
    const guild = channel?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (this.snapshotManager.isSelfAction(`channel:${channel.id}`)) {
      return { triggered: false, skipped: "self" };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.ChannelDelete,
      channel.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      this.snapshotManager.captureGuild(guild);
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const isProtectedLog = g.logChannelId === channel.id;
    const key = `${guild.id}:chDel:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { channel },
      Date.now()
    );

    if (!isProtectedLog && res.count < g.thresholds.channelDeleteLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: isProtectedLog
        ? "Defender guvenlik log kanalini silme girisimi"
        : `Toplu kanal silme saldirisi (${res.count} kanal / ${Math.round(g.thresholds.nukeWindowMs / 1000)}sn)`,
    });

    const restoredNames = [];
    if (g.modules.autoRestore || isProtectedLog) {
      // Restore ALL channels deleted during this attack window
      const seen = new Set();
      for (const item of res.entries) {
        const chObj = item.meta?.channel;
        if (!chObj || seen.has(chObj.id)) continue;
        seen.add(chObj.id);
        const recreated = await this.snapshotManager.restoreDeletedChannel(
          guild,
          chObj
        );
        if (recreated) {
          restoredNames.push(`#${recreated.name}`);
          if (chObj.id === g.logChannelId) {
            this.store.setLogChannel(guild.id, recreated.id);
          }
        }
      }
    }

    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: isProtectedLog
        ? "Güvenlik Log Kanalı Silme Girişimi"
        : "Toplu Kanal Silme (Channel Nuke)",
      executorId,
      target: `#${channel.name}`,
      details: `Yetkisiz kanal silme eşiği aşıldı (${res.count} kanal).`,
      punishment: punish.action,
      restored:
        restoredNames.length > 0
          ? `Geri yüklenen kanallar: ${restoredNames.join(", ")}`
          : null,
    });

    return { triggered: true, punish, restoredNames };
  }

  // 2. CHANNEL CREATE SPAM + AUTO-CLEANUP
  async onChannelCreate(channel) {
    const guild = channel?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (
      this.snapshotManager.isSelfAction(`channel:${channel.id}`) ||
      this.snapshotManager.isSelfAction(`channelCreate:${guild.id}:${channel.name}`)
    ) {
      return { triggered: false, skipped: "self" };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.ChannelCreate,
      channel.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      this.snapshotManager.captureGuild(guild);
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const key = `${guild.id}:chCreate:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { channel },
      Date.now()
    );

    if (res.count < g.thresholds.channelCreateLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Toplu kanal olusturma saldirisi (${res.count} kanal)`,
    });

    let deletedSpam = 0;
    for (const item of res.entries) {
      const chObj = item.meta?.channel;
      if (chObj && typeof chObj.delete === "function") {
        this.snapshotManager.markSelfAction(`channel:${chObj.id}`, 8000);
        await chObj
          .delete("Defender Anti-Nuke: Spam kanal temizlendi")
          .then(() => {
            deletedSpam += 1;
          })
          .catch(() => {});
      }
    }

    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: "Toplu Kanal Oluşturma Spamı",
      executorId,
      target: `#${channel.name}`,
      details: `Kısa sürede ${res.count} yetkisiz kanal oluşturuldu.`,
      punishment: punish.action,
      restored: deletedSpam > 0 ? `${deletedSpam} spam kanal silindi.` : null,
    });

    return { triggered: true, punish, deletedSpam };
  }

  // 3. CHANNEL UPDATE TAMPERING FLOOD
  async onChannelUpdate(oldChannel, newChannel) {
    const guild = newChannel?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (this.snapshotManager.isSelfAction(`channelUpdate:${newChannel.id}`)) {
      return { triggered: false, skipped: "self" };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.ChannelUpdate,
      newChannel.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const key = `${guild.id}:chUpd:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { channelId: newChannel.id },
      Date.now()
    );

    if (res.count < g.thresholds.channelUpdateLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Toplu kanal duzenleme/sabotaj (${res.count} degisiklik)`,
    });
    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "HIGH",
      action: "Toplu Kanal Değişikliği",
      executorId,
      target: `#${newChannel.name}`,
      details: `Kısa sürede ${res.count} yetkisiz kanal düzenlemesi tespit edildi.`,
      punishment: punish.action,
    });

    return { triggered: true, punish };
  }

  // 4. ROLE DELETE FLOOD + AUTO-RESTORE + QUARANTINE ROLE SELF-DEFENSE
  async onRoleDelete(role) {
    const guild = role?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (this.snapshotManager.isSelfAction(`role:${role.id}`)) {
      return { triggered: false, skipped: "self" };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.RoleDelete,
      role.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      this.snapshotManager.captureGuild(guild);
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const isQuarantineRole = g.quarantineRoleId === role.id;
    const key = `${guild.id}:roleDel:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { role },
      Date.now()
    );

    if (!isQuarantineRole && res.count < g.thresholds.roleDeleteLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: isQuarantineRole
        ? "Defender KARANTINA rolunu silme girisimi"
        : `Toplu rol silme saldirisi (${res.count} rol)`,
    });

    const restoredNames = [];
    if (g.modules.autoRestore || isQuarantineRole) {
      const seen = new Set();
      for (const item of res.entries) {
        const rObj = item.meta?.role;
        if (!rObj || seen.has(rObj.id)) continue;
        seen.add(rObj.id);
        const recreated = await this.snapshotManager.restoreDeletedRole(
          guild,
          rObj
        );
        if (recreated) {
          restoredNames.push(recreated.name);
          if (rObj.id === g.quarantineRoleId) {
            this.store.setQuarantineRole(guild.id, recreated.id);
          }
        }
      }
    }

    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: isQuarantineRole
        ? "Karantina Rolü Silme Girişimi"
        : "Toplu Rol Silme (Role Nuke)",
      executorId,
      target: role.name,
      details: `Yetkisiz rol silme eşiği aşıldı (${res.count} rol).`,
      punishment: punish.action,
      restored:
        restoredNames.length > 0
          ? `Geri yüklenen roller: ${restoredNames.join(", ")}`
          : null,
    });

    return { triggered: true, punish, restoredNames };
  }

  // 5. ROLE CREATE SPAM + AUTO-CLEANUP
  async onRoleCreate(role) {
    const guild = role?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (
      this.snapshotManager.isSelfAction(`role:${role.id}`) ||
      this.snapshotManager.isSelfAction(`roleCreate:${guild.id}:${role.name}`)
    ) {
      return { triggered: false, skipped: "self" };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.RoleCreate,
      role.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      this.snapshotManager.captureGuild(guild);
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const key = `${guild.id}:roleCreate:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { role },
      Date.now()
    );

    if (res.count < g.thresholds.roleCreateLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Toplu rol olusturma saldirisi (${res.count} rol)`,
    });

    let deletedSpam = 0;
    for (const item of res.entries) {
      const rObj = item.meta?.role;
      if (rObj && !rObj.managed && typeof rObj.delete === "function") {
        this.snapshotManager.markSelfAction(`role:${rObj.id}`, 8000);
        await rObj
          .delete("Defender Anti-Nuke: Spam rol temizlendi")
          .then(() => {
            deletedSpam += 1;
          })
          .catch(() => {});
      }
    }

    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: "Toplu Rol Oluşturma Spamı",
      executorId,
      target: role.name,
      details: `Kısa sürede ${res.count} yetkisiz rol oluşturuldu.`,
      punishment: punish.action,
      restored: deletedSpam > 0 ? `${deletedSpam} spam rol silindi.` : null,
    });

    return { triggered: true, punish, deletedSpam };
  }

  // 6. INSTANT DANGEROUS ROLE PERMISSION ESCALATION BLOCK & REVERT
  async onRoleUpdate(oldRole, newRole) {
    const guild = newRole?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (this.snapshotManager.isSelfAction(`roleUpdate:${newRole.id}`)) {
      return { triggered: false, skipped: "self" };
    }

    const addedDangerous = getAddedDangerousPermNames(
      oldRole?.permissions?.bitfield,
      newRole?.permissions?.bitfield
    );

    const g = this.store.getGuild(guild.id);
    const isQuarantineTamper = g.quarantineRoleId === newRole.id;

    if (addedDangerous.length === 0 && !isQuarantineTamper) {
      return { triggered: false };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.RoleUpdate,
      newRole.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      this.snapshotManager.captureGuild(guild);
      return { triggered: false, whitelisted: true };
    }

    let reverted = false;
    if (g.modules.autoRestore || isQuarantineTamper) {
      reverted = await this.snapshotManager.revertRolePermissions(
        guild,
        newRole,
        oldRole
      );
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: isQuarantineTamper
        ? "Karantina rolunun izinlerini degistirme girisimi"
        : `Yetkisiz kritik rol izni yukseltmesi (${addedDangerous.join(", ")})`,
    });

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: isQuarantineTamper
        ? "Karantina Rolü Kurcalama"
        : "Kritik Rol Yetki Yükseltmesi",
      executorId,
      target: `${newRole.name} (${newRole.id})`,
      details:
        addedDangerous.length > 0
          ? `Eklenen tehlikeli izinler: ${addedDangerous.join(", ")}`
          : "Karantina rolü izinleri yetkisiz değiştirildi.",
      punishment: punish.action,
      restored: reverted ? "Rol izinleri eski haline geri alındı." : null,
    });

    return { triggered: true, reverted, punish, addedDangerous };
  }

  // 7. INSTANT UNAUTHORIZED DANGEROUS ROLE GRANT TO MEMBER
  async onGuildMemberUpdate(oldMember, newMember) {
    const guild = newMember?.guild;
    if (!this._isActive(guild)) return { triggered: false };
    if (this.snapshotManager.isSelfAction(`memberUpdate:${newMember.id}`)) {
      return { triggered: false, skipped: "self" };
    }

    if (!oldMember?.roles?.cache || !newMember?.roles?.cache) {
      return { triggered: false };
    }

    const addedDangerousRoles = [];
    for (const role of newMember.roles.cache.values()) {
      if (oldMember.roles.cache.has(role.id)) continue;
      const bits = role.permissions?.bitfield ?? 0n;
      if ((bits & DANGEROUS_PERMISSION_BITFIELD) !== 0n) {
        addedDangerousRoles.push(role);
      }
    }

    if (addedDangerousRoles.length === 0) return { triggered: false };

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.MemberRoleUpdate,
      newMember.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    let stripped = false;
    if (g.modules.autoRestore && newMember.roles?.remove) {
      this.snapshotManager.markSelfAction(`memberUpdate:${newMember.id}`, 8000);
      await newMember.roles
        .remove(
          addedDangerousRoles.map((r) => r.id),
          "Defender Anti-Nuke: Yetkisiz verilen kritik rol geri alindi"
        )
        .then(() => {
          stripped = true;
        })
        .catch(() => {});
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Yetkisiz kritik rol verme (${addedDangerousRoles.map((r) => r.name).join(", ")})`,
    });

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: "Yetkisiz Kritik Rol Verme",
      executorId,
      target: `<@${newMember.id}> -> ${addedDangerousRoles.map((r) => r.name).join(", ")}`,
      details: "Whitelist dışındaki bir kişi kritik yetkili rol atadı.",
      punishment: punish.action,
      restored: stripped ? "Atanan kritik rol(ler) geri alındı." : null,
    });

    return { triggered: true, stripped, punish };
  }

  // 8. MASS BAN PROTECTION
  async onGuildBanAdd(ban) {
    const guild = ban?.guild;
    if (!this._isActive(guild)) return { triggered: false };

    const targetId = ban.user?.id;
    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.MemberBanAdd,
      targetId
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const key = `${guild.id}:ban:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { targetId },
      Date.now()
    );

    if (res.count < g.thresholds.banLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Toplu yasaklama (Mass Ban) saldirisi (${res.count} ban)`,
    });
    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: "Toplu Ban Saldırısı (Mass Ban)",
      executorId,
      target: targetId ? `<@${targetId}>` : "Bilinmeyen",
      details: `Kısa sürede ${res.count} yetkisiz ban tespit edildi.`,
      punishment: punish.action,
    });

    return { triggered: true, punish };
  }

  // 9. MASS KICK PROTECTION (via MemberKick audit log)
  async onGuildMemberRemove(member) {
    const guild = member?.guild;
    if (!this._isActive(guild)) return { triggered: false };

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.MemberKick,
      member.id,
      8_000
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const key = `${guild.id}:kick:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { targetId: member.id },
      Date.now()
    );

    if (res.count < g.thresholds.kickLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Toplu atma (Mass Kick) saldirisi (${res.count} kick)`,
    });
    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: "Toplu Kick Saldırısı (Mass Kick)",
      executorId,
      target: `<@${member.id}>`,
      details: `Kısa sürede ${res.count} yetkisiz kick tespit edildi.`,
      punishment: punish.action,
    });

    return { triggered: true, punish };
  }

  // 10. EMOJI & STICKER DELETE FLOOD
  async onAssetDelete(guild, assetType, assetId, assetName) {
    if (!this._isActive(guild)) return { triggered: false };

    const auditType =
      assetType === "sticker"
        ? AuditLogEvent.StickerDelete
        : AuditLogEvent.EmojiDelete;

    const entry = await this.findAuditEntry(guild, auditType, assetId);
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(guild.id);
    const key = `${guild.id}:assetDel:${executorId}`;
    const res = this.tracker.record(
      key,
      g.thresholds.nukeWindowMs,
      { assetId },
      Date.now()
    );

    if (res.count < g.thresholds.assetDeleteLimit) {
      return { triggered: false, count: res.count };
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_NUKE",
      reason: `Toplu emoji/sticker silme (${res.count} adet)`,
    });
    this.tracker.clearKey(key);

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_NUKE",
      severity: "HIGH",
      action: "Toplu Emoji/Sticker Silme",
      executorId,
      target: `${assetType}: ${assetName || assetId}`,
      details: `Kısa sürede ${res.count} sunucu öğesi silindi.`,
      punishment: punish.action,
    });

    return { triggered: true, punish };
  }

  // 11. GUILD SETTINGS TAMPER PROTECTION + AUTO-REVERT
  async onGuildUpdate(oldGuild, newGuild) {
    if (!this._isActive(newGuild)) return { triggered: false };
    if (this.snapshotManager.isSelfAction(`guildUpdate:${newGuild.id}`)) {
      return { triggered: false, skipped: "self" };
    }

    const nameChanged = oldGuild?.name !== newGuild?.name;
    const verifChanged =
      oldGuild?.verificationLevel !== newGuild?.verificationLevel;
    const vanityChanged = oldGuild?.vanityURLCode !== newGuild?.vanityURLCode;

    if (!nameChanged && !verifChanged && !vanityChanged) {
      return { triggered: false };
    }

    const entry = await this.findAuditEntry(
      newGuild,
      AuditLogEvent.GuildUpdate,
      newGuild.id
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(newGuild, executorId, "antiNuke")) {
      this.snapshotManager.captureGuild(newGuild);
      return { triggered: false, whitelisted: true };
    }

    const g = this.store.getGuild(newGuild.id);
    let reverted = false;
    if (g.modules.autoRestore) {
      reverted = await this.snapshotManager.revertGuildSettings(
        newGuild,
        oldGuild
      );
    }

    const punish = await this.punishmentEngine.punishExecutor(
      newGuild,
      executorId,
      {
        module: "ANTI_NUKE",
        reason: "Yetkisiz sunucu ayari degisikligi (isim/dogrulama/vanity)",
      }
    );

    await this.punishmentEngine.logIncident(newGuild, {
      module: "ANTI_NUKE",
      severity: "CRITICAL",
      action: "Yetkisiz Sunucu Ayarı Değişikliği",
      executorId,
      target: newGuild.name,
      details: `Sunucu adı veya güvenlik ayarları izinsiz değiştirildi.`,
      punishment: punish.action,
      restored: reverted ? "Sunucu ayarları eski haline geri alındı." : null,
    });

    return { triggered: true, reverted, punish };
  }

  // 12. ANTI-BOT-ADD (ROGUE BOT INJECTION SHIELD)
  async onBotAdd(member) {
    const guild = member?.guild;
    if (!guild || !member?.user?.bot) return { triggered: false };
    const g = this.store.getGuild(guild.id);
    if (!g.enabled || !g.modules.antiBot) return { triggered: false };

    if (this.store.isWhitelisted(guild, member.id, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.BotAdd,
      member.id
    );
    const inviterId = entry?.executorId || entry?.executor?.id || null;

    if (inviterId && this.store.isWhitelisted(guild, inviterId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    // Immediately remove unauthorized bot
    await this.punishmentEngine.stripRemovableRoles(
      guild,
      member,
      "Defender Anti-Bot: Onaysiz bot kaldirildi"
    );
    let botRemoved = false;
    if (typeof member.kick === "function") {
      await member
        .kick("Defender Anti-Bot: Onaysiz bot sunucudan atildi")
        .then(() => {
          botRemoved = true;
        })
        .catch(() => {});
    }

    let inviterPunish = { action: "none" };
    if (inviterId) {
      inviterPunish = await this.punishmentEngine.punishExecutor(
        guild,
        inviterId,
        {
          module: "ANTI_BOT",
          reason: `Onaysiz bot ekleme (${member.user.tag || member.id})`,
        }
      );
    }

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_BOT",
      severity: "CRITICAL",
      action: "Onaysız Bot Ekleme Engellendi",
      executorId: inviterId,
      target: `${member.user.username || member.id} (\`${member.id}\`)`,
      details: "Whitelist içinde olmayan bir bot sunucuya eklendi.",
      punishment: `Bot: ${botRemoved ? "kick" : "rol temizlendi"} | Ekleyen: ${inviterPunish.action}`,
    });

    return { triggered: true, botRemoved, inviterPunish };
  }

  // 13. ANTI-WEBHOOK NUKE SHIELD
  async onWebhooksUpdate(channel) {
    const guild = channel?.guild;
    if (!guild) return { triggered: false };
    const g = this.store.getGuild(guild.id);
    if (!g.enabled || !g.modules.antiWebhook) return { triggered: false };

    const entry = await this.findAuditEntry(
      guild,
      AuditLogEvent.WebhookCreate,
      null,
      10_000
    );
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId) return { triggered: false };

    if (this.store.isWhitelisted(guild, executorId, "antiNuke")) {
      return { triggered: false, whitelisted: true };
    }

    let deletedHooks = 0;
    if (typeof channel.fetchWebhooks === "function") {
      const hooks = await channel.fetchWebhooks().catch(() => null);
      if (hooks) {
        for (const hook of hooks.values()) {
          if (
            hook.owner?.id === executorId ||
            (entry.targetId && hook.id === entry.targetId)
          ) {
            await hook
              .delete("Defender Anti-Webhook: Yetkisiz webhook silindi")
              .then(() => {
                deletedHooks += 1;
              })
              .catch(() => {});
          }
        }
      }
    }

    const punish = await this.punishmentEngine.punishExecutor(guild, executorId, {
      module: "ANTI_WEBHOOK",
      reason: `Yetkisiz webhook olusturma (#${channel.name})`,
    });

    await this.punishmentEngine.logIncident(guild, {
      module: "ANTI_WEBHOOK",
      severity: "CRITICAL",
      action: "Yetkisiz Webhook Oluşturma",
      executorId,
      target: `#${channel.name}`,
      details: "Whitelist dışındaki bir kullanıcı/bot webhook oluşturdu.",
      punishment: punish.action,
      restored:
        deletedHooks > 0 ? `${deletedHooks} yetkisiz webhook silindi.` : null,
    });

    return { triggered: true, deletedHooks, punish };
  }
}

module.exports = { AntiNukeEngine, getAddedDangerousPermNames };
