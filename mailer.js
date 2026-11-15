// Transactional email through Brevo (https://developers.brevo.com/reference/sendtransacemail). No extra npm package: Node 18+ has fetch.
//   BREVO_API_KEY       API key from Brevo > SMTP & API > API Keys (server-side only, never put it in the frontend)
//   BREVO_SENDER_EMAIL  a sender you verified in Brevo > Senders & IP
//   BREVO_SENDER_NAME   display name (default "Orderistan")
const isProd = process.env.NODE_ENV === "production";
const KEY = () => String(process.env.BREVO_API_KEY || "").trim();
const placeholder = (v) => !v || /PASTE_YOUR|your_verified|^<.*>$/i.test(v);
const configured = () => !placeholder(KEY()) && !placeholder(process.env.BREVO_SENDER_EMAIL);

const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function send({ to, name, subject, html, text }) {
  if (!configured()) {
    // Development convenience only: print the mail so you can test without Brevo. NEVER happens in production.
    if (!isProd) { console.log(`\n[mail:dev] to=${to} subject="${subject}"\n${text}\n`); return { dev: true }; }
    throw Object.assign(new Error("Email service is not configured. Please try again later."), { status: 503 });
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": KEY(), "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME || "Orderistan", email: process.env.BREVO_SENDER_EMAIL },
      replyTo: { name: "Orderistan Support", email: process.env.SUPPORT_EMAIL || "orderistan@gmail.com" },
      to: [{ email: to, ...(name ? { name: String(name).slice(0, 80) } : {}) }],
      subject, htmlContent: html, textContent: text
    }),
    signal: AbortSignal.timeout(10000)
  }).catch((e) => { console.error("brevo network error:", e.message); throw Object.assign(new Error("Could not send the email. Please try again."), { status: 503 }); });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    console.error("brevo error", res.status, body);   // never logs the key or the code
    let why = ""; try { why = JSON.parse(body).message || ""; } catch { why = body; }
    // The reason comes from Brevo itself (no secrets in it); it tells the owner exactly what to fix in Brevo.
    throw Object.assign(new Error(`Could not send the email (Brevo ${res.status}: ${String(why).slice(0, 160)}).`), { status: 503 });
  }
  return { ok: true };
}

const wrapHtml = (title, bodyHtml) => `<!doctype html><html><body style="margin:0;background:#f4f6f3;font-family:Arial,Helvetica,sans-serif;color:#1c2a1a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:14px;padding:28px">
<tr><td><a href="https://${process.env.ROOT_DOMAIN || "orderistan.site"}" style="text-decoration:none"><img src="https://${process.env.ROOT_DOMAIN || "orderistan.site"}/logo.png" alt="Orderistan" height="44" style="height:44px;width:auto;vertical-align:middle;border:0"> <span style="font-size:22px;font-weight:700;color:#0b3a8a;vertical-align:middle">Order<span style="color:#f26a1b">istan</span></span></a>
<h2 style="margin:18px 0 8px;font-size:19px">${h(title)}</h2>${bodyHtml}
<p style="margin:22px 0 0;font-size:12px;color:#7a857a">If you did not request this, you can safely ignore this email. Orderistan will never ask you for this code by phone, WhatsApp or chat.</p>
<p style="margin:8px 0 0;font-size:12px;color:#7a857a">Need help? Write to <a href="mailto:${process.env.SUPPORT_EMAIL || "orderistan@gmail.com"}" style="color:#0b3a8a">${process.env.SUPPORT_EMAIL || "orderistan@gmail.com"}</a> &middot; <a href="https://${process.env.ROOT_DOMAIN || "orderistan.site"}" style="color:#0b3a8a">${process.env.ROOT_DOMAIN || "orderistan.site"}</a></p>
</td></tr></table></td></tr></table></body></html>`;

const PURPOSE = {
  signup: ["Verify your email", "Use this code to finish creating your Orderistan account."],
  reset: ["Reset your password", "Use this code to set a new password for your Orderistan account."],
  link: ["Link your Gmail", "Use this code to link this Gmail address to your Orderistan account."],
  admin: ["Owner sign-in code", "Someone entered the correct password for the Orderistan OWNER account. Use this code to finish signing in."]
};
function sendOtp({ to, name, code, purpose, minutes }) {
  const [subj, intro] = PURPOSE[purpose];
  const html = wrapHtml(subj, `<p style="margin:0 0 14px;font-size:14px">Hi ${h(name || "there")}, ${h(intro)}</p>
<div style="font-size:34px;letter-spacing:10px;font-weight:700;background:#f1f7ee;border-radius:10px;padding:14px 0;text-align:center">${h(code)}</div>
<p style="margin:14px 0 0;font-size:13px;color:#4a5a48">This code expires in ${minutes} minutes and works once.</p>`);
  return send({ to, name, subject: `${code} is your Orderistan code`, html, text: `Your Orderistan code is ${code}. It expires in ${minutes} minutes. If you did not request it, ignore this email.` });
}
function sendLockAlert({ to, name, minutes }) {
  const html = wrapHtml("Too many failed sign-in attempts", `<p style="margin:0 0 10px;font-size:14px">Hi ${h(name || "there")}, someone entered a wrong password for your account several times, so we paused sign-ins for ${minutes} minute(s).</p>
<p style="margin:0;font-size:14px">If this was you, wait and try again. If it was not you, use <b>Forgot password</b> on the login page to set a new password.</p>`);
  return send({ to, name, subject: "Security alert: sign-in attempts paused", html, text: `Too many wrong passwords were entered for your Orderistan account; sign-in is paused for ${minutes} minute(s). If it was not you, use Forgot password.` });
}
function sendPasswordChanged({ to, name }) {
  const html = wrapHtml("Your password was changed", `<p style="margin:0;font-size:14px">Hi ${h(name || "there")}, the password of your Orderistan account was just changed and all other devices were signed out. If this was not you, reset your password immediately and contact support.</p>`);
  return send({ to, name, subject: "Your Orderistan password was changed", html, text: "Your Orderistan password was changed and other devices were signed out. If this was not you, reset it immediately." });
}

// Sent to the OLD Gmail when a different Gmail is linked. Shows the new address partly masked so the owner can spot a takeover.
function sendGmailChanged({ to, name, newEmail }) {
  const [l, d] = String(newEmail || "").split("@"), masked = (l || "").slice(0, 2) + "***@" + (d || "");
  const html = wrapHtml("Your linked Gmail was changed", `<p style="margin:0;font-size:14px">Hi ${h(name || "there")}, a new Gmail (${h(masked)}) was linked to your Orderistan account in place of this one. If you did this, no action is needed. If you did not, reset your password right away and contact ${h(process.env.SUPPORT_EMAIL || "support")}.</p>`);
  return send({ to, name, subject: "Your Orderistan Gmail was changed", html, text: "A new Gmail was linked to your Orderistan account in place of this one. If this was not you, reset your password right away." });
}

module.exports = { send, sendOtp, sendLockAlert, sendPasswordChanged, sendGmailChanged, configured };
