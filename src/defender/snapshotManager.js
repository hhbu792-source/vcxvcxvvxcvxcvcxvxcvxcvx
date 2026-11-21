const fs = require("fs");
const path = require("path");
const { ChannelType } = require("discord.js");

const SNAPSHOT_DIR = path.join(__dirname, "..", "..", "data", "snapshots");

function serializeOverwrites(channel) {
  const list = [];
  const cache = channel.permissionOverwrites?.cache;
  if (!cache) return list;

  for (const ow of cache.values()) {
    list.push({
      id: ow.id,
      type: ow.type,
      allow: ow.allow?.bitfield ? ow.allow.bitfield.toString() : "0",
      deny: ow.deny?.bitfield ? ow.deny.bitfield.toString() : "0",
    });
  }
  return list;
}

class SnapshotManager {
  /**
   * @param {object} options
   * @param {boolean} [options.persist=true]
   * @param {object} [options.logger=console]
   */
  constructor(options = {}) {
    this.persist = options.persist !== false;
    this.snapshotDir = options.snapshotDir || SNAPSHOT_DIR;
    this.logger = options.logger || console;

    /** @type {Map<string, object>} guildId -> snapshot */
    this.snapshots = new Map();

    /**
     * Tracks IDs recently modified/created by Defender itself to avoid self-trigger loops.
     * Map<key, expiresAt>
     */
    this.selfActions = new Map();
  }

  markSelfAction(key, ttlMs = 8000) {
    this.selfActions.set(key, Date.now() + ttlMs);
  }

  isSelfAction(key) {
    const exp = this.selfActions.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.selfActions.delete(key);
      return false;
    }
    return true;
  }

  captureGuild(guild) {
    if (!guild) return null;

    const roles = {};
    if (guild.roles?.cache) {
      for (const role of guild.roles.cache.values()) {
        roles[role.id] = {
          id: role.id,
          name: role.name,
          color: role.color,
          hoist: Boolean(role.hoist),
          mentionable: Boolean(role.mentionable),
          permissions: role.permissions?.bitfield
            ? role.permissions.bitfield.toString()
            : "0",
          position: role.rawPosition ?? role.position ?? 0,
          managed: Boolean(role.managed),
        };
      }
    }

    const channels = {};
    if (guild.channels?.cache) {
      for (const ch of guild.channels.cache.values()) {
        channels[ch.id] = {
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parentId: ch.parentId || null,
          parentName: ch.parent?.name || null,
          topic: ch.topic || null,
          position: ch.rawPosition ?? ch.position ?? 0,
          rateLimitPerUser: ch.rateLimitPerUser || 0,
          nsfw: Boolean(ch.nsfw),
          bitrate: ch.bitrate || null,
          userLimit: ch.userLimit || null,
          permissionOverwrites: serializeOverwrites(ch),
        };
      }
    }

    const snapshot = {
      guildId: guild.id,
      capturedAt: Date.now(),
      settings: {
        name: guild.name,
        verificationLevel: guild.verificationLevel ?? null,
        explicitContentFilter: guild.explicitContentFilter ?? null,
      },
      roles,
      channels,
    };

    this.snapshots.set(guild.id, snapshot);

    if (this.persist) {
      try {
        fs.mkdirSync(this.snapshotDir, { recursive: true });
        const target = path.join(this.snapshotDir, `${guild.id}.json`);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
        fs.renameSync(tmp, target);
      } catch (err) {
        this.logger.warn(
          `[SNAPSHOT] ${guild.id} yedegi diske yazilamadi:`,
          err.message
        );
      }
    }

    return snapshot;
  }

  getSnapshot(guildId) {
    if (this.snapshots.has(guildId)) {
      return this.snapshots.get(guildId);
    }
    if (this.persist) {
      try {
        const target = path.join(this.snapshotDir, `${guildId}.json`);
        if (fs.existsSync(target)) {
          const parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
          this.snapshots.set(guildId, parsed);
          return parsed;
        }
      } catch {
        // Ignore corrupted snapshot
      }
    }
    return null;
  }

  async restoreDeletedChannel(guild, deletedChannel) {
    const snap = this.getSnapshot(guild.id);
    const saved = snap?.channels?.[deletedChannel.id] || null;

    const name = saved?.name || deletedChannel.name || "geri-yuklenen-kanal";
    const type = saved?.type ?? deletedChannel.type ?? ChannelType.GuildText;

    // Resolve parent category (check if still exists by ID, else by saved name)
    let parentId = saved?.parentId || deletedChannel.parentId || null;
    if (parentId && !guild.channels.cache.has(parentId)) {
      if (saved?.parentName) {
        const byName = guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name === saved.parentName
        );
        parentId = byName ? byName.id : null;
      } else {
        parentId = null;
      }
    }

    // Filter permission overwrites so deleted/non-existent roles don't fail creation
    const rawOverwrites =
      saved?.permissionOverwrites || serializeOverwrites(deletedChannel);
    const validOverwrites = rawOverwrites
      .filter((ow) => {
        if (ow.type === 0) {
          return guild.roles?.cache?.has(ow.id) || ow.id === guild.roles?.everyone?.id;
        }
        return true;
      })
      .map((ow) => ({
        id: ow.id,
        type: ow.type,
        allow: BigInt(ow.allow || "0"),
        deny: BigInt(ow.deny || "0"),
      }));

    const createPayload = {
      name,
      type,
      reason: "Defender Anti-Nuke: Silinen kanal otomatik geri yuklendi",
    };

    if (parentId && type !== ChannelType.GuildCategory) {
      createPayload.parent = parentId;
    }
    if (validOverwrites.length > 0) {
      createPayload.permissionOverwrites = validOverwrites;
    }
    if (saved?.topic || deletedChannel.topic) {
      createPayload.topic = saved?.topic || deletedChannel.topic;
    }
    if (typeof (saved?.rateLimitPerUser ?? deletedChannel.rateLimitPerUser) === "number") {
      createPayload.rateLimitPerUser =
        saved?.rateLimitPerUser ?? deletedChannel.rateLimitPerUser;
    }
    if (typeof (saved?.nsfw ?? deletedChannel.nsfw) === "boolean") {
      createPayload.nsfw = saved?.nsfw ?? deletedChannel.nsfw;
    }
    if (
      type === ChannelType.GuildVoice ||
      type === ChannelType.GuildStageVoice
    ) {
      if (saved?.bitrate || deletedChannel.bitrate) {
        createPayload.bitrate = saved?.bitrate || deletedChannel.bitrate;
      }
      if (typeof (saved?.userLimit ?? deletedChannel.userLimit) === "number") {
        createPayload.userLimit = saved?.userLimit ?? deletedChannel.userLimit;
      }
    }

    this.markSelfAction(`channelCreate:${guild.id}:${name}`, 10_000);

    try {
      const recreated = await guild.channels.create(createPayload);
      this.markSelfAction(`channel:${recreated.id}`, 10_000);
      if (
        typeof (saved?.position ?? deletedChannel.rawPosition) === "number" &&
        typeof recreated.setPosition === "function"
      ) {
        await recreated
          .setPosition(saved?.position ?? deletedChannel.rawPosition)
          .catch(() => {});
      }
      // Update snapshot index with new channel ID
      if (snap) {
        delete snap.channels[deletedChannel.id];
        snap.channels[recreated.id] = {
          ...(saved || {}),
          id: recreated.id,
          name: recreated.name,
          type: recreated.type,
          parentId: recreated.parentId || parentId,
          permissionOverwrites: rawOverwrites,
        };
      }
      return recreated;
    } catch (err) {
      this.logger.warn(
        `[AUTO-RESTORE] Kanal geri yuklenemedi (${name}):`,
        err.message
      );
      return null;
    }
  }

  async restoreDeletedRole(guild, deletedRole) {
    if (deletedRole.managed) return null;

    const snap = this.getSnapshot(guild.id);
    const saved = snap?.roles?.[deletedRole.id] || null;
    const name = saved?.name || deletedRole.name || "geri-yuklenen-rol";

    const perms = saved?.permissions
      ? BigInt(saved.permissions)
      : deletedRole.permissions?.bitfield ?? 0n;

    this.markSelfAction(`roleCreate:${guild.id}:${name}`, 10_000);

    try {
      const recreated = await guild.roles.create({
        name,
        color: saved?.color ?? deletedRole.color ?? 0,
        hoist: saved?.hoist ?? Boolean(deletedRole.hoist),
        mentionable: saved?.mentionable ?? Boolean(deletedRole.mentionable),
        permissions: perms,
        reason: "Defender Anti-Nuke: Silinen rol otomatik geri yuklendi",
      });
      this.markSelfAction(`role:${recreated.id}`, 10_000);

      if (snap) {
        delete snap.roles[deletedRole.id];
        snap.roles[recreated.id] = {
          ...(saved || {}),
          id: recreated.id,
          name: recreated.name,
          permissions: perms.toString(),
        };
      }
      return recreated;
    } catch (err) {
      this.logger.warn(
        `[AUTO-RESTORE] Rol geri yuklenemedi (${name}):`,
        err.message
      );
      return null;
    }
  }

  async revertRolePermissions(guild, role, oldRole) {
    const snap = this.getSnapshot(guild.id);
    const saved = snap?.roles?.[role.id] || null;
    const targetPerms =
      oldRole?.permissions?.bitfield !== undefined
        ? oldRole.permissions.bitfield
        : saved?.permissions
          ? BigInt(saved.permissions)
          : 0n;

    this.markSelfAction(`roleUpdate:${role.id}`, 10_000);
    try {
      await role.setPermissions(
        targetPerms,
        "Defender Anti-Nuke: Yetkisiz izin yukseltmesi geri alindi"
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `[AUTO-RESTORE] Rol izinleri geri alinamadi (${role.name}):`,
        err.message
      );
      return false;
    }
  }

  async revertGuildSettings(guild, oldGuild) {
    const snap = this.getSnapshot(guild.id);
    const prevName = oldGuild?.name || snap?.settings?.name;
    const prevVerif =
      oldGuild?.verificationLevel ?? snap?.settings?.verificationLevel;

    const patch = {};
    if (prevName && guild.name !== prevName) {
      patch.name = prevName;
    }
    if (
      prevVerif !== null &&
      prevVerif !== undefined &&
      guild.verificationLevel !== prevVerif
    ) {
      patch.verificationLevel = prevVerif;
    }

    if (Object.keys(patch).length === 0) return false;

    this.markSelfAction(`guildUpdate:${guild.id}`, 10_000);
    try {
      await guild.edit({
        ...patch,
        reason: "Defender Anti-Nuke: Yetkisiz sunucu ayari degisikligi geri alindi",
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `[AUTO-RESTORE] Sunucu ayarlari geri alinamadi:`,
        err.message
      );
      return false;
    }
  }
}

module.exports = { SnapshotManager };
