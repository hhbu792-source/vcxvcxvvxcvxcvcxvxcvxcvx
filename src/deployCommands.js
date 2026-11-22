const { REST, Routes } = require("discord.js");
const config = require("./config");
const { buildCommands } = require("./commands");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployCommands({
  token = config.token,
  clientId = config.clientId,
  guildId = config.guildId,
  retries = 2,
} = {}) {
  if (!token) {
    throw new Error("DISCORD_TOKEN .env dosyasinda tanimli degil.");
  }
  if (!clientId) {
    throw new Error("CLIENT_ID .env dosyasinda tanimli degil.");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildCommands();
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  let lastErr = null;
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
    try {
      await rest.put(route, { body });
      return guildId
        ? { scope: "guild", guildId, count: body.length }
        : { scope: "global", count: body.length };
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      // Do not retry on permanent auth/permission errors (401/403/400)
      if (status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(2500 * attempt);
      }
    }
  }

  throw lastErr;
}

if (require.main === module) {
  deployCommands()
    .then((res) => {
      if (res.scope === "guild") {
        console.log(
          `[DEPLOY] ${res.count} slash komutu sunucuya (${res.guildId}) yuklendi.`
        );
      } else {
        console.log(`[DEPLOY] ${res.count} slash komutu global olarak yuklendi.`);
      }
    })
    .catch((err) => {
      console.error("[DEPLOY] Komut yukleme hatasi:", err);
      process.exit(1);
    });
}

module.exports = { deployCommands };
