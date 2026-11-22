require("dotenv").config();

function parsePositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config = {
  token: process.env.DISCORD_TOKEN || "",
  clientId: process.env.CLIENT_ID || "",
  guildId: process.env.GUILD_ID || "",
  blacklistRoleId: (
    process.env.BLACKLIST_ROLE_ID || "1573704309034586286"
  ).trim(),
  blacklistRoleName: (process.env.BLACKLIST_ROLE_NAME || "BLACKLIST").trim(),
  ticketPanelChannelId: (
    process.env.TICKET_PANEL_CHANNEL_ID || "1573522477655654544"
  ).trim(),
  defaultLogChannelName: (
    process.env.DEFAULT_LOG_CHANNEL_NAME || "defender-log"
  ).trim(),
  rpCategoryName: (process.env.RP_CATEGORY_NAME || "RP LEVELLER").trim(),
  rpSessionGapMinutes: parsePositiveNumber(
    process.env.RP_SESSION_GAP_MINUTES,
    30
  ),
  snapshotIntervalMinutes: parsePositiveNumber(
    process.env.SNAPSHOT_INTERVAL_MINUTES,
    15
  ),
};

config.snapshotIntervalMs = Math.round(
  config.snapshotIntervalMinutes * 60 * 1000
);
config.rpSessionGapMs = Math.round(config.rpSessionGapMinutes * 60 * 1000);

module.exports = config;
