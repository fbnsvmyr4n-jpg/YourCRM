import { CLOSED_WON_STAGES, OPEN_STAGES, type Stage } from "./repos/deals";
import type { TenantQuery } from "./tenant";

/**
 * The work, filed under the client it is for.
 *
 * A project is not a new kind of record. "Heineken — rebuild warehouse" is a
 * deal: a title, a value, an owner, and a stage that already runs through
 * `delivery`, which is the product's word for "won it, now doing it". Making
 * projects a second entity would have produced two names for one thing and two
 * screens that slowly disagree about it. So this is a view — the same rows the
 * pipeline board shows, grouped by company instead of by stage.
 *
 * What that reframing buys is the question the board cannot answer: what are we
 * doing for this client, what have we done before, and what did it come to.
 */

/** One piece of work. */
export type Project = {
  id: string;
  title: string;
  stage: Stage;
  valueCents: number;
  wonAt: string | null;
  /** The person carrying it. Null when nobody has been assigned. */
  ownerName: string | null;
  /** Who at the client this runs through. Null when it has no contact yet. */
  contactName: string | null;
  meetings: number;
  lastActivityAt: string;
};

export type CompanyProjects = {
  id: string;
  name: string;
  domain: string | null;
  /** In play: won but still being delivered, or not yet closed. */
  live: Project[];
  /** Finished — delivered, referred on, or lost. */
  history: Project[];
  /** Money from work actually won, in integer cents. */
  wonCents: number;
  /** Value still in play. */
  openCents: number;
};

type Row = {
  company_id: string;
  company_name: string;
  domain: string | null;
  id: string;
  title: string;
  stage: Stage;
  value_cents: string;
  won_at: Date | null;
  owner_name: string | null;
  contact_name: string | null;
  meetings: string;
  last_activity_at: Date;
};

/**
 * Which projects are still work and which are history.
 *
 * `delivery` is the interesting one and the reason this is a named list rather
 * than "won or not". A delivered-but-unfinished job is the most live thing a
 * company has — somebody is on site — yet its money is already counted and its
 * deal is already won. Filing it under history because it closed would hide
 * exactly the work a project view exists to show.
 *
 * `referral` and `lost` are terminal; `won` without delivery means the sale
 * landed and the work has not started, which is still ahead of you.
 */
const LIVE_STAGES: readonly Stage[] = [...OPEN_STAGES, "won", "delivery"];

export function isLive(stage: Stage): boolean {
  return LIVE_STAGES.includes(stage);
}

/**
 * Every project, with its client, its owner and how recently anything happened.
 *
 * One statement rather than a query per company: an agency with forty clients
 * would otherwise make forty round trips to render one page.
 */
export async function listProjects(q: TenantQuery): Promise<Row[]> {
  return q.rows<Row>(
    `SELECT co.id   AS company_id,
            co.name AS company_name,
            co.domain,
            d.id, d.title, d.stage, d.value_cents, d.won_at,
            u.name AS owner_name,
            NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '') AS contact_name,
            (SELECT count(*) FROM meetings m
              WHERE m.deal_id = d.id AND m.deleted_at IS NULL)::text AS meetings,
            GREATEST(d.updated_at, d.created_at) AS last_activity_at
       FROM deals d
       JOIN companies co
            ON co.id = d.company_id
           AND co.sub_account_id = d.sub_account_id
           AND co.deleted_at IS NULL
       LEFT JOIN users u ON u.id = d.owner_user_id AND u.deleted_at IS NULL
       LEFT JOIN contacts c
            ON c.id = d.contact_id
           AND c.sub_account_id = d.sub_account_id
           AND c.deleted_at IS NULL
      WHERE d.deleted_at IS NULL AND d.sub_account_id = $1
      ORDER BY GREATEST(d.updated_at, d.created_at) DESC`,
    [q.ctx.subAccountId]
  );
}

/**
 * Group the projects under their companies.
 *
 * Pure, and separate from the SQL so the ordering can be checked against a
 * fixture whose every answer is known by hand.
 *
 * Companies are ordered by what is happening now, not by what they are worth:
 * anyone with live work first, most recently touched at the top, and dormant
 * clients after them. A client you closed R2m with three years ago should not
 * outrank the one whose warehouse you are rebuilding this week — that is the
 * difference between a project view and a revenue report.
 */
export function groupByCompany(rows: Row[]): CompanyProjects[] {
  const byCompany = new Map<string, CompanyProjects>();

  for (const r of rows) {
    let entry = byCompany.get(r.company_id);
    if (!entry) {
      entry = {
        id: r.company_id,
        name: r.company_name,
        domain: r.domain,
        live: [],
        history: [],
        wonCents: 0,
        openCents: 0,
      };
      byCompany.set(r.company_id, entry);
    }

    const project: Project = {
      id: r.id,
      title: r.title,
      stage: r.stage,
      valueCents: Number(r.value_cents),
      wonAt: r.won_at ? r.won_at.toISOString() : null,
      ownerName: r.owner_name,
      contactName: r.contact_name,
      meetings: Number(r.meetings),
      lastActivityAt: r.last_activity_at.toISOString(),
    };

    /* Money is counted by what the deal IS, not by which list it lands in — a
       delivery job is live AND its revenue is already won, and counting it as
       open would inflate the pipeline by work that is already paid for. Mirrors
       `contact-summaries.ts`, which is the rule the contact card uses. */
    if ((CLOSED_WON_STAGES as readonly Stage[]).includes(r.stage)) {
      entry.wonCents += project.valueCents;
    } else if ((OPEN_STAGES as readonly Stage[]).includes(r.stage)) {
      entry.openCents += project.valueCents;
    }

    (isLive(r.stage) ? entry.live : entry.history).push(project);
  }

  /* The rows arrive newest-first, so both lists are already in that order and
     nothing needs re-sorting inside a company. Only the companies do. */
  return [...byCompany.values()].sort((a, b) => {
    const aLive = a.live.length > 0;
    const bLive = b.live.length > 0;
    if (aLive !== bLive) return aLive ? -1 : 1;
    const at = a.live[0]?.lastActivityAt ?? a.history[0]?.lastActivityAt ?? "";
    const bt = b.live[0]?.lastActivityAt ?? b.history[0]?.lastActivityAt ?? "";
    return bt.localeCompare(at);
  });
}
