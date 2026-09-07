import { createHash } from "node:crypto";
import { logDenied, logWrite } from "../log";
import { canAccessCrm } from "../permissions";
import type { TenantQuery } from "../tenant";

/**
 * The CRM Tool Gateway.
 *
 * Every action an agent takes on this CRM passes through here, and the model is
 * never on the other side of it. The model proposes a tool name and a bag of
 * JSON; this decides whether that is allowed, whether the arguments are real,
 * whether it has happened already, and what actually gets written.
 *
 * The V2 specification's rule, restated because it governs every line below:
 * **the model never touches the database.** Not through a general
 * `update_anything(table, fields)` tool, not through raw SQL, not through a
 * repository imported directly into an agent file. A tool is a typed, named,
 * permissioned operation with an audit row, or it does not exist.
 *
 * Five things happen on every call, in this order, and none of them is
 * optional:
 *
 *  1. **Authority.** An agent is never its own principal. It acts as a named
 *     human whose permissions it can never exceed.
 *  2. **Validation.** The model's arguments are parsed by our own code, not
 *     trusted because a schema was sent to the model. A schema is a hint to the
 *     model; `parse` is the guarantee.
 *  3. **Risk.** A tool declares whether it may act alone, needs the caller to
 *     confirm, or needs a person in the CRM to approve. Nothing that reaches a
 *     customer is in the first tier.
 *  4. **Idempotency.** A retried webhook or a reconnected stream must not book
 *     two meetings. The second attempt is answered from the first one's result.
 *  5. **Audit.** Written in the same transaction as the work, so a mutation
 *     cannot exist without the record of who caused it.
 */

/* ------------------------------------------------------------------ */
/* Who is asking                                                       */
/* ------------------------------------------------------------------ */

/**
 * The principal an agent runs as.
 *
 * Deliberately not "the agent" as an identity of its own. Every mutation is
 * attributable to a person who could have made it by hand, which is what makes
 * the audit trail answer the question people actually ask six weeks later —
 * "who changed this" — with a name rather than "the system".
 *
 * `capabilities` is a subset the operator grants, never a superset of what the
 * user could do. A voice agent answering the phone at night must not be able to
 * do more than the person whose account it borrows.
 */
export type AgentPrincipal = {
  /** Which surface is asking. Recorded on every execution. */
  agent: "voice" | "chat";
  /** The human it acts as. */
  userId: string;
  /** That human's role, for the CRM-access gate. */
  role: string;
  /** The call this belongs to, when there is one. */
  callId?: string;
  /** What the operator has allowed this agent to do. */
  capabilities: ReadonlySet<ToolCapability>;
};

/**
 * What a tool needs permission to do.
 *
 * Coarser than the tool list on purpose: a capability is something an operator
 * can reason about when switching an agent on, and "may it read the customer
 * list" is a question with an answer, where "may it call search_contacts" is
 * not.
 */
export const TOOL_CAPABILITIES = [
  "read_crm",
  "write_activity",
  "write_contact",
  "write_task",
  "write_meeting",
  "draft_quote",
  "call_control",
] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/* ------------------------------------------------------------------ */
/* What a tool is                                                      */
/* ------------------------------------------------------------------ */

/**
 * How dangerous a tool is, which decides who has to say yes.
 *
 * `auto` — reversible, internal, and wrong at worst in a way somebody can fix.
 * `confirm` — the caller must have agreed in the conversation. The agent passes
 *   that agreement in explicitly; it cannot be inferred from tone.
 * `approve` — a person in the CRM approves before it takes effect. This is the
 *   tier a quotation sits in, and the reason the caller can never be the
 *   approver: they are the party it is being sent to.
 */
export type ToolRisk = "auto" | "confirm" | "approve";

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ToolDefinition<I, O> = {
  name: string;
  /** Written for the model. Says what it does and when to reach for it. */
  description: string;
  /** Written for a person reading an audit trail. */
  purpose: string;
  /** Advertised to the model. A hint, never the guarantee. */
  inputSchema: Record<string, unknown>;
  /**
   * OUR validation, run on whatever the model actually sent.
   *
   * Separate from `inputSchema` because they answer different questions: the
   * schema shapes what a well-behaved model produces, and this decides what we
   * are willing to act on. A model that ignores its schema, an older model, a
   * replayed payload and a hand-crafted request all arrive here.
   */
  parse: (raw: unknown) => ToolResult<I>;
  capability: ToolCapability;
  risk: ToolRisk;
  /**
   * Whether a retry is safe when we do not know if the first attempt landed.
   *
   * A read is always safe. A write is safe only if repeating it cannot produce
   * a second record — which for most writes means it is NOT, and the
   * idempotency record is what protects them instead.
   */
  retryable: boolean;
  run: (q: TenantQuery, input: I, principal: AgentPrincipal) => Promise<ToolResult<O>>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- a registry holds tools of
   many shapes; each one is fully typed at its own definition site, and this is
   the single place that has to hold them together. */
export type AnyTool = ToolDefinition<any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ */
/* Running one                                                         */
/* ------------------------------------------------------------------ */

export type Invocation = {
  tool: string;
  input: unknown;
  /**
   * What makes this call distinct from the same call retried.
   *
   * The caller supplies it — usually the model's own `tool_use` id, which is
   * stable across a retry of the same turn and different between turns. When it
   * is absent the arguments are hashed instead, so a genuine retry still
   * collides while a deliberate second booking does not.
   */
  actionId?: string;
  /**
   * Set when the caller has explicitly agreed, in the conversation, to a
   * `confirm`-tier action. Never inferred.
   */
  confirmed?: boolean;
};

export type Execution =
  | { status: "succeeded"; value: unknown; replayed: boolean }
  | { status: "refused"; error: string }
  | { status: "failed"; error: string };

/** Stable across retries of the same intent; different between real ones. */
function idempotencyKey(principal: AgentPrincipal, call: Invocation): string {
  const logical =
    call.actionId ??
    createHash("sha256").update(JSON.stringify(call.input ?? null)).digest("hex").slice(0, 16);
  return [principal.agent, principal.callId ?? "no-call", call.tool, logical].join(":");
}

/**
 * Run a tool, or refuse to.
 *
 * Returns a discriminated result rather than throwing: a refusal is an ordinary
 * outcome that the agent has to be told about so it can say something true to
 * the caller, and an exception would either crash a call or be swallowed into a
 * cheerful "done".
 */
export async function invoke(
  q: TenantQuery,
  registry: ReadonlyMap<string, AnyTool>,
  principal: AgentPrincipal,
  call: Invocation
): Promise<Execution> {
  const tool = registry.get(call.tool);
  if (!tool) {
    /* Not an error in our code — the model asked for something that does not
       exist. Logged as a refusal because a model reaching for absent tools is
       worth seeing in a trail. */
    return refuse(q, principal, call, `There is no tool called "${call.tool}".`);
  }

  /*
     The CRM-access gate, before anything else touches a record.

     The same gate the screens use: IT and accounts do not read customer data,
     and an agent borrowing their account does not get to either. Checked here
     rather than per tool so a tool added next year is covered by existing.
  */
  if (!canAccessCrm(principal.role)) {
    return refuse(q, principal, call, "This account does not have access to customer records.");
  }

  if (!principal.capabilities.has(tool.capability)) {
    return refuse(
      q,
      principal,
      call,
      `This agent is not allowed to ${tool.capability.replace(/_/g, " ")}.`
    );
  }

  /* A `confirm` tool without confirmation is refused, not queued. The agent's
     job is then to ask the caller and try again — which is a better
     conversation than one where the CRM changed and nobody said so. */
  if (tool.risk === "confirm" && !call.confirmed) {
    return refuse(
      q,
      principal,
      call,
      "That needs the caller to confirm it first. Ask them, then call this again with their agreement."
    );
  }

  const parsed = tool.parse(call.input);
  if (!parsed.ok) {
    return refuse(q, principal, call, parsed.error);
  }

  const key = idempotencyKey(principal, call);

  /*
     Has this already happened?

     Checked before the work rather than relying on the unique index alone,
     because the index can only tell us AFTER a duplicate write has been
     attempted — and for a tool that creates a meeting, attempting it is the
     damage.
  */
  const prior = await q.one<{ status: string; result: unknown; detail: string | null }>(
    `SELECT status, result, detail FROM agent_tool_executions
      WHERE sub_account_id = $1 AND idempotency_key = $2`,
    [q.ctx.subAccountId, key]
  );
  if (prior) {
    if (prior.status === "succeeded") {
      return { status: "succeeded", value: prior.result, replayed: true };
    }
    /* A previous refusal replays too: the conditions have not changed within a
       call, and re-running it would just write a second identical refusal. */
    if (prior.status === "refused") {
      return { status: "refused", error: prior.detail ?? "Refused." };
    }
    /* A previous FAILURE is allowed to be retried, but only where the tool says
       repeating it is safe. Otherwise we cannot know whether the first attempt
       landed before it broke. */
    if (!tool.retryable) {
      return {
        status: "failed",
        error: "That did not complete last time and cannot be safely retried. Check before trying again.",
      };
    }
    await q.rows(
      `DELETE FROM agent_tool_executions WHERE sub_account_id = $1 AND idempotency_key = $2`,
      [q.ctx.subAccountId, key]
    );
  }

  let outcome: ToolResult<unknown>;
  try {
    outcome = await tool.run(q, parsed.value, principal);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    await record(q, principal, call, key, "failed", detail, null);
    /* The message the agent may say aloud is deliberately vague; the detail
       goes to the trail. A caller does not need our stack. */
    return { status: "failed", error: "That could not be completed just now." };
  }

  if (!outcome.ok) {
    await record(q, principal, call, key, "failed", outcome.error, null);
    return { status: "failed", error: outcome.error };
  }

  await record(q, principal, call, key, "succeeded", null, outcome.value);
  logWrite("create", `agent_tool.${tool.name}`, {
    id: principal.callId,
    actor: principal.userId,
    detail: principal.agent,
  });
  return { status: "succeeded", value: outcome.value, replayed: false };
}

async function refuse(
  q: TenantQuery,
  principal: AgentPrincipal,
  call: Invocation,
  error: string
): Promise<Execution> {
  /* Recorded, and loudly. An agent reaching for something it may not have is
     the signal an attack looks like, and burying it among timeouts is how it
     goes unnoticed. */
  logDenied("agent-tool", `${principal.agent} attempted ${call.tool}`);
  await record(q, principal, call, idempotencyKey(principal, call), "refused", error, null);
  return { status: "refused", error };
}

async function record(
  q: TenantQuery,
  principal: AgentPrincipal,
  call: Invocation,
  key: string,
  status: "succeeded" | "failed" | "refused",
  detail: string | null,
  result: unknown
): Promise<void> {
  await q.rows(
    `INSERT INTO agent_tool_executions
       (id, sub_account_id, call_id, tool_name, actor_user_id, agent, status, detail, result, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     ON CONFLICT (sub_account_id, idempotency_key) DO NOTHING`,
    [
      `ate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      q.ctx.subAccountId,
      principal.callId ?? null,
      call.tool,
      principal.userId,
      principal.agent,
      status,
      detail?.slice(0, 500) ?? null,
      result === undefined ? null : JSON.stringify(result),
      key,
    ]
  );
}

/* ------------------------------------------------------------------ */
/* Building a registry                                                 */
/* ------------------------------------------------------------------ */

/** Refuses duplicate names, which would otherwise shadow silently. */
export function buildRegistry(tools: AnyTool[]): ReadonlyMap<string, AnyTool> {
  const map = new Map<string, AnyTool>();
  for (const tool of tools) {
    if (map.has(tool.name)) throw new Error(`Two tools are called "${tool.name}".`);
    map.set(tool.name, tool);
  }
  return map;
}

/**
 * The tool list as the model is told about it.
 *
 * Filtered by what this principal may actually do, so a model is never offered
 * a tool it will be refused for using — an agent that spends a turn asking for
 * something impossible is a worse conversation, and a model repeatedly refused
 * starts inventing ways around it.
 */
export function toolsFor(
  registry: ReadonlyMap<string, AnyTool>,
  principal: AgentPrincipal
): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return [...registry.values()]
    .filter((tool) => principal.capabilities.has(tool.capability))
    .map((tool) => ({
      name: tool.name,
      description:
        tool.risk === "approve"
          ? `${tool.description} This is drafted for a person to approve; it does not take effect on its own.`
          : tool.risk === "confirm"
            ? `${tool.description} Only call this once the caller has agreed to it out loud.`
            : tool.description,
      input_schema: tool.inputSchema,
    }));
}
