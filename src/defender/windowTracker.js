/**
 * High-precision sliding window rate & burst tracker.
 */
class ActionWindowTracker {
  constructor() {
    /** @type {Map<string, Array<{ ts: number, meta: any }>>} */
    this.buckets = new Map();
  }

  /**
   * Record an event and return the count of events inside [now - windowMs, now].
   */
  record(key, windowMs, meta = null, now = Date.now()) {
    const cutoff = now - windowMs;
    let list = this.buckets.get(key);
    if (!list) {
      list = [];
      this.buckets.set(key, list);
    }

    // Prune expired entries
    let idx = 0;
    while (idx < list.length && list[idx].ts < cutoff) {
      idx += 1;
    }
    if (idx > 0) {
      list.splice(0, idx);
    }

    list.push({ ts: now, meta });
    return {
      count: list.length,
      entries: list,
    };
  }

  getEntries(key, windowMs, now = Date.now()) {
    const list = this.buckets.get(key);
    if (!list) return [];
    const cutoff = now - windowMs;
    return list.filter((e) => e.ts >= cutoff);
  }

  clearKey(key) {
    this.buckets.delete(key);
  }

  clearPrefix(prefix) {
    for (const key of this.buckets.keys()) {
      if (key.startsWith(prefix)) {
        this.buckets.delete(key);
      }
    }
  }

  pruneAll(maxAgeMs = 15 * 60 * 1000, now = Date.now()) {
    const cutoff = now - maxAgeMs;
    for (const [key, list] of this.buckets.entries()) {
      const kept = list.filter((e) => e.ts >= cutoff);
      if (kept.length === 0) {
        this.buckets.delete(key);
      } else if (kept.length !== list.length) {
        this.buckets.set(key, kept);
      }
    }
  }
}

module.exports = { ActionWindowTracker };
