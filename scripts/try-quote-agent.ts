import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ask the real assistant to draft a quotation, against the dev database.
 *
 * The tool loop is covered by `tests/chat-tool-loop.test.ts` with a stubbed
 * model, which proves our half of the conversation: the assistant turn goes
 * back unchanged, the results come back in one message, the usage is billed
 * across every call. It cannot prove the half that matters to a customer —
 * whether Claude, reading a real price list, CHOOSES to call the tool and picks
 * sensible arguments. Only a real key answers that, and only a real run.
 *
 *   npm run try:quote                       # the default question
 *   npm run try:quote -- "your question"    # anything else
 *
 * It prints what the assistant said, then reads back what is actually in the
 * database — because the interesting failure is the two disagreeing: an
 * assistant that says it drafted something and did not.
 *
 * NOTHING IS SENT. The agent has no send tool, and this script does not
 * approve anything: a quotation it drafts sits in `awaiting_approval` exactly
 * as it would in the app, waiting for a person.
 */

/* ------------------------------------------------------------------ */
/* Refuse to touch anything that is not the local database             */
/* ------------------------------------------------------------------ */

function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error("No .env.local — run this from the project root with a dev database configured.");
    process.exit(1);
  }
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvLocal();

const url = process.env.DATABASE_URL ?? "";
/*
   The one check that matters in this file. It runs a real agent that WRITES,
   and pointing it at production would put agent-drafted rows in a customer's
   workspace to satisfy a curiosity. Localhost only, and it fails closed on
   anything it cannot recognise.
*/
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error(
    "DATABASE_URL is not a local database. This script writes, so it refuses to run anywhere else."
  );
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error(
    "ANTHROPIC_API_KEY is not set in .env.local.\n" +
      "Without it the assistant falls back to the deterministic one, which has no tools\n" +
      "and cannot draft — so this script would prove nothing."
  );
  process.exit(1);
}

const question =
  process.argv.slice(2).join(" ").trim() ||
  "Draft a quotation for the Heineken warehouse rebuild: three and a half days of crane hire and two site surveys.";

async function main() {
  const { withSystem, withTenant } = await import("../src/server/tenant");
  const { answer } = await import("../src/server/chat-agent");
  const { quotesNeedingUser } = await import("../src/server/repos/quotes");
  const { listPriceItems } = await import("../src/server/repos/pricing");
  const { listDeals } = await import("../src/server/repos/deals");
  const { closePool } = await import("../src/server/db");

  const sub = await withSystem((q) =>
    q.one<{ id: string; agency_id: string }>(
      `SELECT id, agency_id FROM sub_accounts WHERE deleted_at IS NULL
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`
    )
  );
  const user = await withSystem((q) =>
    q.one<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE agency_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [sub!.agency_id]
    )
  );
  if (!sub || !user) {
    console.error("No workspace in the dev database. Run `npm run dev:db` first.");
    process.exit(1);
  }

  const ctx = { agencyId: sub.agency_id, subAccountId: sub.id, userId: user.id, role: "owner" as const };

  await withTenant(ctx, async (q) => {
    const prices = await listPriceItems(q, true);
    const deals = (await listDeals(q)).filter((d) => d.wonAt === null);

    console.log(`\nWorkspace: ${sub.id}   asking as: ${user.name}`);
    console.log(`Price list (${prices.length}):`);
    for (const p of prices) console.log(`  • ${p.name} — $${(p.unitCents / 100).toFixed(2)} ${p.unit}`);
    console.log(`Open projects (${deals.length}): ${deals.map((d) => d.title).join(", ") || "none"}`);
    if (prices.length === 0) {
      console.log("\nNothing is priced, so the honest answer is that it cannot quote. Add items at /pricing.");
    }

    console.log(`\n> ${question}\n`);
    const started = Date.now();
    const reply = await answer(q, question, [], user.name);
    console.log(`--- the assistant (${reply.live ? "live model" : "FALLBACK — not the model"}, ${Date.now() - started}ms)`);
    console.log(reply.text);

    /* What is actually there, which is the point. An assistant that says it
       drafted a quotation and did not is the failure this exists to catch. */
    const pending = await quotesNeedingUser(q);
    console.log(`\n--- what is in the database: ${pending.length} quotation(s) awaiting a person`);
    for (const quote of pending) {
      console.log(`  ${quote.number} — ${quote.projectTitle} — ${quote.party ?? "no recipient"} [${quote.status}]`);
      for (const l of quote.lines) {
        console.log(
          `     ${l.description}  ${l.quantity} × $${(l.unitCents / 100).toFixed(2)} = $${(l.totalCents / 100).toFixed(2)}`
        );
      }
      console.log(`     total $${(quote.totalCents / 100).toFixed(2)}  drafted by: ${quote.draftedByAgent ?? "a person"}`);
      console.log(`     approved: ${quote.approvedAt ?? "no"}   sent: ${quote.sentAt ?? "no"}`);
    }
  });

  await closePool?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
