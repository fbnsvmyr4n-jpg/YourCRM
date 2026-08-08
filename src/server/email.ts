/**
 * Outbound email.
 *
 * Uses Resend when `RESEND_API_KEY` is set. Without it the app does not
 * pretend to have sent anything: `sent` comes back false and, in development,
 * the message is logged to the server console so a reset link can still be
 * followed while testing.
 *
 * Deliberately a plain fetch rather than the Resend SDK — this is one HTTP
 * POST, and a dependency for that would earn its place only if we needed
 * attachments, batching or webhooks.
 */

export type SendResult = { sent: boolean; reason?: string };

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/** The From address. Resend's shared sender works before a domain is verified. */
function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || "YourCRM <onboarding@resend.dev>";
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY?.trim();

  if (!key) {
    if (process.env.NODE_ENV !== "production") {
      console.info(
        `\n[email:not-configured] would send to ${opts.to}\n  ${opts.subject}\n  ${opts.text}\n`
      );
    }
    return { sent: false, reason: "RESEND_API_KEY is not set" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, reason: `Resend returned ${res.status} ${detail.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The reset email. Plain and legible — this is a security message, not a newsletter. */
export function resetEmail(link: string) {
  return {
    subject: "Reset your YourCRM password",
    text:
      `Someone asked to reset the password for your YourCRM account.\n\n` +
      `Open this link to choose a new one:\n${link}\n\n` +
      `The link expires in one hour and can only be used once. ` +
      `If this wasn't you, you can ignore this email — nothing has changed.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0b1220">
  <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">Reset your password</h1>
  <p style="margin:0 0 20px;line-height:1.6;color:#55617a">
    Someone asked to reset the password for your YourCRM account. Choose a new one below.
  </p>
  <p style="margin:0 0 24px">
    <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">Choose a new password</a>
  </p>
  <p style="margin:0 0 8px;line-height:1.6;font-size:13px;color:#8a94a8">
    The link expires in one hour and can only be used once.
  </p>
  <p style="margin:0;line-height:1.6;font-size:13px;color:#8a94a8">
    If this wasn't you, ignore this email — nothing has changed.
  </p>
</div>`,
  };
}
