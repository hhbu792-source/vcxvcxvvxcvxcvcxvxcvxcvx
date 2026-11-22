const { AuditLogEvent, ChannelType, EmbedBuilder } = require("discord.js");
const { DEFAULT_BLACKLIST_ROLE_ID } = require("./constants");
const { createEmptyUserRecord } = require("./userLogStore");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampText(text, maxLen = 1000) {
  const s = String(text || "");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

function truncateLine(text, maxLen = 90) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatDurationTr(ms) {
  const totalSec = Math.max(1, Math.round(Number(ms || 0) / 1000));
  if (totalSec < 60) return `${totalSec} sn`;
  const mins = Math.round(totalSec / 60);
  if (mins < 60) return `${mins} dk`;
  const hours = Math.round((mins / 60) * 10) / 10;
  if (hours < 24) return `${hours} sa`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} gun`;
}

function formatActor(entry) {
  if (entry.moderatorId) return `<@${entry.moderatorId}>`;
  return entry.moderatorTag || "Bilinmiyor";
}

class UserLogManager {
  /**
   * @param {import('./userLogStore').UserLogStore} userLogStore
   * @param {import('./store').DefenderStore} defenderStore
   * @param {import('./punishmentEngine').PunishmentEngine} punishmentEngine
   * @param {object} [options]
   */
  constructor(userLogStore, defenderStore, punishmentEngine, options = {}) {
    this.store = userLogStore;
    this.defenderStore = defenderStore;
    this.punishmentEngine = punishmentEngine;
    this.rpCategoryName = (options.rpCategoryName || "RP LEVELLER").trim();
    this.rpSessionGapMs = options.rpSessionGapMs ?? 30 * 60 * 1000;
    this.blacklistRoleId =
      options.blacklistRoleId || DEFAULT_BLACKLIST_ROLE_ID;
    this.auditLogDelayMs = options.auditLogDelayMs ?? 400;
    this.logger = options.logger || console;

    /** @type {Set<string>} */
    this._processedAuditIds = new Set();
    /** @type {Map<string, number>} */
    this._directMarks = new Map();
    /** @type {Map<string, number>} */
    this._recentBans = new Map();
  }

  _markDirect(key, ttlMs = 8000) {
    this._directMarks.set(key, Date.now() + ttlMs);
    if (this._directMarks.size > 500) {
      const now = Date.now();
      for (const [k, exp] of this._directMarks.entries()) {
        if (exp <= now) this._directMarks.delete(k);
      }
    }
  }

  _consumeDirect(key) {
    const exp = this._directMarks.get(key);
    if (!exp) return false;
    if (Date.now() <= exp) {
      this._directMarks.delete(key);
      return true;
    }
    this._directMarks.delete(key);
    return false;
  }

  _rememberAuditId(id) {
    if (!id) return false;
    const key = String(id);
    if (this._processedAuditIds.has(key)) return true;
    this._processedAuditIds.add(key);
    if (this._processedAuditIds.size > 1000) {
      const first = this._processedAuditIds.values().next().value;
      if (first) this._processedAuditIds.delete(first);
    }
    return false;
  }

  async _findRecentAuditEntry(guild, type, targetId, maxAgeMs = 15_000) {
    if (!guild || typeof guild.fetchAuditLogs !== "function") return null;
    if (this.auditLogDelayMs > 0) {
      await sleep(this.auditLogDelayMs);
    }
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 6 });
      const now = Date.now();
      for (const entry of logs.entries.values()) {
        const entryTargetId = entry.targetId || entry.target?.id;
        if (String(entryTargetId || "") !== String(targetId)) continue;
        if (now - entry.createdTimestamp > maxAgeMs) continue;
        return entry;
      }
    } catch {
      return null;
    }
    return null;
  }

  isRpChannel(channel) {
    if (!channel || !channel.guild) return false;

    const baseChannel =
      typeof channel.isThread === "function" && channel.isThread() && channel.parent
        ? channel.parent
        : channel;

    if (
      baseChannel.type !== ChannelType.GuildText &&
      baseChannel.type !== ChannelType.GuildAnnouncement
    ) {
      return false;
    }

    const chName = String(baseChannel.name || "").toLowerCase();
    const chTopic = String(baseChannel.topic || "");
    if (chName === "cagri-log" || chTopic.includes("[CALL_LOG]")) {
      return false;
    }

    if (chTopic.includes("LEVEL_ID:")) {
      return true;
    }

    const parent =
      baseChannel.parent ||
      (baseChannel.parentId
        ? channel.guild.channels?.cache?.get(baseChannel.parentId)
        : null);
    if (parent && parent.name) {
      const pName = String(parent.name).trim().toLowerCase();
      if (pName === this.rpCategoryName.toLowerCase()) {
        return true;
      }
      if (/(?:^|[\s\-_|/])(rp|roleplay)(?:$|[\s\-_|/])/i.test(pName)) {
        return true;
      }
    }

    return false;
  }

  async onMessageCreate(message) {
    if (!message || !message.guild || message.author?.bot) {
      return { tracked: false };
    }
    if (!this.isRpChannel(message.channel)) {
      return { tracked: false };
    }

    const content = String(message.content || "").trim();
    // Skip out-of-character & staff call prefixes for RP participation counting
    if (/^\.(ooc|cagir)\b/i.test(content)) {
      return { tracked: false, reason: "OOC_OR_CALL" };
    }

    const res = this.store.recordRpActivity(message.guild.id, message.author.id, {
      channelId: message.channel.id,
      channelName: message.channel.name || "rp-kanali",
      tag: message.author.tag || message.author.username || null,
      sessionGapMs: this.rpSessionGapMs,
    });

    return {
      tracked: true,
      newSession: res.newSession,
      totalRpCount: res.totalRpCount,
    };
  }

  async onGuildMemberAdd(member) {
    if (!member || !member.guild || member.user?.bot) return;
    this.store.touchUser(member.guild.id, member.id, {
      tag: member.user?.tag || member.user?.username || null,
      joined: true,
    });
  }

  async onGuildBanAdd(ban) {
    if (!ban || !ban.guild || !ban.user) return { recorded: false };
    const guild = ban.guild;
    const userId = ban.user.id;
    this._recentBans.set(`${guild.id}:${userId}`, Date.now());

    const audit = await this._findRecentAuditEntry(
      guild,
      AuditLogEvent.MemberBanAdd,
      userId
    );
    if (audit && this._rememberAuditId(audit.id)) {
      return { recorded: false, duplicate: true };
    }

    const entry = this.store.recordBan(guild.id, userId, {
      reason: audit?.reason || ban.reason || "Belirtilmedi",
      moderatorId: audit?.executorId || audit?.executor?.id || null,
      moderatorTag: audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
      tag: ban.user.tag || ban.user.username || null,
    });

    return { recorded: true, entry };
  }

  async onGuildBanRemove(ban) {
    if (!ban || !ban.guild || !ban.user) return { recorded: false };
    const guild = ban.guild;
    const userId = ban.user.id;

    const audit = await this._findRecentAuditEntry(
      guild,
      AuditLogEvent.MemberBanRemove,
      userId
    );
    if (audit && this._rememberAuditId(audit.id)) {
      return { recorded: false, duplicate: true };
    }

    const entry = this.store.recordUnban(guild.id, userId, {
      reason: audit?.reason || "Yasak kaldirildi",
      moderatorId: audit?.executorId || audit?.executor?.id || null,
      moderatorTag: audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
      tag: ban.user.tag || ban.user.username || null,
    });

    return { recorded: true, entry };
  }

  async onGuildMemberRemove(member) {
    if (!member || !member.guild || member.user?.bot) return { recorded: false };
    const guild = member.guild;
    const userId = member.id;

    const audit = await this._findRecentAuditEntry(
      guild,
      AuditLogEvent.MemberKick,
      userId
    );

    // If user was just banned, GuildBanAdd already recorded the ban
    const recentBanTs = this._recentBans.get(`${guild.id}:${userId}`) || 0;
    if (Date.now() - recentBanTs < 12_000) {
      return { recorded: false, skippedBecauseBan: true };
    }

    if (audit) {
      if (this._rememberAuditId(audit.id)) {
        return { recorded: false, duplicate: true };
      }
      const entry = this.store.recordKick(guild.id, userId, {
        reason: audit.reason || "Belirtilmedi",
        moderatorId: audit.executorId || audit.executor?.id || null,
        moderatorTag: audit.executor?.tag || audit.executor?.username || "Bilinmiyor",
        tag: member.user?.tag || member.user?.username || null,
      });
      return { recorded: true, type: "kick", entry };
    }

    this.store.touchUser(guild.id, userId, {
      tag: member.user?.tag || member.user?.username || null,
      left: true,
    });
    return { recorded: true, type: "leave" };
  }

  async onGuildMemberUpdate(oldMember, newMember) {
    if (!newMember || !newMember.guild || newMember.user?.bot) {
      return { recorded: false };
    }
    const guild = newMember.guild;
    const userId = newMember.id;
    const results = [];

    // 1. Timeout detection
    const oldUntil = oldMember?.communicationDisabledUntilTimestamp || 0;
    const newUntil = newMember.communicationDisabledUntilTimestamp || 0;
    const now = Date.now();
    if (newUntil > now && newUntil !== oldUntil) {
      if (!this._consumeDirect(`timeout:${guild.id}:${userId}`)) {
        const audit = await this._findRecentAuditEntry(
          guild,
          AuditLogEvent.MemberUpdate,
          userId
        );
        const entry = this.store.recordTimeout(guild.id, userId, {
          reason: audit?.reason || "Susturma (Timeout)",
          durationMs: Math.max(0, newUntil - now),
          until: newUntil,
          moderatorId: audit?.executorId || audit?.executor?.id || null,
          moderatorTag:
            audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
          tag: newMember.user?.tag || newMember.user?.username || null,
        });
        results.push({ type: "timeout", entry });
      }
    }

    // 2. Manual Blacklist role add/remove detection
    const g = this.defenderStore ? this.defenderStore.getGuild(guild.id) : null;
    const blRoleIds = new Set(
      [this.blacklistRoleId, g?.blacklistRoleId].filter(Boolean)
    );
    if (blRoleIds.size > 0 && oldMember?.roles?.cache && newMember?.roles?.cache) {
      const oldHad = [...blRoleIds].some((id) => oldMember.roles.cache.has(id));
      const newHas = [...blRoleIds].some((id) => newMember.roles.cache.has(id));

      if (!oldHad && newHas) {
        if (!this._consumeDirect(`blacklist:add:${guild.id}:${userId}`)) {
          const audit = await this._findRecentAuditEntry(
            guild,
            AuditLogEvent.MemberRoleUpdate,
            userId
          );
          const entry = this.store.recordBlacklist(guild.id, userId, {
            action: "add",
            reason: audit?.reason || "Blacklist rolu verildi",
            moderatorId: audit?.executorId || audit?.executor?.id || null,
            moderatorTag:
              audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
            tag: newMember.user?.tag || newMember.user?.username || null,
          });
          results.push({ type: "blacklist_add", entry });
        }
      } else if (oldHad && !newHas) {
        if (!this._consumeDirect(`blacklist:remove:${guild.id}:${userId}`)) {
          const audit = await this._findRecentAuditEntry(
            guild,
            AuditLogEvent.MemberRoleUpdate,
            userId
          );
          const entry = this.store.recordBlacklist(guild.id, userId, {
            action: "remove",
            reason: audit?.reason || "Blacklist rolu kaldirildi",
            moderatorId: audit?.executorId || audit?.executor?.id || null,
            moderatorTag:
              audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
            tag: newMember.user?.tag || newMember.user?.username || null,
          });
          results.push({ type: "blacklist_remove", entry });
        }
      }
    }

    return { recorded: results.length > 0, results };
  }

  recordDirectBlacklist(
    guildId,
    userId,
    { action = "add", reason = "Defender Blacklist", moderatorId = null, moderatorTag = "Defender", tag = null } = {}
  ) {
    this._markDirect(`blacklist:${action}:${guildId}:${userId}`, 10_000);
    return this.store.recordBlacklist(guildId, userId, {
      action,
      reason,
      moderatorId,
      moderatorTag,
      tag,
    });
  }

  recordDirectTimeout(
    guildId,
    userId,
    { durationMs = 60_000, reason = "Defender otomatik susturma", moderatorId = null, moderatorTag = "Defender", tag = null } = {}
  ) {
    this._markDirect(`timeout:${guildId}:${userId}`, 10_000);
    const now = Date.now();
    return this.store.recordTimeout(guildId, userId, {
      reason,
      durationMs,
      until: now + durationMs,
      moderatorId,
      moderatorTag,
      tag,
      now,
    });
  }

  recordAutoMod(guildId, userId, tag = null) {
    return this.store.recordAutoMod(guildId, userId, { tag });
  }

  async warnUser(guild, targetUser, reason, moderator) {
    const cleanReason = String(reason || "Belirtilmedi").trim();
    const { entry, totalWarnings } = this.store.addWarning(
      guild.id,
      targetUser.id,
      {
        reason: cleanReason,
        moderatorId: moderator?.id || null,
        moderatorTag: moderator?.tag || moderator?.username || "Yetkili",
        source: "manual",
        tag: targetUser.tag || targetUser.username || null,
      }
    );

    let dmSent = false;
    if (typeof targetUser.send === "function") {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`Uyari Bildirimi - ${guild.name}`)
        .setDescription("Sunucu yonetimi tarafindan size bir uyari verildi.")
        .addFields(
          { name: "Uyari ID", value: `\`${entry.id}\``, inline: true },
          { name: "Toplam Uyari", value: `**${totalWarnings}**`, inline: true },
          { name: "Sebep", value: clampText(cleanReason, 950), inline: false }
        )
        .setFooter({ text: `Defender Uyari Sistemi | ${guild.name}` })
        .setTimestamp(entry.createdAt);

      dmSent = await targetUser
        .send({ embeds: [dmEmbed] })
        .then(() => true)
        .catch(() => false);
    }

    if (this.punishmentEngine) {
      await this.punishmentEngine.logIncident(guild, {
        module: "WARNING",
        severity: "MEDIUM",
        action: `Kullanici Uyarildi (${entry.id})`,
        executorId: moderator?.id || null,
        target: `<@${targetUser.id}> (\`${targetUser.id}\`)`,
        details: `Sebep: ${cleanReason} | Toplam uyari: ${totalWarnings}`,
        punishment: `warning (${entry.id})`,
      });
    }

    return { entry, totalWarnings, dmSent };
  }

  async removeWarning(guild, targetUserId, warningIdOrAll, moderator) {
    const res = this.store.removeWarning(guild.id, targetUserId, warningIdOrAll);

    if (res.removedCount > 0 && this.punishmentEngine) {
      await this.punishmentEngine.logIncident(guild, {
        module: "WARNING",
        severity: "INFO",
        action: "Uyari Silindi",
        executorId: moderator?.id || null,
        target: `<@${targetUserId}> (\`${targetUserId}\`)`,
        details: `Silinen: ${res.removedIds.join(", ")} | Kalan uyari: ${res.remainingCount}`,
      });
    }

    return res;
  }

  buildWarningsEmbed(guild, targetUser, targetId) {
    const uid = String(targetId || targetUser?.id || "");
    const rec = this.store.peekUser(guild.id, uid);
    const warnings = rec?.warnings || [];
    const label = targetUser?.tag || targetUser?.username || rec?.lastTag || uid;

    const lines =
      warnings.length === 0
        ? "Bu kullaniciya ait kayitli uyari bulunmuyor."
        : warnings
            .slice(-15)
            .reverse()
            .map(
              (w) =>
                `- \`${w.id}\` | <t:${Math.floor(w.createdAt / 1000)}:R> | Yetkili: ${formatActor(w)}\n  Sebep: ${truncateLine(w.reason, 120)}`
            )
            .join("\n");

    const embed = new EmbedBuilder()
      .setColor(warnings.length > 0 ? 0xe67e22 : 0x2c3e50)
      .setTitle(`Uyari Kayitlari - ${label}`)
      .setDescription(clampText(lines, 3900))
      .addFields(
        { name: "Kullanici", value: `<@${uid}> (\`${uid}\`)`, inline: true },
        { name: "Toplam Uyari", value: `**${warnings.length}**`, inline: true }
      )
      .setFooter({ text: `Defender Uyari Sistemi | ${guild.name}` })
      .setTimestamp();

    return embed;
  }

  buildUserLogEmbed({
    guild,
    targetId,
    discordUser = null,
    member = null,
    liveBan = null,
    defenderBlacklisted = false,
  }) {
    const uid = String(targetId);
    const rec = this.store.peekUser(guild.id, uid) || createEmptyUserRecord(uid);
    const gDef = this.defenderStore ? this.defenderStore.getGuild(guild.id) : null;
    const blRoleIds = new Set(
      [this.blacklistRoleId, gDef?.blacklistRoleId].filter(Boolean)
    );

    const hasBlacklistRole = Boolean(
      member?.roles?.cache &&
        [...blRoleIds].some((rid) => member.roles.cache.has(rid))
    );
    const isBlacklistedNow = Boolean(defenderBlacklisted || hasBlacklistRole);

    const timeoutUntil = member?.communicationDisabledUntilTimestamp || 0;
    const isTimedOutNow = timeoutUntil > Date.now();

    const statusTags = [];
    if (liveBan) {
      statusTags.push("Yasakli (Banli)");
    } else if (member) {
      statusTags.push("Sunucuda");
    } else {
      statusTags.push("Sunucuda Degil");
    }
    if (isBlacklistedNow) statusTags.push("Blacklist'te");
    if (isTimedOutNow) {
      statusTags.push(`Susturulmus (<t:${Math.floor(timeoutUntil / 1000)}:R>)`);
    }

    const displayName =
      discordUser?.tag ||
      discordUser?.username ||
      member?.user?.tag ||
      member?.user?.username ||
      rec.lastTag ||
      `ID: ${uid}`;

    const createdLine = discordUser?.createdTimestamp
      ? `<t:${Math.floor(discordUser.createdTimestamp / 1000)}:D> (<t:${Math.floor(discordUser.createdTimestamp / 1000)}:R>)`
      : "Bilinmiyor";

    const joinedLine = member?.joinedTimestamp
      ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`
      : "Sunucuda degil";

    const blacklistAddCount = rec.blacklists.filter(
      (b) => b.action !== "remove"
    ).length;

    const effectiveBanCount =
      rec.bans.length === 0 && liveBan ? 1 : rec.bans.length;

    // Combine moderation events chronologically (newest first)
    const modTimeline = [
      ...rec.bans.map((b) => ({
        ts: b.createdAt,
        line: `- [BAN ${b.id}] ${truncateLine(b.reason, 85)} | ${formatActor(b)} | <t:${Math.floor(b.createdAt / 1000)}:R>`,
      })),
      ...rec.unbans.map((u) => ({
        ts: u.createdAt,
        line: `- [UNBAN ${u.id}] ${truncateLine(u.reason, 85)} | ${formatActor(u)} | <t:${Math.floor(u.createdAt / 1000)}:R>`,
      })),
      ...rec.kicks.map((k) => ({
        ts: k.createdAt,
        line: `- [KICK ${k.id}] ${truncateLine(k.reason, 85)} | ${formatActor(k)} | <t:${Math.floor(k.createdAt / 1000)}:R>`,
      })),
      ...rec.blacklists.map((bl) => ({
        ts: bl.createdAt,
        line: `- [${bl.action === "remove" ? "BLACKLIST KALDIR" : "BLACKLIST"} ${bl.id}] ${truncateLine(bl.reason, 80)} | ${formatActor(bl)} | <t:${Math.floor(bl.createdAt / 1000)}:R>`,
      })),
      ...rec.timeouts.map((t) => ({
        ts: t.createdAt,
        line: `- [TIMEOUT ${t.id}${t.durationMs ? ` - ${formatDurationTr(t.durationMs)}` : ""}] ${truncateLine(t.reason, 75)} | ${formatActor(t)} | <t:${Math.floor(t.createdAt / 1000)}:R>`,
      })),
    ].sort((a, b) => b.ts - a.ts);

    if (liveBan && rec.bans.length === 0) {
      modTimeline.unshift({
        ts: Date.now(),
        line: `- [AKTIF BAN] Sebep: ${truncateLine(liveBan.reason || "Belirtilmedi", 110)}`,
      });
    }

    const recentWarningsText =
      rec.warnings.length === 0
        ? "Kayitli uyari yok."
        : rec.warnings
            .slice(-5)
            .reverse()
            .map(
              (w) =>
                `- \`${w.id}\` ${truncateLine(w.reason, 90)} | ${formatActor(w)} | <t:${Math.floor(w.createdAt / 1000)}:R>`
            )
            .join("\n");

    const modHistoryText =
      modTimeline.length === 0
        ? "Kayitli ban, kick, timeout veya blacklist yok."
        : modTimeline
            .slice(0, 6)
            .map((item) => item.line)
            .join("\n");

    const rpSessionsText =
      rec.rp.sessions.length === 0
        ? "Henuz RP katilimi kaydedilmedi."
        : rec.rp.sessions
            .slice(-5)
            .reverse()
            .map((s) => {
              if (s.source === "manual") {
                const sign = s.delta > 0 ? `+${s.delta}` : String(s.delta);
                return `- [Manuel ${sign}] ${truncateLine(s.channelName, 70)} | <t:${Math.floor(s.startedAt / 1000)}:R>`;
              }
              return `- #${truncateLine(s.channelName, 45)} (${s.messages} mesaj) | <t:${Math.floor(s.startedAt / 1000)}:R>`;
            })
            .join("\n");

    const color =
      liveBan || isBlacklistedNow
        ? 0xc0392b
        : rec.warnings.length > 0 || isTimedOutNow
        ? 0xe67e22
        : 0x2c3e50;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`Kullanici Sicil & Log Kaydi - ${displayName}`)
      .addFields(
        {
          name: "Kimlik & Durum",
          value: clampText(
            [
              `Kullanici: <@${uid}> (\`${uid}\`)`,
              `Durum: **${statusTags.join(" | ")}**`,
              `Hesap Olusturma: ${createdLine}`,
              `Sunucuya Katilim: ${joinedLine}`,
              `Giris / Cikis: **${rec.joins}** giris | **${rec.leaves}** cikis`,
            ].join("\n"),
            1000
          ),
          inline: false,
        },
        {
          name: "RP & Aktivite",
          value: clampText(
            [
              `Katildigi RP Sayisi: **${rec.rp.count}**`,
              `Toplam RP Mesaji: **${rec.rp.messageCount}**`,
              `Son RP: ${rec.rp.lastRpAt ? `<t:${Math.floor(rec.rp.lastRpAt / 1000)}:R>` : "Yok"}`,
              `Oto-Mod Engeli: **${rec.autoModCount}**`,
            ].join("\n"),
            1000
          ),
          inline: true,
        },
        {
          name: "Ceza Ozeti",
          value: clampText(
            [
              `Uyari: **${rec.warnings.length}**`,
              `Ban: **${effectiveBanCount}**${liveBan ? " (Aktif)" : ""}`,
              `Kick: **${rec.kicks.length}**`,
              `Timeout: **${rec.timeouts.length}**`,
              `Blacklist: **${blacklistAddCount}**${isBlacklistedNow ? " (Aktif)" : ""}`,
            ].join("\n"),
            1000
          ),
          inline: true,
        },
        {
          name: `Son Uyarilar (${rec.warnings.length})`,
          value: clampText(recentWarningsText, 1000),
          inline: false,
        },
        {
          name: "Ban / Kick / Timeout / Blacklist Gecmisi",
          value: clampText(modHistoryText, 1000),
          inline: false,
        },
        {
          name: `Son RP Katilimlari (${rec.rp.count})`,
          value: clampText(rpSessionsText, 1000),
          inline: false,
        }
      )
      .setFooter({ text: `Defender Kullanici Kayit Sistemi | ${guild.name}` })
      .setTimestamp();

    const avatarUrl =
      typeof discordUser?.displayAvatarURL === "function"
        ? discordUser.displayAvatarURL({ size: 256 })
        : typeof member?.user?.displayAvatarURL === "function"
        ? member.user.displayAvatarURL({ size: 256 })
        : null;
    if (avatarUrl) {
      embed.setThumbnail(avatarUrl);
    }

    return embed;
  }
}

module.exports = { UserLogManager };
