const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { DEFAULT_BLACKLIST_ROLE_ID } = require("./constants");
const { createEmptyUserRecord } = require("./userLogStore");

const VALID_TABS = new Set(["overview", "warnings", "punishments", "rp", "notes"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampText(text, maxLen = 1000) {
  const s = String(text || "");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

function truncateLine(text, maxLen = 95) {
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
  return `${days} gün`;
}

function formatDateIsoTr(ts) {
  if (!ts) return "Bilinmiyor";
  try {
    return new Date(ts).toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

function formatActor(entry) {
  if (entry.moderatorId) return `<@${entry.moderatorId}>`;
  return entry.moderatorTag || "Bilinmiyor";
}

function formatActorPlain(entry) {
  if (entry.moderatorTag && entry.moderatorId) {
    return `${entry.moderatorTag} (${entry.moderatorId})`;
  }
  if (entry.moderatorId) return entry.moderatorId;
  return entry.moderatorTag || "Bilinmiyor";
}

function buildProgressBar(score, width = 10) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${clamped}/100`;
}

function computeRiskProfile(rec, { isBlacklistedNow, isTimedOutNow, liveBan }) {
  let score = 0;

  const banCount = rec.bans.length === 0 && liveBan ? 1 : rec.bans.length;
  const blAddCount = rec.blacklists.filter((b) => b.action !== "remove").length;

  if (liveBan) score += 50;
  else score += Math.min(50, banCount * 25);

  if (isBlacklistedNow) score += 35;
  else score += Math.min(35, blAddCount * 18);

  score += Math.min(48, rec.warnings.length * 12);
  score += Math.min(36, rec.kicks.length * 12);
  score += Math.min(18, rec.timeouts.length * 6);
  score += Math.min(10, rec.autoModCount * 2);
  if (isTimedOutNow) score += 10;

  score = Math.max(0, Math.min(100, score));

  let label = "Temiz Sicil";
  let color = 0x2ecc71;
  if (score >= 70 || liveBan) {
    label = "Kritik Risk";
    color = 0xc0392b;
  } else if (score >= 40 || isBlacklistedNow) {
    label = "Yüksek Risk";
    color = 0xe67e22;
  } else if (score >= 15 || isTimedOutNow) {
    label = "İzleme Altında";
    color = 0xf1c40f;
  }

  return {
    score,
    label,
    color,
    bar: buildProgressBar(score, 10),
  };
}

function getTopRpChannels(rec, limit = 3) {
  const counts = new Map();
  for (const s of rec.rp.sessions) {
    if (s.source !== "auto") continue;
    const key = String(s.channelName || "rp-kanali").toLowerCase();
    const cur = counts.get(key) || { name: s.channelName, sessions: 0, messages: 0 };
    cur.sessions += 1;
    cur.messages += Number(s.messages) || 0;
    counts.set(key, cur);
  }
  return [...counts.values()]
    .sort((a, b) => b.sessions - a.sessions || b.messages - a.messages)
    .slice(0, limit);
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

  pruneExpired(now = Date.now()) {
    for (const [k, exp] of this._directMarks.entries()) {
      if (exp <= now) this._directMarks.delete(k);
    }
    for (const [k, ts] of this._recentBans.entries()) {
      if (now - ts > 60_000) this._recentBans.delete(k);
    }
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
      moderatorTag:
        audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
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
      reason: audit?.reason || "Yasak kaldırıldı",
      moderatorId: audit?.executorId || audit?.executor?.id || null,
      moderatorTag:
        audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
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
        moderatorTag:
          audit.executor?.tag || audit.executor?.username || "Bilinmiyor",
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
    if (
      !oldMember ||
      oldMember.partial ||
      !newMember ||
      !newMember.guild ||
      newMember.user?.bot
    ) {
      return { recorded: false };
    }
    const guild = newMember.guild;
    const userId = newMember.id;
    const results = [];

    // 1. Timeout detection
    const oldUntil = oldMember.communicationDisabledUntilTimestamp || 0;
    const newUntil = newMember.communicationDisabledUntilTimestamp || 0;
    const now = Date.now();
    if (newUntil > now && newUntil !== oldUntil) {
      if (!this._consumeDirect(`timeout:${guild.id}:${userId}`)) {
        const audit = await this._findRecentAuditEntry(
          guild,
          AuditLogEvent.MemberUpdate,
          userId
        );
        if (!audit || !this._rememberAuditId(audit.id)) {
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
    }

    // 2. Manual Blacklist role add/remove detection
    const g = this.defenderStore ? this.defenderStore.getGuild(guild.id) : null;
    const blRoleIds = new Set(
      [this.blacklistRoleId, g?.blacklistRoleId].filter(Boolean)
    );
    if (blRoleIds.size > 0 && oldMember.roles?.cache && newMember.roles?.cache) {
      const oldHad = [...blRoleIds].some((id) => oldMember.roles.cache.has(id));
      const newHas = [...blRoleIds].some((id) => newMember.roles.cache.has(id));

      if (!oldHad && newHas) {
        if (!this._consumeDirect(`blacklist:add:${guild.id}:${userId}`)) {
          const audit = await this._findRecentAuditEntry(
            guild,
            AuditLogEvent.MemberRoleUpdate,
            userId
          );
          if (!audit || !this._rememberAuditId(audit.id)) {
            const entry = this.store.recordBlacklist(guild.id, userId, {
              action: "add",
              reason: audit?.reason || "Blacklist rolü verildi",
              moderatorId: audit?.executorId || audit?.executor?.id || null,
              moderatorTag:
                audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
              tag: newMember.user?.tag || newMember.user?.username || null,
            });
            results.push({ type: "blacklist_add", entry });
          }
        }
      } else if (oldHad && !newHas) {
        if (!this._consumeDirect(`blacklist:remove:${guild.id}:${userId}`)) {
          const audit = await this._findRecentAuditEntry(
            guild,
            AuditLogEvent.MemberRoleUpdate,
            userId
          );
          if (!audit || !this._rememberAuditId(audit.id)) {
            const entry = this.store.recordBlacklist(guild.id, userId, {
              action: "remove",
              reason: audit?.reason || "Blacklist rolü kaldırıldı",
              moderatorId: audit?.executorId || audit?.executor?.id || null,
              moderatorTag:
                audit?.executor?.tag || audit?.executor?.username || "Bilinmiyor",
              tag: newMember.user?.tag || newMember.user?.username || null,
            });
            results.push({ type: "blacklist_remove", entry });
          }
        }
      }
    }

    return { recorded: results.length > 0, results };
  }

  recordDirectBlacklist(
    guildId,
    userId,
    {
      action = "add",
      reason = "Defender Blacklist",
      moderatorId = null,
      moderatorTag = "Defender",
      tag = null,
    } = {}
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
    {
      durationMs = 60_000,
      reason = "Defender otomatik susturma",
      moderatorId = null,
      moderatorTag = "Defender",
      tag = null,
    } = {}
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
        .setAuthor({ name: `${guild.name} | Resmi Uyarı Bildirimi` })
        .setTitle(`Uyarı Kaydı: ${entry.id}`)
        .setDescription(
          "Sunucu yönetimi tarafından hesabınıza resmi bir uyarı kaydedildi. Lütfen sunucu kurallarına dikkat ediniz."
        )
        .addFields(
          { name: "Uyarı Kodu", value: `\`${entry.id}\``, inline: true },
          { name: "Aktif Uyarı Sayısı", value: `**${totalWarnings}**`, inline: true },
          { name: "Sebep", value: clampText(cleanReason, 950), inline: false }
        )
        .setFooter({ text: `Defender Moderasyon Sistemi | ${guild.name}` })
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
        action: `Kullanıcı Uyarıldı (${entry.id})`,
        executorId: moderator?.id || null,
        target: `<@${targetUser.id}> (\`${targetUser.id}\`)`,
        details: `Sebep: ${cleanReason} | Toplam uyarı: ${totalWarnings}`,
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
        action: "Uyarı Kaydı Silindi",
        executorId: moderator?.id || null,
        target: `<@${targetUserId}> (\`${targetUserId}\`)`,
        details: `Silinen: ${res.removedIds.join(", ")} | Kalan uyarı: ${res.remainingCount}`,
      });
    }

    return res;
  }

  async addStaffNote(guild, targetUser, noteText, moderator) {
    const cleanNote = String(noteText || "").trim();
    const res = this.store.addNote(guild.id, targetUser.id, {
      note: cleanNote,
      moderatorId: moderator?.id || null,
      moderatorTag: moderator?.tag || moderator?.username || "Yetkili",
      tag: targetUser.tag || targetUser.username || null,
    });

    if (this.punishmentEngine) {
      await this.punishmentEngine.logIncident(guild, {
        module: "STAFF_NOTE",
        severity: "INFO",
        action: `Yetkili Notu Eklendi (${res.entry.id})`,
        executorId: moderator?.id || null,
        target: `<@${targetUser.id}> (\`${targetUser.id}\`)`,
        details: `Not: ${truncateLine(cleanNote, 180)}`,
      });
    }

    return res;
  }

  async removeStaffNote(guild, targetUserId, noteIdOrAll, moderator) {
    const res = this.store.removeNote(guild.id, targetUserId, noteIdOrAll);

    if (res.removedCount > 0 && this.punishmentEngine) {
      await this.punishmentEngine.logIncident(guild, {
        module: "STAFF_NOTE",
        severity: "INFO",
        action: "Yetkili Notu Silindi",
        executorId: moderator?.id || null,
        target: `<@${targetUserId}> (\`${targetUserId}\`)`,
        details: `Silinen: ${res.removedIds.join(", ")} | Kalan not: ${res.remainingCount}`,
      });
    }

    return res;
  }

  buildWarnConfirmEmbed({
    guild,
    targetUser,
    entry,
    totalWarnings,
    dmSent,
    moderator,
  }) {
    return new EmbedBuilder()
      .setColor(0xe67e22)
      .setAuthor({ name: "Defender Moderasyon | Uyarı İşlemi" })
      .setTitle(`Uyarı Kaydedildi (${entry.id})`)
      .addFields(
        {
          name: "Kullanıcı",
          value: `<@${targetUser.id}> (\`${targetUser.id}\`)`,
          inline: true,
        },
        {
          name: "Yetkili",
          value: moderator?.id ? `<@${moderator.id}>` : "Yetkili",
          inline: true,
        },
        {
          name: "Toplam Aktif Uyarı",
          value: `**${totalWarnings}**`,
          inline: true,
        },
        {
          name: "Sebep",
          value: clampText(entry.reason, 950),
          inline: false,
        },
        {
          name: "DM Bildirimi",
          value: dmSent ? "Gönderildi" : "Gönderilemedi (Kullanıcı DM kapalı)",
          inline: true,
        }
      )
      .setFooter({ text: `Defender Uyarı Sistemi | ${guild.name}` })
      .setTimestamp(entry.createdAt);
  }

  buildWarningsEmbed(guild, targetUser, targetId) {
    const uid = String(targetId || targetUser?.id || "");
    const rec = this.store.peekUser(guild.id, uid);
    const warnings = rec?.warnings || [];
    const label = targetUser?.tag || targetUser?.username || rec?.lastTag || uid;

    const lines =
      warnings.length === 0
        ? "Bu kullanıcıya ait aktif uyarı kaydı bulunmuyor."
        : warnings
            .slice(-15)
            .reverse()
            .map(
              (w) =>
                `- \`${w.id}\` | <t:${Math.floor(w.createdAt / 1000)}:R> | Yetkili: ${formatActor(w)}\n  Sebep: ${truncateLine(w.reason, 130)}`
            )
            .join("\n");

    return new EmbedBuilder()
      .setColor(warnings.length > 0 ? 0xe67e22 : 0x2c3e50)
      .setAuthor({ name: "Defender Moderasyon | Uyarı Listesi" })
      .setTitle(`Uyarı Kayıtları - ${label}`)
      .setDescription(clampText(lines, 3900))
      .addFields(
        { name: "Kullanıcı", value: `<@${uid}> (\`${uid}\`)`, inline: true },
        { name: "Aktif Uyarı", value: `**${warnings.length}**`, inline: true },
        {
          name: "Silinen Uyarı",
          value: `**${rec?.removedWarningsCount || 0}**`,
          inline: true,
        }
      )
      .setFooter({ text: `Defender Uyarı Sistemi | ${guild.name}` })
      .setTimestamp();
  }

  buildQuickWarnModal(targetId) {
    const modal = new ModalBuilder()
      .setCustomId(`ulog:modal:warn:${targetId}`)
      .setTitle("Hızlı Uyarı Ver");

    const reasonInput = new TextInputBuilder()
      .setCustomId("warn_reason")
      .setLabel("Uyarı Sebebi")
      .setPlaceholder("Kural ihlalini açık ve net bir şekilde yazın...")
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(3)
      .setMaxLength(350)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    return modal;
  }

  buildQuickNoteModal(targetId) {
    const modal = new ModalBuilder()
      .setCustomId(`ulog:modal:note:${targetId}`)
      .setTitle("Yetkili Notu Ekle");

    const noteInput = new TextInputBuilder()
      .setCustomId("staff_note")
      .setLabel("Yetkili Notu (Sadece Yöneticilere Görünür)")
      .setPlaceholder("Kullanıcı hakkında iç moderasyon notu yazın...")
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(2)
      .setMaxLength(400)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    return modal;
  }

  _buildModTimeline(rec, liveBan) {
    const timeline = [
      ...rec.bans.map((b) => ({
        ts: b.createdAt,
        kind: "BAN",
        id: b.id,
        reason: b.reason,
        actor: b,
        line: `- **[BAN \`${b.id}\`]** ${truncateLine(b.reason, 85)} | ${formatActor(b)} | <t:${Math.floor(b.createdAt / 1000)}:R>`,
      })),
      ...rec.unbans.map((u) => ({
        ts: u.createdAt,
        kind: "UNBAN",
        id: u.id,
        reason: u.reason,
        actor: u,
        line: `- **[UNBAN \`${u.id}\`]** ${truncateLine(u.reason, 85)} | ${formatActor(u)} | <t:${Math.floor(u.createdAt / 1000)}:R>`,
      })),
      ...rec.kicks.map((k) => ({
        ts: k.createdAt,
        kind: "KICK",
        id: k.id,
        reason: k.reason,
        actor: k,
        line: `- **[KICK \`${k.id}\`]** ${truncateLine(k.reason, 85)} | ${formatActor(k)} | <t:${Math.floor(k.createdAt / 1000)}:R>`,
      })),
      ...rec.blacklists.map((bl) => ({
        ts: bl.createdAt,
        kind: bl.action === "remove" ? "BLACKLIST_KALDIR" : "BLACKLIST",
        id: bl.id,
        reason: bl.reason,
        actor: bl,
        line: `- **[${bl.action === "remove" ? "BLACKLIST KALDIR" : "BLACKLIST"} \`${bl.id}\`]** ${truncateLine(bl.reason, 80)} | ${formatActor(bl)} | <t:${Math.floor(bl.createdAt / 1000)}:R>`,
      })),
      ...rec.timeouts.map((t) => ({
        ts: t.createdAt,
        kind: "TIMEOUT",
        id: t.id,
        reason: t.reason,
        durationMs: t.durationMs,
        actor: t,
        line: `- **[TIMEOUT \`${t.id}\`${t.durationMs ? ` - ${formatDurationTr(t.durationMs)}` : ""}]** ${truncateLine(t.reason, 75)} | ${formatActor(t)} | <t:${Math.floor(t.createdAt / 1000)}:R>`,
      })),
    ].sort((a, b) => b.ts - a.ts);

    if (liveBan && rec.bans.length === 0) {
      timeline.unshift({
        ts: Date.now(),
        kind: "AKTIF_BAN",
        id: "LIVE",
        reason: liveBan.reason || "Belirtilmedi",
        actor: { moderatorTag: "Discord" },
        line: `- **[AKTİF BAN]** Sebep: ${truncateLine(liveBan.reason || "Belirtilmedi", 110)}`,
      });
    }

    return timeline;
  }

  _resolveContext({
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
    if (liveBan) statusTags.push("Yasaklı (Banlı)");
    else if (member) statusTags.push("Sunucuda");
    else statusTags.push("Sunucuda Değil");

    if (isBlacklistedNow) statusTags.push("Blacklist'te");
    if (isTimedOutNow) {
      statusTags.push(`Susturulmuş (<t:${Math.floor(timeoutUntil / 1000)}:R>)`);
    }

    const displayName =
      discordUser?.tag ||
      discordUser?.username ||
      member?.user?.tag ||
      member?.user?.username ||
      rec.lastTag ||
      `ID: ${uid}`;

    const blacklistAddCount = rec.blacklists.filter(
      (b) => b.action !== "remove"
    ).length;
    const effectiveBanCount =
      rec.bans.length === 0 && liveBan ? 1 : rec.bans.length;

    const risk = computeRiskProfile(rec, {
      isBlacklistedNow,
      isTimedOutNow,
      liveBan,
    });

    const modTimeline = this._buildModTimeline(rec, liveBan);

    const avatarUrl =
      typeof discordUser?.displayAvatarURL === "function"
        ? discordUser.displayAvatarURL({ size: 256 })
        : typeof member?.user?.displayAvatarURL === "function"
        ? member.user.displayAvatarURL({ size: 256 })
        : null;

    return {
      uid,
      rec,
      displayName,
      statusTags,
      isBlacklistedNow,
      isTimedOutNow,
      timeoutUntil,
      blacklistAddCount,
      effectiveBanCount,
      risk,
      modTimeline,
      avatarUrl,
    };
  }

  buildUserLogDashboard({
    guild,
    targetId,
    discordUser = null,
    member = null,
    liveBan = null,
    defenderBlacklisted = false,
    tab = "overview",
  }) {
    const activeTab = VALID_TABS.has(tab) ? tab : "overview";
    const ctx = this._resolveContext({
      guild,
      targetId,
      discordUser,
      member,
      liveBan,
      defenderBlacklisted,
    });
    const { uid, rec, displayName, statusTags, isBlacklistedNow, risk, modTimeline } =
      ctx;

    const createdLine = discordUser?.createdTimestamp
      ? `<t:${Math.floor(discordUser.createdTimestamp / 1000)}:D> (<t:${Math.floor(discordUser.createdTimestamp / 1000)}:R>)`
      : "Bilinmiyor";

    const joinedLine = member?.joinedTimestamp
      ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`
      : "Sunucuda değil";

    const embed = new EmbedBuilder()
      .setColor(risk.color)
      .setAuthor({
        name: `Defender Kullanıcı Sicil Dosyası | ${guild.name}`,
        ...(ctx.avatarUrl ? { iconURL: ctx.avatarUrl } : {}),
      })
      .setTimestamp();

    if (ctx.avatarUrl) {
      embed.setThumbnail(ctx.avatarUrl);
    }

    if (activeTab === "overview") {
      const recentWarningsText =
        rec.warnings.length === 0
          ? "Kayıtlı aktif uyarı yok."
          : rec.warnings
              .slice(-3)
              .reverse()
              .map(
                (w) =>
                  `- \`${w.id}\` ${truncateLine(w.reason, 85)} | ${formatActor(w)} | <t:${Math.floor(w.createdAt / 1000)}:R>`
              )
              .join("\n");

      const recentModText =
        modTimeline.length === 0
          ? "Kayıtlı ban, kick, timeout veya blacklist yok."
          : modTimeline
              .slice(0, 4)
              .map((item) => item.line)
              .join("\n");

      embed
        .setTitle(`Genel Sicil Özeti - ${displayName}`)
        .setDescription(
          `Kullanıcı: <@${uid}> (\`${uid}\`)\nAnlık Durum: **${statusTags.join(" | ")}**\nSicil Değerlendirmesi: \`${risk.bar}\` — **${risk.label}**`
        )
        .addFields(
          {
            name: "Hesap Bilgileri",
            value: clampText(
              [
                `Hesap Açılışı: ${createdLine}`,
                `Sunucuya Katılım: ${joinedLine}`,
                `Giriş / Çıkış: **${rec.joins}** giriş | **${rec.leaves}** çıkış`,
              ].join("\n"),
              1000
            ),
            inline: false,
          },
          {
            name: "RP & Aktivite",
            value: clampText(
              [
                `Katıldığı RP Sayısı: **${rec.rp.count}**`,
                `Toplam RP Mesajı: **${rec.rp.messageCount}**`,
                `Son RP: ${rec.rp.lastRpAt ? `<t:${Math.floor(rec.rp.lastRpAt / 1000)}:R>` : "Yok"}`,
                `Oto-Mod Engeli: **${rec.autoModCount}**`,
              ].join("\n"),
              1000
            ),
            inline: true,
          },
          {
            name: "Ceza Özeti",
            value: clampText(
              [
                `Uyarı: **${rec.warnings.length}**${rec.removedWarningsCount > 0 ? ` (${rec.removedWarningsCount} silindi)` : ""}`,
                `Ban: **${ctx.effectiveBanCount}**${liveBan ? " (Aktif)" : ""}`,
                `Kick: **${rec.kicks.length}**`,
                `Timeout: **${rec.timeouts.length}**`,
                `Blacklist: **${ctx.blacklistAddCount}**${isBlacklistedNow ? " (Aktif)" : ""}`,
              ].join("\n"),
              1000
            ),
            inline: true,
          },
          {
            name: `Son Uyarılar (${rec.warnings.length})`,
            value: clampText(recentWarningsText, 1000),
            inline: false,
          },
          {
            name: `Son Ceza Kayıtları (${modTimeline.length})`,
            value: clampText(recentModText, 1000),
            inline: false,
          }
        )
        .setFooter({
          text: `Sekme: Genel Özet | Yetkili Notları: ${rec.notes.length} | ID: ${uid}`,
        });
    } else if (activeTab === "warnings") {
      const warnLines =
        rec.warnings.length === 0
          ? "Bu kullanıcıya ait aktif uyarı kaydı bulunmuyor."
          : rec.warnings
              .slice(-12)
              .reverse()
              .map(
                (w) =>
                  `- **\`${w.id}\`** | <t:${Math.floor(w.createdAt / 1000)}:R> | Yetkili: ${formatActor(w)}\n  Sebep: ${truncateLine(w.reason, 160)}`
              )
              .join("\n");

      embed
        .setTitle(`Uyarı Kayıtları - ${displayName}`)
        .setDescription(clampText(warnLines, 3800))
        .addFields(
          { name: "Aktif Uyarı", value: `**${rec.warnings.length}**`, inline: true },
          {
            name: "Kaldırılan Uyarı",
            value: `**${rec.removedWarningsCount}**`,
            inline: true,
          },
          { name: "Sicil Durumu", value: `**${risk.label}**`, inline: true }
        )
        .setFooter({
          text: `Sekme: Uyarılar (Son 12 kayıt) | ID: ${uid}`,
        });
    } else if (activeTab === "punishments") {
      const punLines =
        modTimeline.length === 0
          ? "Kayıtlı ban, unban, kick, timeout veya blacklist işlemi bulunmuyor."
          : modTimeline
              .slice(0, 12)
              .map((item) => item.line)
              .join("\n");

      embed
        .setTitle(`Ceza & Moderasyon Geçmişi - ${displayName}`)
        .setDescription(clampText(punLines, 3800))
        .addFields(
          {
            name: "Ban / Kick",
            value: `Ban: **${ctx.effectiveBanCount}** | Unban: **${rec.unbans.length}** | Kick: **${rec.kicks.length}**`,
            inline: true,
          },
          {
            name: "Timeout / Blacklist",
            value: `Timeout: **${rec.timeouts.length}** | Blacklist: **${ctx.blacklistAddCount}**`,
            inline: true,
          },
          {
            name: "Oto-Mod Engeli",
            value: `**${rec.autoModCount}** mesaj`,
            inline: true,
          }
        )
        .setFooter({
          text: `Sekme: Ceza Geçmişi (Son 12 kayıt) | ID: ${uid}`,
        });
    } else if (activeTab === "rp") {
      const autoSessions = rec.rp.sessions.filter((s) => s.source === "auto");
      const avgMsgs =
        autoSessions.length > 0
          ? Math.round((rec.rp.messageCount / autoSessions.length) * 10) / 10
          : 0;
      const topChannels = getTopRpChannels(rec, 3);
      const topChannelsText =
        topChannels.length === 0
          ? "Henüz otomatik kanal verisi yok."
          : topChannels
              .map(
                (c, i) =>
                  `${i + 1}. \`#${truncateLine(c.name, 40)}\` — **${c.sessions}** oturum (${c.messages} mesaj)`
              )
              .join("\n");

      const rpLines =
        rec.rp.sessions.length === 0
          ? "Henüz RP katılımı kaydedilmedi."
          : rec.rp.sessions
              .slice(-10)
              .reverse()
              .map((s) => {
                if (s.source === "manual") {
                  const sign = s.delta > 0 ? `+${s.delta}` : String(s.delta);
                  return `- **[Manuel ${sign}]** ${truncateLine(s.channelName, 80)} | ${formatActor(s)} | <t:${Math.floor(s.startedAt / 1000)}:R>`;
                }
                return `- \`#${truncateLine(s.channelName, 45)}\` — **${s.messages}** mesaj | <t:${Math.floor(s.startedAt / 1000)}:R>`;
              })
              .join("\n");

      embed
        .setTitle(`RP Katılım & Aktivite Raporu - ${displayName}`)
        .addFields(
          {
            name: "RP İstatistikleri",
            value: [
              `Katıldığı RP Sayısı: **${rec.rp.count}**`,
              `Toplam RP Mesajı: **${rec.rp.messageCount}**`,
              `Oturum Başına Ortalama: **${avgMsgs}** mesaj`,
              `Son RP: ${rec.rp.lastRpAt ? `<t:${Math.floor(rec.rp.lastRpAt / 1000)}:R>` : "Yok"}`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "En Çok Oynanan Kanallar",
            value: clampText(topChannelsText, 1000),
            inline: true,
          },
          {
            name: `Son RP Oturumları (Son 10 / Toplam ${rec.rp.count})`,
            value: clampText(rpLines, 1000),
            inline: false,
          }
        )
        .setFooter({
          text: `Sekme: RP Geçmişi | Takip Kategorisi: ${this.rpCategoryName} | ID: ${uid}`,
        });
    } else if (activeTab === "notes") {
      const noteLines =
        rec.notes.length === 0
          ? "Bu kullanıcı için eklenmiş yetkili notu bulunmuyor.\nAşağıdaki **Not Ekle** butonunu veya `/defender not-ekle` komutunu kullanabilirsiniz."
          : rec.notes
              .slice(-12)
              .reverse()
              .map(
                (n) =>
                  `- **\`${n.id}\`** | <t:${Math.floor(n.createdAt / 1000)}:R> | Yetkili: ${formatActor(n)}\n  ${truncateLine(n.note, 180)}`
              )
              .join("\n");

      embed
        .setTitle(`Yetkili İç Notları - ${displayName}`)
        .setDescription(clampText(noteLines, 3800))
        .addFields({
          name: "Gizlilik Bilgisi",
          value:
            "Yetkili notları sadece yöneticilere görünür; kullanıcıya DM veya bildirim gönderilmez.",
          inline: false,
        })
        .setFooter({
          text: `Sekme: Yetkili Notları (Toplam ${rec.notes.length}) | ID: ${uid}`,
        });
    }

    const tabRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ulog:tab:${uid}:overview`)
        .setLabel("Genel Özet")
        .setStyle(
          activeTab === "overview" ? ButtonStyle.Primary : ButtonStyle.Secondary
        )
        .setDisabled(activeTab === "overview"),
      new ButtonBuilder()
        .setCustomId(`ulog:tab:${uid}:warnings`)
        .setLabel(`Uyarılar (${rec.warnings.length})`)
        .setStyle(
          activeTab === "warnings" ? ButtonStyle.Primary : ButtonStyle.Secondary
        )
        .setDisabled(activeTab === "warnings"),
      new ButtonBuilder()
        .setCustomId(`ulog:tab:${uid}:punishments`)
        .setLabel(`Cezalar (${modTimeline.length})`)
        .setStyle(
          activeTab === "punishments"
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary
        )
        .setDisabled(activeTab === "punishments"),
      new ButtonBuilder()
        .setCustomId(`ulog:tab:${uid}:rp`)
        .setLabel(`RP (${rec.rp.count})`)
        .setStyle(activeTab === "rp" ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(activeTab === "rp"),
      new ButtonBuilder()
        .setCustomId(`ulog:tab:${uid}:notes`)
        .setLabel(`Notlar (${rec.notes.length})`)
        .setStyle(
          activeTab === "notes" ? ButtonStyle.Primary : ButtonStyle.Secondary
        )
        .setDisabled(activeTab === "notes")
    );

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ulog:warn:${uid}`)
        .setLabel("Uyarı Ver")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ulog:note:${uid}`)
        .setLabel("Not Ekle")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ulog:refresh:${uid}:${activeTab}`)
        .setLabel("Yenile")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ulog:export:${uid}`)
        .setLabel("Rapor İndir (.txt)")
        .setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [tabRow, actionRow] };
  }

  buildUserLogEmbed(params) {
    return this.buildUserLogDashboard(params).embeds[0];
  }

  buildUserLogReportText({
    guild,
    targetId,
    discordUser = null,
    member = null,
    liveBan = null,
    defenderBlacklisted = false,
  }) {
    const ctx = this._resolveContext({
      guild,
      targetId,
      discordUser,
      member,
      liveBan,
      defenderBlacklisted,
    });
    const { uid, rec, displayName, risk, modTimeline } = ctx;

    const lines = [
      "================================================================",
      `DEFENDER KULLANICI SICIL RAPORU - ${guild.name}`,
      `Olusturma Tarihi : ${formatDateIsoTr(Date.now())}`,
      "================================================================",
      "",
      "[KIMLIK & DURUM]",
      `Kullanici        : ${displayName}`,
      `Discord ID       : ${uid}`,
      `Anlik Durum      : ${ctx.statusTags.join(" | ").replace(/<t:\d+:R>/g, formatDateIsoTr(ctx.timeoutUntil))}`,
      `Hesap Acilisi    : ${formatDateIsoTr(discordUser?.createdTimestamp)}`,
      `Sunucu Katilimi  : ${member?.joinedTimestamp ? formatDateIsoTr(member.joinedTimestamp) : "Sunucuda degil"}`,
      `Giris / Cikis    : ${rec.joins} giris / ${rec.leaves} cikis`,
      `Risk Skoru       : ${risk.bar} (${risk.label})`,
      "",
      "[GENEL OZET]",
      `Katildigi RP     : ${rec.rp.count} (${rec.rp.messageCount} RP mesaji)`,
      `Aktif Uyari      : ${rec.warnings.length} (Silinen: ${rec.removedWarningsCount})`,
      `Ban              : ${ctx.effectiveBanCount}${liveBan ? " (Aktif)" : ""}`,
      `Unban            : ${rec.unbans.length}`,
      `Kick             : ${rec.kicks.length}`,
      `Timeout          : ${rec.timeouts.length}`,
      `Blacklist        : ${ctx.blacklistAddCount}${ctx.isBlacklistedNow ? " (Aktif)" : ""}`,
      `Oto-Mod Engeli   : ${rec.autoModCount}`,
      `Yetkili Notu     : ${rec.notes.length}`,
      "",
      "[UYARILAR]",
    ];

    if (rec.warnings.length === 0) {
      lines.push("  Kayitli aktif uyari yok.");
    } else {
      for (const w of rec.warnings) {
        lines.push(
          `  - [${w.id}] ${formatDateIsoTr(w.createdAt)} | Yetkili: ${formatActorPlain(w)} | Sebep: ${w.reason}`
        );
      }
    }

    lines.push("", "[CEZA & MODERASYON GECMISI]");
    if (modTimeline.length === 0) {
      lines.push("  Kayitli ceza islemi yok.");
    } else {
      for (const item of modTimeline) {
        const dur = item.durationMs ? ` (${formatDurationTr(item.durationMs)})` : "";
        lines.push(
          `  - [${item.kind} ${item.id}${dur}] ${formatDateIsoTr(item.ts)} | Yetkili: ${formatActorPlain(item.actor)} | Sebep: ${item.reason}`
        );
      }
    }

    lines.push("", "[RP KATILIMLARI]");
    if (rec.rp.sessions.length === 0) {
      lines.push("  Kayitli RP katilimi yok.");
    } else {
      for (const s of rec.rp.sessions) {
        if (s.source === "manual") {
          const sign = s.delta > 0 ? `+${s.delta}` : String(s.delta);
          lines.push(
            `  - [${s.id} MANUEL ${sign}] ${formatDateIsoTr(s.startedAt)} | Yetkili: ${formatActorPlain(s)} | Not: ${s.channelName}`
          );
        } else {
          lines.push(
            `  - [${s.id}] ${formatDateIsoTr(s.startedAt)} | Kanal: #${s.channelName} | Mesaj: ${s.messages}`
          );
        }
      }
    }

    lines.push("", "[YETKILI NOTLARI]");
    if (rec.notes.length === 0) {
      lines.push("  Kayitli yetkili notu yok.");
    } else {
      for (const n of rec.notes) {
        lines.push(
          `  - [${n.id}] ${formatDateIsoTr(n.createdAt)} | Yetkili: ${formatActorPlain(n)} | Not: ${n.note}`
        );
      }
    }

    lines.push("", "================================================================");
    return lines.join("\n");
  }
}

module.exports = {
  UserLogManager,
  computeRiskProfile,
  buildProgressBar,
  VALID_TABS,
};
