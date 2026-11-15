// Sets (or replaces) the owner/admin login and logs out every existing admin session.
//   1. put a NEW strong ADMIN_EMAIL + ADMIN_PASSWORD in backend/.env
//   2. npm run reset-admin
//   3. delete ADMIN_PASSWORD from .env afterwards
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("node:dns").setServers(["8.8.8.8", "1.1.1.1"]);
const P = require("../password");
const connectDB = require("../config/db");
const { User } = require("../models");
const U = require("../utils");

const die = (m) => { console.error("\nERROR: " + m + "\n"); process.exit(1); };

(async () => {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const pw = String(process.env.ADMIN_PASSWORD || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die("Set a valid ADMIN_EMAIL in backend/.env");
  if (U.isWeakPassword(pw)) die(U.WEAK_ADMIN_MSG + "\nTip: openssl rand -base64 24");
  await connectDB();

  const admins = await User.find({ role: "admin" }).sort({ createdAt: 1 });
  if (admins.length > 1) console.warn(`WARNING: ${admins.length} admin accounts exist. Only the first is reset - review the others in the database.`);
  const clash = await User.findOne({ email, ...(admins[0] ? { _id: { $ne: admins[0]._id } } : {}) });
  if (clash) die("That email already belongs to another account. Choose a different ADMIN_EMAIL.");

  const hash = await P.hash(pw);
  if (!admins[0]) {
    await User.create({ name: process.env.ADMIN_NAME || "Orderistan Owner", email, password: hash, role: "admin" });
    console.log("Owner account created:", email);
  } else {
    const a = admins[0];
    Object.assign(a, { email, password: hash, status: "active", failedLogins: 0, tokenVersion: (a.tokenVersion || 0) + 1 });
    a.lockUntil = undefined; a.lastFailedAt = undefined; a.name = process.env.ADMIN_NAME || a.name;
    await a.save();
    console.log("Owner account updated:", email, "(all old admin sessions are now invalid)");
  }
  console.log("Done. Now remove ADMIN_PASSWORD from .env and restart the server.");
  process.exit(0);
})().catch((e) => die(e.message));
