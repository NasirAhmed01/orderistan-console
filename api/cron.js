// Vercel Cron replacement for the old setInterval background jobs. Protected by CRON_SECRET (Vercel sends it as a Bearer token).
require("dotenv").config();
const { init } = require("../app");
const jobs = require("../jobs");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: "Unauthorized." });
  try {
    await init();
    const out = {};
    out.subscriptions = await jobs.checkSubscriptions();
    out.cloudinary = await jobs.checkCloudinary().catch((e) => ({ error: e.message }));
    out.chat = await jobs.pruneChat().catch((e) => ({ error: e.message }));
    await jobs.backfill().catch((e) => { out.backfill = e.message; });
    await require("../sysmonitor").probe({ persist: true }).catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e) { console.error("cron failed:", e); res.status(500).json({ ok: false, message: e.message }); }
};
