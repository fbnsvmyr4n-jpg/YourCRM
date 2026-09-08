import { logFailure } from "./log";

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

/**
 * `permanent` says whether trying again could ever help.
 *
 * A refused address is refused for ever, and retrying it for two hours only
 * delays the moment somebody finds out. A timeout is the opposite. The caller
 * cannot tell these apart from a message, and the queue's decision to keep or
 * abandon a job turns on exactly this — so the distinction is made here, where
 * the status code is.
 */
export type SendResult = {
  sent: boolean;
  /** A sentence for the person who wrote the message. See `explainFailure`. */
  reason?: string;
  /** The provider's own words, for the log. Never put in front of anybody. */
  detail?: string;
  permanent?: boolean;
};

/**
 * What to tell the person whose message did not go.
 *
 * The first version put the provider's JSON on the screen, and the Inbox duly
 * showed a client-facing failure as `Resend returned 403 {"statusCode":403,
 * "name":"validation_error","message":"You can only send testing emails to
 * your own email address (…). To send emails to other recipients, please veri`
 * — cut off mid-word, naming a vendor the user has never heard of, and not
 * saying the one thing they need to know, which is whether this is their fault
 * and what fixes it.
 *
 * The raw text is kept, in `detail`, for the log. This is the version a person
 * reads.
 */
function explainFailure(status: number, detail: string): string {
  const d = detail.toLowerCase();

  if (status === 403 && d.includes("your own email address")) {
    return "sending is in test mode until this workspace's email domain is verified — for now it can only email the account owner";
  }
  if (status === 401 || status === 403) {
    return "the email service rejected this workspace's credentials — check the email settings";
  }
  if (status === 422 && (d.includes("`to`") || d.includes("invalid_to") || d.includes("recipient"))) {
    return "the recipient's address was refused as invalid — check the email address on that contact";
  }
  if (status === 422 && d.includes("from")) {
    return "the sending address was refused — the workspace's email domain is not verified yet";
  }
  if (status === 413 || d.includes("too large")) return "the message was too large to send";
  if (status === 429) return "the email service is rate limiting us — it will go shortly";
  if (status >= 500) return "the email service is having trouble — it will be tried again";

  /* Unknown, so say what is true and no more: it was refused, we do not know
     why, and here is the code somebody can quote when they ask. */
  return `the email service refused it (error ${status})`;
}

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
  /**
   * Passed to Resend as `Idempotency-Key`, which they honour for 24 hours.
   *
   * This is what makes a retried send exactly once at the far end. Delivery
   * from our queue is at least once and cannot be otherwise — a process that
   * dies after the provider accepted the request has no way to know it did —
   * so the only place the duplicate can be stopped is theirs.
   */
  idempotencyKey?: string;
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY?.trim();

  if (!key) {
    if (process.env.NODE_ENV !== "production") {
      console.info(
        `\n[email:not-configured] would send to ${opts.to}\n  ${opts.subject}\n  ${opts.text}\n`
      );
    }
    return {
      sent: false,
      reason: "email is not set up for this workspace yet",
      detail: "RESEND_API_KEY is not set",
    };
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
        // Resend caps this at 256 characters and ignores the header when absent.
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey.slice(0, 256) } : {}),
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
      const raw = `Resend returned ${res.status} ${detail.slice(0, 200)}`;
      logFailure("email", raw);
      return {
        sent: false,
        reason: explainFailure(res.status, detail),
        detail: raw,
        /* A rejected request — a malformed address, an unverified sender —
           will be rejected identically for ever. The two exceptions are the
           ones that describe a moment rather than the request: a timeout and
           a rate limit both mean "not now". Everything from 500 up is theirs
           and is worth waiting out. */
        permanent: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429,
      };
    }
    return { sent: true };
  } catch (err) {
    /* A thrown fetch is a network fault or our own 10s timeout — never a
       verdict on the message. Always worth another go. */
    const raw = err instanceof Error ? err.message : String(err);
    logFailure("email", raw);
    return {
      sent: false,
      reason: "we could not reach the email service — it will be tried again",
      detail: raw,
    };
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

/**
 * The quotation itself, as an email.
 *
 * Plain: a client reading this on a phone wants the number, the lines and the
 * total, and no gradient. It carries no link back into the CRM — the recipient
 * has no account here, and a dead link on a priced document reads as carelessness.
 *
 * Every value on it is escaped. The lines came out of the price list and the
 * project came from a deal title, but both were typed by a person, and an
 * unescaped `<` in "Steel < 6mm" is markup in a customer's mailbox.
 */
export function quotationEmail(quote: {
  number: string;
  project: string;
  from: string;
  approvedBy: string;
  notes: string | null;
  lines: { description: string; quantity: number; unitCents: number; totalCents: number }[];
  totalCents: number;
}) {
  const money = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const qty = (n: number) => String(Number(n.toFixed(3)));

  const subject = `Quotation ${quote.number} — ${quote.project}`;

  const text = [
    `Quotation ${quote.number}`,
    quote.project,
    "",
    ...quote.lines.map(
      (l) => `${l.description}\n  ${qty(l.quantity)} × ${money(l.unitCents)} = ${money(l.totalCents)}`
    ),
    "",
    `Total: ${money(quote.totalCents)}`,
    ...(quote.notes ? ["", quote.notes] : []),
    "",
    `Sent by ${quote.approvedBy}, ${quote.from}.`,
  ].join("\n");

  const rows = quote.lines
    .map(
      (l) => `    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e6e9f0">${escapeHtml(l.description)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e6e9f0;text-align:right;white-space:nowrap;color:#55617a">${qty(l.quantity)} &times; ${money(l.unitCents)}</td>
      <td style="padding:8px 0 8px 16px;border-bottom:1px solid #e6e9f0;text-align:right;white-space:nowrap;font-weight:600">${money(l.totalCents)}</td>
    </tr>`
    )
    .join("\n");

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0b1220">
  <h1 style="margin:0 0 4px;font-size:20px;font-weight:600">Quotation ${escapeHtml(quote.number)}</h1>
  <p style="margin:0 0 24px;color:#55617a">${escapeHtml(quote.project)}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
${rows}
    <tr>
      <td style="padding:12px 0;font-weight:600">Total</td>
      <td></td>
      <td style="padding:12px 0 12px 16px;text-align:right;font-weight:700;font-size:16px">${money(quote.totalCents)}</td>
    </tr>
  </table>
  ${quote.notes ? `<p style="margin:20px 0 0;line-height:1.6;color:#55617a;white-space:pre-line">${escapeHtml(quote.notes)}</p>` : ""}
  <p style="margin:28px 0 0;font-size:13px;color:#8a94a8">
    Sent by ${escapeHtml(quote.approvedBy)}, ${escapeHtml(quote.from)}.
  </p>
</div>`;

  return { subject, text, html };
}

/**
 * An invoice going to a client.
 *
 * The same lines as the quotation they accepted, and deliberately so — an
 * invoice that restates the agreed figures is one nobody has to reconcile.
 * What it adds is the two things a quotation has no business carrying: WHEN
 * the money is due, and HOW to pay it.
 *
 * `dueOn` and `payTo` are both optional and both simply omitted when absent,
 * rather than printed as a blank row or an invented default. An invoice that
 * shows "Due: —" is worse than one that does not mention it: a client reads a
 * blank date as "whenever", and inventing thirty days would be this app making
 * up somebody's payment terms.
 */
export function invoiceEmail(invoice: {
  number: string;
  project: string;
  from: string;
  sentBy: string;
  dueOn: string | null;
  payTo: string | null;
  notes: string | null;
  lines: { description: string; quantity: number; unitCents: number; totalCents: number }[];
  totalCents: number;
}) {
  const money = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const qty = (n: number) => String(Number(n.toFixed(3)));

  const subject = `Invoice ${invoice.number} — ${invoice.project}`;

  const text = [
    `Invoice ${invoice.number}`,
    invoice.project,
    "",
    ...invoice.lines.map(
      (l) => `${l.description}\n  ${qty(l.quantity)} × ${money(l.unitCents)} = ${money(l.totalCents)}`
    ),
    "",
    `Total due: ${money(invoice.totalCents)}`,
    ...(invoice.dueOn ? [`Payment due by ${invoice.dueOn}`] : []),
    ...(invoice.payTo ? ["", "Payment details:", invoice.payTo] : []),
    ...(invoice.notes ? ["", invoice.notes] : []),
    "",
    `Sent by ${invoice.sentBy}, ${invoice.from}.`,
  ].join("\n");

  const rows = invoice.lines
    .map(
      (l) => `    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e6e9f0">${escapeHtml(l.description)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e6e9f0;text-align:right;white-space:nowrap;color:#55617a">${qty(l.quantity)} &times; ${money(l.unitCents)}</td>
      <td style="padding:8px 0 8px 16px;border-bottom:1px solid #e6e9f0;text-align:right;white-space:nowrap;font-weight:600">${money(l.totalCents)}</td>
    </tr>`
    )
    .join("\n");

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0b1220">
  <h1 style="margin:0 0 4px;font-size:20px;font-weight:600">Invoice ${escapeHtml(invoice.number)}</h1>
  <p style="margin:0 0 24px;color:#55617a">${escapeHtml(invoice.project)}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
${rows}
    <tr>
      <td style="padding:12px 0;font-weight:600">Total due</td>
      <td></td>
      <td style="padding:12px 0 12px 16px;text-align:right;font-weight:700;font-size:16px">${money(invoice.totalCents)}</td>
    </tr>
  </table>
  ${invoice.dueOn ? `<p style="margin:16px 0 0;font-weight:600">Payment due by ${escapeHtml(invoice.dueOn)}</p>` : ""}
  ${invoice.payTo ? `<p style="margin:20px 0 0;line-height:1.6;color:#55617a;white-space:pre-line"><strong style="color:#0b1220">Payment details</strong><br>${escapeHtml(invoice.payTo)}</p>` : ""}
  ${invoice.notes ? `<p style="margin:20px 0 0;line-height:1.6;color:#55617a;white-space:pre-line">${escapeHtml(invoice.notes)}</p>` : ""}
  <p style="margin:28px 0 0;font-size:13px;color:#8a94a8">
    Sent by ${escapeHtml(invoice.sentBy)}, ${escapeHtml(invoice.from)}.
  </p>
</div>`;

  return { subject, text, html };
}

/**
 * A message somebody wrote in the Inbox, on its way to a contact.
 *
 * Deliberately plain. A quotation and an invoice are documents and are laid
 * out as such; this is correspondence, and wrapping somebody's own words in a
 * branded template would change what they wrote. The only addition is the
 * sender's name and workspace at the foot, so the recipient knows who this is
 * and can reply to a person.
 *
 * The body is escaped and its line breaks preserved rather than parsed as
 * markup: whatever was typed is what arrives, and a stray angle bracket in a
 * sentence must not become a tag.
 */
export function messageEmail(message: {
  subject: string;
  body: string;
  fromName: string;
  workspace: string;
}) {
  const subject = message.subject.trim() || `Message from ${message.workspace}`;

  const text = [message.body, "", `— ${message.fromName}, ${message.workspace}`].join("\n");

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0b1220;font-size:15px;line-height:1.6">
  <div style="white-space:pre-line">${escapeHtml(message.body)}</div>
  <p style="margin:28px 0 0;font-size:13px;color:#8a94a8">
    ${escapeHtml(message.fromName)}, ${escapeHtml(message.workspace)}
  </p>
</div>`;

  return { subject, text, html };
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
