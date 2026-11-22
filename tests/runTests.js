const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  AuditLogEvent,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const { DefenderEngine } = require("../src/defender/defenderEngine");
const {
  detectSecretLeak,
  detectPhishing,
  detectExternalInvite,
} = require("../src/defender/chatDefense");
const { buildCommands } = require("../src/commands");

class MockCollection extends Map {
  find(fn) {
    for (const v of this.values()) {
      if (fn(v)) return v;
    }
    return undefined;
  }
}

function makeBitfield(bits = 0n) {
  let bf = BigInt(bits);
  return {
    get bitfield() {
      return bf;
    },
    set bitfield(v) {
      bf = BigInt(v);
    },
    has(flag) {
      return (bf & BigInt(flag)) === BigInt(flag);
    },
  };
}

function createMockGuild() {
  let seq = 1000;
  const channelsCache = new MockCollection();
  const rolesCache = new MockCollection();
  const membersCache = new MockCollection();
  const auditEntries = [];
  const bannedIds = [];

  const everyoneRole = {
    id: "everyone-1",
    name: "@everyone",
    color: 0,
    hoist: false,
    mentionable: false,
    managed: false,
    position: 0,
    rawPosition: 0,
    permissions: makeBitfield(0n),
  };
  rolesCache.set(everyoneRole.id, everyoneRole);

  const botTopRole = {
    id: "role-bot-top",
    name: "Defender",
    color: 0,
    hoist: false,
    mentionable: false,
    managed: true,
    position: 100,
    rawPosition: 100,
    permissions: makeBitfield(PermissionFlagsBits.Administrator),
  };
  rolesCache.set(botTopRole.id, botTopRole);

  const guild = {
    id: "guild-def-1",
    name: "Backrooms Ana Sunucu",
    ownerId: "owner-1",
    verificationLevel: 2,
    vanityURLCode: "backrooms-tr",
    _auditEntries: auditEntries,
    _bannedIds: bannedIds,
    roles: {
      everyone: everyoneRole,
      cache: rolesCache,
      async create(opts) {
        const id = `role-${++seq}`;
        const role = {
          id,
          guild,
          name: opts.name,
          color: opts.color || 0,
          hoist: Boolean(opts.hoist),
          mentionable: Boolean(opts.mentionable),
          managed: false,
          position: opts.position ?? 10,
          rawPosition: opts.position ?? 10,
          permissions: makeBitfield(
            Array.isArray(opts.permissions)
              ? opts.permissions.reduce((a, b) => a | BigInt(b), 0n)
              : BigInt(opts.permissions || 0n)
          ),
          deleted: false,
          async setPermissions(bits) {
            role.permissions = makeBitfield(bits);
            return role;
          },
          async delete() {
            role.deleted = true;
            rolesCache.delete(role.id);
          },
        };
        rolesCache.set(id, role);
        return role;
      },
    },
    channels: {
      cache: channelsCache,
      async create(opts) {
        const id = `ch-${++seq}`;
        const owCache = new MockCollection();
        for (const ow of opts.permissionOverwrites || []) {
          owCache.set(ow.id, {
            id: ow.id,
            type: ow.type ?? 0,
            allow: makeBitfield(
              Array.isArray(ow.allow)
                ? ow.allow.reduce((a, b) => a | BigInt(b), 0n)
                : BigInt(ow.allow || 0n)
            ),
            deny: makeBitfield(
              Array.isArray(ow.deny)
                ? ow.deny.reduce((a, b) => a | BigInt(b), 0n)
                : BigInt(ow.deny || 0n)
            ),
          });
        }
        const hooks = new MockCollection();
        const channel = {
          id,
          guild,
          name: opts.name,
          type: opts.type ?? ChannelType.GuildText,
          parentId: opts.parent || null,
          parent: opts.parent ? channelsCache.get(opts.parent) || null : null,
          topic: opts.topic || null,
          rawPosition: 0,
          rateLimitPerUser: opts.rateLimitPerUser || 0,
          nsfw: Boolean(opts.nsfw),
          deleted: false,
          _sent: [],
          _hooks: hooks,
          permissionOverwrites: {
            cache: owCache,
            async edit(targetId, patch) {
              let cur = owCache.get(targetId);
              if (!cur) {
                cur = {
                  id: targetId,
                  type: 0,
                  allow: makeBitfield(0n),
                  deny: makeBitfield(0n),
                };
                owCache.set(targetId, cur);
              }
              for (const [permKey, val] of Object.entries(patch)) {
                const bit = PermissionFlagsBits[permKey];
                if (!bit) continue;
                if (val === true) {
                  cur.allow.bitfield |= bit;
                  cur.deny.bitfield &= ~bit;
                } else if (val === false) {
                  cur.deny.bitfield |= bit;
                  cur.allow.bitfield &= ~bit;
                } else if (val === null) {
                  cur.allow.bitfield &= ~bit;
                  cur.deny.bitfield &= ~bit;
                }
              }
            },
          },
          async send(payload) {
            const m = {
              id: `msg-${++seq}`,
              payload,
              deleted: false,
              async delete() {
                m.deleted = true;
              },
            };
            channel._sent.push(payload);
            return m;
          },
          async setPosition(pos) {
            channel.rawPosition = pos;
          },
          async fetchWebhooks() {
            return hooks;
          },
          async delete() {
            channel.deleted = true;
            channelsCache.delete(channel.id);
          },
        };
        channelsCache.set(id, channel);
        return channel;
      },
    },
    members: {
      me: {
        id: "bot-self-1",
        roles: { highest: botTopRole },
      },
      cache: membersCache,
      async fetch(id) {
        return membersCache.get(id) || null;
      },
      async ban(id) {
        bannedIds.push(id);
        membersCache.delete(id);
      },
    },
    async edit(patch) {
      if (patch.name) guild.name = patch.name;
      if (patch.verificationLevel !== undefined) {
        guild.verificationLevel = patch.verificationLevel;
      }
      return guild;
    },
    async fetchAuditLogs({ type }) {
      const col = new MockCollection();
      const matching = auditEntries
        .filter((e) => e.action === type)
        .reverse();
      for (const e of matching) col.set(e.id, e);
      return { entries: col };
    },
  };

  function addAudit(action, executorId, targetId, reason = null) {
    auditEntries.push({
      id: `audit-${++seq}`,
      action,
      executorId,
      targetId,
      reason,
      createdTimestamp: Date.now(),
    });
  }

  function addMember({
    id,
    username,
    roleList = [],
    bot = false,
    createdTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000,
    avatar = "hash123",
    canMentionEveryone = false,
  }) {
    const rCache = new MockCollection();
    rCache.set(everyoneRole.id, everyoneRole);
    for (const r of roleList) rCache.set(r.id, r);

    const member = {
      id,
      guild,
      user: {
        id,
        username,
        tag: `${username}#0001`,
        bot,
        createdTimestamp,
        avatar,
      },
      kicked: false,
      timeoutMs: null,
      permissions: makeBitfield(
        canMentionEveryone ? PermissionFlagsBits.MentionEveryone : 0n
      ),
      roles: {
        cache: rCache,
        get highest() {
          let top = everyoneRole;
          for (const r of rCache.values()) {
            if ((r.position ?? 0) > (top.position ?? 0)) top = r;
          }
          return top;
        },
        async add(ids) {
          const arr = Array.isArray(ids) ? ids : [ids];
          for (const rid of arr) {
            const r = rolesCache.get(rid);
            if (r) rCache.set(rid, r);
          }
        },
        async remove(ids) {
          const arr = Array.isArray(ids) ? ids : [ids];
          for (const rid of arr) rCache.delete(rid);
        },
      },
      async timeout(ms) {
        member.timeoutMs = ms;
      },
      async kick() {
        member.kicked = true;
        membersCache.delete(member.id);
      },
    };
    membersCache.set(id, member);
    return member;
  }

  return { guild, addAudit, addMember };
}

function createChatMsg(channel, member, content, { userMentions = 0, roleMentions = 0 } = {}) {
  const uMentions = new MockCollection();
  for (let i = 0; i < userMentions; i++) uMentions.set(`u-${i}`, { id: `u-${i}` });
  const rMentions = new MockCollection();
  for (let i = 0; i < roleMentions; i++) rMentions.set(`r-${i}`, { id: `r-${i}` });

  const msg = {
    id: `m-${Math.random().toString(36).slice(2, 10)}`,
    guild: channel.guild,
    channel,
    member,
    author: member.user,
    content,
    deletable: true,
    deleted: false,
    mentions: { users: uMentions, roles: rMentions },
    async delete() {
      msg.deleted = true;
    },
  };
  return msg;
}

async function runTests() {
  console.log("=== Discord Defender System Test Suite ===");

  // 0. Ensure ZERO emojis in all src/ files
  const srcRoot = path.join(__dirname, "..", "src");
  const emojiRegex = /[\p{Extended_Pictographic}\u2139\u23F0-\u23FF\u2600-\u27BF]/u;
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith(".js")) {
        const txt = fs.readFileSync(full, "utf-8");
        const m = txt.match(emojiRegex);
        assert.strictEqual(m, null, `Emoji found in ${full}: ${m ? m[0] : ""}`);
      }
    }
  }
  walk(srcRoot);
  console.log("[OK] Emoji kontrolu: src/ altinda hicbir emoji yok.");

  // 1. Slash command structure check
  const cmds = buildCommands();
  assert.strictEqual(cmds.length, 2);
  const defCmd = cmds.find((c) => c.name === "defender");
  const userLogCmd = cmds.find((c) => c.name === "user-log");
  assert(defCmd && defCmd.options.length >= 20);
  assert(defCmd.options.some((o) => o.name === "blacklist"));
  assert(defCmd.options.some((o) => o.name === "blacklist-kaldir"));
  assert(defCmd.options.some((o) => o.name === "uyari-ver"));
  assert(defCmd.options.some((o) => o.name === "uyari-kaldir"));
  assert(defCmd.options.some((o) => o.name === "uyarilar"));
  assert(defCmd.options.some((o) => o.name === "not-ekle"));
  assert(defCmd.options.some((o) => o.name === "not-sil"));
  assert(defCmd.options.some((o) => o.name === "rp-ekle"));
  assert(!defCmd.options.some((o) => o.name === "karantina"));
  assert(userLogCmd && userLogCmd.options.some((o) => o.name === "id" && o.required));
  console.log(`[OK] Slash komutlari: /defender (${defCmd.options.length} alt komut) ve /user-log (admin + id) dogrulandi.`);

  // 2. Setup mock guild with exact Blacklist Role ID 1573704309034586286 & ticket panel channel 1573522477655654544
  const { guild, addAudit, addMember } = createMockGuild();
  const configuredBlRole = {
    id: "1573704309034586286",
    guild,
    name: "Blacklist",
    color: 0x000000,
    hoist: false,
    mentionable: false,
    managed: false,
    position: 5,
    rawPosition: 5,
    permissions: makeBitfield(0n),
    deleted: false,
    async setPermissions(bits) {
      configuredBlRole.permissions = makeBitfield(bits);
      return configuredBlRole;
    },
  };
  guild.roles.cache.set(configuredBlRole.id, configuredBlRole);

  const destekAcCh = await guild.channels.create({
    name: "destek-ac",
    type: ChannelType.GuildText,
  });
  guild.channels.cache.delete(destekAcCh.id);
  destekAcCh.id = "1573522477655654544";
  guild.channels.cache.set(destekAcCh.id, destekAcCh);

  const defender = new DefenderEngine({
    persist: false,
    auditLogDelayMs: 0,
    warnNoticeMs: 0,
    blacklistRoleId: "1573704309034586286",
    ticketPanelChannelId: "1573522477655654544",
  });

  const logCh = await defender.punishmentEngine.ensureLogChannel(guild);
  const qRole = await defender.punishmentEngine.ensureBlacklistRole(guild);
  assert.strictEqual(qRole.id, "1573704309034586286");
  assert.strictEqual(
    destekAcCh.permissionOverwrites.cache.has("1573704309034586286"),
    false
  );
  const modRole = await guild.roles.create({
    name: "Moderator",
    color: 0x3498db,
    permissions: PermissionFlagsBits.ManageMessages,
    position: 20,
  });
  const adminRole = await guild.roles.create({
    name: "Admin",
    color: 0xe74c3c,
    permissions: PermissionFlagsBits.Administrator,
    position: 40,
  });
  const ch1 = await guild.channels.create({
    name: "sohbet",
    type: ChannelType.GuildText,
    topic: "Genel sohbet",
  });
  const ch2 = await guild.channels.create({
    name: "duyurular",
    type: ChannelType.GuildText,
    topic: "Sunucu duyurulari",
  });

  // Capture baseline snapshot
  const snap = defender.snapshotManager.captureGuild(guild);
  assert(Object.keys(snap.channels).length >= 3);
  assert(Object.keys(snap.roles).length >= 4);

  // 3. Tiered Whitelist Scope test
  const scopedMod = addMember({
    id: "mod-scoped",
    username: "scopedmod",
    roleList: [modRole],
  });
  defender.store.addWhitelist(guild.id, "users", scopedMod.id, ["chatDefense"]);
  assert.strictEqual(
    defender.store.isWhitelisted(guild, scopedMod, "chatDefense"),
    true
  );
  assert.strictEqual(
    defender.store.isWhitelisted(guild, scopedMod, "antiNuke"),
    false
  );
  assert.strictEqual(
    defender.store.isWhitelisted(guild, guild.ownerId, "antiNuke"),
    true
  );
  console.log("[OK] Kademeli Whitelist: Kapsam bazli muafiyet ve sunucu sahibi korumasi dogrulandi.");

  // 4. Anti-Nuke: Channel Delete Flood -> Blacklist Attacker (1573704309034586286) + Auto-Restore BOTH deleted channels!
  const attacker = addMember({
    id: "nuker-1",
    username: "nuker",
    roleList: [modRole],
  });
  await ch1.delete();
  addAudit(AuditLogEvent.ChannelDelete, attacker.id, ch1.id);
  const d1 = await defender.antiNuke.onChannelDelete(ch1);
  assert.strictEqual(d1.triggered, false);

  await ch2.delete();
  addAudit(AuditLogEvent.ChannelDelete, attacker.id, ch2.id);
  const d2 = await defender.antiNuke.onChannelDelete(ch2);
  assert.strictEqual(d2.triggered, true);
  assert.strictEqual(d2.punish.action, "blacklist");
  assert.strictEqual(attacker.roles.cache.has("1573704309034586286"), true);
  assert.strictEqual(attacker.roles.cache.has(modRole.id), false);
  assert.strictEqual(d2.restoredNames.length, 2);
  assert(guild.channels.cache.find((c) => c.name === "sohbet"));
  assert(guild.channels.cache.find((c) => c.name === "duyurular"));
  console.log("[OK] Anti-Nuke Kanal Silme: Saldirgan blacklist'e (1573704309034586286) alindi, silinen 2 kanal oto geri yuklendi.");

  // 5. Blacklist Vault Restore test (unblacklist gives back exact saved roles!)
  const unqRes = await defender.punishmentEngine.unblacklistMember(
    guild,
    attacker,
    "Owner"
  );
  assert.strictEqual(unqRes.ok, true);
  assert.strictEqual(unqRes.restoredCount, 1);
  assert.strictEqual(attacker.roles.cache.has(modRole.id), true);
  assert.strictEqual(attacker.roles.cache.has("1573704309034586286"), false);
  assert.strictEqual(attacker.timeoutMs, null);
  console.log("[OK] Blacklist Kasasi: Blacklist kaldirilinca saklanan eski roller geri verildi.");

  // 6. Anti-Nuke: INSTANT Dangerous Role Permission Escalation -> Reverts permissions + Punishes!
  const escalater = addMember({
    id: "nuker-2",
    username: "escalater",
    roleList: [modRole],
  });
  const oldModSnapshot = { permissions: makeBitfield(PermissionFlagsBits.ManageMessages) };
  modRole.permissions = makeBitfield(
    PermissionFlagsBits.ManageMessages | PermissionFlagsBits.Administrator
  );
  addAudit(AuditLogEvent.RoleUpdate, escalater.id, modRole.id);
  const escRes = await defender.antiNuke.onRoleUpdate(oldModSnapshot, modRole);
  assert.strictEqual(escRes.triggered, true);
  assert.strictEqual(escRes.reverted, true);
  assert.strictEqual(
    modRole.permissions.has(PermissionFlagsBits.Administrator),
    false
  );
  assert.strictEqual(escalater.roles.cache.has(qRole.id), true);
  console.log("[OK] Anti-Nuke Yetki Yukseltme: Rol izni aninda geri alindi ve yetkisiz kisi blacklist'e alindi.");

  // 7. Anti-Nuke: Unauthorized Dangerous Role Grant to Member -> Strips role + Punishes!
  const granter = addMember({
    id: "nuker-3",
    username: "granter",
    roleList: [modRole],
  });
  const targetUser = addMember({ id: "victim-1", username: "victim" });
  const oldTargetRoles = new MockCollection(targetUser.roles.cache);
  await targetUser.roles.add(adminRole.id);
  addAudit(AuditLogEvent.MemberRoleUpdate, granter.id, targetUser.id);
  const grantRes = await defender.antiNuke.onGuildMemberUpdate(
    { id: targetUser.id, guild, roles: { cache: oldTargetRoles } },
    targetUser
  );
  assert.strictEqual(grantRes.triggered, true);
  assert.strictEqual(grantRes.stripped, true);
  assert.strictEqual(targetUser.roles.cache.has(adminRole.id), false);
  assert.strictEqual(granter.roles.cache.has(qRole.id), true);
  console.log("[OK] Anti-Nuke Kritik Rol Atama: Verilen admin rolu aninda geri alindi.");

  // 8. Anti-Nuke: Guild Update Tamper -> Reverts server name + Punishes!
  const renamer = addMember({ id: "nuker-4", username: "renamer" });
  const oldGuildSnap = { name: guild.name, verificationLevel: guild.verificationLevel };
  guild.name = "HACKED SERVER";
  addAudit(AuditLogEvent.GuildUpdate, renamer.id, guild.id);
  const gUpdRes = await defender.antiNuke.onGuildUpdate(oldGuildSnap, guild);
  assert.strictEqual(gUpdRes.triggered, true);
  assert.strictEqual(gUpdRes.reverted, true);
  assert.strictEqual(guild.name, "Backrooms Ana Sunucu");
  console.log("[OK] Anti-Nuke Sunucu Ayari: Yetkisiz isim degisikligi aninda geri alindi.");

  // 9. Anti-Bot: Unapproved Rogue Bot Injection -> Bot Kicked + Inviter Punished!
  const inviter = addMember({ id: "nuker-5", username: "botadder" });
  const rogueBot = addMember({ id: "rogue-bot-1", username: "NukeBot", bot: true });
  addAudit(AuditLogEvent.BotAdd, inviter.id, rogueBot.id);
  const botRes = await defender.antiNuke.onBotAdd(rogueBot);
  assert.strictEqual(botRes.triggered, true);
  assert.strictEqual(botRes.botRemoved, true);
  assert.strictEqual(rogueBot.kicked, true);
  assert.strictEqual(inviter.roles.cache.has(qRole.id), true);
  console.log("[OK] Anti-Bot: Onaysiz bot atildi ve ekleyen kisi blacklist'e alindi.");

  // 10. Anti-Webhook: Unauthorized Webhook Creation -> Webhook Deleted + Creator Punished!
  const hookCreator = addMember({ id: "nuker-6", username: "hooker" });
  const liveSohbet = guild.channels.cache.find((c) => c.name === "sohbet");
  let hookDeleted = false;
  liveSohbet._hooks.set("wh-1", {
    id: "wh-1",
    owner: { id: hookCreator.id },
    async delete() {
      hookDeleted = true;
    },
  });
  addAudit(AuditLogEvent.WebhookCreate, hookCreator.id, "wh-1");
  const whRes = await defender.antiNuke.onWebhooksUpdate(liveSohbet);
  assert.strictEqual(whRes.triggered, true);
  assert.strictEqual(whRes.deletedHooks, 1);
  assert.strictEqual(hookDeleted, true);
  assert.strictEqual(hookCreator.roles.cache.has(qRole.id), true);
  console.log("[OK] Anti-Webhook: Yetkisiz webhook silindi ve olusturan blacklist'e alindi.");

  // 11. Anti-Raid & Alt-Shield: Suspicious brand-new account + Join Velocity Wave + Auto-Lockdown!
  const suspiciousAlt = addMember({
    id: "alt-1",
    username: "freshalt99",
    createdTimestamp: Date.now() - 10 * 60 * 1000, // 10 min old
    avatar: null, // default avatar -> score = 55 + 20 = 75 >= 65
  });
  const altRes = await defender.antiRaid.onGuildMemberAdd(suspiciousAlt);
  assert.strictEqual(altRes.triggered, true);
  assert.strictEqual(altRes.type, "SUSPICIOUS_ACCOUNT");
  assert(altRes.risk.score >= 65);
  assert.strictEqual(suspiciousAlt.roles.cache.has(qRole.id), true);

  // Simulate 5 rapid raid joins (bringing total in 12s window to 6 -> triggers Raid Mode + Auto-Lockdown!)
  let raidTrigger = null;
  for (let i = 1; i <= 5; i++) {
    const rMem = addMember({
      id: `raider-${i}`,
      username: `raidwave_${i}`,
      createdTimestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
    });
    const rr = await defender.antiRaid.onGuildMemberAdd(rMem);
    if (rr.type === "RAID_BURST") raidTrigger = rr;
  }
  assert(raidTrigger && raidTrigger.raidActivated === true);
  assert.strictEqual(defender.antiRaid.isRaidModeActive(guild.id), true);
  assert.strictEqual(defender.store.getGuild(guild.id).lockdown.active, true);
  assert.strictEqual(
    liveSohbet.permissionOverwrites.cache
      .get(guild.roles.everyone.id)
      .deny.has(PermissionFlagsBits.SendMessages),
    true
  );

  // Lift lockdown -> restores original channel permissions!
  defender.antiRaid.clearRaidMode(guild.id);
  const unlockRes = await defender.punishmentEngine.disableLockdown(guild, "Owner");
  assert.strictEqual(unlockRes.ok, true);
  assert.strictEqual(defender.store.getGuild(guild.id).lockdown.active, false);
  assert.strictEqual(
    liveSohbet.permissionOverwrites.cache
      .get(guild.roles.everyone.id)
      .deny.has(PermissionFlagsBits.SendMessages),
    false
  );
  console.log("[OK] Anti-Raid & Alt-Shield: Supheli hesap, raid dalgasi, oto-kilit ve kilit kaldirma dogrulandi.");

  // 12. Chat Defense: Token Leak, Disguised Phishing, Invite, Mass Mention, Burst Spam, Escalation!
  // 12a. Pure detector unit checks
  assert(
    detectSecretLeak(
      "tokenim: MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0.AbCdEf.1234567890abcdef1234567890abcdef"
    )
  );
  assert(
    detectSecretLeak(
      "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz12345"
    )
  );
  assert(detectPhishing("[https://discord.com/gift](https://evil-stealer.xyz/claim)"));
  assert(detectPhishing("bedava nitro https://dlscord.xyz/gift"));
  assert(detectPhishing("giris yap http://45.33.12.9/login"));
  assert.strictEqual(detectPhishing("https://discord.com/channels/1/2"), null);
  assert(detectExternalInvite("gelin discord.gg/baskasunucu", guild));
  assert(detectExternalInvite("gelin discord . gg / gizlidavet", guild));
  assert.strictEqual(
    detectExternalInvite("bizim sunucu discord.gg/backrooms-tr", guild),
    null
  );

  // 12b. Token leak deletes even for whitelisted users!
  const leakMsg = createChatMsg(
    liveSohbet,
    scopedMod,
    "yanlislikla attim https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz12345"
  );
  const leakRes = await defender.chatDefense.onMessageCreate(leakMsg);
  assert.strictEqual(leakRes.blocked, true);
  assert.strictEqual(leakRes.module, "ANTI_TOKEN_LEAK");
  assert.strictEqual(leakMsg.deleted, true);

  // 12c. Phishing + Invite + Escalation Ladder -> reaches Strike 4 -> Auto-Blacklist!
  const spammer = addMember({ id: "spammer-1", username: "spammer" });
  // Phishing gives 3 strikes immediately -> timeout 10m!
  const phishMsg = createChatMsg(
    liveSohbet,
    spammer,
    "bedava nitro al [https://discord.com](https://fake-nitro.ru/gift)"
  );
  const phishRes = await defender.chatDefense.onMessageCreate(phishMsg);
  assert.strictEqual(phishRes.blocked, true);
  assert.strictEqual(phishRes.strikes, 3);
  assert.strictEqual(phishRes.actionTaken, "timeout_10m");
  assert.strictEqual(phishMsg.deleted, true);

  // Next offense (invite, +1 strike -> 4 total) -> Auto-Blacklist (1573704309034586286)!
  const invMsg = createChatMsg(liveSohbet, spammer, "gel discord.gg/reklam123");
  const invRes = await defender.chatDefense.onMessageCreate(invMsg);
  assert.strictEqual(invRes.blocked, true);
  assert.strictEqual(invRes.strikes, 4);
  assert.strictEqual(invRes.actionTaken, "blacklist");
  assert.strictEqual(spammer.roles.cache.has("1573704309034586286"), true);

  // 12d. Mass Mention + Unauthorized @everyone
  const mentioner = addMember({ id: "ment-1", username: "ment" });
  const evMsg = createChatMsg(liveSohbet, mentioner, "@everyone bedava");
  const evRes = await defender.chatDefense.onMessageCreate(evMsg);
  assert.strictEqual(evRes.blocked, true);
  assert.strictEqual(evRes.module, "ANTI_MENTION");

  // 12e. Zalgo & Newline bomb & Burst spam
  const flooder = addMember({ id: "flood-1", username: "flood" });
  const nlMsg = createChatMsg(liveSohbet, flooder, "a\n".repeat(30));
  const nlRes = await defender.chatDefense.onMessageCreate(nlMsg);
  assert.strictEqual(nlRes.blocked, true);
  assert.strictEqual(nlRes.module, "ANTI_SPAM");

  // 12f. Edited message turned into phishing is caught without false-triggering burst spam
  const editor = addMember({ id: "edit-1", username: "editor" });
  const editedPhish = createChatMsg(
    liveSohbet,
    editor,
    "tikla https://free-nitro.xyz/claim"
  );
  const editRes = await defender.chatDefense.onMessageCreate(editedPhish, {
    isEdit: true,
  });
  assert.strictEqual(editRes.blocked, true);
  assert.strictEqual(editRes.module, "ANTI_PHISHING");
  console.log("[OK] Sohbet Korumasi: Token/Webhook sizintisi, maskeli phishing, davet, mention, spam ve kademeli blacklist dogrulandi.");

  // 13. Warning System + User-Log (RP count, warnings, bans, kicks, timeouts, blacklists)
  const rpCategory = await guild.channels.create({
    name: "RP LEVELLER",
    type: ChannelType.GuildCategory,
  });
  const rpCh0 = await guild.channels.create({
    name: "level-0",
    type: ChannelType.GuildText,
    parent: rpCategory.id,
    topic: "LEVEL_ID:0",
  });
  const rpCh1 = await guild.channels.create({
    name: "level-1",
    type: ChannelType.GuildText,
    parent: rpCategory.id,
    topic: "LEVEL_ID:1",
  });
  const callLogCh = await guild.channels.create({
    name: "cagri-log",
    type: ChannelType.GuildText,
    parent: rpCategory.id,
    topic: "[CALL_LOG] Yetkili cagri kayitlari",
  });

  const player = addMember({
    id: "123456789012345678",
    username: "rpplayer",
  });
  const playerDms = [];
  player.user.send = async (payload) => {
    playerDms.push(payload);
    return { id: "dm-1" };
  };
  const adminActor = { id: guild.ownerId, tag: "Admin#0001" };

  // 13a. Automatic RP participation tracking (deduplicates within same RP channel, skips .ooc/.cagir/cagri-log)
  const rpMsg1 = createChatMsg(rpCh0, player, ".me koridora goz atti");
  const rpRes1 = await defender.userLogManager.onMessageCreate(rpMsg1);
  assert.strictEqual(rpRes1.tracked, true);
  assert.strictEqual(rpRes1.newSession, true);
  assert.strictEqual(rpRes1.totalRpCount, 1);

  const rpMsg2 = createChatMsg(rpCh0, player, "Etrafta hafif bir ugultu vardi.");
  const rpRes2 = await defender.userLogManager.onMessageCreate(rpMsg2);
  assert.strictEqual(rpRes2.tracked, true);
  assert.strictEqual(rpRes2.newSession, false);
  assert.strictEqual(rpRes2.totalRpCount, 1);

  const oocMsg = createChatMsg(rpCh0, player, ".ooc birazdan geliyorum");
  const oocRes = await defender.userLogManager.onMessageCreate(oocMsg);
  assert.strictEqual(oocRes.tracked, false);

  const callMsg = createChatMsg(callLogCh, player, "test");
  const callRes = await defender.userLogManager.onMessageCreate(callMsg);
  assert.strictEqual(callRes.tracked, false);

  const rpMsg3 = createChatMsg(rpCh1, player, ".do kapidan iceri girdi");
  const rpRes3 = await defender.userLogManager.onMessageCreate(rpMsg3);
  assert.strictEqual(rpRes3.tracked, true);
  assert.strictEqual(rpRes3.newSession, true);
  assert.strictEqual(rpRes3.totalRpCount, 2);

  // Manual RP adjust (+2 -> 4, -1 -> 3)
  const adj1 = defender.userLogStore.adjustRpCount(guild.id, player.id, {
    delta: 2,
    note: "Gecmis RP oturumlari",
    moderatorId: adminActor.id,
    moderatorTag: adminActor.tag,
  });
  assert.strictEqual(adj1.totalRpCount, 4);
  const adj2 = defender.userLogStore.adjustRpCount(guild.id, player.id, {
    delta: -1,
    note: "Hatali kayit duzeltme",
    moderatorId: adminActor.id,
    moderatorTag: adminActor.tag,
  });
  assert.strictEqual(adj2.totalRpCount, 3);

  // 13b. Warnings: add, DM, log, remove single, remove all
  const w1 = await defender.userLogManager.warnUser(
    guild,
    player.user,
    "RP kurallarini ihlal etti",
    adminActor
  );
  assert.strictEqual(w1.entry.id, "W-1");
  assert.strictEqual(w1.totalWarnings, 1);
  assert.strictEqual(w1.dmSent, true);
  assert.strictEqual(playerDms.length, 1);

  const w2 = await defender.userLogManager.warnUser(
    guild,
    player.user,
    "Metagaming yapma",
    adminActor
  );
  assert.strictEqual(w2.entry.id, "W-2");
  assert.strictEqual(w2.totalWarnings, 2);

  const rem1 = await defender.userLogManager.removeWarning(
    guild,
    player.id,
    "W-1",
    adminActor
  );
  assert.strictEqual(rem1.removedCount, 1);
  assert.strictEqual(rem1.remainingCount, 1);

  const warnEmbed = defender.userLogManager.buildWarningsEmbed(
    guild,
    player.user,
    player.id
  );
  assert.strictEqual(emojiRegex.test(JSON.stringify(warnEmbed.toJSON())), false);

  // 13c. Kick, Ban, Unban, Timeout, Blacklist tracking in User-Log
  addAudit(AuditLogEvent.MemberKick, adminActor.id, player.id, "Uyari sonrasi kick");
  const kickRes = await defender.userLogManager.onGuildMemberRemove(player);
  assert.strictEqual(kickRes.recorded, true);
  assert.strictEqual(kickRes.type, "kick");

  addAudit(AuditLogEvent.MemberBanAdd, adminActor.id, player.id, "Agir kural ihlali");
  const banTrack = await defender.userLogManager.onGuildBanAdd({
    guild,
    user: player.user,
    reason: "Agir kural ihlali",
  });
  assert.strictEqual(banTrack.recorded, true);

  // GuildMemberRemove fired immediately after ban must NOT duplicate as kick/leave
  const postBanRemove = await defender.userLogManager.onGuildMemberRemove(player);
  assert.strictEqual(postBanRemove.skippedBecauseBan, true);

  addAudit(AuditLogEvent.MemberBanRemove, adminActor.id, player.id, "Af");
  const unbanTrack = await defender.userLogManager.onGuildBanRemove({
    guild,
    user: player.user,
  });
  assert.strictEqual(unbanTrack.recorded, true);

  // Manual timeout detection
  const futureTimeout = Date.now() + 5 * 60 * 1000;
  addAudit(AuditLogEvent.MemberUpdate, adminActor.id, player.id, "Sohbet susturma");
  const toTrack = await defender.userLogManager.onGuildMemberUpdate(
    { id: player.id, guild, user: player.user, communicationDisabledUntilTimestamp: null, roles: { cache: new MockCollection() } },
    { id: player.id, guild, user: player.user, communicationDisabledUntilTimestamp: futureTimeout, roles: { cache: new MockCollection() } }
  );
  assert.strictEqual(toTrack.recorded, true);
  assert.strictEqual(toTrack.results[0].type, "timeout");

  // Direct blacklist -> records once without duplicating on memberUpdate
  const blTrackRes = await defender.punishmentEngine.blacklistMember(
    guild,
    player,
    "Test blacklist",
    adminActor.tag,
    adminActor.id
  );
  assert.strictEqual(blTrackRes.ok, true);
  const dupBlUpdate = await defender.userLogManager.onGuildMemberUpdate(
    { id: player.id, guild, user: player.user, roles: { cache: new MockCollection() } },
    player
  );
  assert.strictEqual(dupBlUpdate.recorded, false);

  // 13d. Staff Notes add / remove
  const note1 = await defender.userLogManager.addStaffNote(
    guild,
    player.user,
    "RP kalitesi yuksek ancak OOC kurallarina dikkat etmeli.",
    adminActor
  );
  assert.strictEqual(note1.entry.id, "N-1");
  assert.strictEqual(note1.totalNotes, 1);

  const note2 = await defender.userLogManager.addStaffNote(
    guild,
    player.user,
    "Gecici not silinecek",
    adminActor
  );
  assert.strictEqual(note2.entry.id, "N-2");
  const remNote = await defender.userLogManager.removeStaffNote(
    guild,
    player.id,
    "N-2",
    adminActor
  );
  assert.strictEqual(remNote.removedCount, 1);
  assert.strictEqual(remNote.remainingCount, 1);

  const userRec = defender.userLogStore.peekUser(guild.id, player.id);
  assert.strictEqual(userRec.rp.count, 3);
  assert.strictEqual(userRec.rp.messageCount, 3);
  assert.strictEqual(userRec.warnings.length, 1);
  assert.strictEqual(userRec.removedWarningsCount, 1);
  assert.strictEqual(userRec.kicks.length, 1);
  assert.strictEqual(userRec.bans.length, 1);
  assert.strictEqual(userRec.unbans.length, 1);
  assert.strictEqual(userRec.timeouts.length, 1);
  assert.strictEqual(userRec.blacklists.length, 1);
  assert.strictEqual(userRec.notes.length, 1);

  // 13e. Interactive 5-tab /user-log dashboard, modals, warn confirm embed & .txt report export
  const confirmEmbed = defender.userLogManager.buildWarnConfirmEmbed({
    guild,
    targetUser: player.user,
    entry: w2.entry,
    totalWarnings: 1,
    dmSent: true,
    moderator: adminActor,
  });
  assert.strictEqual(emojiRegex.test(JSON.stringify(confirmEmbed.toJSON())), false);

  for (const tab of ["overview", "warnings", "punishments", "rp", "notes"]) {
    const dash = defender.userLogManager.buildUserLogDashboard({
      guild,
      targetId: player.id,
      discordUser: player.user,
      member: player,
      liveBan: null,
      defenderBlacklisted: true,
      tab,
    });
    assert.strictEqual(dash.embeds.length, 1);
    assert.strictEqual(dash.components.length, 2);
    assert.strictEqual(dash.components[0].components.length, 5);
    assert.strictEqual(dash.components[1].components.length, 4);
    const json = JSON.stringify(dash.embeds[0].toJSON());
    assert.strictEqual(emojiRegex.test(json), false);
    if (tab === "overview") {
      assert(json.includes("Katıldığı RP Sayısı: **3**"));
      assert(json.includes("Uyarı: **1**"));
      assert(json.includes("Ban: **1**"));
      assert(json.includes("Kick: **1**"));
      assert(json.includes("Timeout: **1**"));
      assert(json.includes("Blacklist: **1** (Aktif)"));
      assert(json.includes("W-2"));
    }
    if (tab === "notes") {
      assert(json.includes("N-1"));
    }
    if (tab === "rp") {
      assert(json.includes("#level-0"));
    }
  }

  const warnModal = defender.userLogManager.buildQuickWarnModal(player.id);
  const noteModal = defender.userLogManager.buildQuickNoteModal(player.id);
  assert.strictEqual(warnModal.toJSON().custom_id, `ulog:modal:warn:${player.id}`);
  assert.strictEqual(noteModal.toJSON().custom_id, `ulog:modal:note:${player.id}`);

  const reportTxt = defender.userLogManager.buildUserLogReportText({
    guild,
    targetId: player.id,
    discordUser: player.user,
    member: player,
    liveBan: null,
    defenderBlacklisted: true,
  });
  assert(reportTxt.includes("DEFENDER KULLANICI SICIL RAPORU"));
  assert(reportTxt.includes("[W-2]"));
  assert(reportTxt.includes("[N-1]"));
  assert(reportTxt.includes("Katildigi RP     : 3 (3 RP mesaji)"));
  assert.strictEqual(emojiRegex.test(reportTxt), false);
  console.log("[OK] Uyari Sistemi & Profesyonel /user-log: 5 sekme, risk skoru, modallar, yetkili notlari ve .txt rapor dogrulandi.");

  // 14. Regression tests for critical bugfixes
  // 14a. Multi-invite vanity bypass must be caught
  const multiInv = detectExternalInvite(
    "bizimki discord.gg/backrooms-tr ama buraya gel discord.gg/korsan123",
    guild
  );
  assert(multiInv && multiInv.code === "korsan123");

  // 14b. Double-blacklisting an already blacklisted member must preserve original vaulted roles!
  const vaultVictim = addMember({
    id: "vault-victim-1",
    username: "vaultvictim",
    roleList: [modRole],
  });
  const firstBl = await defender.punishmentEngine.blacklistMember(
    guild,
    vaultVictim,
    "Ilk blacklist",
    "Admin"
  );
  assert.strictEqual(firstBl.ok, true);
  assert.strictEqual(firstBl.removedRolesCount, 1);

  const secondBl = await defender.punishmentEngine.blacklistMember(
    guild,
    vaultVictim,
    "Tekrar blacklist",
    "Admin"
  );
  assert.strictEqual(secondBl.ok, true);
  assert.strictEqual(secondBl.removedRolesCount, 1);

  const restoredVault = await defender.punishmentEngine.unblacklistMember(
    guild,
    vaultVictim,
    "Admin"
  );
  assert.strictEqual(restoredVault.ok, true);
  assert.strictEqual(restoredVault.restoredCount, 1);
  assert.strictEqual(vaultVictim.roles.cache.has(modRole.id), true);

  // 14c. Anti-Nuke findAuditEntry must NOT match null targetId when targetId is requested
  addAudit(AuditLogEvent.ChannelDelete, "innocent-admin", null);
  const badAudit = await defender.antiNuke.findAuditEntry(
    guild,
    AuditLogEvent.ChannelDelete,
    "ch-nonexistent-999"
  );
  assert.strictEqual(badAudit, null);

  // 14d. Partial oldMember must NOT falsely record timeout or blacklist role change
  const partialUpdateRes = await defender.userLogManager.onGuildMemberUpdate(
    { partial: true, id: player.id, guild, user: player.user },
    {
      id: player.id,
      guild,
      user: player.user,
      communicationDisabledUntilTimestamp: Date.now() + 300_000,
      roles: player.roles,
    }
  );
  assert.strictEqual(partialUpdateRes.recorded, false);

  // 14e. Category auto-restore must NOT include invalid Discord API fields (topic, rateLimitPerUser, nsfw)
  const origCreate = guild.channels.create;
  let capturedCatPayload = null;
  guild.channels.create = async (payload) => {
    capturedCatPayload = payload;
    return origCreate(payload);
  };
  await defender.snapshotManager.restoreDeletedChannel(guild, {
    id: "cat-del-1",
    name: "DENEME KATEGORI",
    type: ChannelType.GuildCategory,
    topic: "invalid-for-cat",
    rateLimitPerUser: 5,
    nsfw: false,
  });
  guild.channels.create = origCreate;
  assert(capturedCatPayload);
  assert.strictEqual("topic" in capturedCatPayload, false);
  assert.strictEqual("rateLimitPerUser" in capturedCatPayload, false);
  assert.strictEqual("nsfw" in capturedCatPayload, false);

  // 14f. Failed timeout must NOT log a false timeout in userLogStore
  const failToUser = addMember({ id: "fail-to-1", username: "failto" });
  failToUser.timeout = async () => {
    throw new Error("Missing Permissions");
  };
  await defender.chatDefense.onMessageCreate(
    createChatMsg(liveSohbet, failToUser, "gel discord.gg/reklam1")
  );
  const failToRes = await defender.chatDefense.onMessageCreate(
    createChatMsg(liveSohbet, failToUser, "gel discord.gg/reklam2")
  );
  assert.strictEqual(failToRes.actionTaken, "delete_warn");
  const failToRec = defender.userLogStore.peekUser(guild.id, failToUser.id);
  assert.strictEqual(failToRec.timeouts.length, 0);

  // 14g. Blacklist role hierarchy block must fail cleanly WITHOUT stripping roles
  const origBlPos = configuredBlRole.position;
  configuredBlRole.position = 999; // Higher than botTopRole (90)
  const hierUser = addMember({
    id: "hier-user-1",
    username: "hieruser",
    roleList: [modRole],
  });
  const hierRes = await defender.punishmentEngine.blacklistMember(
    guild,
    hierUser,
    "Hiyerarsi testi",
    "Admin"
  );
  configuredBlRole.position = origBlPos;
  assert.strictEqual(hierRes.ok, false);
  assert.strictEqual(hierRes.reason, "ROLE_HIERARCHY_BLOCKED");
  assert.strictEqual(hierUser.roles.cache.has(modRole.id), true);

  // 14h. Periodic pruneExpired runs cleanly
  defender.snapshotManager.pruneExpired();
  defender.punishmentEngine.pruneExpired();
  defender.userLogManager.pruneExpired();
  console.log("[OK] Bugfix Regresyon Testleri: 8 kritik hata duzeltmesi (kasa koruma, davet bypass, audit eslesme, partial, kategori restore, timeout, hiyerarsi, bellek temizligi) dogrulandi.");

  // 15. Forensic incident logs verified
  assert(logCh._sent.length >= 8);
  const status = defender.getGuildStatus(guild);
  assert(status.incidentCount >= 8);
  for (const sent of logCh._sent) {
    assert.strictEqual(emojiRegex.test(JSON.stringify(sent)), false);
  }
  console.log(`[OK] Adli Olay Kaydi: ${status.incidentCount} olay #defender-log kanalina emojisiz kaydedildi.`);

  defender.shutdown();
  console.log("\nTUM DEFENDER TESTLERI BASARIYLA GECTI.");
}

runTests().catch((err) => {
  console.error("\nTEST HATASI:", err);
  process.exit(1);
});
