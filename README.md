# Discord Defender Botu

Sunucu koruma (Guard) odaklı, çok katmanlı **Defender Sistemi**.

## Defender Katmanları

1. **Anti-Nuke & Audit Log Adli Takip (`src/defender/antiNuke.js`)**
   - Kanal silme saldırısı (toplu silinen tüm kanalları yedekten otomatik geri yükler)
   - Kanal oluşturma spamı (spam kanalları otomatik siler) ve toplu kanal düzenleme koruması
   - Rol silme saldırısı (silinen rolleri renk ve izinleriyle geri yükler) ve rol oluşturma spamı
   - **Anlık Yetki Yükseltme Koruması:** Whitelist dışındaki biri bir role kritik izin (`Administrator`, `ManageGuild`, `ManageRoles`, `ManageChannels`, `ManageWebhooks`, `BanMembers`, `KickMembers` vb.) eklerse anında geri alır ve saldırganı cezalandırır
   - **Anlık Kritik Rol Verme Koruması:** Whitelist dışındaki biri bir üyeye kritik yetkili rol verirse rolü anında geri alır ve vereni cezalandırır
   - Toplu Ban (`Mass Ban`), Toplu Kick (`Mass Kick`), Toplu Emoji/Sticker silme koruması
   - Sunucu ayarı sabotajı (sunucu adı / doğrulama seviyesi değişimini geri alır)
   - **Anti-Bot:** Onaylı (whitelist) olmayan bot eklendiğinde botu anında atar ve ekleyen kişiyi cezalandırır
   - **Anti-Webhook:** İzinsiz webhook açıldığında webhook'u anında siler ve açanı cezalandırır
   - **Öz-Savunma:** Blacklist rolü (`1573704309034586286`) veya `#defender-log` kanalı kurcalanırsa anında engeller ve geri yükler

2. **Anti-Raid & Yan Hesap Kalkanı (`src/defender/antiRaid.js`)**
   - Hızlı giriş patlamasını (varsayılan 12 saniyede 6 giriş) algılayıp **Raid Modu** ve **Otomatik Acil Kilit** açar, saldırı dalgasındaki hesapları izole eder
   - **Risk Puanlama (0-100):** Hesap yaşı, varsayılan profil fotoğrafı ve koordineli benzer kullanıcı adı dalgalarını (`raider_01`, `raider_02`, `raider_03`...) puanlayarak şüpheli hesapları otomatik engeller

3. **Çok Katmanlı Sohbet Koruması (`src/defender/chatDefense.js`)**
   - **Token & Webhook Sızıntı Koruması:** Sohbete yapıştırılan Discord Bot Token veya Webhook URL'lerini herkes için (adminler dahil) anında siler ve uyarır
   - **Phishing / Dolandırıcılık Kalkanı:** Sahte Discord/Steam/Nitro alan adları, IP adresli linkler ve maskelenmiş sahte Markdown linkleri (`[discord.com](https://zararli.xyz)`) engeller (mesaj düzenlemeleri dahil)
   - **Davet Engelleyici:** Sunucu dışı Discord davet linklerini ve boşluklu gizleme girişimlerini engeller
   - **Toplu Etiket & `@everyone`/`@here` Koruması**
   - **Anti-Spam:** Hızlı mesaj burst, aynı mesaj tekrarı, satır duvarı, Zalgo bozuk karakter ve aşırı emoji flood koruması
   - **Kademeli Ceza Merdiveni:** 1. İhlal (Sil + Uyarı) -> 2. İhlal (1 dk Timeout) -> 3. İhlal (10 dk Timeout) -> 4. İhlal (Otomatik Blacklist)

4. **Sunucu Yedeği & Oto-Geri Yükleme (`src/defender/snapshotManager.js`)**
   - Sunucunun tüm rol, kanal, kategori ve kanal izin overwrites yapısını periyodik olarak yedekler ve saldırı sonrası otomatik geri yükler

5. **Blacklist Kasası, Acil Kilit & Olay Kayıtları (`src/defender/punishmentEngine.js`)**
   - Blacklist'e alınan üyenin eski rolleri saklanır ve `1573704309034586286` rolü verilir; `/defender blacklist-kaldir` ile eski roller eksiksiz geri verilir
   - Acil kilitte her kanalın mevcut `@everyone` izinleri kaydedilir; `/defender kilit-kaldir` ile eski izinler aynen geri yüklenir
   - Her güvenlik olayı `#INC-1`, `#INC-2` şeklinde numaralandırılarak `#defender-log` kanalına kaydedilir

## Slash Komutları (`/defender`)

| Komut | Açıklama |
| --- | --- |
| `/defender kurulum` | `#defender-log`, Blacklist rolü (`1573704309034586286`) ve ilk sunucu yedeğini tek tıkla kurar |
| `/defender durum` | Tüm koruma modüllerinin canlı durumunu gösterir |
| `/defender modul <ad> <aktif>` | İstenen koruma modülünü açar/kapatır *(Sunucu Sahibi / Whitelist Admin)* |
| `/defender ceza <mod>` | Ceza modunu seçer (`blacklist`, `strip_roles`, `kick`, `ban`) *(Sunucu Sahibi / Whitelist Admin)* |
| `/defender log <kanal>` | Güvenlik log kanalını ayarlar |
| `/defender whitelist-ekle <tur> <id> [kapsam]` | Güvenli listeye kullanıcı, rol veya bot ekler |
| `/defender whitelist-cikar <tur> <id>` | Güvenli listeden çıkarır |
| `/defender whitelist-liste` | Güvenli listeyi gösterir |
| `/defender kilit [sebep]` | Acil durum sunucu kilidini açar |
| `/defender kilit-kaldir` | Kilidi ve raid modunu kaldırıp eski izinleri geri yükler |
| `/defender blacklist <kullanici> [sebep]` | Üyeyi manuel blacklist'e alır (`1573704309034586286` rolü verilir) |
| `/defender blacklist-kaldir <kullanici>` | Blacklist'i kaldırır ve eski rolleri geri verir |
| `/defender yedek` | Anlık sunucu yedeği (snapshot) alır |
| `/defender olaylar` | Son 10 güvenlik olayını listeler |

## Kurulum

1. Discord Developer Portal -> **Bot -> Privileged Gateway Intents** altında **`SERVER MEMBERS INTENT`** ve **`MESSAGE CONTENT INTENT`** seçeneklerini açın.
2. Botu sunucuya **Administrator** yetkisiyle davet edin ve **bot rolünü sunucu rol listesinde en üste** (Sunucu Sahibi hariç tüm yetkili rollerin üstüne) taşıyın.
3. `.env.example` dosyasını `.env` olarak kopyalayıp `DISCORD_TOKEN` değerini girin ve başlatın:
   ```bash
   cp .env.example .env
   npm install
   npm start
   ```
