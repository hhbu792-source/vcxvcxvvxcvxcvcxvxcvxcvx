const {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { DANGEROUS_PERMISSION_BITFIELD } = require("./constants");

const SEVERITY_COLORS = {
  CRITICAL: 0xc0392b,
  HIGH: 0xe67e22,
  MEDIUM: 0xf1c40f,
  INFO: 0x34495e,
};

class PunishmentEngine {
  /**
   * @param {import('./store').DefenderStore} store
   * @param {import('./snapshotManager').SnapshotManager} snapshotManager
   * @param {object} options
   */
  constructor(store, snapshotManager, options = {}) {
    this.store = store;
    this.snapshotManager = snapshotManager;
    this.quarantineRoleName = options.quarantineRoleName || "KARANTINA";
    this.defaultLogChannelName = options.defaultLogChannelName || "defender-log";
    this.logger = options.logger || console;

    /** Prevent duplicate simultaneous punishments on same guild:user during a burst */
    this.recentPunishments = new Map();
  }

  _canActOnMember(guild, targetMember) {
    if (!guild || !targetMember) return false;
    if (targetMember.id === guild.ownerId) return false;
    const me = guild.members?.me;
    if (!me) return true;
    if (targetMember.id === me.id) return false;

    const myPos = me.roles?.highest?.position ?? 9999;
    const targetPos = targetMember.roles?.highest?.position ?? -1;
    return myPos > targetPos;
  }

  async resolveLogChannel(guild) {
    const g = this.store.getGuild(guild.id);
    if (g.logChannelId) {
      const ch = guild.channels.cache.get(g.logChannelId);
      if (ch && ch.type === ChannelType.GuildText) return ch;
    }

    const byName = guild.channels.cache.find(
      (ch) =>
        ch.type === ChannelType.GuildText &&
        ch.name.toLowerCase() === this.defaultLogChannelName.toLowerCase()
    );
    if (byName) {
      this.store.setLogChannel(guild.id, byName.id);
      return byName;
    }

    return null;
  }

  async ensureLogChannel(guild) {
    const existing = await this.resolveLogChannel(guild);
    if (existing) return existing;

    const overwrites = [];
    if (guild.roles?.everyone?.id) {
      overwrites.push({
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      });
    }
    const botId = guild.members?.me?.id || guild.client?.user?.id;
    if (botId) {
      overwrites.push({
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    this.snapshotManager.markSelfAction(
      `channelCreate:${guild.id}:${this.defaultLogChannelName}`,
      10_000
    );

    const ch = await guild.channels.create({
      name: this.defaultLogChannelName,
      type: ChannelType.GuildText,
      topic: "Defender guvenlik ve olay kayitlari (Sadece Yonetici)",
      permissionOverwrites: overwrites,
      reason: "Defender guvenlik log kanali olusturuldu",
    });

    this.store.setLogChannel(guild.id, ch.id);
    return ch;
  }

  async ensureQuarantineRole(guild) {
    const g = this.store.getGuild(guild.id);
    let role = g.quarantineRoleId
      ? guild.roles.cache.get(g.quarantineRoleId)
      : null;

    if (!role) {
      role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === this.quarantineRoleName.toLowerCase()
      );
    }

    if (!role) {
      this.snapshotManager.markSelfAction(
        `roleCreate:${guild.id}:${this.quarantineRoleName}`,
        10_000
      );
      role = await guild.roles.create({
        name: this.quarantineRoleName,
        color: 0x2c3e50,
        permissions: [],
        reason: "Defender karantina rolu olusturuldu",
      });
    }

    if (g.quarantineRoleId !== role.id) {
      this.store.setQuarantineRole(guild.id, role.id);
    }

    // Apply deny overwrites on channels so quarantined users cannot type/speak
    for (const ch of guild.channels.cache.values()) {
      if (
        ch.type !== ChannelType.GuildText &&
        ch.type !== ChannelType.GuildVoice &&
        ch.type !== ChannelType.GuildForum &&
        ch.type !== ChannelType.GuildAnnouncement
      ) {
        continue;
      }
      if (!ch.permissionOverwrites?.edit) continue;

      const existingOw = ch.permissionOverwrites.cache?.get(role.id);
      if (existingOw) continue;

      this.snapshotManager.markSelfAction(`channelUpdate:${ch.id}`, 8_000);
      await ch.permissionOverwrites
        .edit(
          role.id,
          {
            SendMessages: false,
            SendMessagesInThreads: false,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            Connect: false,
            Speak: false,
          },
          { reason: "Defender karantina kisitlamasi" }
        )
        .catch(() => {});
    }

    return role;
  }

  async stripRemovableRoles(guild, member, reason) {
    const me = guild.members?.me;
    const myPos = me?.roles?.highest?.position ?? 9999;
    const removedIds = [];

    if (!member.roles?.cache) return removedIds;

    const toRemove = [];
    for (const role of member.roles.cache.values()) {
      if (role.id === guild.roles?.everyone?.id) continue;
      if (role.managed) {
        // If this is a rogue bot's managed integration role carrying dangerous perms, strip those perms!
        if (
          member.user?.bot &&
          role.permissions?.bitfield &&
          (role.permissions.bitfield & DANGEROUS_PERMISSION_BITFIELD) !== 0n &&
          role.position < myPos &&
          typeof role.setPermissions === "function"
        ) {
          this.snapshotManager.markSelfAction(`roleUpdate:${role.id}`, 10_000);
          await role.setPermissions(0n, reason).catch(() => {});
        }
        continue;
      }
      if (role.position < myPos) {
        toRemove.push(role.id);
      }
    }

    if (toRemove.length > 0 && member.roles?.remove) {
      this.snapshotManager.markSelfAction(`memberUpdate:${member.id}`, 10_000);
      await member.roles.remove(toRemove, reason).catch(() => {});
      removedIds.push(...toRemove);
    }

    return removedIds;
  }

  async quarantineMember(guild, member, reason, actorTag = "Defender") {
    if (!this._canActOnMember(guild, member)) {
      return { ok: false, reason: "HIERARCHY_BLOCKED" };
    }

    const qRole = await this.ensureQuarantineRole(guild);
    const removedRoles = await this.stripRemovableRoles(
      guild,
      member,
      `Defender Karantina: ${reason}`
    );

    const savedRoles = removedRoles.filter((id) => id !== qRole.id);
    this.store.saveQuarantinedUser(guild.id, member.id, {
      previousRoles: savedRoles,
      reason,
      actor: actorTag,
    });

    if (member.roles?.add) {
      this.snapshotManager.markSelfAction(`memberUpdate:${member.id}`, 10_000);
      await member.roles
        .add(qRole.id, `Defender Karantina: ${reason}`)
        .catch(() => {});
    }

    // Secondary safeguard: apply 24h timeout on non-bot members where supported
    if (!member.user?.bot && typeof member.timeout === "function") {
      await member
        .timeout(24 * 60 * 60 * 1000, `Defender Karantina: ${reason}`)
        .catch(() => {});
    }

    return {
      ok: true,
      action: "quarantine",
      removedRolesCount: savedRoles.length,
      quarantineRoleId: qRole.id,
    };
  }

  async unquarantineMember(guild, member, actorTag = "Yonetici") {
    const g = this.store.getGuild(guild.id);
    const qRoleId = g.quarantineRoleId;
    const saved = this.store.popQuarantinedUser(guild.id, member.id);

    if (qRoleId && member.roles?.cache?.has(qRoleId) && member.roles?.remove) {
      this.snapshotManager.markSelfAction(`memberUpdate:${member.id}`, 10_000);
      await member.roles
        .remove(qRoleId, `Karantina kaldirildi (${actorTag})`)
        .catch(() => {});
    }

    if (typeof member.timeout === "function") {
      await member
        .timeout(null, `Karantina kaldirildi (${actorTag})`)
        .catch(() => {});
    }

    let restoredCount = 0;
    if (saved?.previousRoles?.length && member.roles?.add) {
      const me = guild.members?.me;
      const myPos = me?.roles?.highest?.position ?? 9999;
      const validIds = saved.previousRoles.filter((rid) => {
        const r = guild.roles.cache.get(rid);
        return r && !r.managed && r.position < myPos;
      });
      if (validIds.length > 0) {
        this.snapshotManager.markSelfAction(`memberUpdate:${member.id}`, 10_000);
        await member.roles
          .add(validIds, `Karantina sonrasi eski roller geri verildi (${actorTag})`)
          .catch(() => {});
        restoredCount = validIds.length;
      }
    }

    return { ok: true, hadRecord: Boolean(saved), restoredCount };
  }

  /**
   * Execute configured punishment against an attacking executor (user or bot).
   */
  async punishExecutor(
    guild,
    executorId,
    { module = "DEFENDER", reason = "Guvenlik ihlali", forceMode = null } = {}
  ) {
    if (!guild || !executorId) {
      return { ok: false, action: "none", reason: "NO_EXECUTOR" };
    }
    if (executorId === guild.ownerId) {
      return { ok: false, action: "none", reason: "OWNER_IMMUNE" };
    }
    const me = guild.members?.me;
    if (me && executorId === me.id) {
      return { ok: false, action: "none", reason: "SELF_IMMUNE" };
    }

    // Deduplicate burst punishments within 5s for the same user
    const dedupKey = `${guild.id}:${executorId}`;
    const lastTs = this.recentPunishments.get(dedupKey) || 0;
    if (Date.now() - lastTs < 5000 && !forceMode) {
      return { ok: true, action: "already_punished", deduplicated: true };
    }
    this.recentPunishments.set(dedupKey, Date.now());

    let member = guild.members.cache.get(executorId);
    if (!member && typeof guild.members.fetch === "function") {
      member = await guild.members.fetch(executorId).catch(() => null);
    }

    const g = this.store.getGuild(guild.id);
    let mode = forceMode || g.punishmentMode || "quarantine";

    // Rogue/compromised bots should at minimum be stripped & kicked if mode is quarantine
    const isBot = Boolean(member?.user?.bot);
    if (isBot && mode === "quarantine") {
      mode = "kick";
    }

    const auditReason = `[Defender/${module}] ${reason}`;

    if (mode === "ban") {
      if (member && !this._canActOnMember(guild, member)) {
        return { ok: false, action: "ban_failed", reason: "HIERARCHY_BLOCKED" };
      }
      if (guild.members?.ban) {
        await guild.members
          .ban(executorId, { reason: auditReason })
          .catch(() => {});
        return { ok: true, action: "ban" };
      }
    }

    if (!member) {
      // User already left server -> ban by ID if severe antiNuke
      if (module === "ANTI_NUKE" && guild.members?.ban) {
        await guild.members
          .ban(executorId, { reason: auditReason })
          .catch(() => {});
        return { ok: true, action: "ban_absent" };
      }
      return { ok: false, action: "none", reason: "MEMBER_NOT_FOUND" };
    }

    if (!this._canActOnMember(guild, member)) {
      return { ok: false, action: "failed", reason: "HIERARCHY_BLOCKED" };
    }

    if (mode === "kick") {
      await this.stripRemovableRoles(guild, member, auditReason);
      if (typeof member.kick === "function") {
        await member.kick(auditReason).catch(() => {});
      }
      return { ok: true, action: "kick" };
    }

    if (mode === "strip_roles") {
      const removed = await this.stripRemovableRoles(guild, member, auditReason);
      return { ok: true, action: "strip_roles", removedRolesCount: removed.length };
    }

    // Default: quarantine (strip roles + save to vault + assign KARANTINA + timeout)
    const res = await this.quarantineMember(guild, member, reason, `Defender/${module}`);
    return res.ok
      ? { ok: true, action: "quarantine", removedRolesCount: res.removedRolesCount }
      : { ok: false, action: "quarantine_failed", reason: res.reason };
  }

  async enableLockdown(guild, reason = "Acil durum kilidi", actorTag = "Defender") {
    const g = this.store.getGuild(guild.id);
    if (g.lockdown.active) {
      return { ok: false, reason: "ALREADY_LOCKED", lockedCount: 0 };
    }

    const everyoneId = guild.roles?.everyone?.id;
    if (!everyoneId) {
      return { ok: false, reason: "NO_EVERYONE_ROLE", lockedCount: 0 };
    }

    const savedOverwrites = {};
    let lockedCount = 0;

    for (const ch of guild.channels.cache.values()) {
      if (
        ch.type !== ChannelType.GuildText &&
        ch.type !== ChannelType.GuildForum &&
        ch.type !== ChannelType.GuildAnnouncement
      ) {
        continue;
      }
      if (ch.id === g.logChannelId) continue;
      if (!ch.permissionOverwrites?.edit) continue;

      const currentOw = ch.permissionOverwrites.cache?.get(everyoneId);
      const sendAllow = currentOw?.allow?.has?.(PermissionFlagsBits.SendMessages) || false;
      const sendDeny = currentOw?.deny?.has?.(PermissionFlagsBits.SendMessages) || false;
      const reactAllow = currentOw?.allow?.has?.(PermissionFlagsBits.AddReactions) || false;
      const reactDeny = currentOw?.deny?.has?.(PermissionFlagsBits.AddReactions) || false;

      // Skip channels that are already completely hidden & send-denied to @everyone
      const viewDeny = currentOw?.deny?.has?.(PermissionFlagsBits.ViewChannel) || false;
      if (viewDeny && sendDeny) continue;

      savedOverwrites[ch.id] = {
        SendMessages: sendAllow ? true : sendDeny ? false : null,
        AddReactions: reactAllow ? true : reactDeny ? false : null,
      };

      this.snapshotManager.markSelfAction(`channelUpdate:${ch.id}`, 10_000);
      try {
        await ch.permissionOverwrites.edit(
          everyoneId,
          { SendMessages: false, AddReactions: false },
          { reason: `Defender Acil Kilit (${actorTag}): ${reason}` }
        );
        lockedCount += 1;
      } catch {
        delete savedOverwrites[ch.id];
      }
    }

    g.lockdown = {
      active: true,
      activatedAt: Date.now(),
      activatedBy: actorTag,
      reason,
      savedOverwrites,
    };
    this.store.save();

    return { ok: true, lockedCount };
  }

  async disableLockdown(guild, actorTag = "Yonetici") {
    const g = this.store.getGuild(guild.id);
    if (!g.lockdown.active) {
      return { ok: false, reason: "NOT_LOCKED", unlockedCount: 0 };
    }

    const everyoneId = guild.roles?.everyone?.id;
    let unlockedCount = 0;

    if (everyoneId) {
      for (const [channelId, prev] of Object.entries(
        g.lockdown.savedOverwrites || {}
      )) {
        const ch = guild.channels.cache.get(channelId);
        if (!ch || !ch.permissionOverwrites?.edit) continue;

        this.snapshotManager.markSelfAction(`channelUpdate:${ch.id}`, 10_000);
        try {
          await ch.permissionOverwrites.edit(
            everyoneId,
            {
              SendMessages: prev.SendMessages,
              AddReactions: prev.AddReactions,
            },
            { reason: `Defender Acil Kilit Kaldirildi (${actorTag})` }
          );
          unlockedCount += 1;
        } catch {
          // Ignore deleted/unmanageable channels
        }
      }
    }

    g.lockdown = {
      active: false,
      activatedAt: null,
      activatedBy: null,
      reason: null,
      savedOverwrites: {},
    };
    this.store.save();

    return { ok: true, unlockedCount };
  }

  async logIncident(guild, incident) {
    const record = this.store.recordIncident(guild.id, incident);

    const logChannel = await this.resolveLogChannel(guild);
    if (!logChannel) return record;

    const fields = [
      { name: "Olay ID", value: record.id, inline: true },
      { name: "Modül", value: record.module, inline: true },
      { name: "Önem", value: record.severity, inline: true },
    ];

    if (record.executorId) {
      fields.push({
        name: "Sorumlu",
        value: `<@${record.executorId}> (\`${record.executorId}\`)`,
        inline: true,
      });
    }
    if (record.target) {
      fields.push({ name: "Hedef", value: String(record.target), inline: true });
    }
    if (record.punishment) {
      fields.push({
        name: "Uygulanan İşlem",
        value: String(record.punishment),
        inline: true,
      });
    }
    if (record.restored) {
      fields.push({
        name: "Oto-Geri Yükleme",
        value: String(record.restored),
        inline: false,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(SEVERITY_COLORS[record.severity] || SEVERITY_COLORS.HIGH)
      .setTitle(`[${record.id}] ${record.action}`)
      .setDescription(record.details || "Güvenlik olayı kaydedildi.")
      .addFields(fields)
      .setFooter({ text: `Defender Güvenlik Sistemi | ${guild.name}` })
      .setTimestamp(record.ts);

    await logChannel
      .send({ embeds: [embed], allowedMentions: { parse: [] } })
      .catch(() => {});

    return record;
  }
}

module.exports = { PunishmentEngine };
