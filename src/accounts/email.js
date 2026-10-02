// Outbound email for password resets — one sender, honest about whether it can send.
//
// Mirrors draft's services/emailService.js rule (09-30): with no provider configured NOTHING
// "succeeds" and no link or code is ever logged — a reset link in a log is a live credential.
// Unlike draft there is no development console fallback: this service never logs content.
export function emailConfigured(env = process.env) {
  return !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
}

export async function sendResetEmail({ to, resetUrl }, { env = process.env, fetchImpl = fetch } = {}) {
  if (!emailConfigured(env)) return { ok: false, reason: "email_unconfigured" };
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM, to, subject: "Reset your Resume Master password",
      text: ["Use this link to reset your Resume Master password. It works once and expires in 30 minutes:", "",
             resetUrl, "", "If you did not ask for this, ignore this email — your password stays as it is."].join("\n"),
    }),
  });
  if (!r.ok) throw Object.assign(new Error(`email send failed: ${r.status}`), { code: "email_failed" });
  return { ok: true };
}
