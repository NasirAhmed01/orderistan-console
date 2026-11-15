const r = require("express").Router();
const { User, Store } = require("../models");
const { protect, wrap, tenantHost, upload } = require("../guards");
const C = require("../cloud");
const P = require("../password");
const U = require("../utils");

const otp = require("../otp");
const { TERMS_VERSION } = require("../legal");
const mailer = require("../mailer");

// ---- Sign-in protection -------------------------------------------------------------------------------------------------------
// Normal login = email + password, NO code. Defence against password guessing:
//   1. every attempt is COUNTED BEFORE the password is checked (atomic $inc), so 100 parallel guesses still only get LOCK_AFTER checks
//   2. LOCK_AFTER wrong passwords inside FAIL_WINDOW lock the account, and every repeated lock within 24 h is longer
//      (1 min, 5, 15, 60, 6 h, 24 h; owner account x2). The owner of the account gets a security e-mail when it locks.
//   3. a locked account is refused before any bcrypt work, and the correct password does NOT unlock it early
//   4. "Forgot password" (e-mail code) unlocks immediately, so an attacker cannot keep the real owner out
//   5. per IP+email and per IP limiters in ratelimit.js stop one machine that sprays many accounts
const LOCK_AFTER = 5;
const FAIL_WINDOW = 15 * 60 * 1000;
const LOCK_MEMORY = 24 * 3600 * 1000;
const LOCK_STEPS_MIN = [1, 5, 15, 60, 360, 1440];
const lockMinutesFor = (user) => {
  const recent = user.lastLockAt && Date.now() - new Date(user.lastLockAt) < LOCK_MEMORY;
  const m = LOCK_STEPS_MIN[Math.min(recent ? user.lockLevel || 0 : 0, LOCK_STEPS_MIN.length - 1)];
  return user.role === "admin" ? m * 2 : m;
};
const lockedMsg = (mins) => `Too many failed attempts. Sign-in is paused for ${mins} minute(s). If you forgot your password, use "Forgot password".`;
const notLocked = () => ({ $or: [{ lockUntil: { $exists: false } }, { lockUntil: null }, { lockUntil: { $lte: new Date() } }] });

async function lockAccount(req, user) {
  const mins = lockMinutesFor(user), recent = user.lastLockAt && Date.now() - new Date(user.lastLockAt) < LOCK_MEMORY;
  const r = await User.updateOne({ _id: user._id, ...notLocked() },
    { lockUntil: new Date(Date.now() + mins * 60000), lockLevel: (recent ? user.lockLevel || 0 : 0) + 1, lastLockAt: new Date(), failedLogins: 0 });
  if (r.modifiedCount) {   // only the request that really set the lock reports it (parallel requests do not send 5 e-mails)
    U.bg(U.log(req, "auth.account_locked", { email: user.email, minutes: mins }, { actor: user }));
    if (user.email) U.bg(mailer.sendLockAlert({ to: user.email, name: user.name, minutes: mins }));
  }
  return mins;
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const normEmail = (v) => String(v || "").trim().toLowerCase().slice(0, 150);

const withStore = async (user) => {
  const out = { user: U.safeUser(user) };
  if (user.role === "seller") out.store = await Store.findOne({ owner: user._id }).select("slug name status subscription category").lean();
  return out;
};

// ---- Sign-up with e-mail OTP ----------------------------------------------------------------------------------------------------
// Step 1 (register / register-seller): validate everything, hash the password, store the pending sign-up with the code, e-mail the code.
//         NO account exists yet, so nobody can reserve somebody else's e-mail address.
// Step 2 (verify-signup): the right code creates the account and logs the person in.
// Sign-up needs an explicit "I agree" to the Terms of Use, Seller Agreement and Privacy Policy. The version, time and IP are stored with the account.
const needTerms = (req) => { if (req.body.acceptTerms !== true) throw U.fail(400, "You must accept the Terms of Use and Privacy Policy to create an account."); return { version: TERMS_VERSION, at: new Date().toISOString(), ip: String(req.ip || "").slice(0, 64) }; };
const termsOf = (p) => (p.terms ? { version: p.terms.version, at: new Date(p.terms.at), ip: p.terms.ip } : undefined);
const sentReply = (email) => ({ otpRequired: true, email, expiresInMinutes: otp.TTL_MIN, message: `We sent a 6-digit code to ${email}.` });

// Customer sign-up with a username and password. No e-mail is needed; the customer can link a Gmail later from the profile (routes/me.js).
r.post("/register", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 80), phone = String(req.body.phone || "").trim().slice(0, 30);
  const username = String(req.body.username || "").trim().toLowerCase();
  if (name.length < 2) throw U.fail(400, "Name must be at least 2 characters.");
  if (!U.validUsername(username)) throw U.fail(400, "Username: 3-20 characters, start with a letter, use only letters, numbers, _ or . (not admin, seller, support or similar).");
  const password = U.checkPassword(req.body.password, "Password", "");
  const terms = needTerms(req);
  if (await User.exists({ username })) throw U.fail(409, "That username is taken. Choose another.");
  let user;
  try { user = await User.create({ name, username, phone, password: await P.hash(password), role: "customer", terms }); }
  catch (e) { if (e.code === 11000) throw U.fail(409, "That username is taken. Choose another."); throw e; }
  U.bg(U.log(req, "auth.register", { username }, { actor: user }));
  res.status(201).json({ token: U.token(user), ...(await withStore(user)) });
}));

r.post("/register-seller", wrap(async (req, res) => {
  const b = req.body;   // whitelist: no plan/days/role from the client
  const name = String(b.name || "").trim().slice(0, 80), email = normEmail(b.email), phone = String(b.phone || "").trim().slice(0, 30);
  const storeName = String(b.storeName || "").trim().slice(0, 80), slug = String(b.slug || "").trim().toLowerCase(), category = String(b.category || "").trim().toLowerCase();
  if (name.length < 2) throw U.fail(400, "Name must be at least 2 characters.");
  if (!emailOk(email)) throw U.fail(400, "Enter a valid email address.");
  const password = U.checkPassword(b.password, "Password", email);
  if (storeName.length < 2) throw U.fail(400, "Enter your store name.");
  if (!U.validSlug(slug)) throw U.fail(400, "Store link must be 3-30 letters, numbers or hyphens (and not a reserved word).");
  if (category && !["food", "clothing", "services"].includes(category)) throw U.fail(400, "Choose a valid business category.");
  if (await User.exists({ email })) throw U.fail(409, "An account with this email already exists. Try logging in.");
  if (await Store.exists({ slug })) throw U.fail(409, "This store link is already taken.");
  const terms = needTerms(req);
  const payload = { kind: "seller", terms, name, email, phone, storeName, slug, category, passwordHash: await P.hash(password) };
  await otp.deliver(email, "signup", await otp.issue(email, "signup", payload), name);
  res.json(sentReply(email));
}));

r.post("/resend-signup", wrap(async (req, res) => {
  const email = normEmail(req.body.email), p = await otp.pending(email, "signup");
  if (!p) throw U.fail(400, "Your sign-up has expired. Please fill in the form again.");
  await otp.deliver(email, "signup", await otp.issue(email, "signup", p), p.name);
  res.json(sentReply(email));
}));

r.post("/verify-signup", wrap(async (req, res) => {
  const email = normEmail(req.body.email), p = await otp.verify(email, "signup", req.body.code);
  if (!p || p.email !== email) throw U.fail(400, "Your sign-up has expired. Please fill in the form again.");
  let user, store;
  if (p.kind === "seller") {
    ({ user, store } = await U.createSeller({ name: p.name, email, passwordHash: p.passwordHash, phone: p.phone, storeName: p.storeName, slug: p.slug,
      category: p.category, plan: "Basic", days: Number(process.env.TRIAL_DAYS || 0), emailVerified: true, terms: termsOf(p) }));
    U.bg(U.log(req, "seller.signup", { slug: store.slug }, { actor: user, store: store._id }));
    U.bg(U.notifyAdmins("New seller signup", `${store.name} (${store.slug}) is waiting for activation.`, "/admin/sellers"));
    if (store.status === "active") U.bg(U.syncLive(store));
  } else {
    // role is ALWAYS "customer" here, whatever the request body says
    user = await User.create({ name: p.name, email, phone: p.phone, password: p.passwordHash, role: "customer", emailVerified: true, ...(termsOf(p) ? { terms: termsOf(p) } : {}) });
    U.bg(U.log(req, "auth.register", { store: p.store }, { actor: user }));
  }
  res.status(201).json({ token: U.token(user), ...(await withStore(user)) });
}));

// ---- Login (no code) ----------------------------------------------------------------------------------------------------------
r.post("/login", wrap(async (req, res) => {
  // The field holds an e-mail (everyone) or a username (customers only). A username never matches a seller or the owner.
  const email = normEmail(req.body.email), password = String(req.body.password || "");
  if (!email || !password) throw U.fail(400, "Email (or username) and password are required.");
  if (password.length > 200) throw U.fail(401, "Incorrect email or password.");
  const user = await User.findOne(email.includes("@") ? { email } : { username: email, role: "customer" }).select("+password");
  if (!user) {   // unknown e-mail pays the same bcrypt cost (no timing leak) and gives the same answer as a wrong password
    await P.compare(password, P.DUMMY_HASH);
    U.bg(U.log(req, "auth.login_failed", { email }));
    throw U.fail(401, "Incorrect email or password.");
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    U.bg(U.log(req, "auth.login_locked", { email }));
    throw U.fail(429, lockedMsg(Math.max(1, Math.ceil((user.lockUntil - Date.now()) / 60000))));
  }
  // forget old failures (outside the window), then reserve this attempt BEFORE checking the password
  if (user.failedLogins && user.lastFailedAt && user.lastFailedAt < new Date(Date.now() - FAIL_WINDOW))
    await User.updateOne({ _id: user._id, lastFailedAt: { $lt: new Date(Date.now() - FAIL_WINDOW) } }, { failedLogins: 0 });
  const reserved = await User.findOneAndUpdate({ _id: user._id, ...notLocked() }, { $inc: { failedLogins: 1 }, $set: { lastFailedAt: new Date() } }, { new: true }).select("failedLogins");
  if (!reserved) throw U.fail(429, lockedMsg(lockMinutesFor(user)));              // locked by a parallel request a moment ago
  if (reserved.failedLogins > LOCK_AFTER) throw U.fail(429, lockedMsg(await lockAccount(req, user)));

  const ok = await P.compare(password, user.password);
  if (!ok) {
    U.bg(U.log(req, "auth.login_failed", { email }));
    if (reserved.failedLogins >= LOCK_AFTER) throw U.fail(429, lockedMsg(await lockAccount(req, user)));
    throw U.fail(401, "Incorrect email or password.");
  }
  if (user.status === "suspended") throw U.fail(403, "This account is suspended. Contact the administrator.");

  // Seller / owner accounts can only sign in on the main domain, never on a store sub-domain.
  if (user.role !== "customer" && tenantHost(req))
    throw U.fail(403, `Seller and admin accounts must log in at ${process.env.ROOT_DOMAIN || "the main website"}.`);
  // The owner account is never allowed in with a weak/default password.
  if (user.role === "admin" && U.isWeakPassword(password)) {
    U.bg(U.log(req, "auth.admin_weak_password_blocked", { email }, { actor: user }));
    throw U.fail(403, "The owner account still has a weak or default password. On the server run: npm run reset-admin");
  }

  // OWNER ACCOUNT: the password is only the first factor. No token is issued here. A 6-digit code is e-mailed to the owner
  // and the session is created only by POST /auth/admin/verify-login after that code is entered.
  if (user.role === "admin") {
    await User.updateOne({ _id: user._id }, { failedLogins: 0, lockLevel: 0, $unset: { lockUntil: 1, lastFailedAt: 1, lastLockAt: 1 } });
    try { await otp.deliver(user.email, "admin", await otp.issue(user.email, "admin"), user.name); }
    catch (e) { if (!e.cooldown) throw e; }   // a code went out less than 60 s ago and is still valid: do not send another one
    U.bg(U.log(req, "auth.admin_code_sent", {}, { actor: user }));
    return res.json(sentReply(user.email));
  }

  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date(), failedLogins: 0, lockLevel: 0, $unset: { lockUntil: 1, lastFailedAt: 1, lastLockAt: 1 } });
  U.bg(U.log(req, "auth.login", {}, { actor: user }));
  res.json({ token: U.token(user), ...(await withStore(user)) });
}));

// ---- Owner (admin) second factor ----------------------------------------------------------------------------------------------------
// Step 2 of owner sign-in. The code can only exist if the correct password was just checked in /login (otp.issue is called only there),
// and it is bound to the purpose "admin", so a sign-up or password-reset code cannot be used here.
r.post("/admin/verify-login", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!emailOk(email)) throw U.fail(400, "That code is invalid or has expired. Log in again.");
  await otp.verify(email, "admin", req.body.code);                 // single use, 5 wrong tries burn it, 10 minutes
  const user = await User.findOne({ email, role: "admin" });
  if (!user) throw U.fail(400, "That code is invalid or has expired. Log in again.");
  if (user.status === "suspended") throw U.fail(403, "This account is suspended. Contact the administrator.");
  if (tenantHost(req)) throw U.fail(403, `Seller and admin accounts must log in at ${process.env.ROOT_DOMAIN || "the main website"}.`);
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
  U.bg(U.log(req, "auth.login", { second_factor: "email_code" }, { actor: user }));
  res.json({ token: U.token(user), ...(await withStore(user)) });
}));

// ---- Forgot / reset password with e-mail OTP ------------------------------------------------------------------------------------
// The answer is ALWAYS the same, whether or not the e-mail has an account (no account enumeration), and the e-mail is sent after the
// response so the timing does not reveal it either. The owner (admin) account is excluded: reset it on the server with `npm run reset-admin`.
const FORGOT_REPLY = { message: "If an account exists for that email, we sent a 6-digit code. It expires in 10 minutes." };
r.post("/forgot-password", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!emailOk(email)) throw U.fail(400, "Enter a valid email address.");
  res.json(FORGOT_REPLY);
  U.bg((async () => {
    const user = await User.findOne({ email }).select("name role status").lean();
    if (!user || user.role === "admin" || user.status === "suspended") return;
    await otp.deliver(email, "reset", await otp.issue(email, "reset"), user.name);
  })());
}));

r.post("/reset-password", wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const next = U.checkPassword(req.body.password, "New password", email);      // checked BEFORE the code is used, so a weak password does not burn it
  await otp.verify(email, "reset", req.body.code);
  const u = await User.findOne({ email }).select("+password");
  if (!u || u.role === "admin") throw U.fail(400, "That code is invalid or has expired. Request a new one.");
  u.password = await P.hash(next);
  u.tokenVersion = (u.tokenVersion || 0) + 1;                                  // every logged-in device is signed out
  u.failedLogins = 0; u.lockLevel = 0; u.lockUntil = undefined; u.lastFailedAt = undefined; u.lastLockAt = undefined;
  u.emailVerified = true;                                                      // they just proved they own the mailbox
  await u.save();
  U.bg(U.log(req, "auth.password_reset", {}, { actor: u }));
  U.bg(mailer.sendPasswordChanged({ to: u.email, name: u.name }));
  res.json({ message: "Password updated. You can log in now." });
}));

r.get("/me", protect, wrap(async (req, res) => res.json(await withStore(req.user))));

r.put("/me", protect, wrap(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 80);
  if (name.length < 2) throw U.fail(400, "Name must be at least 2 characters.");
  const user = await User.findByIdAndUpdate(req.user._id, { name, phone: String(req.body.phone || "").trim().slice(0, 30) }, { new: true });
  res.json({ user: U.safeUser(user) });
}));

// Profile picture: JPG/PNG/WEBP/GIF up to 5 MB, file type checked from the real bytes, EXIF/GPS stripped, stored on Cloudinary.
r.put("/me/avatar", protect, upload.single("avatar"), wrap(async (req, res) => {
  if (!req.file) throw U.fail(400, "Choose a photo first.");
  const url = await C.uploadPublic(req.file, { folder: "avatars" });
  const old = req.user.avatar;
  const user = await User.findByIdAndUpdate(req.user._id, { avatar: url }, { new: true });
  if (old) C.removePublic(old);
  res.json({ user: U.safeUser(user) });
}));
r.delete("/me/avatar", protect, wrap(async (req, res) => {
  const old = req.user.avatar;
  const user = await User.findByIdAndUpdate(req.user._id, { avatar: "" }, { new: true });
  if (old) C.removePublic(old);
  res.json({ user: U.safeUser(user) });
}));

r.put("/password", protect, wrap(async (req, res) => {
  const u = await User.findById(req.user._id).select("+password");
  const next = U.checkPassword(req.body.next, "New password", u.email);
  if (!(await P.compare(String(req.body.current || "").slice(0, 200), u.password))) throw U.fail(400, "Current password is incorrect.");
  if (next === String(req.body.current)) throw U.fail(400, "Choose a password different from the current one.");
  if (u.role === "admin" && U.isWeakPassword(next)) throw U.fail(400, U.WEAK_ADMIN_MSG);
  u.password = await P.hash(next);
  u.tokenVersion = (u.tokenVersion || 0) + 1;          // every other device/session is logged out
  await u.save();
  U.bg(U.log(req, "auth.password_change"));
  res.json({ message: "Password updated.", token: U.token(u) });   // fresh token keeps THIS session alive
}));

module.exports = r;
