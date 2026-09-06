import { listDeals } from "./repos/deals";
import { listContacts } from "./repos/contacts";
import { listPriceItems, type PriceItem } from "./repos/pricing";
import {
  draftQuote,
  quotesAwaitingApproval,
  reviseQuote,
  type DraftLine,
  type Quote,
} from "./repos/quotes";
import { logWrite } from "./log";
import type { TenantQuery } from "./tenant";
import { decimal, multiline, text } from "./validate";

/**
 * The assistant's hands.
 *
 * Until now the chat agent could only read. This file is the first thing it can
 * WRITE, and everything in it is arranged around one rule:
 *
 *   **The AI drafts and revises. A named human approves. Only then does
 *   anything leave for a client.**
 *
 * There are two tools and neither of them sends. There is no send tool, no
 * status tool, no "mark approved" tool — approval is a button a person presses
 * in the UI, and the model is told so in its own instructions. The model cannot
 * be argued into sending a quotation because the vocabulary for it does not
 * exist in the tools it was handed.
 *
 * The second rule is that prices come from the price list. A line cites an item
 * on `price_items` by name; there is no field for the model to type an amount
 * into. That is not a formality — an AI asked to quote a crane with no price
 * list produces a number that looks like a price and is not one, and a
 * quotation is a document somebody signs.
 *
 * Tool INPUT is untrusted in exactly the way form input is untrusted. It is
 * generated text, so every number goes through the same validators a server
 * action uses. `decimal`, not `count`: a line of 3.5 days is ordinary, and
 * rounding it to 4 is how a purchase order once went out $7,250 too high.
 */

/** Enough for a real quotation; a cap so one call cannot write a hundred rows. */
const MAX_LINES = 30;
/** Matches `document_lines.quantity`, which is NUMERIC(14,3). */
const MAX_QUANTITY = 1_000_000;

export const QUOTE_TOOLS = [
  {
    name: "draft_quotation",
    description:
      "Draft a quotation for a project and put it in front of the user for approval. " +
      "Every line must name an item from the price list — you cannot set a price yourself. " +
      "The draft is NOT sent: it appears in the chat with Approve and Request changes buttons, " +
      "and only the user can send it. Say what you have drafted and what it comes to.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description:
            "Which project or deal the quotation is for, by name — e.g. 'Heineken Stellenbosch'.",
        },
        recipient: {
          type: "string",
          description:
            "The person it is addressed to, by name. Optional: defaults to the project's own contact.",
        },
        lines: {
          type: "array",
          description: "The lines of the quotation, in the order they should read.",
          items: {
            type: "object",
            properties: {
              item: {
                type: "string",
                description: "The price list item's name, exactly as it appears on the price list.",
              },
              quantity: {
                type: "number",
                description: "How many units. May have a fraction — 3.5 days is valid. Defaults to 1.",
              },
              note: {
                type: "string",
                description:
                  "Optional detail appended to the line, e.g. 'north elevation'. Never a price.",
              },
            },
            required: ["item"],
          },
        },
        notes: {
          type: "string",
          description: "Optional note for the foot of the quotation, e.g. validity or terms.",
        },
      },
      required: ["project", "lines"],
    },
  },
  {
    name: "revise_quotation",
    description:
      "Replace the lines of a quotation that is still waiting for approval, after the user has " +
      "asked for changes. Give the FULL set of lines the quotation should now have, not just the " +
      "changed ones. The revision is counted and still requires the user's approval.",
    input_schema: {
      type: "object" as const,
      properties: {
        quotation: {
          type: "string",
          description: "The quotation's number, e.g. 'Q-1042'.",
        },
        lines: {
          type: "array",
          description: "The complete set of lines the quotation should now have.",
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "The price list item's name." },
              quantity: { type: "number", description: "How many units. May have a fraction." },
              note: { type: "string", description: "Optional detail appended to the line." },
            },
            required: ["item"],
          },
        },
        notes: { type: "string", description: "Optional replacement note for the foot." },
      },
      required: ["quotation", "lines"],
    },
  },
];

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

/** A quantity reads as "3.5" and "2", never "3.500" and "2.000". */
const qty = (n: number) => String(Number(n.toFixed(3)));

/**
 * What the model is told about a quotation it just wrote.
 *
 * The document id is deliberately absent. The model refers to a quotation by
 * its NUMBER, which is what the user sees on the card and says out loud; giving
 * it an internal id as well would only be an opportunity to quote one at
 * somebody.
 */
function describe(quote: Quote, lead: string): string {
  return [
    `${lead} ${quote.number} for ${quote.projectTitle}${quote.party ? `, addressed to ${quote.party}` : ""}.`,
    ...quote.lines.map(
      (l) => `  • ${l.description} — ${qty(l.quantity)} × ${money(l.unitCents)} = ${money(l.totalCents)}`
    ),
    `  Total: ${money(quote.totalCents)}`,
    quote.partyEmail
      ? `It is waiting for the user's approval. When they approve it, it will be emailed to ${quote.partyEmail}.`
      : "It is waiting for the user's approval. NOTE: that contact has no email address on file, so it cannot be emailed until one is added — tell the user.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Resolving what the model named                                      */
/* ------------------------------------------------------------------ */

/**
 * Find the one thing the model meant, or say why not.
 *
 * Ambiguity comes back as an ERROR to the model rather than being resolved by
 * picking the first match. The model can then ask the user which one — which is
 * what a person would do, and infinitely better than silently quoting the wrong
 * job. Anything returned here has been read out of this tenant's own database;
 * a name the model invented resolves to nothing.
 */
function resolveOne<T>(
  query: string,
  candidates: T[],
  nameOf: (item: T) => string
): { item?: T; error?: string } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { error: "No name was given." };

  const exact = candidates.filter((c) => nameOf(c).toLowerCase() === needle);
  if (exact.length === 1) return { item: exact[0] };

  const partial = candidates.filter((c) => {
    const name = nameOf(c).toLowerCase();
    return name.includes(needle) || needle.includes(name);
  });
  if (partial.length === 1) return { item: partial[0] };
  if (partial.length > 1) {
    return {
      error: `"${query}" matches more than one: ${partial.map(nameOf).join(", ")}. Ask which one.`,
    };
  }
  return { error: `Nothing matches "${query}".` };
}

type ToolLine = { item?: unknown; quantity?: unknown; note?: unknown };

/**
 * Model-written lines into rows, or a refusal.
 *
 * Every line has to resolve to a price list item and a readable quantity. One
 * bad line fails the whole call rather than being dropped: a quotation missing
 * a line the user asked for, sent without comment, is worse than a tool error
 * the model has to explain.
 */
function buildLines(
  raw: unknown,
  prices: PriceItem[]
): { lines?: DraftLine[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "No lines were given. A quotation needs at least one." };
  }
  if (raw.length > MAX_LINES) {
    return { error: `That is more than ${MAX_LINES} lines. Split it into separate quotations.` };
  }
  if (prices.length === 0) {
    return {
      error:
        "There is nothing on the price list yet, so there are no prices to quote. " +
        "Ask the user to add what they sell on the Price list page first.",
    };
  }

  const lines: DraftLine[] = [];
  for (const entry of raw as ToolLine[]) {
    const wanted = text(entry?.item, 120);
    const { item, error } = resolveOne(wanted, prices, (p) => p.name);
    if (!item) {
      return {
        error: `${error} The price list has: ${prices.map((p) => p.name).join(", ")}.`,
      };
    }

    /* `decimal`, and three places, matching NUMERIC(14,3) on the column — so a
       quantity cannot be accepted here and then rounded again by the database.
       A MISSING quantity is one; a quantity of zero is a line included at no
       charge, which is meaningful, so it is not treated as missing. */
    const quantity =
      entry?.quantity === undefined || entry?.quantity === null
        ? 1
        : decimal(entry.quantity, MAX_QUANTITY, 3);
    if (quantity === null) {
      return { error: `The quantity for "${item.name}" could not be read as a number.` };
    }

    const note = text(entry?.note, 120);
    lines.push({
      description: note ? `${item.name} — ${note}` : item.name,
      quantity,
      unitCents: item.unitCents,
    });
  }

  return { lines };
}

/* ------------------------------------------------------------------ */
/* Running a tool                                                      */
/* ------------------------------------------------------------------ */

export type ToolOutcome = {
  /** What goes back to the model as the tool result. */
  text: string;
  /** The quotation this call produced, if it produced one. */
  quote?: Quote;
};

export async function runQuoteTool(
  q: TenantQuery,
  name: string,
  input: unknown,
  agent: string
): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === "draft_quotation") {
    const deals = (await listDeals(q)).filter((d) => d.wonAt === null);
    const contacts = await listContacts(q);
    const fullName = (c: (typeof contacts)[number]) => `${c.firstName} ${c.lastName}`.trim();

    const { item: deal, error: dealError } = resolveOne(
      text(args.project, 140),
      deals,
      (d) => d.title
    );
    if (!deal) {
      return {
        text: `${dealError} Open projects are: ${deals.map((d) => d.title).join(", ") || "none"}.`,
      };
    }

    /* Who it is addressed to. Named explicitly if the user said so, otherwise
       the project's own contact — and if the project has neither, the quotation
       is still drafted. A missing recipient is something the person approving
       can fix in a second; refusing to draft over it wastes the work. */
    let recipient: (typeof contacts)[number] | null = null;
    const namedRecipient = text(args.recipient, 120);
    if (namedRecipient) {
      const { item, error } = resolveOne(namedRecipient, contacts, fullName);
      if (!item) return { text: `${error} Give a contact's name, or leave it out.` };
      recipient = item;
    } else {
      recipient = contacts.find((c) => c.id === deal.contactId) ?? null;
    }

    const prices = await listPriceItems(q, true);
    const { lines, error: lineError } = buildLines(args.lines, prices);
    if (!lines) return { text: lineError! };

    const { quote, error } = await draftQuote(q, {
      dealId: deal.id,
      partyContactId: recipient?.id ?? null,
      party: recipient
        ? `${fullName(recipient)}${recipient.companyName ? `, ${recipient.companyName}` : ""}`
        : null,
      notes: multiline(args.notes, 600) || null,
      lines,
      agent,
    });
    if (!quote) return { text: error ?? "The quotation could not be drafted." };

    /* Logged because a priced document now exists that nobody typed. The id and
       the actor, and nothing about what it says — the log must never carry
       record contents. */
    logWrite("draft", "quote", {
      id: quote.id,
      actor: q.ctx.userId,
      detail: `${agent} agent, ${quote.lines.length} lines`,
    });

    return { text: describe(quote, "Drafted quotation"), quote };
  }

  if (name === "revise_quotation") {
    const pending = await quotesAwaitingApproval(q);
    const { item: existing, error: findError } = resolveOne(
      text(args.quotation, 60),
      pending,
      (d) => d.number
    );
    if (!existing) {
      return {
        text: `${findError} Waiting for approval: ${pending.map((p) => p.number).join(", ") || "nothing"}.`,
      };
    }

    const prices = await listPriceItems(q, true);
    const { lines, error: lineError } = buildLines(args.lines, prices);
    if (!lines) return { text: lineError! };

    const { quote, error } = await reviseQuote(q, {
      documentId: existing.id,
      lines,
      notes: multiline(args.notes, 600) || null,
    });
    if (!quote) return { text: error ?? "The quotation could not be revised." };

    logWrite("update", "quote", {
      id: quote.id,
      actor: q.ctx.userId,
      detail: `${agent} agent, revision ${quote.revision}`,
    });

    return { text: describe(quote, `Revised quotation (revision ${quote.revision})`), quote };
  }

  /* An unknown tool name is a bug, not an attack — the model can only call what
     it was handed — but it is answered rather than thrown so one bad name does
     not take the user's whole message down with it. */
  return { text: `There is no tool called "${name}".` };
}

/**
 * What the agent is told about quoting, appended to its system prompt.
 *
 * Written as house rules rather than as a warning, because that is what they
 * are: this is how quoting works here, and the model following them produces
 * the same behaviour a new employee following them would.
 */
export function quoteInstructions(): string {
  return [
    "QUOTATIONS.",
    "You can draft a quotation with draft_quotation, and change one with revise_quotation.",
    "You CANNOT send a quotation, and you must never say or imply that you have sent one, or that you will.",
    "A draft appears in the chat with Approve and Request changes buttons; only the user can send it, by approving it.",
    "Every line takes its price from the price list. If somebody asks you to quote something that is not on it, say so and offer what is — never estimate a price.",
    "When the user asks for a change to a quotation that is waiting for approval, call revise_quotation with the FULL set of lines it should end up with.",
  ].join("\n");
}
