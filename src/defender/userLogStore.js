const fs = require("fs");
const path = require("path");

const DEFAULT_USER_LOG_FILE = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "user-logs.json"
);

const MAX_LIST_ENTRIES = 150;
const MAX_RP_SESSIONS = 100;

function createEmptyUserRecord(userId, now = Date.now()) {
  return {
    userId: String(userId),
    lastTag: null,
    firstSeenAt: now,
    lastSeenAt: now,
    joins: 0,
    leaves: 0,
    autoModCount: 0,
    rp: {
      count: 0,
      messageCount: 0,
      lastRpAt: null,
      sessions: [],
    },
    counters: {
      warning: 0,
      ban: 0,
      unban: 0,
      kick: 0,
      timeout: 0,
      blacklist: 0,
      rp: 0,
    },
    warnings: [],
    bans: [],
    unbans: [],
    kicks: [],
    timeouts: [],
    blacklists: [],
  };
}

function normalizeUserRecord(userId, raw) {
  const base = createEmptyUserRecord(userId, raw?.firstSeenAt || Date.now());
  if (!raw || typeof raw !== "object") return base;

  return {
    userId: String(userId),
    lastTag: raw.lastTag || null,
    firstSeenAt: Number(raw.firstSeenAt) || base.firstSeenAt,
    lastSeenAt: Number(raw.lastSeenAt) || base.lastSeenAt,
    joins: Number(raw.joins) || 0,
    leaves: Number(raw.leaves) || 0,
    autoModCount: Number(raw.autoModCount) || 0,
    rp: {
      count: Math.max(0, Number(raw.rp?.count) || 0),
      messageCount: Math.max(0, Number(raw.rp?.messageCount) || 0),
      lastRpAt: raw.rp?.lastRpAt ? Number(raw.rp.lastRpAt) : null,
      sessions: Array.isArray(raw.rp?.sessions)
        ? raw.rp.sessions.slice(-MAX_RP_SESSIONS)
        : [],
    },
    counters: {
      warning: Number(raw.counters?.warning) || (Array.isArray(raw.warnings) ? raw.warnings.length : 0),
      ban: Number(raw.counters?.ban) || (Array.isArray(raw.bans) ? raw.bans.length : 0),
      unban: Number(raw.counters?.unban) || (Array.isArray(raw.unbans) ? raw.unbans.length : 0),
      kick: Number(raw.counters?.kick) || (Array.isArray(raw.kicks) ? raw.kicks.length : 0),
      timeout: Number(raw.counters?.timeout) || (Array.isArray(raw.timeouts) ? raw.timeouts.length : 0),
      blacklist:
        Number(raw.counters?.blacklist) ||
        (Array.isArray(raw.blacklists) ? raw.blacklists.length : 0),
      rp:
        Number(raw.counters?.rp) ||
        (Array.isArray(raw.rp?.sessions) ? raw.rp.sessions.length : 0),
    },
    warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(-MAX_LIST_ENTRIES) : [],
    bans: Array.isArray(raw.bans) ? raw.bans.slice(-MAX_LIST_ENTRIES) : [],
    unbans: Array.isArray(raw.unbans) ? raw.unbans.slice(-MAX_LIST_ENTRIES) : [],
    kicks: Array.isArray(raw.kicks) ? raw.kicks.slice(-MAX_LIST_ENTRIES) : [],
    timeouts: Array.isArray(raw.timeouts) ? raw.timeouts.slice(-MAX_LIST_ENTRIES) : [],
    blacklists: Array.isArray(raw.blacklists)
      ? raw.blacklists.slice(-MAX_LIST_ENTRIES)
      : [],
  };
}

class UserLogStore {
  /**
   * @param {object} options
   * @param {string} [options.filePath]
   * @param {boolean} [options.persist=true]
   */
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_USER_LOG_FILE;
    this.persist = options.persist !== false;
    /** @type {Record<string, { users: Record<string, ReturnType<typeof createEmptyUserRecord>> }>} */
    this.guilds = {};

    if (this.persist) {
      this._load();
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.guilds === "object") {
        for (const [guildId, gData] of Object.entries(parsed.guilds)) {
          const users = {};
          if (gData && typeof gData.users === "object") {
            for (const [userId, uData] of Object.entries(gData.users)) {
              users[userId] = normalizeUserRecord(userId, uData);
            }
          }
          this.guilds[guildId] = { users };
        }
      }
    } catch (err) {
      console.error("[USER LOG STORE] Dosya yuklenemedi:", err.message);
    }
  }

  save() {
    if (!this.persist) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ guilds: this.guilds }, null, 2),
        "utf-8"
      );
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[USER LOG STORE] Dosya kaydedilemedi:", err.message);
    }
  }

  _ensureGuild(guildId) {
    const gid = String(guildId);
    if (!this.guilds[gid]) {
      this.guilds[gid] = { users: {} };
    }
    return this.guilds[gid];
  }

  getUser(guildId, userId) {
    const g = this._ensureGuild(guildId);
    const uid = String(userId);
    if (!g.users[uid]) {
      g.users[uid] = createEmptyUserRecord(uid);
      this.save();
    }
    return g.users[uid];
  }

  peekUser(guildId, userId) {
    const g = this.guilds[String(guildId)];
    const uid = String(userId);
    if (!g || !g.users[uid]) return null;
    return g.users[uid];
  }

  touchUser(guildId, userId, { tag = null, joined = false, left = false, now = Date.now() } = {}) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    if (joined) rec.joins += 1;
    if (left) rec.leaves += 1;
    this.save();
    return rec;
  }

  addWarning(
    guildId,
    userId,
    { reason, moderatorId = null, moderatorTag = "Yetkili", source = "manual", tag = null, now = Date.now() }
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.counters.warning += 1;

    const entry = {
      id: `W-${rec.counters.warning}`,
      reason: String(reason || "Belirtilmedi").trim().slice(0, 300),
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Yetkili"),
      source: source === "auto" ? "auto" : "manual",
      createdAt: now,
    };

    rec.warnings.push(entry);
    if (rec.warnings.length > MAX_LIST_ENTRIES) {
      rec.warnings.splice(0, rec.warnings.length - MAX_LIST_ENTRIES);
    }
    this.save();
    return { entry, totalWarnings: rec.warnings.length };
  }

  removeWarning(guildId, userId, warningIdOrAll = null) {
    const rec = this.peekUser(guildId, userId);
    if (!rec || rec.warnings.length === 0) {
      return { removedCount: 0, removedIds: [], remainingCount: 0 };
    }

    const raw = String(warningIdOrAll || "").trim().toLowerCase();
    if (raw === "hepsi" || raw === "all" || raw === "tumu") {
      const ids = rec.warnings.map((w) => w.id);
      rec.warnings = [];
      this.save();
      return { removedCount: ids.length, removedIds: ids, remainingCount: 0 };
    }

    if (!raw) {
      const removed = rec.warnings.pop();
      this.save();
      return {
        removedCount: removed ? 1 : 0,
        removedIds: removed ? [removed.id] : [],
        remainingCount: rec.warnings.length,
      };
    }

    const normalizedTarget = /^w-\d+$/.test(raw)
      ? raw.toUpperCase()
      : /^\d+$/.test(raw)
      ? `W-${raw}`
      : raw.toUpperCase();

    const idx = rec.warnings.findIndex(
      (w) => String(w.id).toUpperCase() === normalizedTarget
    );
    if (idx === -1) {
      return {
        removedCount: 0,
        removedIds: [],
        remainingCount: rec.warnings.length,
      };
    }

    const [removed] = rec.warnings.splice(idx, 1);
    this.save();
    return {
      removedCount: 1,
      removedIds: [removed.id],
      remainingCount: rec.warnings.length,
    };
  }

  recordBan(
    guildId,
    userId,
    { reason = "Belirtilmedi", moderatorId = null, moderatorTag = "Bilinmiyor", tag = null, now = Date.now() } = {}
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.counters.ban += 1;

    const entry = {
      id: `B-${rec.counters.ban}`,
      reason: String(reason || "Belirtilmedi").trim().slice(0, 300),
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Bilinmiyor"),
      createdAt: now,
    };

    rec.bans.push(entry);
    if (rec.bans.length > MAX_LIST_ENTRIES) {
      rec.bans.splice(0, rec.bans.length - MAX_LIST_ENTRIES);
    }
    this.save();
    return entry;
  }

  recordUnban(
    guildId,
    userId,
    { reason = "Yasak kaldirildi", moderatorId = null, moderatorTag = "Bilinmiyor", tag = null, now = Date.now() } = {}
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.counters.unban += 1;

    const entry = {
      id: `UB-${rec.counters.unban}`,
      reason: String(reason || "Yasak kaldirildi").trim().slice(0, 300),
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Bilinmiyor"),
      createdAt: now,
    };

    rec.unbans.push(entry);
    if (rec.unbans.length > MAX_LIST_ENTRIES) {
      rec.unbans.splice(0, rec.unbans.length - MAX_LIST_ENTRIES);
    }
    this.save();
    return entry;
  }

  recordKick(
    guildId,
    userId,
    { reason = "Belirtilmedi", moderatorId = null, moderatorTag = "Bilinmiyor", tag = null, now = Date.now() } = {}
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.counters.kick += 1;

    const entry = {
      id: `K-${rec.counters.kick}`,
      reason: String(reason || "Belirtilmedi").trim().slice(0, 300),
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Bilinmiyor"),
      createdAt: now,
    };

    rec.kicks.push(entry);
    if (rec.kicks.length > MAX_LIST_ENTRIES) {
      rec.kicks.splice(0, rec.kicks.length - MAX_LIST_ENTRIES);
    }
    this.save();
    return entry;
  }

  recordTimeout(
    guildId,
    userId,
    {
      reason = "Belirtilmedi",
      durationMs = null,
      until = null,
      moderatorId = null,
      moderatorTag = "Bilinmiyor",
      tag = null,
      now = Date.now(),
    } = {}
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.counters.timeout += 1;

    const entry = {
      id: `T-${rec.counters.timeout}`,
      reason: String(reason || "Belirtilmedi").trim().slice(0, 300),
      durationMs: durationMs ? Number(durationMs) : null,
      until: until ? Number(until) : null,
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Bilinmiyor"),
      createdAt: now,
    };

    rec.timeouts.push(entry);
    if (rec.timeouts.length > MAX_LIST_ENTRIES) {
      rec.timeouts.splice(0, rec.timeouts.length - MAX_LIST_ENTRIES);
    }
    this.save();
    return entry;
  }

  recordBlacklist(
    guildId,
    userId,
    {
      action = "add",
      reason = "Belirtilmedi",
      moderatorId = null,
      moderatorTag = "Defender",
      tag = null,
      now = Date.now(),
    } = {}
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.counters.blacklist += 1;

    const entry = {
      id: `BL-${rec.counters.blacklist}`,
      action: action === "remove" ? "remove" : "add",
      reason: String(reason || "Belirtilmedi").trim().slice(0, 300),
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Defender"),
      createdAt: now,
    };

    rec.blacklists.push(entry);
    if (rec.blacklists.length > MAX_LIST_ENTRIES) {
      rec.blacklists.splice(0, rec.blacklists.length - MAX_LIST_ENTRIES);
    }
    this.save();
    return entry;
  }

  recordAutoMod(guildId, userId, { tag = null, now = Date.now() } = {}) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.autoModCount += 1;
    this.save();
    return rec.autoModCount;
  }

  recordRpActivity(
    guildId,
    userId,
    {
      channelId,
      channelName = "rp-kanali",
      tag = null,
      sessionGapMs = 30 * 60 * 1000,
      now = Date.now(),
    }
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;
    rec.rp.messageCount += 1;
    rec.rp.lastRpAt = now;

    // Find most recent session in this exact channel
    let activeSession = null;
    for (let i = rec.rp.sessions.length - 1; i >= 0; i -= 1) {
      const s = rec.rp.sessions[i];
      if (s.source === "auto" && s.channelId === String(channelId)) {
        if (now - s.lastActivityAt <= sessionGapMs) {
          activeSession = s;
        }
        break;
      }
    }

    if (activeSession) {
      activeSession.lastActivityAt = now;
      activeSession.messages += 1;
      if (channelName) activeSession.channelName = String(channelName);
      this.save();
      return { newSession: false, totalRpCount: rec.rp.count, session: activeSession };
    }

    rec.counters.rp += 1;
    rec.rp.count += 1;
    const session = {
      id: `RP-${rec.counters.rp}`,
      channelId: String(channelId),
      channelName: String(channelName || "rp-kanali"),
      startedAt: now,
      lastActivityAt: now,
      messages: 1,
      source: "auto",
    };

    rec.rp.sessions.push(session);
    if (rec.rp.sessions.length > MAX_RP_SESSIONS) {
      rec.rp.sessions.splice(0, rec.rp.sessions.length - MAX_RP_SESSIONS);
    }
    this.save();
    return { newSession: true, totalRpCount: rec.rp.count, session };
  }

  adjustRpCount(
    guildId,
    userId,
    {
      delta = 1,
      note = "Manuel RP kaydi",
      moderatorId = null,
      moderatorTag = "Yetkili",
      tag = null,
      now = Date.now(),
    } = {}
  ) {
    const rec = this.getUser(guildId, userId);
    if (tag) rec.lastTag = String(tag);
    rec.lastSeenAt = now;

    const amount = Math.trunc(Number(delta) || 0);
    if (amount === 0) {
      return { totalRpCount: rec.rp.count, delta: 0, session: null };
    }

    rec.rp.count = Math.max(0, rec.rp.count + amount);
    if (amount > 0) {
      rec.rp.lastRpAt = now;
    }

    rec.counters.rp += 1;
    const session = {
      id: `RP-${rec.counters.rp}`,
      channelId: null,
      channelName: String(note || "Manuel RP kaydi").trim().slice(0, 100),
      startedAt: now,
      lastActivityAt: now,
      messages: 0,
      delta: amount,
      moderatorId: moderatorId ? String(moderatorId) : null,
      moderatorTag: String(moderatorTag || "Yetkili"),
      source: "manual",
    };

    rec.rp.sessions.push(session);
    if (rec.rp.sessions.length > MAX_RP_SESSIONS) {
      rec.rp.sessions.splice(0, rec.rp.sessions.length - MAX_RP_SESSIONS);
    }
    this.save();
    return { totalRpCount: rec.rp.count, delta: amount, session };
  }
}

module.exports = { UserLogStore, createEmptyUserRecord };
