const fs = require("fs");
const path = require("path");
const { createDefaultGuildSettings } = require("./constants");

const DEFAULT_STATE_FILE = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "defender-state.json"
);

const MAX_INCIDENTS_PER_GUILD = 100;

function mergeDefaults(target, defaults) {
  const result = { ...defaults, ...(target || {}) };
  result.modules = { ...defaults.modules, ...(target?.modules || {}) };
  result.thresholds = { ...defaults.thresholds, ...(target?.thresholds || {}) };
  result.whitelist = {
    users: { ...(target?.whitelist?.users || {}) },
    roles: { ...(target?.whitelist?.roles || {}) },
    bots: { ...(target?.whitelist?.bots || {}) },
  };
  result.quarantinedUsers = { ...(target?.quarantinedUsers || {}) };
  result.lockdown = {
    ...defaults.lockdown,
    ...(target?.lockdown || {}),
    savedOverwrites: { ...(target?.lockdown?.savedOverwrites || {}) },
  };
  result.incidents = Array.isArray(target?.incidents)
    ? target.incidents.slice(-MAX_INCIDENTS_PER_GUILD)
    : [];
  result.incidentCounter = Number(target?.incidentCounter) || 0;
  return result;
}

class DefenderStore {
  /**
   * @param {object} options
   * @param {string} [options.filePath] Path to JSON state file
   * @param {boolean} [options.persist=true] Set false for pure in-memory tests
   */
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_STATE_FILE;
    this.persist = options.persist !== false;
    /** @type {Record<string, ReturnType<typeof createDefaultGuildSettings>>} */
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
        for (const [guildId, data] of Object.entries(parsed.guilds)) {
          this.guilds[guildId] = mergeDefaults(
            data,
            createDefaultGuildSettings()
          );
        }
      }
    } catch (err) {
      console.error("[DEFENDER STORE] Durum dosyasi yuklenemedi:", err.message);
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
      console.error("[DEFENDER STORE] Durum dosyasi kaydedilemedi:", err.message);
    }
  }

  getGuild(guildId) {
    if (!this.guilds[guildId]) {
      this.guilds[guildId] = createDefaultGuildSettings();
      this.save();
    }
    return this.guilds[guildId];
  }

  setModuleEnabled(guildId, moduleKey, enabled) {
    const g = this.getGuild(guildId);
    if (!(moduleKey in g.modules)) return false;
    g.modules[moduleKey] = Boolean(enabled);
    this.save();
    return true;
  }

  setPunishmentMode(guildId, mode) {
    const g = this.getGuild(guildId);
    g.punishmentMode = mode;
    this.save();
  }

  setLogChannel(guildId, channelId) {
    const g = this.getGuild(guildId);
    g.logChannelId = channelId;
    this.save();
  }

  setQuarantineRole(guildId, roleId) {
    const g = this.getGuild(guildId);
    g.quarantineRoleId = roleId;
    this.save();
  }

  setThreshold(guildId, key, value) {
    const g = this.getGuild(guildId);
    if (!(key in g.thresholds)) return false;
    g.thresholds[key] = value;
    this.save();
    return true;
  }

  addWhitelist(guildId, category, targetId, scopes = ["all"], addedBy = null) {
    const g = this.getGuild(guildId);
    if (!g.whitelist[category]) return false;
    const cleanScopes =
      Array.isArray(scopes) && scopes.length > 0 ? [...new Set(scopes)] : ["all"];
    g.whitelist[category][targetId] = {
      scopes: cleanScopes,
      addedBy,
      addedAt: Date.now(),
    };
    this.save();
    return true;
  }

  removeWhitelist(guildId, category, targetId) {
    const g = this.getGuild(guildId);
    if (!g.whitelist[category] || !g.whitelist[category][targetId]) {
      return false;
    }
    delete g.whitelist[category][targetId];
    this.save();
    return true;
  }

  /**
   * Check whether a user/member/bot is whitelisted for a given Defender scope.
   * Server owner and the Defender bot itself are ALWAYS immune.
   */
  isWhitelisted(guild, userIdOrMember, scope = "all") {
    if (!guild || !userIdOrMember) return false;

    const userId =
      typeof userIdOrMember === "string" ? userIdOrMember : userIdOrMember.id;
    if (!userId) return false;

    // Server Owner is always immune
    if (guild.ownerId && userId === guild.ownerId) return true;

    // Defender bot itself is always immune
    const botId = guild.members?.me?.id || guild.client?.user?.id;
    if (botId && userId === botId) return true;

    const g = this.getGuild(guild.id);
    const hasScope = (entry) =>
      Boolean(
        entry &&
          Array.isArray(entry.scopes) &&
          (entry.scopes.includes("all") || entry.scopes.includes(scope))
      );

    if (hasScope(g.whitelist.users[userId])) return true;
    if (hasScope(g.whitelist.bots[userId])) return true;

    // Resolve member roles if available
    const member =
      typeof userIdOrMember === "object" && userIdOrMember.roles
        ? userIdOrMember
        : guild.members?.cache?.get(userId);

    if (member?.roles?.cache) {
      for (const roleId of member.roles.cache.keys()) {
        if (hasScope(g.whitelist.roles[roleId])) return true;
      }
    } else if (Array.isArray(member?.roles)) {
      for (const roleId of member.roles) {
        if (hasScope(g.whitelist.roles[roleId])) return true;
      }
    }

    return false;
  }

  saveQuarantinedUser(guildId, userId, record) {
    const g = this.getGuild(guildId);
    g.quarantinedUsers[userId] = {
      previousRoles: record.previousRoles || [],
      reason: record.reason || "Defender korumasi",
      actor: record.actor || "Defender",
      quarantinedAt: Date.now(),
    };
    this.save();
  }

  popQuarantinedUser(guildId, userId) {
    const g = this.getGuild(guildId);
    const rec = g.quarantinedUsers[userId] || null;
    if (rec) {
      delete g.quarantinedUsers[userId];
      this.save();
    }
    return rec;
  }

  recordIncident(guildId, incident) {
    const g = this.getGuild(guildId);
    g.incidentCounter += 1;
    const entry = {
      id: `INC-${g.incidentCounter}`,
      ts: Date.now(),
      module: incident.module || "DEFENDER",
      severity: incident.severity || "HIGH",
      action: incident.action || "DETECTED",
      executorId: incident.executorId || null,
      target: incident.target || null,
      details: incident.details || "",
      punishment: incident.punishment || null,
      restored: incident.restored || null,
    };
    g.incidents.push(entry);
    if (g.incidents.length > MAX_INCIDENTS_PER_GUILD) {
      g.incidents.splice(0, g.incidents.length - MAX_INCIDENTS_PER_GUILD);
    }
    this.save();
    return entry;
  }
}

module.exports = { DefenderStore };
