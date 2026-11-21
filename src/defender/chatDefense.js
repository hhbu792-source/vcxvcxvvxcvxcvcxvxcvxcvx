const { PermissionFlagsBits } = require("discord.js");
const { SCAM_DOMAIN_PATTERNS, SAFE_OFFICIAL_DOMAINS } = require("./constants");
const { ActionWindowTracker } = require("./windowTracker");

const TOKEN_LEAK_RE =
  /\b[MNO][A-Za-z\d_-]{23,32}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/;
const WEBHOOK_LEAK_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/i;

const INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord\s*\.\s*gg|discord(?:app)?\s*\.\s*com\s*\/\s*invite|dsc\s*\.\s*gg|invite\s*\.\s*gg)\s*\/\s*([a-zA-Z0-9-]{2,32})/i;

const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
const IP_URL_RE = /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?:[:/]|$)/i;
const ZALGO_RE = /[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\ufe20-\ufe2f]/g;
const CUSTOM_EMOJI_RE = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/gu;

function extractHost(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getRootDomain(host) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

function detectSecretLeak(content) {
  if (TOKEN_LEAK_RE.test(content)) {
    return { type: "BOT_TOKEN", label: "Discord Bot Token sızıntısı" };
  }
  if (WEBHOOK_LEAK_RE.test(content)) {
    return { type: "WEBHOOK_URL", label: "Discord Webhook URL sızıntısı" };
  }
  return null;
}

function detectPhishing(content) {
  // 1. Disguised Markdown links: [discord.com](https://evil.xyz)
  MARKDOWN_LINK_RE.lastIndex = 0;
  let mdMatch;
  while ((mdMatch = MARKDOWN_LINK_RE.exec(content)) !== null) {
    const labelText = mdMatch[1].trim();
    const targetUrl = mdMatch[2].trim();
    const labelDomainMatch = labelText.match(
      /(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i
    );
    if (labelDomainMatch) {
      const visibleRoot = getRootDomain(
        labelDomainMatch[1].toLowerCase().replace(/^www\./, "")
      );
      const actualRoot = getRootDomain(extractHost(targetUrl));
      if (visibleRoot && actualRoot && visibleRoot !== actualRoot) {
        return {
          reason: `Maskelenmiş sahte bağlantı (${visibleRoot} -> ${actualRoot})`,
          host: actualRoot,
        };
      }
    }
  }

  // 2. Inspect all URLs in content
  URL_RE.lastIndex = 0;
  const urls = content.match(URL_RE) || [];
  for (const rawUrl of urls) {
    if (IP_URL_RE.test(rawUrl)) {
      return { reason: "Doğrudan IP adresli şüpheli bağlantı", host: rawUrl };
    }
    const host = extractHost(rawUrl);
    if (!host) continue;
    const root = getRootDomain(host);
    if (SAFE_OFFICIAL_DOMAINS.has(host) || SAFE_OFFICIAL_DOMAINS.has(root)) {
      continue;
    }
    for (const pat of SCAM_DOMAIN_PATTERNS) {
      if (pat.test(host) || pat.test(rawUrl)) {
        return { reason: `Phishing / dolandırıcılık alanı (${host})`, host };
      }
    }
  }

  return null;
}

function detectExternalInvite(content, guild) {
  const m = content.match(INVITE_RE);
  if (!m) return null;
  const code = m[1];
  if (
    guild?.vanityURLCode &&
    code.toLowerCase() === guild.vanityURLCode.toLowerCase()
  ) {
    return null;
  }
  return { code };
}

class ChatDefenseEngine {
  /**
   * @param {import('./store').DefenderStore} store
   * @param {import('./punishmentEngine').PunishmentEngine} punishmentEngine
   * @param {object} options
   */
  constructor(store, punishmentEngine, options = {}) {
    this.store = store;
    this.punishmentEngine = punishmentEngine;
    this.tracker = new ActionWindowTracker();
    this.warnNoticeMs = options.warnNoticeMs ?? 5000;
  }

  async _sendTempWarn(channel, text) {
    if (!channel || typeof channel.send !== "function") return;
    const msg = await channel
      .send({ content: text, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (msg && this.warnNoticeMs > 0) {
      const t = setTimeout(() => {
        msg.delete().catch(() => {});
      }, this.warnNoticeMs);
      if (typeof t.unref === "function") t.unref();
    }
  }

  async _applyStrike(message, { module, reason, strikeWeight = 1, alwaysLog = false }) {
    const guild = message.guild;
    const g = this.store.getGuild(guild.id);
    const userId = message.author.id;

    if (message.deletable) {
      await message.delete().catch(() => {});
    }

    const strikeKey = `${guild.id}:strikes:${userId}`;
    let totalStrikes = 0;
    for (let i = 0; i < strikeWeight; i++) {
      const r = this.tracker.record(
        strikeKey,
        g.thresholds.strikeDecayMs,
        { module, reason },
        Date.now()
      );
      totalStrikes = r.count;
    }

    let actionTaken = "delete_warn";

    if (totalStrikes >= 4) {
      const q = await this.punishmentEngine.punishExecutor(guild, userId, {
        module,
        reason: `Tekrarlayan sohbet ihlali (${totalStrikes} uyari): ${reason}`,
      });
      actionTaken = q.action || "quarantine";
      this.tracker.clearKey(strikeKey);
      await this._sendTempWarn(
        message.channel,
        `<@${userId}> tekrarlayan güvenlik ihlalleri nedeniyle kısıtlandı (${reason}).`
      );
    } else if (totalStrikes === 3) {
      if (message.member && typeof message.member.timeout === "function") {
        await message.member
          .timeout(10 * 60 * 1000, `[Defender/${module}] ${reason}`)
          .catch(() => {});
      }
      actionTaken = "timeout_10m";
      await this._sendTempWarn(
        message.channel,
        `<@${userId}> 10 dakika susturuldu. Sebep: ${reason} (İhlal: 3/4)`
      );
    } else if (totalStrikes === 2) {
      if (message.member && typeof message.member.timeout === "function") {
        await message.member
          .timeout(60 * 1000, `[Defender/${module}] ${reason}`)
          .catch(() => {});
      }
      actionTaken = "timeout_1m";
      await this._sendTempWarn(
        message.channel,
        `<@${userId}> 1 dakika susturuldu. Sebep: ${reason} (İhlal: 2/4)`
      );
    } else {
      await this._sendTempWarn(
        message.channel,
        `<@${userId}> mesajınız engellendi. Sebep: ${reason} (İhlal: 1/4)`
      );
    }

    if (alwaysLog || totalStrikes >= 3) {
      await this.punishmentEngine.logIncident(guild, {
        module,
        severity: totalStrikes >= 4 || alwaysLog ? "HIGH" : "MEDIUM",
        action: `Sohbet Koruması Tetiklendi (${module})`,
        executorId: userId,
        target: `#${message.channel.name}`,
        details: `${reason} (Toplam ihlal puanı: ${totalStrikes})`,
        punishment: actionTaken,
      });
    }

    return {
      blocked: true,
      module,
      reason,
      strikes: totalStrikes,
      actionTaken,
    };
  }

  async onMessageCreate(message, options = {}) {
    const { isEdit = false } = options;
    if (!message || !message.guild || message.author?.bot) {
      return { blocked: false };
    }

    const guild = message.guild;
    const g = this.store.getGuild(guild.id);
    if (!g.enabled) return { blocked: false };

    const content = message.content || "";

    // 1. Token / Webhook Leak Shield (protects EVERYONE, even whitelisted admins!)
    if (g.modules.antiTokenLeak && content) {
      const leak = detectSecretLeak(content);
      if (leak) {
        if (message.deletable) {
          await message.delete().catch(() => {});
        }
        await this._sendTempWarn(
          message.channel,
          `<@${message.author.id}> güvenlik uyarısı: Mesajınızda **${leak.label}** tespit edildiği için anında silindi. İlgili token/webhook'u hemen yenileyin.`
        );
        await this.punishmentEngine.logIncident(guild, {
          module: "ANTI_TOKEN_LEAK",
          severity: "CRITICAL",
          action: leak.label,
          executorId: message.author.id,
          target: `#${message.channel.name}`,
          details: "Hassas Discord kimlik bilgisi sohbetten otomatik temizlendi.",
          punishment: "message_deleted",
        });
        return { blocked: true, module: "ANTI_TOKEN_LEAK", leak: leak.type };
      }
    }

    // Exempt whitelisted users/roles for remaining chat filters
    if (
      this.store.isWhitelisted(guild, message.member || message.author.id, "chatDefense")
    ) {
      return { blocked: false, whitelisted: true };
    }

    // 2. Phishing / Scam & Disguised Markdown Link Shield (High strike weight = 3)
    if (g.modules.antiPhishing && content) {
      const phish = detectPhishing(content);
      if (phish) {
        return this._applyStrike(message, {
          module: "ANTI_PHISHING",
          reason: phish.reason,
          strikeWeight: 3,
          alwaysLog: true,
        });
      }
    }

    // 3. External Discord Invite Blocker
    if (g.modules.antiInvite && content) {
      const inv = detectExternalInvite(content, guild);
      if (inv) {
        return this._applyStrike(message, {
          module: "ANTI_INVITE",
          reason: `İzinsiz Discord davet bağlantısı (${inv.code})`,
          strikeWeight: 1,
        });
      }
    }

    // 4. Mass Mention & Unauthorized @everyone/@here Shield
    if (g.modules.antiMention) {
      const userMentions = message.mentions?.users?.size || 0;
      const roleMentions = message.mentions?.roles?.size || 0;
      const totalMentions = userMentions + roleMentions;

      const hasEveryoneText = /@(?:everyone|here)\b/i.test(content);
      const canMentionEveryone = Boolean(
        message.member?.permissions?.has?.(PermissionFlagsBits.MentionEveryone)
      );

      if (hasEveryoneText && !canMentionEveryone) {
        return this._applyStrike(message, {
          module: "ANTI_MENTION",
          reason: "Yetkisiz @everyone / @here etiketleme girişimi",
          strikeWeight: 2,
          alwaysLog: true,
        });
      }

      if (totalMentions >= g.thresholds.maxMentionsPerMessage) {
        return this._applyStrike(message, {
          module: "ANTI_MENTION",
          reason: `Toplu etiket spamı (${totalMentions} etiket)`,
          strikeWeight: 2,
          alwaysLog: true,
        });
      }
    }

    // 5. Anti-Spam: Burst, Duplicate Flood, Newline Bomb, Zalgo, Emoji Flood
    if (g.modules.antiSpam) {
      // 5a. Newline wall bomb
      const newlineCount = (content.match(/\n/g) || []).length;
      if (newlineCount >= g.thresholds.maxNewlinesPerMessage) {
        return this._applyStrike(message, {
          module: "ANTI_SPAM",
          reason: `Satır/duvar spamı (${newlineCount} satır)`,
          strikeWeight: 1,
        });
      }

      // 5b. Zalgo text flood
      const zalgoCount = (content.match(ZALGO_RE) || []).length;
      if (zalgoCount >= g.thresholds.maxZalgoMarks) {
        return this._applyStrike(message, {
          module: "ANTI_SPAM",
          reason: `Zalgo / bozuk karakter spamı (${zalgoCount} işaret)`,
          strikeWeight: 1,
        });
      }

      // 5c. Excessive emoji flood
      const customEmojiCount = (content.match(CUSTOM_EMOJI_RE) || []).length;
      const unicodeEmojiCount = (content.match(UNICODE_EMOJI_RE) || []).length;
      if (customEmojiCount + unicodeEmojiCount >= g.thresholds.maxEmojisPerMessage) {
        return this._applyStrike(message, {
          module: "ANTI_SPAM",
          reason: `Aşırı emoji spamı (${customEmojiCount + unicodeEmojiCount} emoji)`,
          strikeWeight: 1,
        });
      }

      // 5d. Duplicate message flood (skip on edit)
      if (!isEdit) {
        const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
        if (normalized.length >= 3) {
          const dupKey = `${guild.id}:dup:${message.author.id}:${normalized.slice(0, 80)}`;
          const dupRes = this.tracker.record(
            dupKey,
            g.thresholds.duplicateWindowMs,
            { messageId: message.id },
            Date.now()
          );
          if (dupRes.count >= g.thresholds.duplicateLimit) {
            this.tracker.clearKey(dupKey);
            return this._applyStrike(message, {
              module: "ANTI_SPAM",
              reason: `Tekrarlayan mesaj spamı (${dupRes.count} aynı mesaj)`,
              strikeWeight: 1,
            });
          }
        }

        // 5e. Rapid burst spam
        const burstKey = `${guild.id}:burst:${message.author.id}`;
        const burstRes = this.tracker.record(
          burstKey,
          g.thresholds.spamWindowMs,
          { messageId: message.id },
          Date.now()
        );
        if (burstRes.count >= g.thresholds.spamMessageLimit) {
          this.tracker.clearKey(burstKey);
          return this._applyStrike(message, {
            module: "ANTI_SPAM",
            reason: `Hızlı mesaj spamı (${burstRes.count} mesaj / ${Math.round(g.thresholds.spamWindowMs / 1000)}sn)`,
            strikeWeight: 1,
          });
        }
      }
    }

    return { blocked: false };
  }
}

module.exports = {
  ChatDefenseEngine,
  detectSecretLeak,
  detectPhishing,
  detectExternalInvite,
};
