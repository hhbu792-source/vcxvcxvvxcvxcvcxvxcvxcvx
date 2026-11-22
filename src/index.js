const {
  AttachmentBuilder,
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
    "[HATA] DISCORD_TOKEN bulunamadı. .env.example dosyasını .env olarak kopyalayıp bot token'ınızı girin."
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

function canModerateTarget(interaction, targetMember) {
  if (!interaction.guild || !targetMember) return true;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  if (targetMember.id === interaction.guild.ownerId) return false;
  const actorPos = interaction.member?.roles?.highest?.position ?? -1;
  const targetPos = targetMember.roles?.highest?.position ?? -1;
  return actorPos > targetPos;
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

async function fetchUserLogContext(guild, targetId) {
  const [discordUser, member, liveBan] = await Promise.all([
    client.users.fetch(targetId).catch(() => null),
    guild.members.fetch(targetId).catch(() => null),
    guild.bans.fetch(targetId).catch(() => null),
  ]);

  const gDef = defender.store.getGuild(guild.id);
  const defenderBlacklisted = Boolean(gDef.blacklistedUsers[targetId]);

  return {
    guild,
    targetId,
    discordUser,
    member,
    liveBan,
    defenderBlacklisted,
  };
}

async function handleUserLogButton(interaction) {
  if (!interaction.guild) return;
  if (!isAdministrator(interaction)) {
    await interaction.reply({
      content:
        "Bu paneli sadece **Yönetici (Administrator)** yetkisine sahip kişiler kullanabilir.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parts = String(interaction.customId || "").split(":");
  const action = parts[1];
  const targetId = cleanSnowflake(parts[2]);
  if (!targetId) {
    await interaction.reply({
      content: "Geçersiz kullanıcı kimliği.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "tab" || action === "refresh") {
    const tab = parts[3] || "overview";
    await interaction.deferUpdate();
    const ctx = await fetchUserLogContext(interaction.guild, targetId);
    const dashboard = defender.userLogManager.buildUserLogDashboard({
      ...ctx,
      tab,
    });
    await interaction.editReply(dashboard);
    return;
  }

  if (action === "warn") {
    if (targetId === interaction.user.id) {
      await interaction.reply({
        content: "Kendinize uyarı veremezsiniz.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (targetId === interaction.guild.ownerId) {
      await interaction.reply({
        content: "Sunucu sahibine uyarı verilemez.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    if (targetUser?.bot) {
      await interaction.reply({
        content: "Bot hesaplarına uyarı verilemez.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modal = defender.userLogManager.buildQuickWarnModal(targetId);
    await interaction.showModal(modal);
    return;
  }

  if (action === "note") {
    const modal = defender.userLogManager.buildQuickNoteModal(targetId);
    await interaction.showModal(modal);
    return;
  }

  if (action === "export") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ctx = await fetchUserLogContext(interaction.guild, targetId);
    const reportText = defender.userLogManager.buildUserLogReportText(ctx);
    const file = new AttachmentBuilder(Buffer.from(reportText, "utf-8"), {
      name: `user-log-${targetId}.txt`,
    });
    await interaction.editReply({
      content: `<@${targetId}> (\`${targetId}\`) için eksiksiz kullanıcı sicil raporu hazırlandı.`,
      files: [file],
    });
  }
}

async function handleUserLogModal(interaction) {
  if (!interaction.guild) return;
  if (!isAdministrator(interaction)) {
    await interaction.reply({
      content:
        "Bu işlemi sadece **Yönetici (Administrator)** yetkisine sahip kişiler yapabilir.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parts = String(interaction.customId || "").split(":");
  const modalKind = parts[2];
  const targetId = cleanSnowflake(parts[3]);
  if (!targetId) {
    await interaction.reply({
      content: "Geçersiz kullanıcı kimliği.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guild = interaction.guild;

  if (modalKind === "warn") {
    const reason = interaction.fields.getTextInputValue("warn_reason").trim();
    const [discordUser, member] = await Promise.all([
      client.users.fetch(targetId).catch(() => null),
      guild.members.fetch(targetId).catch(() => null),
    ]);

    if (discordUser?.bot) {
      await interaction.reply({
        content: "Bot hesaplarına uyarı verilemez.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (targetId === interaction.user.id || targetId === guild.ownerId) {
      await interaction.reply({
        content: "Bu kullanıcıya uyarı verilemez.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (member && !canModerateTarget(interaction, member)) {
      await interaction.reply({
        content:
          "Rol hiyerarşisi nedeniyle sizden üst veya eşit yetkideki bir üyeye uyarı veremezsiniz.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetObj = discordUser || { id: targetId, tag: targetId };
    const fromMsg =
      typeof interaction.isFromMessage === "function" &&
      interaction.isFromMessage();

    if (fromMsg) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const res = await defender.userLogManager.warnUser(
      guild,
      targetObj,
      reason,
      interaction.user
    );
    const confirmEmbed = defender.userLogManager.buildWarnConfirmEmbed({
      guild,
      targetUser: targetObj,
      entry: res.entry,
      totalWarnings: res.totalWarnings,
      dmSent: res.dmSent,
      moderator: interaction.user,
    });

    if (fromMsg) {
      const ctx = await fetchUserLogContext(guild, targetId);
      const dashboard = defender.userLogManager.buildUserLogDashboard({
        ...ctx,
        tab: "warnings",
      });
      await interaction.editReply(dashboard);
      await interaction.followUp({
        embeds: [confirmEmbed],
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.editReply({ embeds: [confirmEmbed] });
    }
    return;
  }

  if (modalKind === "note") {
    const noteText = interaction.fields.getTextInputValue("staff_note").trim();
    const discordUser = await client.users.fetch(targetId).catch(() => null);
    const targetObj = discordUser || { id: targetId, tag: targetId };

    const fromMsg =
      typeof interaction.isFromMessage === "function" &&
      interaction.isFromMessage();

    if (fromMsg) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const res = await defender.userLogManager.addStaffNote(
      guild,
      targetObj,
      noteText,
      interaction.user
    );

    if (fromMsg) {
      const ctx = await fetchUserLogContext(guild, targetId);
      const dashboard = defender.userLogManager.buildUserLogDashboard({
        ...ctx,
        tab: "notes",
      });
      await interaction.editReply(dashboard);
      await interaction.followUp({
        content: `<@${targetId}> siciline yetkili notu eklendi (\`${res.entry.id}\`). Toplam not: **${res.totalNotes}**.`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.editReply({
        content: `<@${targetId}> siciline yetkili notu eklendi (\`${res.entry.id}\`). Toplam not: **${res.totalNotes}**.`,
      });
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  const snapCount = defender.initializeGuilds(readyClient);
  console.log("========================================");
  console.log(`[DEFENDER] Bot aktif: ${readyClient.user.tag}`);
  console.log(`[DEFENDER] Korunan sunucu sayisi : ${snapCount}`);
  console.log(`[DEFENDER] Blacklist Rol ID      : ${config.blacklistRoleId}`);
  console.log(`[DEFENDER] RP Takip Kategorisi   : ${config.rpCategoryName}`);
  console.log("========================================");

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

client.on(Events.Error, (err) => {
  console.error("[DISCORD CLIENT HATASI]", err.message);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith("ulog:")) {
      await handleUserLogButton(interaction);
      return;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("ulog:modal:")
    ) {
      await handleUserLogModal(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (
      interaction.commandName !== "defender" &&
      interaction.commandName !== "user-log"
    ) {
      return;
    }

    if (!interaction.guild) {
      await interaction.reply({
        content: "Bu komut sadece sunucu içinde kullanılabilir.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAdministrator(interaction)) {
      await interaction.reply({
        content:
          "Bu komutu sadece **Yönetici (Administrator)** yetkisine sahip kişiler kullanabilir.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guild = interaction.guild;

    if (interaction.commandName === "user-log") {
      const rawId = interaction.options.getString("id", true);
      const targetId = cleanSnowflake(rawId);
      if (!targetId) {
        await interaction.reply({
          content:
            "Geçerli bir Discord ID'si girin (örnek: `123456789012345678`).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ctx = await fetchUserLogContext(guild, targetId);
      const dashboard = defender.userLogManager.buildUserLogDashboard({
        ...ctx,
        tab: "overview",
      });
      await interaction.editReply(dashboard);
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
          "Bu kritik Defender ayarını sadece **Sunucu Sahibi** veya `all` kapsamında whitelist'e eklenmiş yöneticiler değiştirebilir.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "kurulum") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const logCh = await defender.punishmentEngine.ensureLogChannel(guild);
      const blRole = await defender.punishmentEngine.ensureBlacklistRole(guild);
      const snap = defender.snapshotManager.captureGuild(guild);

      const setupEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setAuthor({ name: "Defender Güvenlik Sistemi" })
        .setTitle("Kurulum Tamamlandı")
        .addFields(
          { name: "Log Kanalı", value: `${logCh}`, inline: true },
          { name: "Blacklist Rolü", value: `<@&${blRole.id}>`, inline: true },
          {
            name: "İlk Sunucu Yedeği",
            value: `${Object.keys(snap.roles).length} rol, ${Object.keys(snap.channels).length} kanal`,
            inline: true,
          },
          {
            name: "Önemli Not",
            value:
              "Güvendiğiniz yöneticileri `/defender whitelist-ekle` ile eklemeyi unutmayın (Sunucu Sahibi otomatik muaftır).",
            inline: false,
          }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [setupEmbed] });
      return;
    }

    if (sub === "durum") {
      const st = defender.getGuildStatus(guild);
      const modLines = Object.entries(st.modules)
        .map(([k, v]) => `- \`${k}\`: **${v ? "AÇIK" : "KAPALI"}**`)
        .join("\n");

      const snapText = st.snapshot
        ? `${st.snapshot.roleCount} rol, ${st.snapshot.channelCount} kanal (<t:${Math.floor(st.snapshot.capturedAt / 1000)}:R>)`
        : "Henüz alınmadı";

      const embed = new EmbedBuilder()
        .setColor(st.lockdownActive || st.raidModeActive ? 0xc0392b : 0x2c3e50)
        .setAuthor({ name: "Defender Güvenlik Motoru" })
        .setTitle(`Canlı Güvenlik Durumu - ${guild.name}`)
        .addFields(
          {
            name: "Genel",
            value: [
              `Sistem: **${st.enabled ? "AKTİF" : "PASİF"}**`,
              `Ceza Modu: \`${st.punishmentMode}\``,
              `Acil Kilit: **${st.lockdownActive ? "AKTİF" : "Kapalı"}**`,
              `Raid Modu: **${st.raidModeActive ? "AKTİF" : "Normal"}**`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "Kayıtlar",
            value: [
              `Log Kanalı: ${st.logChannelId ? `<#${st.logChannelId}>` : "Ayarlanmadı"}`,
              `Blacklist Rolü: ${st.blacklistRoleId ? `<@&${st.blacklistRoleId}>` : "Ayarlanmadı"}`,
              `Blacklist'teki Üye: **${st.blacklistedCount}**`,
              `Toplam Olay: **${st.incidentCount}**`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "Whitelist & Yedek",
            value: [
              `Kullanıcı: ${st.whitelistCounts.users} | Rol: ${st.whitelistCounts.roles} | Bot: ${st.whitelistCounts.bots}`,
              `Son Yedek: ${snapText}`,
            ].join("\n"),
            inline: false,
          },
          {
            name: "Koruma Modülleri",
            value: modLines,
            inline: false,
          }
        )
        .setFooter({ text: `Defender Güvenlik Sistemi | ${guild.name}` })
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
        action: `Modül Ayarı Değiştirildi (${modName})`,
        executorId: interaction.user.id,
        target: modName,
        details: `Yeni durum: ${active ? "AÇIK" : "KAPALI"}`,
      });

      await interaction.reply({
        content: `\`${modName}\` modülü **${active ? "AÇIK" : "KAPALI"}** olarak güncellendi.`,
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
        action: "Ceza Modu Değiştirildi",
        executorId: interaction.user.id,
        target: mode,
        details: `Varsayılan ceza modu \`${mode}\` yapıldı.`,
      });

      await interaction.reply({
        content: `Varsayılan ceza modu \`${mode}\` olarak ayarlandı.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "log") {
      const ch = interaction.options.getChannel("kanal", true);
      defender.store.setLogChannel(guild.id, ch.id);
      await interaction.reply({
        content: `Güvenlik log kanalı ${ch} olarak ayarlandı.`,
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
          content: "Geçerli bir Discord ID'si veya etiket girin.",
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
        content: `\`${targetId}\` (${category}) güvenli listeye eklendi (kapsam: \`${scope}\`).`,
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
          content: "Geçerli bir Discord ID'si girin.",
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
          content: `\`${targetId}\` (${category}) güvenli listede bulunamadı.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await defender.punishmentEngine.logIncident(guild, {
        module: "WHITELIST",
        severity: "INFO",
        action: "Whitelist Çıkarma",
        executorId: interaction.user.id,
        target: `${category}: ${targetId}`,
        details: "Güvenli listeden kaldırıldı.",
      });

      await interaction.reply({
        content: `\`${targetId}\` (${category}) güvenli listeden çıkarıldı.`,
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
        .setTitle("Defender Güvenli Liste (Whitelist)")
        .setDescription(
          `Sunucu Sahibi (<@${guild.ownerId}>) ve Defender botu her zaman muaftır.`
        )
        .addFields(
          { name: "Kullanıcılar", value: fmt(g.whitelist.users, "<@"), inline: false },
          { name: "Roller", value: fmt(g.whitelist.roles, "<@&"), inline: false },
          { name: "Onaylı Botlar", value: fmt(g.whitelist.bots, "<@"), inline: false }
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
        "Yönetici acil durum kilidi";
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
        action: "Acil Durum Kilidi Açıldı",
        executorId: interaction.user.id,
        target: `${res.lockedCount} kanal`,
        details: `Sebep: ${reason}`,
      });

      await interaction.editReply(
        `Acil durum kilidi aktif edildi. **${res.lockedCount}** kanal kilitlendi.`
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
        action: "Acil Durum Kilidi & Raid Modu Kaldırıldı",
        executorId: interaction.user.id,
        target: `${res.unlockedCount} kanal`,
        details: "Eski kanal izinleri geri yüklendi.",
      });

      await interaction.editReply(
        res.ok
          ? `Acil kilit ve raid modu kaldırıldı. **${res.unlockedCount}** kanalın eski izinleri geri yüklendi.`
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
        await interaction.editReply("Kullanıcı sunucuda bulunamadı.");
        return;
      }
      if (!canModerateTarget(interaction, member)) {
        await interaction.editReply(
          "Rol hiyerarşisi nedeniyle sizden üst veya eşit yetkideki bir üyeyi blacklist'e alamazsınız."
        );
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
        if (
          res.reason === "ROLE_HIERARCHY_BLOCKED" ||
          res.reason === "ROLE_ASSIGN_FAILED"
        ) {
          await interaction.editReply(
            `Botun rolü <@&${res.blacklistRoleId}> rolünün altında kaldığı veya yetkisi yetersiz olduğu için Blacklist rolü verilemedi. Bot rolünü bu rolün üstüne taşıyın.`
          );
          return;
        }
        await interaction.editReply(
          "Bu kullanıcı blacklist'e alınamadı (bot rol hiyerarşisi veya sunucu sahibi)."
        );
        return;
      }

      await defender.punishmentEngine.logIncident(guild, {
        module: "BLACKLIST",
        severity: "HIGH",
        action: "Manuel Blacklist",
        executorId: interaction.user.id,
        target: `<@${user.id}>`,
        details: `Sebep: ${reason} (${res.removedRolesCount} rol saklandı)`,
        punishment: "blacklist",
      });

      await interaction.editReply(
        `<@${user.id}> blacklist'e alındı (<@&${res.blacklistRoleId}> verildi, **${res.removedRolesCount}** eski rol yedeklendi).`
      );
      return;
    }

    if (sub === "blacklist-kaldir") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.editReply("Kullanıcı sunucuda bulunamadı.");
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
        action: "Blacklist Kaldırıldı",
        executorId: interaction.user.id,
        target: `<@${user.id}>`,
        details: `${res.restoredCount} eski rol geri verildi.`,
      });

      await interaction.editReply(
        `<@${user.id}> blacklist'ten çıkarıldı (**${res.restoredCount}** eski rol geri yüklendi).`
      );
      return;
    }

    if (sub === "uyari-ver") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const reason = interaction.options.getString("sebep", true).trim();

      if (user.bot) {
        await interaction.editReply("Bot hesaplarına uyarı verilemez.");
        return;
      }
      if (user.id === interaction.user.id) {
        await interaction.editReply("Kendinize uyarı veremezsiniz.");
        return;
      }
      if (user.id === guild.ownerId) {
        await interaction.editReply("Sunucu sahibine uyarı verilemez.");
        return;
      }

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member && !canModerateTarget(interaction, member)) {
        await interaction.editReply(
          "Rol hiyerarşisi nedeniyle sizden üst veya eşit yetkideki bir üyeye uyarı veremezsiniz."
        );
        return;
      }

      const res = await defender.userLogManager.warnUser(
        guild,
        user,
        reason,
        interaction.user
      );

      const confirmEmbed = defender.userLogManager.buildWarnConfirmEmbed({
        guild,
        targetUser: user,
        entry: res.entry,
        totalWarnings: res.totalWarnings,
        dmSent: res.dmSent,
        moderator: interaction.user,
      });

      await interaction.editReply({ embeds: [confirmEmbed] });
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
            ? `<@${user.id}> kullanıcısında \`${warningId}\` kodlu bir uyarı bulunamadı.`
            : `<@${user.id}> kullanıcısının silinecek uyarısı bulunmuyor.`
        );
        return;
      }

      await interaction.editReply(
        `<@${user.id}> kullanıcısından **${res.removedCount}** uyarı silindi (\`${res.removedIds.join(", ")}\`). Kalan aktif uyarı: **${res.remainingCount}**.`
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

    if (sub === "not-ekle") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const noteText = interaction.options.getString("not", true).trim();

      const res = await defender.userLogManager.addStaffNote(
        guild,
        user,
        noteText,
        interaction.user
      );

      await interaction.editReply(
        `<@${user.id}> siciline yetkili notu kaydedildi (\`${res.entry.id}\`). Toplam not: **${res.totalNotes}**.`
      );
      return;
    }

    if (sub === "not-sil") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const user = interaction.options.getUser("kullanici", true);
      const noteId = interaction.options.getString("not_id", false);

      const res = await defender.userLogManager.removeStaffNote(
        guild,
        user.id,
        noteId,
        interaction.user
      );

      if (res.removedCount === 0) {
        await interaction.editReply(
          noteId
            ? `<@${user.id}> kullanıcısında \`${noteId}\` kodlu bir yetkili notu bulunamadı.`
            : `<@${user.id}> kullanıcısının silinecek yetkili notu bulunmuyor.`
        );
        return;
      }

      await interaction.editReply(
        `<@${user.id}> sicilinden **${res.removedCount}** yetkili notu silindi (\`${res.removedIds.join(", ")}\`). Kalan not: **${res.remainingCount}**.`
      );
      return;
    }

    if (sub === "rp-ekle") {
      const user = interaction.options.getUser("kullanici", true);
      const delta = interaction.options.getInteger("adet", false) ?? 1;
      const note =
        interaction.options.getString("not", false) || "Manuel RP kaydı";

      if (user.bot) {
        await interaction.reply({
          content: "Bot hesaplarına RP kaydı eklenemez.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (delta === 0) {
        await interaction.reply({
          content: "Adet 0 olamaz (örnek: `1` veya `-1` girin).",
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
        content: `<@${user.id}> RP sayısı güncellendi (${sign}). Yeni toplam RP sayısı: **${res.totalRpCount}** (Not: ${note}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "yedek") {
      const snap = defender.snapshotManager.captureGuild(guild);
      await interaction.reply({
        content: `Sunucu yedeği alındı: **${Object.keys(snap.roles).length}** rol ve **${Object.keys(snap.channels).length}** kanal kaydedildi.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "olaylar") {
      const g = defender.store.getGuild(guild.id);
      const recent = g.incidents.slice(-10).reverse();
      if (recent.length === 0) {
        await interaction.reply({
          content: "Henüz kaydedilmiş bir güvenlik olayı bulunmuyor.",
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
        .setAuthor({ name: "Defender Adli Olay Kayıtları" })
        .setTitle(`Son Güvenlik Olayları (${guild.name})`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Toplam kayıtlı olay: ${g.incidentCounter}` })
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (err) {
    console.error("[DEFENDER ETKILESIM HATASI]", err);
    const msg =
      "İşlem çalıştırılırken hata oluştu. Botun en üstte yer alan bir Yönetici rolüne sahip olduğundan emin olun.";
    if (interaction.replied && !interaction.deferred) {
      await interaction
        .followUp({ content: msg, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content: msg }).catch(() => {});
    } else {
      await interaction
        .reply({ content: msg, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
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
