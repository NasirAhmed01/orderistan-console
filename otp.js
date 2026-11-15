// One-time passcodes (6 digits) for email verification at sign-up and for password reset.
//   - the code is random (crypto.randomInt) and stored only as an HMAC, never in clear text
//   - valid 10 minutes, single use, 5 wrong guesses burn it (the counter is incremented atomically BEFORE the code is compared,
//     so parallel guessing cannot get more than 5 tries)
//   - a new code can be requested once per 60 s and at most 5 times per hour per email+purpose (stops inbox bombing)
const crypto = require("crypto");
const { Otp, MailStat } = require("./models");
const mailer = require("./mailer");

const TTL_MIN = 10, MAX_ATTEMPTS = 5, COOLDOWN_S = 60, MAX_SENDS_HOUR = 5, HOUR = 3600e3;
const { fail } = require("./utils");
const id = (purpose, email) => `${purpose}:${email}`;
const mac = (purpose, email, code) => crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${purpose}|${email}|${code}`).digest("hex");

// Creates (or replaces) the code for purpose+email and returns it. Caller emails it with deliver().
async function issue(email, purpose, payload = null) {
  const _id = id(purpose, email), now = Date.now();
  const cur = await Otp.findOne({ _id }).lean();
  const inWindow = cur?.windowStart && +cur.windowStart > now - HOUR;
  if (inWindow && cur.sends >= MAX_SENDS_HOUR) throw fail(429, "Too many codes requested. Please try again in an hour.");
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  try {
    // Atomic cool-down: this matches only when the previous code was sent more than COOLDOWN_S ago (or never). If it is still
    // cooling down the upsert collides with the existing _id (E11000) and we refuse.
    await Otp.findOneAndUpdate(
      { _id, $or: [{ lastSentAt: { $lte: new Date(now - COOLDOWN_S * 1000) } }, { lastSentAt: { $exists: false } }] },
      { $set: {
          codeHash: mac(purpose, email, code), expiresAt: new Date(now + TTL_MIN * 60000), attempts: 0, lastSentAt: new Date(now), payload,
          sends: inWindow ? cur.sends + 1 : 1, windowStart: inWindow ? cur.windowStart : new Date(now), purgeAt: new Date(now + 2 * HOUR)
      } },
      { upsert: true }
    );
  } catch (e) {
    if (e.code === 11000) throw Object.assign(fail(429, `Please wait ${COOLDOWN_S} seconds before requesting another code.`), { cooldown: true });
    throw e;
  }
  return code;
}

// Sends the code by email. If the mail fails the code is deleted so the person can immediately try again.
async function deliver(email, purpose, code, name) {
  let r;
  try { r = await mailer.sendOtp({ to: email, name, code, purpose, minutes: TTL_MIN }); }
  catch (e) { await Otp.deleteOne({ _id: id(purpose, email) }).catch(() => {}); count(false); throw e; }
  if (!r?.dev) count(true);   // dev mode only prints the code to the console, so it is not a real e-mail and is not counted
}
// Admin analytics: one atomic counter per day. Fire-and-forget; a counting problem must never block a person from getting their code.
// Day boundaries follow ONE configured time zone (STATS_TIMEZONE, default Asia/Karachi), not the server's clock, so "today" means the same
// thing to the admin whether the server runs in UTC or locally.
const STATS_TZ = (() => { const z = process.env.STATS_TIMEZONE || "Asia/Karachi"; try { new Intl.DateTimeFormat("en-CA", { timeZone: z }); return z; } catch { return "UTC"; } })();
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: STATS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });   // en-CA prints YYYY-MM-DD
const dayKey = (d = new Date()) => dayFmt.format(d);
function count(ok) {
  const now = new Date(), day = dayKey(now), _id = `otp:${day}`;
  const upd = { $inc: ok ? { sent: 1 } : { failed: 1 }, $set: ok ? { lastSentAt: now } : { lastFailedAt: now }, $setOnInsert: { kind: "otp", day } };
  MailStat.updateOne({ _id }, upd, { upsert: true })
    .catch((e) => e.code === 11000 ? MailStat.updateOne({ _id }, { $inc: upd.$inc, $set: upd.$set }) : Promise.reject(e))   // two workers created the same day at once
    .catch((e) => console.error("mail stat not recorded:", e.message));
}

// Checks the code. Returns the stored payload and consumes the code (single use). Throws 400 otherwise.
async function verify(email, purpose, code) {
  const _id = id(purpose, email), bad = () => fail(400, "That code is invalid or has expired. Request a new one.");
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) throw fail(400, "Enter the 6-digit code from your email.");
  const d = await Otp.findOneAndUpdate({ _id, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_ATTEMPTS } }, { $inc: { attempts: 1 } }, { new: true }).lean();
  if (!d) throw bad();
  const a = Buffer.from(d.codeHash, "hex"), b = Buffer.from(mac(purpose, email, code), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    if (d.attempts >= MAX_ATTEMPTS) { await Otp.deleteOne({ _id }).catch(() => {}); throw fail(400, "Too many wrong codes. Request a new one."); }
    throw fail(400, `Incorrect code. ${MAX_ATTEMPTS - d.attempts} attempt(s) left.`);
  }
  const used = await Otp.deleteOne({ _id, codeHash: d.codeHash });   // atomic single use: two parallel correct submissions cannot both pass
  if (used.deletedCount !== 1) throw bad();
  return d.payload;
}
// Peek at stored signup data without consuming the code (used by "resend").
const pending = async (email, purpose) => (await Otp.findOne({ _id: id(purpose, email) }).lean())?.payload || null;

module.exports = { issue, deliver, verify, pending, TTL_MIN, dayKey, STATS_TZ };
