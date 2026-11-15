// Rate limiting that is NOT only "per IP".
//   - Pakistani mobile networks (Jazz/Zong/Ufone) put thousands of people behind one IP (CGNAT), so logged-in users are counted
//     per USER id and anonymous browsing gets a generous per-IP budget.
//   - Sensitive limiters (login, sign-up, orders, uploads) keep their counters in MongoDB, so they survive restarts and are shared
//     by every pm2 cluster worker. The busy general limiter stays in memory (no DB op per page view).
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");

// Signature-checked only (no DB call). A forged/expired token simply falls back to the IP key.
function whoKey(req) {
  if (req._rk) return req._rk;
  const [scheme, tok] = (req.headers.authorization || "").split(" ");
  let key = null;
  if (scheme === "Bearer" && tok) {
    try { key = "u:" + jwt.verify(tok, process.env.JWT_SECRET, { algorithms: ["HS256"] }).sub; } catch { /* fall through */ }
  }
  return (req._rk = key || "ip:" + req.ip);
}

class MongoStore {
  constructor(prefix) { this.prefix = prefix + ":"; this.windowMs = 60000; }
  init(options) { this.windowMs = options.windowMs; }
  get col() { return mongoose.connection.collection("ratelimits"); }
  async increment(key) {
    const k = this.prefix + key, now = new Date();
    try {
      for (let i = 0; i < 3; i++) {
        // 1) live window: atomic +1
        let d = await this.col.findOneAndUpdate({ _id: k, expiresAt: { $gt: now } }, { $inc: { hits: 1 } }, { returnDocument: "after" });
        if (!d) {
          // 2) no live window: start a new one (matches only an EXPIRED doc; if a live one appeared meanwhile the upsert hits a
          //    duplicate key and we loop back to step 1)
          try {
            d = await this.col.findOneAndUpdate({ _id: k, expiresAt: { $lte: now } },
              { $set: { hits: 1, expiresAt: new Date(+now + this.windowMs) } }, { upsert: true, returnDocument: "after" });
          } catch (e) { if (e.code === 11000) continue; throw e; }
        }
        return { totalHits: d.hits, resetTime: d.expiresAt };
      }
    } catch (e) { console.error("ratelimit store:", e.message); } // fail open: a DB hiccup must not lock everybody out
    return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
  }
  async decrement(key) { await this.col.updateOne({ _id: this.prefix + key }, { $inc: { hits: -1 } }).catch(() => {}); }
  async resetKey(key) { await this.col.deleteOne({ _id: this.prefix + key }).catch(() => {}); }
}

// shared = true -> counters live in MongoDB (cluster-safe). Otherwise in this process's memory.
const make = (name, o, shared) => rateLimit({
  standardHeaders: true, legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  ...(shared ? { store: new MongoStore(name) } : {}),
  ...o
});

const msg = (m) => ({ message: m });
const loginMsg = msg("Too many login attempts. Try again in 15 minutes.");

function mount(app) {
  const ipEmail = (req) => `${req.ip}|${String(req.body?.email || "").toLowerCase().slice(0, 100)}`;

  // --- auth (counted per IP + email, per IP, and per user) ---
  app.use("/api/auth/login", make("login-ip-email", { windowMs: 15 * 60 * 1000, limit: 8, skipSuccessfulRequests: true, keyGenerator: ipEmail, message: loginMsg }, true));
  app.use("/api/auth/login", make("login-ip", { windowMs: 15 * 60 * 1000, limit: 60, skipSuccessfulRequests: true, keyGenerator: (r) => r.ip, message: loginMsg }, true));
  app.use(["/api/auth/register", "/api/auth/register-seller"], make("signup", { windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: (r) => r.ip, message: msg("Too many sign-ups from this network. Try again later.") }, true));
  // --- e-mail codes (sign-up verification + password reset). Each send costs an e-mail, each check could be a guess. ---
  const codeMsg = msg("Too many attempts. Please wait a few minutes and try again.");
  app.use(["/api/auth/forgot-password", "/api/auth/resend-signup"], make("otp-send-ip", { windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: (r) => r.ip, message: codeMsg }, true));
  app.use(["/api/auth/forgot-password", "/api/auth/resend-signup"], make("otp-send-email", { windowMs: 60 * 60 * 1000, limit: 6, keyGenerator: (r) => String(r.body?.email || "").toLowerCase().slice(0, 100) || r.ip, message: codeMsg }, true));
  app.use(["/api/auth/verify-signup", "/api/auth/reset-password", "/api/auth/admin/verify-login"], make("otp-check-ip-email", { windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: ipEmail, message: codeMsg }, true));
  app.use(["/api/auth/verify-signup", "/api/auth/reset-password", "/api/auth/admin/verify-login"], make("otp-check-ip", { windowMs: 15 * 60 * 1000, limit: 60, keyGenerator: (r) => r.ip, message: codeMsg }, true));
  app.use("/api/auth/password", make("password", { windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: whoKey, message: msg("Too many attempts. Try again later.") }, true));

  // --- writes that cost money/storage: per USER (falls back to IP when there is no valid token) ---
  const writesOnly = (req) => !["POST", "PUT", "PATCH"].includes(req.method);
  app.use(["/api/seller/products", "/api/seller/store/images"], make("uploads", { windowMs: 60 * 60 * 1000, limit: 200, skip: writesOnly, keyGenerator: whoKey, message: msg("Too many uploads. Try again later.") }, true));
  app.use("/api/auth/me/avatar", make("avatar", { windowMs: 60 * 60 * 1000, limit: 20, skip: writesOnly, keyGenerator: whoKey, message: msg("Too many photo changes. Try again later.") }, true));
  app.use("/api/chat/messages", make("chat", { windowMs: 60 * 1000, limit: 25, skip: writesOnly, keyGenerator: whoKey, message: msg("You are sending too fast. Please wait a moment.") }, true));
  app.use("/api/seller/subscription", make("subreq", { windowMs: 60 * 60 * 1000, limit: 20, skip: writesOnly, keyGenerator: whoKey, message: msg("Too many requests. Try again later.") }, true));
  app.use("/api/store/orders", make("orders", { windowMs: 60 * 60 * 1000, limit: 60, skip: writesOnly, keyGenerator: whoKey, message: msg("Too many order actions. Try again later.") }, true));

  // --- linking a Gmail to a customer account: each send costs an e-mail, each check is a guess ---
  app.post("/api/me/gmail", make("gmail-send-user", { windowMs: 60 * 60 * 1000, limit: 8, keyGenerator: whoKey, message: msg("Too many codes requested. Try again later.") }, true));
  app.post("/api/me/gmail/verify", make("gmail-check-user", { windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: whoKey, message: msg("Too many attempts. Please wait a few minutes and try again.") }, true));

  app.use("/api/consent", make("consent", { windowMs: 60 * 60 * 1000, limit: 40, keyGenerator: (r) => r.ip, message: msg("Too many requests. Try again later.") }, false));

  // --- everything else: logged-in = 400/min per user, anonymous = 1200/min per IP (a whole mobile-carrier IP can browse) ---
  app.use("/api", make("general", {
    windowMs: 60 * 1000, keyGenerator: whoKey,
    limit: (req) => (whoKey(req).startsWith("u:") ? 400 : 1200),
    skip: (req) => req.path === "/health"
  }, false));
}

module.exports = { mount, whoKey, MongoStore };
