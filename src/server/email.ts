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
    // Without this a stalled connection blocks a password reset indefinitely:
    // `fetch` has no default timeout, and this runs inside a user's request.
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
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

/**
 * Anything that came from a person, on its way into an HTML string.
 *
 * `resetEmail` interpolates only a token this server generated, so it needed
 * none of this. An invite carries the inviter's own name, typed into a form,
 * and an unescaped `<` there is markup in somebody else's mailbox.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The invitation.
 *
 * It carries a reset link rather than a password. Emailing somebody a password
 * puts a live credential in a mailbox for as long as the mailbox exists; a
 * one-hour single-use link lets them choose their own and expires whether they
 * use it or not.
 */
export function inviteEmail(link: string, inviterName: string, workspaceName: string) {
  const inviter = inviterName.trim() || "A colleague";
  const workspace = workspaceName.trim() || "YourCRM";
  return {
    subject: `${inviter} invited you to ${workspace} on YourCRM`,
    text:
      `${inviter} has added you to ${workspace} on YourCRM.\n\n` +
      `Choose your password to get started:\n${link}\n\n` +
      `The link expires in one hour and can only be used once. ` +
      `If it expires, use "Forgot your password?" on the sign-in page with this address.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0b1220">
  <h1 style="margin:0 0 16px;font-size:20px;font-weight:600">You&rsquo;ve been added to ${escapeHtml(workspace)}</h1>
  <p style="margin:0 0 20px;line-height:1.6;color:#55617a">
    ${escapeHtml(inviter)} has invited you to YourCRM. Choose a password and you&rsquo;re in.
  </p>
  <p style="margin:0 0 24px">
    <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">Choose your password</a>
  </p>
  <p style="margin:0;line-height:1.6;font-size:13px;color:#8a94a8">
    The link expires in one hour and can only be used once. If it expires, use
    &ldquo;Forgot your password?&rdquo; on the sign-in page with this address.
  </p>
</div>`,
  };
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
