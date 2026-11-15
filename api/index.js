// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
// 1) Env keys are checked FIRST and printed in the Vercel logs (so you see what is missing even if the app crashes while loading).
// 2) If the app fails to load, the real reason is printed with console.error and returned as JSON.
let app;
try {
  const { runStartupCheck } = require("../startup-check");
  // Only the env part here (sync-ish, no network). The full live report (MongoDB/Cloudinary/Brevo) is printed by app.js after the DB connects.
  runStartupCheck({ live: false, print: false }).then((r) => {
    const bad = Object.entries(r.env).filter(([, v]) => v !== "ok");
    if (bad.length) console.error("⚠️  Env problems:\n" + bad.map(([k, v]) => `   - ${k}: ${v}`).join("\n"));
  }).catch(() => {});
  app = require("../app").app;
  console.log("✅ App module loaded (Express ready). Waiting for first request to connect MongoDB...");
} catch (e) {
  console.error("❌ Startup crash (module load):", e && e.stack || e);
  const msg = String(e && e.message).slice(0, 300);
  app = (_req, res) => res.status(500).json({ status: "error", stage: "module load", message: msg });
}
module.exports = (req, res) => app(req, res);
