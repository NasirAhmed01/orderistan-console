// Admin "System Overview": Brevo OTP e-mail counters, MongoDB Atlas storage, connection health and last successful database sync.
// Every figure comes from the live system (MailStat counters written by otp.js, MongoDB's dbStats, a real ping + acknowledged write).
// A section that cannot be measured is returned as null and the UI shows "Not Available" - nothing is estimated or made up.
// Results are cached for 60 s (cache.system) and concurrent requests share one in-flight computation, so opening the dashboard in
// several tabs never multiplies the work on the database.
const mongoose = require("mongoose");
const { MailStat } = require("./models");
const cache = require("./cache");
const mailer = require("./mailer");
const { dayKey, STATS_TZ } = require("./otp");

const CAPACITY_MB = (() => { const n = Number(process.env.DB_CAPACITY_MB); return Number.isFinite(n) && n > 0 ? n : 512; })();   // Atlas M0 (free) = 512 MB
const WARN = 80, CRIT = 95;
const MB = 1024 * 1024, r2 = (n) => Math.round(n * 100) / 100;
const STATES = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
// Own tiny collection (not "settings"): older databases have a unique index on settings.key that rejects a second document without a key.
const sysState = () => mongoose.connection.collection("sysstate");
const withTimeout = (p, ms = 5000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref())]);
// Raw driver errors are logged on the server only. The browser gets a short, safe reason (never a connection string or stack trace).
const errors = {};
const reason = (e) => /timeout|timed out|MaxTimeMS/i.test(e?.message || "") || e?.code === 50 ? "Timed out" : (e?.code === 13 || /not authorized|unauthorized/i.test(e?.message || "")) ? "The database user is not permitted to run this check" : "The check failed";
const fail = (what, e, key) => { console.error(`system overview: ${what} unavailable:`, e?.message || e); if (key) errors[key] = reason(e); return null; };

let lastOk = null;   // in-memory copy of the last successful probe, used when the database cannot even be read

// Health check = a real ping to MongoDB. The time of the last ping that succeeded is remembered (in memory, and in the settings collection by the
// 5-minute heartbeat in jobs.js so it survives restarts). This is a connectivity check, NOT a data-synchronisation event: Orderistan has no sync job.
async function probe({ persist = false } = {}) {
  const t0 = Date.now();
  await withTimeout(mongoose.connection.db.admin().ping());
  const latencyMs = Date.now() - t0, at = new Date();
  lastOk = at;
  if (persist) await withTimeout(sysState().updateOne({ _id: "dbHealthCheck" }, { $set: { at } }, { upsert: true }));
  return { latencyMs, at };
}

async function database() {
  const state = STATES[mongoose.connection.readyState] || "disconnected";
  const out = { status: state, connected: state === "connected", latencyMs: null, lastHealthCheckAt: null,
    sync: { available: false, reason: "Orderistan has no database sync job, so there is no sync time to report. MongoDB Atlas replicates its own nodes internally." } };
  if (out.connected) {
    try { const p = await probe(); out.latencyMs = p.latencyMs; out.lastHealthCheckAt = p.at; }
    catch (e) { fail("database health check", e, "database"); out.status = "unreachable"; out.connected = false; }
  }
  if (!out.lastHealthCheckAt) {   // not reachable right now: show the last time it did work
    try { const v = (await withTimeout(sysState().findOne({ _id: "dbHealthCheck" })))?.at; if (v) out.lastHealthCheckAt = new Date(v); } catch {}
    if (!out.lastHealthCheckAt && lastOk) out.lastHealthCheckAt = lastOk;
  }
  return out;
}

async function storage() {
  try {
    const s = await withTimeout(mongoose.connection.db.command({ dbStats: 1, scale: 1, maxTimeMS: 5000 }), 8000);
    const data = Number(s.dataSize), index = Number(s.indexSize);
    if (!Number.isFinite(data) || !Number.isFinite(index)) return null;
    const usedMB = (data + index) / MB, percent = Math.min(100, (usedMB / CAPACITY_MB) * 100);
    return {
      usedMB: r2(usedMB), remainingMB: r2(Math.max(0, CAPACITY_MB - usedMB)), capacityMB: CAPACITY_MB, percent: r2(percent),
      // The limit is a CONFIGURED threshold (DB_CAPACITY_MB, default 512 = the Atlas free-tier size). It is not read from Atlas: that needs an Atlas API key.
      capacitySource: process.env.DB_CAPACITY_MB ? "configured" : "default",
      level: percent >= CRIT ? "critical" : percent >= WARN ? "warning" : "ok",   // 80 % = warning, 95 % = critical
      dataMB: r2(data / MB), indexMB: r2(index / MB), collections: Number(s.collections) || 0, objects: Number(s.objects) || 0
    };
  } catch (e) { return fail("storage", e, "storage"); }
}

// One pass over the daily counter rows (about 1 per day). Total/month/today are summed in the database.
async function email() {
  try {
    const now = new Date(), today = dayKey(now), month = today.slice(0, 7);
    const [a] = await withTimeout(MailStat.aggregate([
      { $match: { kind: "otp" } },
      { $group: { _id: null,
          total: { $sum: "$sent" }, failed: { $sum: "$failed" },
          today: { $sum: { $cond: [{ $eq: ["$day", today] }, "$sent", 0] } }, failedToday: { $sum: { $cond: [{ $eq: ["$day", today] }, "$failed", 0] } },
          month: { $sum: { $cond: [{ $eq: [{ $substrCP: ["$day", 0, 7] }, month] }, "$sent", 0] } }, failedMonth: { $sum: { $cond: [{ $eq: [{ $substrCP: ["$day", 0, 7] }, month] }, "$failed", 0] } },
          since: { $min: "$day" }, lastSentAt: { $max: "$lastSentAt" }, lastFailedAt: { $max: "$lastFailedAt" } } }
    ]).option({ maxTimeMS: 5000 }));
    return {
      provider: "Brevo", configured: mailer.configured(),
      today: a?.today || 0, month: a?.month || 0, total: a?.total || 0, failed: a?.failed || 0, failedToday: a?.failedToday || 0, failedMonth: a?.failedMonth || 0,
      trackingSince: a?.since || null, lastSentAt: a?.lastSentAt || null, lastFailedAt: a?.lastFailedAt || null
    };
  } catch (e) { return fail("e-mail counters", e, "email"); }
}

let inflight = null;
async function snapshot({ force = false } = {}) {
  const hit = cache.system.get("overview");
  if (hit && !(force && Date.now() - hit.at > 10000)) return { ...hit, cached: true };   // a forced refresh is honoured at most every 10 s
  if (!inflight) inflight = (async () => {
    for (const k of Object.keys(errors)) delete errors[k];
    const [db, st, em] = await Promise.all([database(), storage(), email()]);   // independent, so one failing source never hides the others
    const out = { generatedAt: new Date().toISOString(), at: Date.now(), cached: false, timezone: STATS_TZ, database: db, storage: st, email: em, errors: { ...errors }, thresholds: { warning: WARN, critical: CRIT } };
    cache.system.set("overview", out); return out;
  })().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { snapshot, probe };
