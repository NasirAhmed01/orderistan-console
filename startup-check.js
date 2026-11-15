// Startup / health diagnostics. Prints a clear report to the console (Vercel > Project > Logs):
//   - every env key: OK / MISSING / PLACEHOLDER / INVALID  (values are NEVER printed)
//   - live checks: MongoDB ping, Cloudinary ping, Brevo API key + verified sender
// Success lines use console.log, problems use console.error (so Vercel shows them as "Error" level).
const mongoose = require("mongoose");

const PLACEHOLDER = /PASTE_|your_verified|^<.*>$|put_a_long|replace_this/i;
const has = (k) => String(process.env[k] || "").trim().length > 0;
const val = (k) => String(process.env[k] || "").trim();

// level: "required" = backend cannot work properly without it, "warn" = works but a feature is limited
const RULES = [
  { key: "MONGODB_URI", level: "required", test: (v) => /^mongodb(\+srv)?:\/\//.test(v) || "must start with mongodb:// or mongodb+srv://" },
  { key: "JWT_SECRET", level: "required", test: (v) => v.length >= 32 || "must be 32+ characters" },
  { key: "CLOUDINARY_URL", level: "required", test: (v) => /^cloudinary:\/\/\d+:[^@]+@.+/.test(v) || "format: cloudinary://<api_key>:<api_secret>@<cloud_name>" },
  { key: "CRON_SECRET", level: "required", test: () => true },
  { key: "ADMIN_EMAIL", level: "required", test: (v) => /^\S+@\S+\.\S+$/.test(v) || "not a valid e-mail" },
  { key: "BREVO_API_KEY", level: "warn", note: "sign-up / password-reset e-mails will NOT be sent", test: () => true },
  { key: "BREVO_SENDER_EMAIL", level: "warn", note: "sign-up / password-reset e-mails will NOT be sent", test: (v) => /^\S+@\S+\.\S+$/.test(v) || "not a valid e-mail" },
  { key: "ALLOWED_ORIGINS", level: "warn", note: "only the built-in frontends will be allowed by CORS", test: () => true },
  { key: "ROOT_DOMAIN", level: "warn", note: "store sub-domains / main-host checks may not work", test: () => true }
];

// Synchronous: only looks at environment variables.
function checkEnv() {
  const items = RULES.map((r) => {
    const v = val(r.key);
    if (!has(r.key)) return { key: r.key, level: r.level, ok: false, msg: "MISSING" + (r.note ? ` (${r.note})` : "") };
    if (PLACEHOLDER.test(v)) return { key: r.key, level: r.level, ok: false, msg: "still a PLACEHOLDER value" };
    const t = r.test(v);
    if (t !== true) return { key: r.key, level: r.level, ok: false, msg: "INVALID - " + t };
    return { key: r.key, level: r.level, ok: true, msg: "OK" };
  });
  return items;
}

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);

async function checkMongo() {
  try {
    if (mongoose.connection.readyState !== 1) throw new Error("not connected (readyState=" + mongoose.connection.readyState + ")");
    await withTimeout(mongoose.connection.db.admin().ping(), 6000, "MongoDB ping");
    return { name: "MongoDB", ok: true, msg: `connected (db: ${mongoose.connection.name})` };
  } catch (e) { return { name: "MongoDB", ok: false, msg: e.message }; }
}

async function checkCloudinary() {
  if (!has("CLOUDINARY_URL")) return { name: "Cloudinary", ok: false, msg: "CLOUDINARY_URL missing" };
  try {
    const { v2: cloudinary } = require("cloudinary");
    cloudinary.config({ secure: true });
    await withTimeout(cloudinary.api.ping(), 8000, "Cloudinary ping");
    return { name: "Cloudinary", ok: true, msg: `credentials valid (cloud: ${cloudinary.config().cloud_name})` };
  } catch (e) {
    const m = e?.error?.message || e?.message || String(e);
    return { name: "Cloudinary", ok: false, msg: m + " - check CLOUDINARY_URL (api_key / secret / cloud_name)" };
  }
}

async function checkBrevo() {
  const key = val("BREVO_API_KEY"), sender = val("BREVO_SENDER_EMAIL").toLowerCase();
  if (!key || PLACEHOLDER.test(key)) return { name: "Brevo", ok: false, warn: true, msg: "BREVO_API_KEY not set - e-mails disabled" };
  try {
    const H = { "api-key": key, accept: "application/json" };
    const acc = await fetch("https://api.brevo.com/v3/account", { headers: H, signal: AbortSignal.timeout(8000) });
    if (acc.status === 401 || acc.status === 403) return { name: "Brevo", ok: false, msg: `API key rejected (HTTP ${acc.status}) - key wrong, or Brevo blocks this IP (Security > Authorized IPs: deactivate it for Vercel)` };
    if (!acc.ok) return { name: "Brevo", ok: false, msg: `account check failed (HTTP ${acc.status})` };
    if (!sender || PLACEHOLDER.test(sender)) return { name: "Brevo", ok: false, warn: true, msg: "API key OK but BREVO_SENDER_EMAIL is not set" };
    const sres = await fetch("https://api.brevo.com/v3/senders", { headers: H, signal: AbortSignal.timeout(8000) });
    if (sres.ok) {
      const { senders = [] } = await sres.json().catch(() => ({}));
      const hit = senders.find((s) => String(s.email).toLowerCase() === sender);
      if (!hit) return { name: "Brevo", ok: false, msg: `API key OK but sender "${sender}" is NOT in your Brevo senders list - add and verify it` };
      if (hit.active === false) return { name: "Brevo", ok: false, msg: `sender "${sender}" exists but is NOT verified/active yet` };
    }
    return { name: "Brevo", ok: true, msg: `API key valid, sender ${sender} verified` };
  } catch (e) { return { name: "Brevo", ok: false, msg: "could not reach Brevo: " + e.message }; }
}

// Runs everything, prints the report, returns a JSON-safe result.
async function runStartupCheck({ live = true, print = true } = {}) {
  const env = checkEnv();
  const services = live ? await Promise.all([checkMongo(), checkCloudinary(), checkBrevo()]) : [];
  const envBad = env.filter((x) => !x.ok && x.level === "required");
  const envWarn = env.filter((x) => !x.ok && x.level === "warn");
  const svcBad = services.filter((x) => !x.ok && !x.warn);
  const svcWarn = services.filter((x) => !x.ok && x.warn);
  const ok = envBad.length === 0 && svcBad.length === 0;

  if (print) {
    const L = [];
    L.push("================ ORDERISTAN STARTUP CHECK ================");
    L.push(`node ${process.version} | NODE_ENV=${process.env.NODE_ENV || "-"} | ${process.env.VERCEL ? `Vercel (${process.env.VERCEL_ENV || "?"}, region ${process.env.VERCEL_REGION || "?"})` : "local"}`);
    L.push("--- Environment keys ---");
    for (const x of env) L.push(`${x.ok ? "✅" : x.level === "required" ? "❌" : "⚠️ "} ${x.key}: ${x.msg}`);
    if (services.length) {
      L.push("--- Live services ---");
      for (const s of services) L.push(`${s.ok ? "✅" : s.warn ? "⚠️ " : "❌"} ${s.name}: ${s.msg}`);
    }
    L.push("----------------------------------------------------------");
    if (ok && !envWarn.length && !svcWarn.length) L.push("✅✅ ALL OK - backend is running and every env key / service is working.");
    else if (ok) L.push(`✅ Backend is RUNNING, but ${envWarn.length + svcWarn.length} warning(s) above (optional features limited).`);
    else L.push(`❌ BACKEND HAS PROBLEMS: ${envBad.length + svcBad.length} error(s) above. Fix them in Vercel > Settings > Environment Variables, then redeploy.`);
    L.push("==========================================================");
    (ok ? console.log : console.error)(L.join("\n"));
  }
  return { ok, env: Object.fromEntries(env.map((x) => [x.key, x.ok ? "ok" : x.msg])), services: Object.fromEntries(services.map((s) => [s.name, s.ok ? "ok" : s.msg])) };
}

module.exports = { checkEnv, runStartupCheck };
