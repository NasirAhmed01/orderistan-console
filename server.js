// Local development only:  npm run dev   (Vercel uses api/index.js instead)
require("dotenv").config();
const { app, init, trust } = require("./app");
const jobs = require("./jobs");
const port = process.env.PORT || 5000;
init().then(() => jobs.backfill()).then(() => {
  app.listen(port, () => console.log(`Orderistan API on http://localhost:${port} | trust proxy=${trust}`));
}).catch((e) => { console.error("Startup failed:", e.message); process.exit(1); });
