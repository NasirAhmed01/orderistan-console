// Tiny in-memory TTL caches so that `protect` (User) and `tenant` (Store) do not hit MongoDB on every single request.
// Every write made through Mongoose (see hooks in models.js) invalidates the matching entry in THIS process.
// Other cluster workers pick up the change when the short TTL runs out (15s users, 30s stores).
class TTLCache {
  constructor(ttlMs, max = 5000) { this.ttl = ttlMs; this.max = max; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k, v) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value); // drop the oldest entry
    this.m.set(k, { v, exp: Date.now() + this.ttl });
  }
  del(k) { this.m.delete(String(k)); }
  clear() { this.m.clear(); }
}

module.exports = {
  TTLCache,
  users: new TTLCache(15 * 1000, 5000),   // key: user id
  stores: new TTLCache(30 * 1000, 2000),  // key: store slug
  adminStats: new TTLCache(60 * 1000, 4),
  system: new TTLCache(60 * 1000, 2)      // admin System Overview (e-mail counters, MongoDB size, connection) - see sysmonitor.js
};
