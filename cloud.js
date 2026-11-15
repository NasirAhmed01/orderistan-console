// Cloudinary media layer. The API secret lives ONLY in backend/.env (CLOUDINARY_URL) and never reaches the browser.
//   - Public media (logos, banners, product photos/videos): delivered from Cloudinary's CDN, auto format + auto quality.
//     The frontend asks for small versions in lists (see thumb() in frontend/src/api.js).
//   - Private media (payment screenshots): stored as type "authenticated". The raw Cloudinary URL is useless without a
//     signature, and only this server can sign it, after checking that the requester is the buyer / store owner / admin.
// Uploads arrive as temp files on disk (multer diskStorage) and are streamed to Cloudinary, so they never sit in RAM.
const crypto = require("crypto");
const fs = require("fs");
const { pipeline } = require("stream");
const { Readable } = require("stream");
const { v2: cloudinary } = require("cloudinary"); // reads CLOUDINARY_URL from the environment

if (!process.env.CLOUDINARY_URL || !/^cloudinary:\/\/\d+:[^@]+@.+/.test(process.env.CLOUDINARY_URL)) {
  throw new Error("Set CLOUDINARY_URL env var (cloudinary://<api_key>:<api_secret>@<cloud_name>).");
}
cloudinary.config({ secure: true });

const ROOT = "orderistan";
const { fail } = require("./utils");

// Never trust the browser's Content-Type: check the real file signature.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image";                                   // JPEG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image"; // PNG
  if (buf.subarray(0, 4).toString() === "GIF8") return "image";                                                // GIF
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image";   // WEBP
  if (buf.subarray(4, 8).toString() === "ftyp") return "video";                                                // MP4 / MOV
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video";                // WEBM
  return null;
}
// First bytes of an uploaded file (from disk, or from memory if someone still uses memoryStorage).
async function head(file) {
  if (file?.buffer) return file.buffer.subarray(0, 16);
  if (!file?.path) return null;
  const fh = await fs.promises.open(file.path, "r");
  try { const b = Buffer.alloc(16); const { bytesRead } = await fh.read(b, 0, 16, 0); return b.subarray(0, bytesRead); }
  finally { await fh.close(); }
}

const send = (file, opts) => new Promise((resolve, reject) => {
  const up = cloudinary.uploader.upload_stream({ overwrite: false, unique_filename: false, timeout: 60000, ...opts }, (e, r) => (e ? reject(e) : resolve(r)));
  if (file.path) { const src = fs.createReadStream(file.path); src.on("error", reject); src.pipe(up); }
  else up.end(file.buffer);
});

const rid = () => crypto.randomBytes(16).toString("hex");
const IMG_IN = [{ width: 2000, height: 2000, crop: "limit" }, { flags: "strip_profile" }]; // cap size, strip EXIF/GPS
const wrapErr = (e) => { console.error("cloudinary:", e.message || e); return fail(502, "Upload failed. Please try again."); };

// kind: "image" | "video". Returns the CDN URL to store in MongoDB.
async function uploadPublic(file, { folder = "public", kind = "image" } = {}) {
  if (sniff(await head(file)) !== kind) throw fail(400, kind === "video" ? "Only MP4, MOV or WEBM videos are allowed." : "Only JPG, PNG, WEBP or GIF images are allowed.");
  try {
    const r = await send(file, kind === "video"
      ? { folder: `${ROOT}/${folder}`, public_id: rid(), resource_type: "video", allowed_formats: ["mp4", "mov", "webm"] }
      : { folder: `${ROOT}/${folder}`, public_id: rid(), resource_type: "image", allowed_formats: ["jpg", "png", "webp", "gif"], transformation: IMG_IN });
    return cloudinary.url(r.public_id, { resource_type: kind, version: r.version, secure: true,
      transformation: [{ fetch_format: "auto", quality: "auto" }] });
  } catch (e) { throw wrapErr(e); }
}

// Uploads several files. If one fails, the ones that already went up are deleted again (no orphans in Cloudinary).
async function uploadManyPublic(files, opts) {
  const res = await Promise.allSettled((files || []).map((f) => uploadPublic(f, opts)));
  const ok = res.filter((x) => x.status === "fulfilled").map((x) => x.value);
  const bad = res.find((x) => x.status === "rejected");
  if (bad) { ok.forEach(removePublic); throw bad.reason; }
  return ok;
}

// Returns the private public_id to store in MongoDB (NOT a URL).
const PRIVATE_FOLDERS = ["payments", "chat", "subs"];   // order screenshots, admin<->seller chat photos, renewal payment proofs
async function uploadPrivate(file, folder = "payments") {
  if (!PRIVATE_FOLDERS.includes(folder)) throw fail(500, "Bad upload folder.");
  if (sniff(await head(file)) !== "image") throw fail(400, "Only JPG, PNG, WEBP or GIF images are allowed.");
  try {
    const r = await send(file, { folder: `${ROOT}/${folder}`, public_id: rid(), type: "authenticated", resource_type: "image",
      allowed_formats: ["jpg", "png", "webp", "gif"], transformation: IMG_IN });
    return r.public_id;
  } catch (e) { throw wrapErr(e); }
}

const idFromUrl = (u) => { const m = /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|video)\/upload\/(?:.*\/)?(orderistan\/[^?]+?)(?:\.\w+)?(?:\?.*)?$/.exec(String(u || "")); return m ? { id: m[2], kind: m[1] } : null; };
const removePublic = (url) => { const p = idFromUrl(url); if (p) cloudinary.uploader.destroy(p.id, { resource_type: p.kind, invalidate: true }).catch((e) => console.error("cloudinary delete:", e.message)); };
const isPrivateId = (id) => /^orderistan\/(payments|chat|subs)\/[a-f0-9]{32}$/.test(String(id || ""));
const removePrivate = (id) => { if (isPrivateId(id)) cloudinary.uploader.destroy(id, { type: "authenticated", resource_type: "image", invalidate: true }).catch((e) => console.error("cloudinary delete:", e.message)); };

// Streams a private image through our server (after the caller has done the permission check).
// It is downscaled by Cloudinary first (max 1600px wide, auto quality), which cuts bandwidth a lot. It is never cached by the browser.
async function streamPrivate(res, id) {
  if (!isPrivateId(id)) return res.status(404).json({ message: "No screenshot." });
  const sized = cloudinary.url(id, { type: "authenticated", resource_type: "image", sign_url: true, secure: true,
    transformation: [{ width: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }] });
  const original = cloudinary.url(id, { type: "authenticated", resource_type: "image", sign_url: true, secure: true });
  let up;
  for (const url of [sized, original]) {
    try { up = await fetch(url, { signal: AbortSignal.timeout(15000) }); } catch { up = null; }
    if (up?.ok && up.body) break;
  }
  if (!up?.ok || !up.body) return res.status(404).json({ message: "No screenshot." });
  // Payment proofs are personal: never kept in any cache (a shared computer must not show the previous person's screenshot).
  res.set({ "Content-Type": up.headers.get("content-type") || "image/jpeg", "Cache-Control": "private, no-store", "Vary": "Authorization", "X-Content-Type-Options": "nosniff" });
  // pipeline() handles errors on either side; a bare .pipe() would throw an uncaught 'error' and take the whole server down
  pipeline(Readable.fromWeb(up.body), res, (e) => { if (e && !res.destroyed) res.destroy(); });
}

// Account usage from Cloudinary's Admin API (storage, bandwidth, transformations, credits). Cached for 5 minutes because the API is rate limited.
let usageMemo = { at: 0, data: null };
const metric = (m) => (m && typeof m === "object" ? { usage: Number(m.usage) || 0, limit: Number(m.limit) || 0, percent: m.used_percent != null ? Number(m.used_percent) : (m.limit ? (m.usage / m.limit) * 100 : null), credits: m.credits_usage != null ? Number(m.credits_usage) : null } : { usage: 0, limit: 0, percent: null, credits: null });
async function usage(force = false) {
  if (!force && usageMemo.data && Date.now() - usageMemo.at < 300000) return usageMemo.data;
  const r = await cloudinary.api.usage();
  const m = { storage: metric(r.storage), bandwidth: metric(r.bandwidth), transformations: metric(r.transformations), objects: metric(r.objects), requests: Number(r.requests) || 0 };
  const credits = r.credits ? { usage: Number(r.credits.usage) || 0, limit: Number(r.credits.limit) || 0, percent: r.credits.used_percent != null ? Number(r.credits.used_percent) : null } : null;
  const percents = [credits?.percent, m.storage.percent, m.bandwidth.percent, m.transformations.percent].filter((x) => typeof x === "number" && Number.isFinite(x));
  const data = { plan: r.plan || "", updated: r.last_updated || r.date_requested || null, ...m, credits, resources: Number(r.resources) || 0, derived: Number(r.derived_resources) || 0,
    percent: percents.length ? Math.max(...percents) : null };
  usageMemo = { at: Date.now(), data };
  return data;
}

module.exports = { usage, uploadPublic, uploadManyPublic, uploadPrivate, removePublic, removePrivate, streamPrivate, isPrivateId, sniff };
