const { Events } = require("discord.js");
const { DefenderStore } = require("./store");
const { SnapshotManager } = require("./snapshotManager");
const { PunishmentEngine } = require("./punishmentEngine");
const { AntiNukeEngine } = require("./antiNuke");
const { AntiRaidEngine } = require("./antiRaid");
const { ChatDefenseEngine } = require("./chatDefense");

class DefenderEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 15 * 60 * 1000;

    this.store =
      options.store ||
      new DefenderStore({
        persist: options.persist !== false,
        filePath: options.stateFilePath,
      });

    this.snapshotManager =
      options.snapshotManager ||
      new SnapshotManager({
        persist: options.persist !== false,
        snapshotDir: options.snapshotDir,
        logger: this.logger,
      });

    this.punishmentEngine =
      options.punishmentEngine ||
      new PunishmentEngine(this.store, this.snapshotManager, {
        blacklistRoleId: options.blacklistRoleId,
        blacklistRoleName: options.blacklistRoleName || "BLACKLIST",
        ticketPanelChannelId: options.ticketPanelChannelId || null,
        defaultLogChannelName: options.defaultLogChannelName || "defender-log",
        logger: this.logger,
      });

    this.antiNuke = new AntiNukeEngine(
      this.store,
      this.snapshotManager,
      this.punishmentEngine,
      {
        auditLogDelayMs: options.auditLogDelayMs ?? 250,
        logger: this.logger,
      }
    );

    this.antiRaid = new AntiRaidEngine(this.store, this.punishmentEngine, {
      logger: this.logger,
    });

    this.chatDefense = new ChatDefenseEngine(
      this.store,
      this.punishmentEngine,
      {
        warnNoticeMs: options.warnNoticeMs ?? 5000,
      }
    );

    this._snapshotTimer = null;
    this._pruneTimer = null;
  }

  /**
   * Capture initial snapshots for all guilds and start periodic maintenance intervals.
   */
  initializeGuilds(client) {
    let count = 0;
    for (const guild of client.guilds.cache.values()) {
      this.snapshotManager.captureGuild(guild);
      count += 1;
    }

    if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    this._snapshotTimer = setInterval(() => {
      for (const guild of client.guilds.cache.values()) {
        const g = this.store.getGuild(guild.id);
        // Never overwrite snapshot during an active lockdown or raid wave
        if (!g.lockdown.active && !this.antiRaid.isRaidModeActive(guild.id)) {
          this.snapshotManager.captureGuild(guild);
        }
      }
    }, this.snapshotIntervalMs);
    if (typeof this._snapshotTimer.unref === "function") {
      this._snapshotTimer.unref();
    }

    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._pruneTimer = setInterval(() => {
      this.antiNuke.tracker.pruneAll();
      this.antiRaid.tracker.pruneAll();
      this.chatDefense.tracker.pruneAll();
    }, 5 * 60 * 1000);
    if (typeof this._pruneTimer.unref === "function") {
      this._pruneTimer.unref();
    }

    return count;
  }

  /**
   * Attach all Defender security event listeners onto a Discord.js Client.
   */
  attach(client) {
    client.on(Events.GuildCreate, (guild) => {
      this.snapshotManager.captureGuild(guild);
    });

    // --- Anti-Nuke Events ---
    client.on(Events.ChannelDelete, (channel) => {
      this.antiNuke.onChannelDelete(channel).catch((err) => {
        this.logger.error("[DEFENDER/channelDelete]", err.message);
      });
    });

    client.on(Events.ChannelCreate, (channel) => {
      this.antiNuke.onChannelCreate(channel).catch((err) => {
        this.logger.error("[DEFENDER/channelCreate]", err.message);
      });
    });

    client.on(Events.ChannelUpdate, (oldCh, newCh) => {
      this.antiNuke.onChannelUpdate(oldCh, newCh).catch((err) => {
        this.logger.error("[DEFENDER/channelUpdate]", err.message);
      });
    });

    client.on(Events.GuildRoleDelete, (role) => {
      this.antiNuke.onRoleDelete(role).catch((err) => {
        this.logger.error("[DEFENDER/roleDelete]", err.message);
      });
    });

    client.on(Events.GuildRoleCreate, (role) => {
      this.antiNuke.onRoleCreate(role).catch((err) => {
        this.logger.error("[DEFENDER/roleCreate]", err.message);
      });
    });

    client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
      this.antiNuke.onRoleUpdate(oldRole, newRole).catch((err) => {
        this.logger.error("[DEFENDER/roleUpdate]", err.message);
      });
    });

    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      this.antiNuke.onGuildMemberUpdate(oldMember, newMember).catch((err) => {
        this.logger.error("[DEFENDER/memberUpdate]", err.message);
      });
    });

    client.on(Events.GuildBanAdd, (ban) => {
      this.antiNuke.onGuildBanAdd(ban).catch((err) => {
        this.logger.error("[DEFENDER/banAdd]", err.message);
      });
    });

    client.on(Events.GuildMemberRemove, (member) => {
      this.antiNuke.onGuildMemberRemove(member).catch((err) => {
        this.logger.error("[DEFENDER/memberRemove]", err.message);
      });
    });

    client.on(Events.GuildEmojiDelete, (emoji) => {
      this.antiNuke
        .onAssetDelete(emoji.guild, "emoji", emoji.id, emoji.name)
        .catch((err) => {
          this.logger.error("[DEFENDER/emojiDelete]", err.message);
        });
    });

    client.on(Events.GuildStickerDelete, (sticker) => {
      this.antiNuke
        .onAssetDelete(sticker.guild, "sticker", sticker.id, sticker.name)
        .catch((err) => {
          this.logger.error("[DEFENDER/stickerDelete]", err.message);
        });
    });

    client.on(Events.GuildUpdate, (oldGuild, newGuild) => {
      this.antiNuke.onGuildUpdate(oldGuild, newGuild).catch((err) => {
        this.logger.error("[DEFENDER/guildUpdate]", err.message);
      });
    });

    client.on(Events.WebhooksUpdate, (channel) => {
      this.antiNuke.onWebhooksUpdate(channel).catch((err) => {
        this.logger.error("[DEFENDER/webhooksUpdate]", err.message);
      });
    });

    // --- Anti-Bot + Anti-Raid Events ---
    client.on(Events.GuildMemberAdd, (member) => {
      if (member.user?.bot) {
        this.antiNuke.onBotAdd(member).catch((err) => {
          this.logger.error("[DEFENDER/botAdd]", err.message);
        });
      } else {
        this.antiRaid.onGuildMemberAdd(member).catch((err) => {
          this.logger.error("[DEFENDER/memberAdd]", err.message);
        });
      }
    });

    // --- Chat Defense Events ---
    client.on(Events.MessageCreate, (message) => {
      this.chatDefense.onMessageCreate(message).catch((err) => {
        this.logger.error("[DEFENDER/messageCreate]", err.message);
      });
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      // Prevent editing a clean message into a phishing link / invite / token leak
      if (!newMsg || newMsg.partial) return;
      this.chatDefense
        .onMessageCreate(newMsg, { isEdit: true })
        .catch((err) => {
          this.logger.error("[DEFENDER/messageUpdate]", err.message);
        });
    });
  }

  getGuildStatus(guild) {
    const g = this.store.getGuild(guild.id);
    const snap = this.snapshotManager.getSnapshot(guild.id);

    return {
      enabled: g.enabled,
      punishmentMode: g.punishmentMode,
      logChannelId: g.logChannelId,
      blacklistRoleId: g.blacklistRoleId,
      modules: { ...g.modules },
      thresholds: { ...g.thresholds },
      lockdownActive: Boolean(g.lockdown.active),
      raidModeActive: this.antiRaid.isRaidModeActive(guild.id),
      blacklistedCount: Object.keys(g.blacklistedUsers).length,
      whitelistCounts: {
        users: Object.keys(g.whitelist.users).length,
        roles: Object.keys(g.whitelist.roles).length,
        bots: Object.keys(g.whitelist.bots).length,
      },
      snapshot: snap
        ? {
            capturedAt: snap.capturedAt,
            roleCount: Object.keys(snap.roles || {}).length,
            channelCount: Object.keys(snap.channels || {}).length,
          }
        : null,
      incidentCount: g.incidentCounter,
      recentIncidents: g.incidents.slice(-5).reverse(),
    };
  }

  shutdown() {
    if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._snapshotTimer = null;
    this._pruneTimer = null;
  }
}

module.exports = { DefenderEngine };
