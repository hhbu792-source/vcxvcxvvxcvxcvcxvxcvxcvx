const { REST, Routes } = require("discord.js");
const config = require("./config");
const { buildCommands } = require("./commands");

async function deployCommands({
  token = config.token,
  clientId = config.clientId,
  guildId = config.guildId,
} = {}) {
  if (!token) {
    throw new Error("DISCORD_TOKEN .env dosyasinda tanimli degil.");
  }
  if (!clientId) {
    throw new Error("CLIENT_ID .env dosyasinda tanimli degil.");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildCommands();

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body,
    });
    return { scope: "guild", guildId, count: body.length };
  }

  await rest.put(Routes.applicationCommands(clientId), { body });
  return { scope: "global", count: body.length };
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
