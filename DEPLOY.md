# Orderistan backend on Vercel

1. Push this folder to GitHub (or run `npx vercel` inside it). Root Directory = this folder.
2. Vercel > Project > Settings > Environment Variables: add everything from `.env.example`
   (MONGODB_URI, JWT_SECRET, CLOUDINARY_URL, BREVO_API_KEY, BREVO_SENDER_EMAIL, ADMIN_EMAIL, ADMIN_PASSWORD, CRON_SECRET, ALLOWED_ORIGINS ...).
3. MongoDB Atlas > Network Access: allow 0.0.0.0/0 (Vercel has no fixed IP).
4. Deploy, then open `https://<project>.vercel.app/api/health` -> {"status":"ok"}.
5. Frontend: set its API base URL to `https://<project>.vercel.app/api` and rebuild/redeploy on Cloudflare.

Notes
- Background jobs (subscription expiry, Cloudinary alert, chat prune) run via Vercel Cron at /api/cron once a day (Hobby plan limit). On Pro change the schedule in vercel.json, e.g. "*/10 * * * *".
- Vercel limits request bodies to 4.5 MB: bigger image/video uploads will fail. Upload big files straight to Cloudinary (unsigned/signed preset) from the browser.
- Local run: `npm install && npm run dev`.
