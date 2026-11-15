// Password hashing. Uses the native `bcrypt` addon when it is installed (runs on the libuv thread pool, does not block Node),
// otherwise falls back to the pure-JS `bcryptjs`. Both produce/verify the same $2a/$2b hashes, so existing users keep working.
// Cost 10 (~80ms) is the default; raise it with BCRYPT_COST (10-14) if your server is fast.
let impl, native = true;
try { impl = require("bcrypt"); } catch { impl = require("bcryptjs"); native = false; }

const COST = Math.min(14, Math.max(10, parseInt(process.env.BCRYPT_COST, 10) || 10));

// At most MAX_ACTIVE hashes at once, MAX_QUEUE waiting. Beyond that we answer 503 instead of piling up CPU work (login/register flood).
const MAX_ACTIVE = native ? 4 : 2, MAX_QUEUE = 60;
let active = 0; const queue = [];
function slot() {
  if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
  if (queue.length >= MAX_QUEUE) return Promise.reject(Object.assign(new Error("Server is busy. Please try again in a moment."), { status: 503 }));
  return new Promise((res) => queue.push(res)).then(() => { active++; });
}
function release() { active--; const next = queue.shift(); if (next) next(); }
async function run(fn) { await slot(); try { return await fn(); } finally { release(); } }

const hash = (pw) => run(() => impl.hash(String(pw), COST));
const compare = (pw, h) => run(() => impl.compare(String(pw), h));
const DUMMY_HASH = impl.hashSync("not-a-real-password", COST); // unknown emails pay the same bcrypt cost (no timing leak)

module.exports = { hash, compare, DUMMY_HASH, COST, native };
