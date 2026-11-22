const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const config = require("./config");
const { DefenderEngine } = require("./defender/defenderEngine");
const { deployCommands } = require("./deployCommands");

if (!config.token) {
  console.error(
    "[HATA] DISCORD_TOKEN bulunamadi. .env.example dosyasini .env olarak kopyalayip bot token'inizi girin."
  );
  process.exit(1);
}

const defender = new DefenderEngine({
  blacklistRoleId: config.blacklistRoleId,
  blacklistRoleName: config.blacklistRoleName,
  ticketPanelChannelId: config.ticketPanelChannelId,
  defaultLogChannelName: config.defaultLogChannelName,
  rpCategoryName: config.rpCategoryName,
  rpSessionGapMs: config.rpSessionGapMs,
  snapshotIntervalMs: config.snapshotIntervalMs,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildExpressions,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

defender.attach(client);

function cleanSnowflake(raw) {
  const m = String(raw || "").match(/\d{17,20}/);
  return m ? m[0] : null;
}

function isAdministrator(interaction) {
  return Boolean(
    interaction.guild?.ownerId === interaction.user.id ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

/**
 * High-security actions (whitelist edits, toggling modules, changing punishment mode)
 * require Server Owner OR a Whitelisted ("all") Administrator so a hijacked admin
 * cannot turn off Defender before nuking.
 */
function canModifyDefenderCore(interaction) {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  if (!isAdministrator(interaction)) return false;
  return defender.store.isWhitelisted(
    interaction.guild,
    interaction.member || interaction.user.id,
    "all"
  );
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[DEFENDER] ${readyClient.user.tag} aktif.`);
  const snapCount = defender.initializeGuilds(readyClient);
  console.log(
    `[DEFENDER] ${snapCount} sunucu icin koruma ve yapi yedegi baslatildi.`
  );

  try {
    const res = await deployCommands({
      token: config.token,
      clientId: config.clientId || readyClient.user.id,
      guildId: config.guildId,
    });
    console.log(
      res.scope === "guild"
        ? `[DEPLOY] ${res.count} slash komutu sunucuya (${res.guildId}) senkronize edildi.`
        : `[DEPLOY] ${res.count} slash komutu global olarak senkronize edildi.`
    );
  } catch (err) {
    console.error("[DEPLOY] Slash komutlari yuklenemedi:", err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (
    interaction.commandName !== "defender" &&
    interaction.commandName !== "user-log"
  ) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: "Bu komut sadece sunucu icinde kullanilabilir.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isAdministrator(interaction)) {
    await interaction.reply({
      content: "Bu komutu sadece Yonetici (Administrator) yetkisine sahip kisiler kullanabilir.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;

  if (interaction.commandName === "user-log") {
    try {
      const rawId = interaction.options.getString("id", true);
      const targetId = cleanSnowflake(rawId);
      if (!targetId) {
        await interaction.reply({
          content: "Gecerli bir Discord ID'si girin (ornek: `123456789012345678`).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const [discordUser, member, liveBan] = await Promise.all([
        client.users.fetch(targetId).catch(() => null),
        guild.members.fetch(targetId).catch(() => null),
        guild.bans.fetch(targetId).catch(() => null),
      ]);

      const gDef = defender.store.getGuild(guild.id);
      const defenderBlacklisted = Boolean(gDef.blacklistedUsers[targetId]);

      const embed = defender.userLogManager.buildUserLogEmbed({
        guild,
        targetId,
        discordUser,
        member,
        liveBan,
        defenderBlacklisted,
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("[USER-LOG KOMUT HATASI]", err);
      const msg = "Kullanici kaydi getirilirken bir hata olustu.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction
          .reply({ content: msg, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return;
  }

  const sub = interaction.options.getSubcommand();

  const coreProtectedSubs = new Set([
    "modul",
    "ceza",
    "whitelist-ekle",
    "whitelist-cikar",
  ]);
  if (coreProtectedSubs.has(sub) && !canModifyDefenderCore(interaction)) {
    await interaction.reply({
      content:
        "Bu kritik Defender ayarini sadece **Sunucu Sahibi** veya `all` kapsaminda whitelist'e eklenmis yoneticiler degistirebilir.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    if (sub === "kurulum") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const logCh = await defender.punishmentEngine.ensureLogChannel(guild);
      const blRole = await defender.punishmentEngine.ensureBlacklistRole(guild);
      const snap = defender.snapshotManager.captureGuild(guild);

      await interaction.editReply(
        [
          "Defender kurulumu tamamlandi.",
          `Log Kanali: ${logCh}`,
          `Blacklist Rolu: <@&${blRole.id}>`,
          `Ilk Yedek: ${Object.keys(snap.roles).length} rol, ${Object.keys(snap.channels).length} kanal kaydedildi.`,
          "",
          "Not: Guvendiginiz yoneticileri `/defender whitelist-ekle` ile eklemeyi unutmayin (Sunucu Sahibi otomatik muaftir).",
        ].join("\n")
      );
      return;
    }

    if (sub === "durum") {
      const st = defender.getGuildStatus(guild);
      const modLines = Object.entries(st.modules)
        .map(([k, v]) => `- \`${k}\`: **${v ? "ACIK" : "KAPALI"}**`)
        .join("\n");

      const snapText = st.snapshot
        ? `${st.snapshot.roleCount} rol, ${st.snapshot.channelCount} kanal (<t:${Math.floor(st.snapshot.capturedAt / 1000)}:R>)`
        : "Henuz alinmadi";

      const embed = new EmbedBuilder()
        .setColor(st.lockdownActive || st.raidModeActive ? 0xc0392b : 0x2c3e50)
        .setTitle(`Defender Guvenlik Durumu - ${guild.name}`)
        .addFields(
          {
            name: "Genel",
            value: [
              `Sistem: **${st.enabled ? "AKTIF" : "PASIF"}**`,
              `Ceza Modu: \`${st.punishmentMode}\``,
              `Acil Kilit: **${st.lockdownActive ? "AKTIF" : "Kapali"}**`,
              `Raid Modu: **${st.raidModeActive ? "AKTIF" : "Normal"}**`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "Kayitlar",
            value: [
              `Log Kanali: ${st.logChannelId ? `<#${st.logChannelId}>` : "Ayarlanmadi"}`,
              `Blacklist Rolu: ${st.blacklistRoleId ? `<@&${st.blacklistRoleId}>` : "Ayarlanmadi"}`,
              `Blacklist'teki Uye: **${st.blacklistedCount}**`,
              `Toplam Olay: **${st.incidentCount}**`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "Whitelist & Yedek",
            value: [
              `Kullanici: ${st.whitelistCounts.users} | Rol: ${st.whitelistCounts.roles} | Bot: ${st.whitelistCounts.bots}`,
              `Son Yedek: ${snapText}`,
            ].join("\n"),
            inline: false,
          },
          {
            name: "Koruma Modulleri",
            value: modLines,
            inline: false,
          }
        )
        .setFooter({ text: "Defender Guvenlik Motoru" })
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "modul") {
      const modName = interaction.options.getString("ad", true);
      const active = interaction.options.getBoolean("aktif", true);
      defender.store.setModuleEnabled(guild.id, modName, active);

      await defender.punishmentEngine.logIncident(guild, {
        module: "CONFIG",
        severity: "INFO",
        action: `Modul Ayari Degistirildi (${modName})`,
        executorId: interaction.user.id,
        target: modName,
        details: `Yeni durum: ${active ? "ACIK" : "KAPALI"}`,
      });

      await interaction.reply({
        content: `\`${modName}\` modulu **${active ? "ACIK" : "KAPALI"}** olarak guncellendi.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "ceza") {
      const mode = interaction.options.getString("mod", true);
      defender.store.setPunishmentMode(guild.id, mode);

      await defender.punishmentEngine.logIncident(guild, {
        module: "CONFIG",
        severity: "INFO",
        action: "Ceza Modu Degistirildi",
        executorId: interaction.user.id,
        target: mode,
        details: `Varsayilan ceza modu \`${mode}\` yapildi.`,
      });

      await interaction.reply({
        content: `Varsayilan ceza modu \`${mode}\` olarak ayarlandi.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "log") {
      const ch = interaction.options.getChannel("kanal", true);
      defender.store.setLogChannel(guild.id, ch.id);
      await interaction.reply({
        content: `Guvenlik log kanali ${ch} olarak ayarlandi.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "whitelist-ekle") {
      const category = interaction.options.getString("tur", true);
      const rawId = interaction.options.getString("id", true);
      const scope = interaction.options.getString("kapsam", false) || "all";
      const targetId = cleanSnowflake(rawId);

      if (!targetId) {
        await interaction.reply({
          content: "Gecerli bir Discord ID'si veya etiket girin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      defender.store.addWhitelist(
        guild.id,
        category,
        targetId,
        [scope],
        interaction.user.id
      );

      await defender.punishmentEngine.logIncident(guild, {
        module: "WHITELIST",
        severity: "INFO",
        action: "Whitelist Ekleme",
        executorId: interaction.user.id,
        target: `${category}: ${targetId}`,
        details: `Kapsam: \`${scope}\``,
      });

      await interaction.reply({
        content: `\`${targetId}\` (${category}) guvenli listeye eklendi (kapsam: \`${scope}\`).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "whitelist-cikar") {
      const category = interaction.options.getString("tur", true);
      const rawId = interaction.options.getString("id", true);
      const targetId = cleanSnowflake(rawId);

      if (!targetId) {
        await interaction.reply({
          content: "Gecerli bir Discord ID'si girin.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const removed = defender.store.removeWhitelist(
        guild.id,
        category,
        targetId
      );
      if (!removed) {
        await interaction.reply({
          content: `\`${targetId}\` (${category}) guvenli listede bulunamadi.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await defender.punishmentEngine.logIncident(guild, {
        module: "WHITELIST",
        severity: "INFO",
        action: "Whitelist Cikarma",
        executorId: interaction.user.id,
        target: `${category}: ${targetId}`,
        details: "Guvenli listeden kaldirildi.",
      });

      await interaction.reply({
        content: `\`${targetId}\` (${category}) guvenli listeden cikarildi.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "whitelist-liste") {
      const g = defender.store.getGuild(guild.id);
      const fmt = (obj, prefix) => {
        const entries = Object.entries(obj);
        if (entries.length === 0) return "Yok";
        return entries
          .map(
            ([id, info]) =>
              `- ${prefix}${id}> (\`${(info.scopes || ["all"]).join(", ")}\`)`
          )
          .join("\n");
      };

      const embed = new EmbedBuilder()
        .setColor(0x2c3e50)
        .setTitle("Defender Guvenli Liste (Whitelist)")
        .setDescription(
          `Sunucu Sahibi (<@${guild.ownerId}>) ve Defender botu her zaman muaftir.`
        )
        .addFields(
          { name: "Kullanicilar", value: fmt(g.whitelist.users, "<@"), inline: false },
          { name: "Roller", value: fmt(g.whitelist.roles, "<@&"), inline: false },
          { name: "Onayli Botlar", value: fmt(g.whitelist.bots, "<@"), inline: false }
        )
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "kilit") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reason =
        interaction.options.getString("sebep", false) ||
        "Yonetici acil durum kilidi";
      const res = await defender.punishmentEngine.enableLockdown(
        guild,
        reason,
        interaction.user.tag
      );
      if (!res.ok) {
        await interaction.editReply("Sunucu zaten kilitli durumda.");
        return;
      }

      await defender.punishmentEngine.logIncident(guild, {
        module: "LOCKDOWN",
        severity: "HIGH",
        action: "Acil Durum Kilidi Acildi",
        executorId: interaction.user.id,
        target: `${res.lockedCount} kanal`,
        details: `Sebep: ${reason}`,
      });

      await interaction.editReply(
        `Acil durum kilidi aktif edildi. ${res.lockedCount} kanal kilitlendi.`
      );
      return;
    }

    if (sub === "kilit-kaldir") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      defender.antiRaid.clearRaidMode(guild.id);
      const res = await defender.punishmentEngine.disableLockdown(
        guild,
        interaction.user.tag
      );

      await defender.punishmentEngine.logIncident(guild, {
        module: "LOCKDOWN",
        severity: "INFO",
        action: "Acil Durum Kilidi & Raid Modu Kaldirildi",
        executorId: interaction.user.id,
        target: `${res.unlockedCount} kanal`,
        details: "Eski kanal izinleri geri yuklendi.",
      });

      await interaction.editReply(
        res.ok
          ? `Acil kilit ve raid modu kaldirildi. ${res.unlockedCount} kanalin eski izinleri geri yuklendi.`
          : "Raid modu temizlendi (aktif kilit bulunmuyordu)."
      );
      return;
    }

    if (sub === "blacklist") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const reason =
        interaction.options.getString("sebep", false) || "Manuel blacklist";
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply("Kullanici sunucuda bulunamadi.");
        return;
      }
      const res = await defender.punishmentEngine.blacklistMember(
        guild,
        member,
        reason,
        interaction.user.tag,
        interaction.user.id
      );
      if (!res.ok) {
        await interaction.editReply(
          "Bu kullanici blacklist'e alinamadi (rol hiyerarsisi veya sunucu sahibi)."
        );
        return;
      }

      await defender.punishmentEngine.logIncident(guild, {
        module: "BLACKLIST",
        severity: "HIGH",
        action: "Manuel Blacklist",
        executorId: interaction.user.id,
        target: `<@${user.id}>`,
        details: `Sebep: ${reason} (${res.removedRolesCount} rol saklandi)`,
        punishment: "blacklist",
      });

      await interaction.editReply(
        `<@${user.id}> blacklist'e alindi (<@&${res.blacklistRoleId}> verildi, ${res.removedRolesCount} eski rol yedeklendi).`
      );
      return;
    }

    if (sub === "blacklist-kaldir") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply("Kullanici sunucuda bulunamadi.");
        return;
      }
      const res = await defender.punishmentEngine.unblacklistMember(
        guild,
        member,
        interaction.user.tag,
        interaction.user.id
      );

      await defender.punishmentEngine.logIncident(guild, {
        module: "BLACKLIST",
        severity: "INFO",
        action: "Blacklist Kaldirildi",
        executorId: interaction.user.id,
        target: `<@${user.id}>`,
        details: `${res.restoredCount} eski rol geri verildi.`,
      });

      await interaction.editReply(
        `<@${user.id}> blacklist'ten cikarildi (${res.restoredCount} eski rol geri yuklendi).`
      );
      return;
    }

    if (sub === "uyari-ver") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const reason = interaction.options.getString("sebep", true).trim();

      if (user.bot) {
        await interaction.editReply("Bot hesaplarina uyari verilemez.");
        return;
      }
      if (user.id === interaction.user.id) {
        await interaction.editReply("Kendinize uyari veremezsiniz.");
        return;
      }
      if (user.id === guild.ownerId) {
        await interaction.editReply("Sunucu sahibine uyari verilemez.");
        return;
      }

      const res = await defender.userLogManager.warnUser(
        guild,
        user,
        reason,
        interaction.user
      );

      await interaction.editReply(
        [
          `<@${user.id}> kullanicisina uyari verildi.`,
          `Uyari ID: \`${res.entry.id}\``,
          `Sebep: ${res.entry.reason}`,
          `Toplam Uyari: **${res.totalWarnings}**`,
          `DM Bildirimi: **${res.dmSent ? "Gonderildi" : "Gonderilemedi (DM kapali)"}**`,
        ].join("\n")
      );
      return;
    }

    if (sub === "uyari-kaldir") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const warningId = interaction.options.getString("uyari_id", false);

      const res = await defender.userLogManager.removeWarning(
        guild,
        user.id,
        warningId,
        interaction.user
      );

      if (res.removedCount === 0) {
        await interaction.editReply(
          warningId
            ? `<@${user.id}> kullanicisinda \`${warningId}\` kodlu bir uyari bulunamadi.`
            : `<@${user.id}> kullanicisinin silinecek uyarisi bulunmuyor.`
        );
        return;
      }

      await interaction.editReply(
        `<@${user.id}> kullanicisindan **${res.removedCount}** uyari silindi (\`${res.removedIds.join(", ")}\`). Kalan uyari: **${res.remainingCount}**.`
      );
      return;
    }

    if (sub === "uyarilar") {
      const user = interaction.options.getUser("kullanici", true);
      const embed = defender.userLogManager.buildWarningsEmbed(
        guild,
        user,
        user.id
      );
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "rp-ekle") {
      const user = interaction.options.getUser("kullanici", true);
      const delta = interaction.options.getInteger("adet", false) ?? 1;
      const note =
        interaction.options.getString("not", false) || "Manuel RP kaydi";

      if (user.bot) {
        await interaction.reply({
          content: "Bot hesaplarina RP kaydi eklenemez.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (delta === 0) {
        await interaction.reply({
          content: "Adet 0 olamaz (ornek: 1 veya -1 girin).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const res = defender.userLogStore.adjustRpCount(guild.id, user.id, {
        delta,
        note,
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
        tag: user.tag || user.username,
      });

      const sign = delta > 0 ? `+${delta}` : String(delta);
      await interaction.reply({
        content: `<@${user.id}> RP sayisi guncellendi (${sign}). Yeni toplam RP sayisi: **${res.totalRpCount}** (Not: ${note}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "yedek") {
      const snap = defender.snapshotManager.captureGuild(guild);
      await interaction.reply({
        content: `Sunucu yedegi alindi: **${Object.keys(snap.roles).length}** rol ve **${Object.keys(snap.channels).length}** kanal kaydedildi.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "olaylar") {
      const g = defender.store.getGuild(guild.id);
      const recent = g.incidents.slice(-10).reverse();
      if (recent.length === 0) {
        await interaction.reply({
          content: "Henuz kaydedilmis bir guvenlik olayi bulunmuyor.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = recent.map(
        (inc) =>
          `**[${inc.id}]** \`${inc.module}\` (${inc.severity}) - ${inc.action} | <t:${Math.floor(inc.ts / 1000)}:R>`
      );

      const embed = new EmbedBuilder()
        .setColor(0x2c3e50)
        .setTitle(`Son Guvenlik Olaylari (${guild.name})`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Toplam kayitli olay: ${g.incidentCounter}` })
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (err) {
    console.error("[DEFENDER KOMUT HATASI]", err);
    const msg =
      "Komut calistirilirken hata olustu. Botun en ustte yer alan bir Yonetici rolune sahip oldugundan emin olun.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction
        .reply({ content: msg, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

function handleShutdown(signal) {
  console.log(`[DEFENDER] ${signal} alindi, kapatiliyor...`);
  defender.shutdown();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

client.login(config.token);
