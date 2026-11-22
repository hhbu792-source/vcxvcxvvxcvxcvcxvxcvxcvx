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
  { name: "Blacklist (Rolleri al + Blacklist rolu ver)", value: "blacklist" },
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
          "Tek tikla kurulum: log kanali, blacklist rolu ve ilk sunucu yedegini olusturur."
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
        .setName("blacklist")
        .setDescription("Bir uyeyi manuel olarak blacklist'e alir (eski rolleri saklanir).")
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Blacklist'e alinacak uye")
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
        .setName("blacklist-kaldir")
        .setDescription("Blacklist'teki uyeyi cikarir ve eski rollerini geri yukler.")
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Blacklist'i kaldirilacak uye")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("uyari-ver")
        .setDescription(
          "Bir üyeye resmi uyarı verir, DM bildirimi gönderir ve siciline kaydeder."
        )
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Uyarılacak kullanıcı")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("sebep")
            .setDescription("Uyarı sebebi")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("uyari-kaldir")
        .setDescription(
          "Bir üyenin uyarısını siler (ID, 'hepsi' veya boş bırakılırsa son uyarı)."
        )
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Uyarısı silinecek kullanıcı")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("uyari_id")
            .setDescription("Silinecek uyarı ID (W-1), 'hepsi' veya boş (son uyarı)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("uyarilar")
        .setDescription("Bir üyenin tüm kayıtlı uyarılarını listeler.")
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Uyarıları görüntülenecek kullanıcı")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("not-ekle")
        .setDescription(
          "Kullanıcının siciline sadece yöneticilerin göreceği iç not ekler."
        )
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Not eklenecek kullanıcı")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("not")
            .setDescription("Yetkili notu")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("not-sil")
        .setDescription(
          "Kullanıcının yetkili notunu siler (ID, 'hepsi' veya boş bırakılırsa son not)."
        )
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("Notu silinecek kullanıcı")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("not_id")
            .setDescription("Silinecek not ID (N-1), 'hepsi' veya boş (son not)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("rp-ekle")
        .setDescription(
          "Bir üyenin katıldığı RP sayısını manuel artırır veya düzeltir."
        )
        .addUserOption((opt) =>
          opt
            .setName("kullanici")
            .setDescription("RP sayısı güncellenecek kullanıcı")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("adet")
            .setDescription("Eklenecek/çıkarılacak RP sayısı (varsayılan: 1)")
            .setMinValue(-100)
            .setMaxValue(100)
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("not")
            .setDescription("Açıklama veya RP notu (isteğe bağlı)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("uyari-esik")
        .setDescription(
          "Uyarı eşiğinde otomatik timeout veya blacklist kademesini ayarlar."
        )
        .addBooleanOption((opt) =>
          opt
            .setName("aktif")
            .setDescription("Otomatik uyarı kademesi açık mı?")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("timeout_sinir")
            .setDescription("Otomatik susturma için uyarı sayısı (0 = kapalı)")
            .setMinValue(0)
            .setMaxValue(20)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("timeout_dakika")
            .setDescription("Otomatik susturma süresi (dakika, varsayılan: 60)")
            .setMinValue(1)
            .setMaxValue(40320)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("blacklist_sinir")
            .setDescription("Otomatik Blacklist için uyarı sayısı (0 = kapalı)")
            .setMinValue(0)
            .setMaxValue(20)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("istatistik")
        .setDescription(
          "Sunucu geneli RP sıralamasını ve moderasyon istatistiklerini gösterir."
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("yedek")
        .setDescription("Sunucunun rol, kanal ve izin yedeğini (snapshot) anlık olarak alır.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("olaylar")
        .setDescription("Kaydedilen güvenlik olaylarını filtreli ve sayfalı olarak listeler.")
        .addStringOption((opt) =>
          opt
            .setName("modul")
            .setDescription("Olay türüne göre filtrele (isteğe bağlı)")
            .setRequired(false)
            .addChoices(
              { name: "Tümü", value: "ALL" },
              { name: "Anti-Nuke", value: "ANTI_NUKE" },
              { name: "Anti-Raid / Alt-Shield", value: "ANTI_RAID" },
              { name: "Sohbet Koruması", value: "CHAT_DEFENSE" },
              { name: "Uyarılar", value: "WARNING" },
              { name: "Blacklist", value: "BLACKLIST" },
              { name: "Acil Kilit & Ayarlar", value: "CONFIG" }
            )
        )
    );

  const userLog = new SlashCommandBuilder()
    .setName("user-log")
    .setDescription(
      "Admin komutu: Discord ID ile kullanıcının RP, uyarı, ban, kick ve sicil dosyasını açar."
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("id")
        .setDescription("Kullanıcının Discord ID'si (etiket de yazılabilir)")
        .setRequired(true)
    );

  return [defender.toJSON(), userLog.toJSON()];
}

module.exports = { buildCommands, MODULE_CHOICES, PUNISHMENT_CHOICES };
