const { PermissionFlagsBits } = require("discord.js");

/**
 * Permissions considered critical/dangerous for privilege-escalation & nuke detection.
 */
const DANGEROUS_PERMISSIONS = [
  { flag: PermissionFlagsBits.Administrator, name: "Administrator" },
  { flag: PermissionFlagsBits.ManageGuild, name: "ManageGuild" },
  { flag: PermissionFlagsBits.ManageRoles, name: "ManageRoles" },
  { flag: PermissionFlagsBits.ManageChannels, name: "ManageChannels" },
  { flag: PermissionFlagsBits.ManageWebhooks, name: "ManageWebhooks" },
  { flag: PermissionFlagsBits.BanMembers, name: "BanMembers" },
  { flag: PermissionFlagsBits.KickMembers, name: "KickMembers" },
  { flag: PermissionFlagsBits.ManageGuildExpressions, name: "ManageGuildExpressions" },
  { flag: PermissionFlagsBits.MentionEveryone, name: "MentionEveryone" },
];

const DANGEROUS_PERMISSION_BITFIELD = DANGEROUS_PERMISSIONS.reduce(
  (acc, item) => acc | item.flag,
  0n
);

const DEFAULT_BLACKLIST_ROLE_ID = "1573704309034586286";

const PUNISHMENT_MODES = ["blacklist", "strip_roles", "kick", "ban"];

const WHITELIST_SCOPES = ["all", "antiNuke", "antiRaid", "chatDefense"];

function createDefaultGuildSettings() {
  return {
    enabled: true,
    punishmentMode: "blacklist", // blacklist | strip_roles | kick | ban
    logChannelId: null,
    blacklistRoleId: DEFAULT_BLACKLIST_ROLE_ID,
    modules: {
      antiNuke: true,
      antiRaid: true,
      antiSpam: true,
      antiInvite: true,
      antiPhishing: true,
      antiMention: true,
      antiWebhook: true,
      antiBot: true,
      antiTokenLeak: true,
      autoRestore: true,
      altShield: true,
    },
    thresholds: {
      // Anti-Nuke sliding window limits
      channelDeleteLimit: 2,
      channelCreateLimit: 3,
      channelUpdateLimit: 4,
      roleDeleteLimit: 2,
      roleCreateLimit: 3,
      banLimit: 2,
      kickLimit: 2,
      assetDeleteLimit: 3,
      nukeWindowMs: 15_000,

      // Anti-Raid limits
      raidJoinCount: 6,
      raidJoinWindowMs: 12_000,
      raidAutoLockdown: true,
      raidModeDurationMs: 10 * 60 * 1000,
      minAccountAgeDays: 7,
      suspiciousRiskThreshold: 65,

      // Chat Defense limits
      spamMessageLimit: 5,
      spamWindowMs: 5_000,
      duplicateLimit: 3,
      duplicateWindowMs: 15_000,
      maxMentionsPerMessage: 5,
      maxNewlinesPerMessage: 25,
      maxEmojisPerMessage: 15,
      maxZalgoMarks: 30,
      strikeDecayMs: 10 * 60 * 1000,
    },
    whitelist: {
      // Map-like objects: id -> { scopes: string[], addedBy, addedAt }
      users: {},
      roles: {},
      bots: {},
    },
    blacklistedUsers: {},
    lockdown: {
      active: false,
      activatedAt: null,
      activatedBy: null,
      reason: null,
      savedOverwrites: {},
    },
    incidentCounter: 0,
    incidents: [],
  };
}

/**
 * Known scam/phishing host keywords and lookalike patterns.
 */
const SCAM_DOMAIN_PATTERNS = [
  /d[i1l]sc[o0]rd[\-a-z0-9]*(?:g[i1l]ft|n[i1l]tr[o0]|app|pr[o0]m[o0]|st[o0]re|dr[o0]p|event|airdrop)\.[a-z]{2,}/i,
  /discor[cdl][a-z0-9\-]*\.(?!com$|gg$|net$|media$|status\.com$)[a-z]{2,}/i,
  /dlscord\.[a-z]{2,}/i,
  /discrod\.[a-z]{2,}/i,
  /disc0rd\.[a-z]{2,}/i,
  /steamc[o0]mmun[i1l]t[yv]\.(?!com$)[a-z]{2,}/i,
  /stearn[a-z0-9\-]*\.[a-z]{2,}/i,
  /steam[\-a-z0-9]*(?:g[i1l]ft|n[i1l]tr[o0]|tr[a4]de|dr[o0]p|free)\.[a-z]{2,}/i,
  /free[\-]?nitro\.[a-z]{2,}/i,
  /nitro[\-]?gift\.[a-z]{2,}/i,
  /grabify\.link/i,
  /iplogger\.(?:org|com|co|ru)/i,
  /2no\.co/i,
  /yip\.su/i,
];

const SAFE_OFFICIAL_DOMAINS = new Set([
  "discord.com",
  "discord.gg",
  "discordapp.com",
  "discordapp.net",
  "discord.media",
  "discordstatus.com",
  "steampowered.com",
  "steamcommunity.com",
  "github.com",
  "youtube.com",
  "youtu.be",
]);

module.exports = {
  DEFAULT_BLACKLIST_ROLE_ID,
  DANGEROUS_PERMISSIONS,
  DANGEROUS_PERMISSION_BITFIELD,
  PUNISHMENT_MODES,
  WHITELIST_SCOPES,
  SCAM_DOMAIN_PATTERNS,
  SAFE_OFFICIAL_DOMAINS,
  createDefaultGuildSettings,
};
