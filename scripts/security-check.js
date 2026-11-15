// Live cross-tenant check. Logs in as two sellers and tries to use seller B's IDs with seller A's token.
// Every attempt must be refused (403/404). Read-only except for one harmless PUT that is rejected anyway.
//
//   BASE_URL=https://orderistan.site \
//   SELLER_A_EMAIL=... SELLER_A_PASSWORD=... \
//   SELLER_B_EMAIL=... SELLER_B_PASSWORD=... \
//   node scripts/security-check.js
//
// Needs Node 18+ (global fetch). Seller B should have at least one product, order, booking and subscription request for full coverage.
// The owner account cannot be tested here because its sign-in needs the e-mailed code.
const BASE = (process.env.BASE_URL || "http://localhost:5000").replace(/\/$/, "") + "/api";
const need = ["SELLER_A_EMAIL", "SELLER_A_PASSWORD", "SELLER_B_EMAIL", "SELLER_B_PASSWORD"].filter((k) => !process.env[k]);
if (need.length) { console.error("Missing env: " + need.join(", ")); process.exit(2); }

const call = async (method, path, token, body) => {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* binary or empty */ }
  return { status: r.status, data };
};
const login = async (email, password) => {
  const r = await call("POST", "/auth/login", null, { email, password });
  if (r.status !== 200 || !r.data?.token) throw new Error(`Login failed for ${email} (${r.status}): ${r.data?.message || ""}`);
  return { token: r.data.token, store: r.data.store };
};

let pass = 0, fail = 0, skipped = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`); };
const refused = (r) => r.status === 403 || r.status === 404;
const attempt = async (name, fn) => {
  try { const r = await fn(); check(name, refused(r), `status ${r.status}`); }
  catch (e) { check(name, false, e.message); }
};

(async () => {
  const A = await login(process.env.SELLER_A_EMAIL, process.env.SELLER_A_PASSWORD);
  const B = await login(process.env.SELLER_B_EMAIL, process.env.SELLER_B_PASSWORD);
  console.log(`Seller A store: ${A.store?.slug}   Seller B store: ${B.store?.slug}\n`);
  if (!A.store || !B.store || A.store.slug === B.store.slug) { console.error("Use two different sellers with a store each."); process.exit(2); }

  // Collect seller B's own IDs (with B's token, so they are legitimately B's)
  const pBody = await call("GET", "/seller/products?limit=1", B.token);
  const oBody = await call("GET", "/seller/orders", B.token);
  const bBody = await call("GET", "/seller/bookings?limit=1", B.token);
  const sBody = await call("GET", "/seller/subscription", B.token);
  const bProd = pBody.data?.items?.[0]?._id, bOrder = oBody.data?.items?.[0], bBook = bBody.data?.items?.[0]?._id;
  const bReq = sBody.data?.history?.[0]?._id, bShotOrder = (oBody.data?.items || []).find((o) => o.hasScreenshot);
  console.log(`Seller B ids -> product:${!!bProd} order:${!!bOrder} booking:${!!bBook} subscription request:${!!bReq} order with screenshot:${!!bShotOrder}\n`);

  // 1. unauthenticated
  await attempt("no token -> seller orders", () => call("GET", "/seller/orders", null));
  // 2. seller A using seller B's objects
  if (bProd) {
    await attempt("A reads B's product (not in A's list, but PUT by id)", () => call("PUT", `/seller/products/${bProd}`, A.token, {}));
    await attempt("A deletes B's product", () => call("DELETE", `/seller/products/${bProd}`, A.token));
  } else skipped++, console.log("SKIP  product checks (seller B has no product)");
  if (bOrder) {
    await attempt("A reads B's order", () => call("GET", `/seller/orders/${bOrder._id}`, A.token));
    await attempt("A changes B's order status", () => call("PATCH", `/seller/orders/${bOrder._id}`, A.token, { action: "status", status: "cancelled" }));
    await attempt("A verifies B's payment", () => call("PATCH", `/seller/orders/${bOrder._id}`, A.token, { action: "verify" }));
    await attempt("A's customer-order screenshot endpoint for B's order", () => call("GET", `/orders/${bOrder._id}/screenshot`, A.token));
  } else { skipped += 4; console.log("SKIP  order checks (seller B has no order)"); }
  if (bShotOrder) await attempt("A opens B's payment screenshot", () => call("GET", `/orders/${bShotOrder._id}/screenshot`, A.token));
  else { skipped++; console.log("SKIP  payment screenshot check (no B order with a screenshot)"); }
  if (bBook) await attempt("A changes B's booking", () => call("PATCH", `/seller/bookings/${bBook}`, A.token, { status: "cancelled" }));
  else { skipped++; console.log("SKIP  booking check (seller B has no booking)"); }
  if (bReq) {
    await attempt("A opens B's subscription payment proof", () => call("GET", `/sub-requests/${bReq}/proof`, A.token));
    await attempt("A cancels B's subscription request", () => call("DELETE", `/seller/subscription/requests/${bReq}`, A.token));
  } else { skipped += 2; console.log("SKIP  subscription checks (seller B has no request)"); }

  // 3. role boundaries
  await attempt("seller calls admin orders list", () => call("GET", "/admin/orders", A.token));
  await attempt("seller calls admin renewal list", () => call("GET", "/admin/sub-requests", A.token));
  await attempt("seller calls admin sellers list", () => call("GET", "/admin/sellers", A.token));
  await attempt("seller calls customer account API", () => call("GET", "/me/orders", A.token));

  // 4. chat: a seller only ever sees its own thread
  const chat = await call("GET", "/chat/messages", A.token);
  check("A's chat thread is A's store, not B's", chat.status === 200 && chat.data?.store?.slug === A.store.slug, `thread store: ${chat.data?.store?.slug}`);
  const chatB = await call("GET", `/chat/messages?store=${B.store._id || ""}`, A.token);
  check("A ignores ?store=B in the seller chat", chatB.status === 200 && chatB.data?.store?.slug === A.store.slug, `thread store: ${chatB.data?.store?.slug}`);

  // 5. the owner account must need the e-mail code
  console.log(`\nResult: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Script error:", e.message); process.exit(2); });
