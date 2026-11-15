require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
// Some hosts cannot resolve MongoDB Atlas SRV records with their default DNS. Set DNS_SERVERS=system to use the OS resolver instead.
if (process.env.DNS_SERVERS !== "system") require("node:dns").setServers((process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1").split(",").map((x) => x.trim()).filter(Boolean));
const connectDB = require("./config/db");
const { User } = require("./models");
const { mainHostOnly, sanitize } = require("./guards");
const P = require("./password");
const rl = require("./ratelimit");
const U = require("./utils");
const jobs = require("./jobs");
const plans = require("./plans");
const { runStartupCheck, checkEnv } = require("./startup-check");

let compression = null; try { compression = require("compression"); } catch { console.warn("Tip: run `npm install` to enable gzip compression (package: compression), or enable gzip/brotli in nginx/Cloudflare."); }

const isProd = process.env.NODE_ENV === "production";
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || /put_a_long|replace_this/i.test(process.env.JWT_SECRET)) {
  throw new Error("Set JWT_SECRET (env var) to a random string of 32+ characters.");
}

if (!require("./mailer").configured())
  console.warn(isProd ? "WARNING: BREVO_API_KEY / BREVO_SENDER_EMAIL are not set - sign-up and password-reset e-mails CANNOT be sent." : "Dev mode: Brevo is not configured, one-time codes are printed in this console instead of e-mailed.");

const app = express();
app.disable("x-powered-by");
// 1 = nginx only. 2 = Cloudflare -> nginx -> node. A wrong value gives wrong IPs in logs and rate limits (all users look like ONE IP).
const tp = process.env.TRUST_PROXY;
const trust = tp === undefined || tp === "" ? 1 : (isNaN(tp) ? tp : Number(tp));
app.set("trust proxy", trust);
if (compression) app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"], mediaSrc: ["'self'", "https://res.cloudinary.com"], fontSrc: ["'self'", "data:"], connectSrc: ["'self'"], manifestSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      ...(isProd ? { upgradeInsecureRequests: [] } : {})
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS: only orderistan.site, its store sub-domains, ALLOWED_ORIGINS, and localhost in development.
const ROOT = (process.env.ROOT_DOMAIN || "").toLowerCase();
// Tolerant parsing: accepts commas/spaces/newlines, surrounding quotes and trailing slashes.
const norm = (x) => String(x).trim().replace(/^["\x27]+|["\x27]+$/g, "").replace(/\/+$/, "").toLowerCase();
// Built-in allowed frontends (so nothing needs to be set in Vercel). Extra ones can still be added with ALLOWED_ORIGINS.
const DEFAULT_ORIGINS = ["https://orderistan-frontend-cloudflare.nasirsaeed6767.workers.dev", "https://orderistan-complete.nasirsaeed6767.workers.dev"];
const extraOrigins = [...DEFAULT_ORIGINS, ...(process.env.ALLOWED_ORIGINS || "").split(/[\s,;]+/)].map(norm).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // same-origin / server-to-server
    try {
      const h = new URL(origin).hostname.toLowerCase();
      const ok = extraOrigins.includes(norm(origin)) || (ROOT && (h === ROOT || h.endsWith("." + ROOT))) || (!isProd && (h === "localhost" || h.endsWith(".localhost")));
      cb(null, !!ok);
    } catch { cb(null, false); }
  }
}));
// Diagnostic health check: runs BEFORE the DB middleware and reports what is wrong (no secrets are printed).
// Open https://<project>.vercel.app/api/health -> full env + MongoDB + Cloudinary + Brevo report (also printed in the Vercel logs).
app.get("/api/health", async (_req, res) => {
  try { await init(); }
  catch (e) {
    console.error("❌ /api/health: database/startup failed:", e.message);
    const r = await runStartupCheck({ live: false, print: false });
    return res.status(500).json({ status: "error", stage: "database/startup", message: String(e.message).slice(0, 300), env: r.env });
  }
  const r = await runStartupCheck({ live: true, print: true }).catch((e) => ({ ok: false, error: e.message }));
  res.status(r.ok ? 200 : 500).json({ status: r.ok ? "ok" : "error", service: "Orderistan API", db: "connected", ...r, allowedOrigins: extraOrigins });
});
app.use((req, res, next) => (req.method === "OPTIONS" ? next() : init().then(() => next(), next))); // DB ready before any route
app.use(express.json({ limit: "200kb" }));
app.use(sanitize); // strips $operators and dotted keys from body/query/params

rl.mount(app);     // login / sign-up / orders / uploads (cluster-safe, per user) + general limit (see ratelimit.js)

app.use("/api/auth", require("./routes/auth"));
app.use("/api/market", require("./routes/market"));
app.use("/api/me", mainHostOnly, require("./routes/me"));
app.use("/api/store", require("./routes/store"));
app.use("/api/seller", mainHostOnly, require("./routes/seller"));
app.use("/api/chat", mainHostOnly, require("./routes/chat"));
app.use("/api/admin", mainHostOnly, require("./routes/admin"));
app.use("/api", require("./routes/common"));
app.use("/api", (_req, res) => res.status(404).json({ message: "API route not found." }));

app.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: "File is too large (images max 5 MB)." });
  if (err.name === "MulterError") return res.status(400).json({ message: "Invalid upload." });
  if (err.type === "entity.too.large") return res.status(413).json({ message: "Request is too large." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid request." });
  if (err.code === 11000) return res.status(409).json({ message: "This already exists." });
  if (err.name === "VersionError") return res.status(409).json({ message: "This order was just changed by someone else. Please refresh and try again." });
  if (err.name === "CastError") return res.status(404).json({ message: "Not found." });
  if (err.name === "ValidationError") return res.status(400).json({ message: Object.values(err.errors)[0]?.message || "Invalid data." });
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message });
  if (err.status === 503) return res.status(503).json({ message: err.message });
  console.error(err); res.status(500).json({ message: "Server error. Please try again." });
});

async function seedAdmin() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pw, ADMIN_NAME: name } = process.env;
  if (await User.exists({ role: "admin" })) return;
  if (!email || !pw) return console.warn("No admin yet: set ADMIN_EMAIL and a strong ADMIN_PASSWORD in .env, then restart.");
  if (U.isWeakPassword(pw)) return console.error("Admin NOT created: ADMIN_PASSWORD is weak or a default. " + U.WEAK_ADMIN_MSG);
  try {
    await User.create({ name: name || "Orderistan Owner", email: email.toLowerCase(), password: await P.hash(pw), role: "admin" });
    console.log("Owner admin account created for", email);
  } catch (e) { if (e.code !== 11000) throw e; } // another cluster worker created it a moment ago
}


// ---- serverless bootstrap: connect once per warm instance, reuse on every request ----
let ready = null, reported = false;
function init() {
  if (!ready) ready = connectDB().then(seedAdmin).then(() => plans.seed()).then(() => { report(); }).catch((e) => {
    ready = null;
    console.error("❌ Startup FAILED:", e.message);
    if (/MONGODB_URI/.test(e.message)) console.error("   -> MONGODB_URI is missing in Vercel Environment Variables.");
    else if (/ENOTFOUND|querySrv|ECONNREFUSED|ETIMEDOUT|ServerSelection|whitelist|IP/i.test(e.message)) console.error("   -> Cannot reach MongoDB. Atlas > Network Access: allow 0.0.0.0/0, and check the username/password in MONGODB_URI.");
    else if (/auth/i.test(e.message)) console.error("   -> MongoDB authentication failed: wrong user/password in MONGODB_URI.");
    throw e;
  });
  return ready;
}
// Prints the full ✅/❌ report once per cold start (kept alive with waitUntil so Vercel does not freeze it mid-way).
function report() {
  if (reported) return; reported = true;
  const p = runStartupCheck({ live: true, print: true }).catch((e) => console.error("❌ Startup check crashed:", e.message));
  try { require("@vercel/functions").waitUntil(p); } catch {}
}
process.on("unhandledRejection", (e) => console.error("❌ Unhandled promise rejection:", e && e.stack || e));
process.on("uncaughtException", (e) => console.error("❌ Uncaught exception:", e && e.stack || e));
// export the Express app itself (a function) and attach helpers, so it works even if a platform treats this file as the entry point
app.init = init; app.trust = trust; app.app = app;
module.exports = app;
