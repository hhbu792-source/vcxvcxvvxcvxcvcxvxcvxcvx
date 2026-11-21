const { ActionWindowTracker } = require("./windowTracker");

function normalizeUsernameRoot(username) {
  const clean = String(username || "")
    .toLowerCase()
    .replace(/[0-9_\-.]+$/g, "")
    .replace(/[^a-z0-9]/g, "");
  return clean.length >= 3 ? clean : "";
}

class AntiRaidEngine {
  /**
   * @param {import('./store').DefenderStore} store
   * @param {import('./punishmentEngine').PunishmentEngine} punishmentEngine
   * @param {object} options
   */
  constructor(store, punishmentEngine, options = {}) {
    this.store = store;
    this.punishmentEngine = punishmentEngine;
    this.tracker = new ActionWindowTracker();
    this.logger = options.logger || console;

    /** Map<guildId, { activeUntil: number, triggeredAt: number, waveCount: number }> */
    this.raidModes = new Map();
  }

  isRaidModeActive(guildId) {
    const state = this.raidModes.get(guildId);
    if (!state) return false;
    if (Date.now() > state.activeUntil) {
      this.raidModes.delete(guildId);
      return false;
    }
    return true;
  }

  clearRaidMode(guildId) {
    this.raidModes.delete(guildId);
  }

  /**
   * Calculate an account risk score (0-100) based on age, avatar, and coordinated username patterns.
   */
  assessMemberRisk(member, recentWaveEntries, thresholds, now = Date.now()) {
    let score = 0;
    const reasons = [];

    const createdTs = member.user?.createdTimestamp || now;
    const ageMs = Math.max(0, now - createdTs);
    const ageHours = ageMs / (60 * 60 * 1000);
    const ageDays = ageHours / 24;

    if (ageHours < 1) {
      score += 55;
      reasons.push("Hesap 1 saatten yeni");
    } else if (ageHours < 24) {
      score += 40;
      reasons.push(`Hesap 24 saatten yeni (${Math.floor(ageHours)} saat)`);
    } else if (ageDays < thresholds.minAccountAgeDays) {
      score += 25;
      reasons.push(
        `Yeni hesap (${Math.floor(ageDays)} gün < ${thresholds.minAccountAgeDays} gün)`
      );
    }

    if (!member.user?.avatar) {
      score += 20;
      reasons.push("Varsayılan profil fotoğrafı");
    }

    // Coordinated username similarity wave detection (e.g., raider_01, raider_02, raider_03)
    const root = normalizeUsernameRoot(member.user?.username);
    if (root) {
      const sameRootCount = recentWaveEntries.filter(
        (e) => e.meta?.usernameRoot === root
      ).length;
      if (sameRootCount >= 3) {
        score += 45;
        reasons.push(
          `Koordineli benzer kullanıcı adı dalgası ("${root}*", ${sameRootCount} hesap)`
        );
      }
    }

    return {
      score: Math.min(100, score),
      ageDays: Math.floor(ageDays * 10) / 10,
      reasons,
    };
  }

  async onGuildMemberAdd(member) {
    const guild = member?.guild;
    if (!guild || !member?.user || member.user.bot) {
      return { triggered: false };
    }

    const g = this.store.getGuild(guild.id);
    if (!g.enabled) return { triggered: false };

    if (this.store.isWhitelisted(guild, member, "antiRaid")) {
      return { triggered: false, whitelisted: true };
    }

    const now = Date.now();
    const usernameRoot = normalizeUsernameRoot(member.user.username);

    // Record in both rapid join window and 60s pattern-analysis window
    const joinKey = `${guild.id}:joins`;
    const patternKey = `${guild.id}:joinPatterns`;

    const joinRes = this.tracker.record(
      joinKey,
      g.thresholds.raidJoinWindowMs,
      { member, userId: member.id, usernameRoot },
      now
    );
    const patternRes = this.tracker.record(
      patternKey,
      60_000,
      { userId: member.id, usernameRoot },
      now
    );

    // 1. Check Active Raid Mode or New Join-Burst Raid Trigger
    if (g.modules.antiRaid) {
      const alreadyRaid = this.isRaidModeActive(guild.id);
      const velocityTriggered = joinRes.count >= g.thresholds.raidJoinCount;

      if (velocityTriggered && !alreadyRaid) {
        this.raidModes.set(guild.id, {
          activeUntil: now + g.thresholds.raidModeDurationMs,
          triggeredAt: now,
          waveCount: joinRes.count,
        });

        let lockdownResult = null;
        if (g.thresholds.raidAutoLockdown && !g.lockdown.active) {
          lockdownResult = await this.punishmentEngine.enableLockdown(
            guild,
            `Anti-Raid otomatik acil kilit (${joinRes.count} giris / ${Math.round(g.thresholds.raidJoinWindowMs / 1000)}sn)`,
            "Defender/ANTI_RAID"
          );
        }

        // Punish all members caught in the triggering raid burst
        let neutralized = 0;
        const seen = new Set();
        for (const entry of joinRes.entries) {
          const uid = entry.meta?.userId;
          if (!uid || seen.has(uid)) continue;
          seen.add(uid);
          if (this.store.isWhitelisted(guild, uid, "antiRaid")) continue;
          const p = await this.punishmentEngine.punishExecutor(guild, uid, {
            module: "ANTI_RAID",
            reason: `Raid dalgasi tespiti (${joinRes.count} hizli giris)`,
          });
          if (p.ok) neutralized += 1;
        }

        await this.punishmentEngine.logIncident(guild, {
          module: "ANTI_RAID",
          severity: "CRITICAL",
          action: "Raid Saldırısı Tespit Edildi (Oto-Koruma Aktif)",
          executorId: member.id,
          target: `${joinRes.count} hesap / ${Math.round(g.thresholds.raidJoinWindowMs / 1000)}sn`,
          details:
            `Ani giriş artışı algılandı. Raid modu ${Math.round(g.thresholds.raidModeDurationMs / 60000)} dakika boyunca aktif edildi.`,
          punishment: `${neutralized} hesap engellendi (${g.punishmentMode})`,
          restored: lockdownResult?.ok
            ? `${lockdownResult.lockedCount} kanal otomatik kilitlendi.`
            : null,
        });

        return {
          triggered: true,
          type: "RAID_BURST",
          raidActivated: true,
          neutralized,
          lockdownResult,
        };
      }

      if (alreadyRaid) {
        const punish = await this.punishmentEngine.punishExecutor(
          guild,
          member.id,
          {
            module: "ANTI_RAID",
            reason: "Aktif Raid Modu sirasinda sunucuya giris",
          }
        );

        await this.punishmentEngine.logIncident(guild, {
          module: "ANTI_RAID",
          severity: "HIGH",
          action: "Raid Modu Girişi Engellendi",
          executorId: member.id,
          target: `${member.user.username} (\`${member.id}\`)`,
          details: "Aktif Raid Modu sırasında katılan hesap otomatik izole edildi.",
          punishment: punish.action,
        });

        return { triggered: true, type: "RAID_MODE_JOIN", punish };
      }
    }

    // 2. Suspicious Alt-Account & Coordinated Username Risk Shield
    if (g.modules.altShield) {
      const risk = this.assessMemberRisk(
        member,
        patternRes.entries,
        g.thresholds,
        now
      );

      if (risk.score >= g.thresholds.suspiciousRiskThreshold) {
        const punish = await this.punishmentEngine.punishExecutor(
          guild,
          member.id,
          {
            module: "ALT_SHIELD",
            reason: `Yuksek riskli hesap (Skor: ${risk.score}/100 - ${risk.reasons.join(", ")})`,
          }
        );

        await this.punishmentEngine.logIncident(guild, {
          module: "ALT_SHIELD",
          severity: risk.score >= 80 ? "HIGH" : "MEDIUM",
          action: `Şüpheli / Yan Hesap Engellendi (Risk: ${risk.score}/100)`,
          executorId: member.id,
          target: `${member.user.username} (\`${member.id}\`)`,
          details: `Tespit nedenleri:\n- ${risk.reasons.join("\n- ")}`,
          punishment: punish.action,
        });

        return { triggered: true, type: "SUSPICIOUS_ACCOUNT", risk, punish };
      }
    }

    return { triggered: false };
  }
}

module.exports = { AntiRaidEngine, normalizeUsernameRoot };
