import { BRAND, SENDER_FROM } from "../shared/brand.js";

export async function sendPasswordResetEmail({ to, resetUrl, otp, expiresAt }) {
  if (!to || !resetUrl || !otp) return { ok: false, skipped: true };

  const subject = `Reset your ${BRAND} password`;
  const expires = new Date(expiresAt * 1000).toLocaleString();
  const text = [
    `Use this one-time link to reset your ${BRAND} password:`,
    resetUrl,
    "",
    `OTP: ${otp}`,
    `Expires: ${expires}`,
  ].join("\n");

  if (process.env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_FROM || SENDER_FROM,
        to,
        subject,
        text,
      }),
    });
    if (!response.ok) throw new Error(`Password reset email failed: ${response.status}`);
    return { ok: true, provider: "resend" };
  }

  console.info("[password-reset] Email provider not configured; reset link for dev:", { to, resetUrl, otp });
  return { ok: true, provider: "console" };
}
