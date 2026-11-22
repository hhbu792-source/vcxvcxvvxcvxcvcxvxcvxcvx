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

function isValidSnowflake(val) {
  return /^\d{17,20}$/.test(String(val || "").trim());
}

config.snapshotIntervalMs = Math.round(
  config.snapshotIntervalMinutes * 60 * 1000
);
config.rpSessionGapMs = Math.round(config.rpSessionGapMinutes * 60 * 1000);

config.validate = function validateConfig() {
  const warnings = [];
  if (config.clientId && !isValidSnowflake(config.clientId)) {
    warnings.push(`CLIENT_ID gecersiz gorunuyor: "${config.clientId}"`);
  }
  if (config.guildId && !isValidSnowflake(config.guildId)) {
    warnings.push(`GUILD_ID gecersiz gorunuyor: "${config.guildId}"`);
  }
  if (config.blacklistRoleId && !isValidSnowflake(config.blacklistRoleId)) {
    warnings.push(`BLACKLIST_ROLE_ID gecersiz gorunuyor: "${config.blacklistRoleId}"`);
  }
  if (
    config.ticketPanelChannelId &&
    !isValidSnowflake(config.ticketPanelChannelId)
  ) {
    warnings.push(
      `TICKET_PANEL_CHANNEL_ID gecersiz gorunuyor: "${config.ticketPanelChannelId}"`
    );
  }
  return warnings;
};

module.exports = config;
