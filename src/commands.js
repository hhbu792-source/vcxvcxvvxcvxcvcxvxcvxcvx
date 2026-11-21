const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  ChannelType,
} = require("discord.js");

const MODULE_CHOICES = [
  { name: "Anti-Nuke (Kanal/Rol/Ban/Kick/Yetki)", value: "antiNuke" },
  { name: "Anti-Raid (Hizli Giris + Oto Kilit)", value: "antiRaid" },
  { name: "Alt-Shield (Yeni/Supheli Hesap)", value: "altShield" },
  { name: "Anti-Spam (Flood/Zalgo/Emoji)", value: "antiSpam" },
  { name: "Anti-Invite (Discord Davet Engel)", value: "antiInvite" },
  { name: "Anti-Phishing (Dolandiricilik Linkleri)", value: "antiPhishing" },
  { name: "Anti-Mention (Toplu Etiket / Everyone)", value: "antiMention" },
  { name: "Anti-Webhook (Yetkisiz Webhook)", value: "antiWebhook" },
  { name: "Anti-Bot (Onaysiz Bot Ekleme)", value: "antiBot" },
  { name: "Anti-Token-Leak (Token/Webhook Sizintisi)", value: "antiTokenLeak" },
  { name: "Oto-Geri Yukleme (Auto-Restore)", value: "autoRestore" },
];

const PUNISHMENT_CHOICES = [
  { name: "Karantina (Rolleri al + KARANTINA + sustur)", value: "quarantine" },
  { name: "Rolleri Al (Strip Roles)", value: "strip_roles" },
  { name: "Sunucudan At (Kick)", value: "kick" },
  { name: "Sunucudan Yasakla (Ban)", value: "ban" },
];

const SCOPE_CHOICES = [
  { name: "Tumu (all)", value: "all" },
  { name: "Sadece Anti-Nuke", value: "antiNuke" },
  { name: "Sadece Anti-Raid", value: "antiRaid" },
  { name: "Sadece Sohbet Korumasi", value: "chatDefense" },
];

function buildCommands() {
  const defender = new SlashCommandBuilder()
    .setName("defender")
    .setDescription("Gelismis Defender sunucu koruma sistemi yonetimi")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("kurulum")
        .setDescription(
          "Tek tikla kurulum: log kanali, karantina rolu ve ilk sunucu yedegini olusturur."
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("durum")
        .setDescription("Tum Defender koruma modullerinin canli durumunu gosterir.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("modul")
        .setDescription("Bir koruma modulunu acar veya kapatir.")
        .addStringOption((opt) =>
          opt
            .setName("ad")
            .setDescription("Degistirilecek koruma modulu")
            .setRequired(true)
            .addChoices(...MODULE_CHOICES)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("aktif")
            .setDescription("Acik (True) / Kapali (False)")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("ceza")
        .setDescription("Saldiri tespitinde uygulanacak varsayilan ceza modunu ayarlar.")
        .addStringOption((opt) =>
          opt
            .setName("mod")
            .setDescription("Ceza modu")
            .setRequired(true)
            .addChoices(...PUNISHMENT_CHOICES)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("log")
        .setDescription("Guvenlik olay kayitlarinin gonderilecegi kanali ayarlar.")
        .addChannelOption((opt) =>
          opt
            .setName("kanal")
            .setDescription("Log kanali")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("whitelist-ekle")
        .setDescription("Guvenli listeye kullanici, rol veya bot ekler (Sunucu Sahibi / Guvenli Admin).")
        .addStringOption((opt) =>
          opt
            .setName("tur")
            .setDescription("Whitelist turu")
            .setRequired(true)
            .addChoices(
              { name: "Kullanici", value: "users" },
              { name: "Rol", value: "roles" },
              { name: "Bot", value: "bots" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("id")
            .setDescription("Kullanici, rol veya bot ID'si (etiket de yazilabilir)")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("kapsam")
            .setDescription("Muafiyet kapsami (varsayilan: all)")
            .setRequired(false)
            .addChoices(...SCOPE_CHOICES)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("whitelist-cikar")
        .setDescription("Guvenli listeden kullanici, rol veya bot cikarir.")
        .addStringOption((opt) =>
          opt
            .setName("tur")
            .setDescription("Whitelist turu")
            .setRequired(true)
            .addChoices(
              { name: "Kullanici", value: "users" },
              { name: "Rol", value: "roles" },
              { name: "Bot", value: "bots" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("id")
            .setDescription("Cikarilacak ID")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("whitelist-liste")
        .setDescription("Guvenli listedeki tum kullanici, rol ve botlari listeler.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("kilit")
        .setDescription("Acil durum kilidini acar ve tum acik kanallari kilitler.")
        .addStringOption((opt) =>
          opt
            .setName("sebep")
            .setDescription("Kilit sebebi (istege bagli)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("kilit-kaldir")
        .setDescription("Acil durum kilidini ve raid modunu kaldirir, eski kanal izinlerini geri yukler.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("karantina")
        .setDescription("Bir uyeyi manuel olarak karantinaya alir (eski rolleri saklanir).")
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Karantinaya alinacak uye")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("sebep")
            .setDescription("Sebep (istege bagli)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("karantina-kaldir")
        .setDescription("Karantinadaki uyeyi cikarir ve eski rollerini geri yukler.")
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Karantinadan cikarilacak uye")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("yedek")
        .setDescription("Sunucunun rol, kanal ve izin yedegini (snapshot) anlik olarak alir.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("olaylar")
        .setDescription("Son kaydedilen guvenlik olaylarini listeler.")
    );

  return [defender.toJSON()];
}

module.exports = { buildCommands, MODULE_CHOICES, PUNISHMENT_CHOICES };
