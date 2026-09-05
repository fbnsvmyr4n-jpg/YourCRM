"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Briefcase, Building2, ChevronDown, Search, Settings2 } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import { stageMeta } from "@/data/pipeline";
import type { CompanyProjects, Project } from "@/server/projects-view";

/**
 * The work, filed under the client it is for.
 *
 * "Heineken — rebuild warehouse", and next year another one for Heineken. The
 * pipeline board answers "what is at the demo stage"; this answers the question
 * a board cannot: what are we doing for this client, what did we do before, and
 * what did it come to.
 *
 * Deliberately a VIEW of the same deals rather than a second kind of record. A
 * project entity beside a deal would be two names for one thing and two screens
 * that slowly disagree about it — so a stage moved on the board is the same
 * move here, with nothing to keep in step.
 *
 * Live work is open and history is folded, because the reason to open a client
 * is almost always the job that is running now. A company with nothing live is
 * still listed, below the ones that have something — a dormant client is a fact,
 * and hiding it would make the list lie about who you have worked with.
 */

const money = (cents: number) => {
  const n = Math.round(cents / 100);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${n}`;
};

export function ProjectsView({ companies }: { companies: CompanyProjects[] }) {
  const [query, setQuery] = useState("");

  /**
   * Searches company names AND project titles.
   *
   * Somebody looking for "warehouse" does not necessarily remember it was
   * Heineken — that is the whole reason a project has a name. A company matches
   * if its own name matches, in which case all of its work is shown; otherwise
   * only the projects that match are.
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies
      .map((c) => {
        if (c.name.toLowerCase().includes(q)) return c;
        const hit = (p: Project) => p.title.toLowerCase().includes(q);
        return { ...c, live: c.live.filter(hit), history: c.history.filter(hit) };
      })
      .filter((c) => c.live.length > 0 || c.history.length > 0);
  }, [companies, query]);

  const liveCount = companies.reduce((n, c) => n + c.live.length, 0);

  return (
    <div className="mx-auto max-w-[1080px] animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Projects</h1>
          <p className="mt-1 text-sm text-muted">The work you are doing, by client.</p>
        </div>
        {/* Companies are still a thing you rename and tidy up; that screen did
            not stop being useful, it stopped being the front door. */}
        <Link
          href="/companies"
          className="btn-soft focus-ring flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-xs font-medium text-muted"
        >
          <Settings2 className="h-4 w-4" />
          Manage companies
        </Link>
      </div>

      <label className="relative mb-4 block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a client or a project"
          aria-label="Search projects"
          /* Padding set in the style attribute, not with `pl-9`.
             `field-input` sets the `padding` shorthand in a single-class rule,
             which beats a utility of equal specificity by source order — the
             placeholder ran under the magnifier on the Notes search for exactly
             this reason. */
          className="field-input"
          style={{ paddingLeft: 36 }}
        />
      </label>

      {shown.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            {query.trim()
              ? "No client or project matches that."
              : "No projects yet. A deal filed against a company appears here as that client's work."}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {!query.trim() && (
            <p className="px-0.5 text-xs text-faint">
              <span className="font-semibold text-[var(--text)]">{liveCount}</span>{" "}
              {liveCount === 1 ? "project is" : "projects are"} live across{" "}
              <span className="font-semibold text-[var(--text)]">{companies.length}</span>{" "}
              {companies.length === 1 ? "client" : "clients"}.
            </p>
          )}
          {shown.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompanyCard({ company }: { company: CompanyProjects }) {
  const [showHistory, setShowHistory] = useState(false);
  const historyId = `history-${company.id}`;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{company.name}</span>
          </span>
        }
        icon={<Building2 className="h-[18px] w-[18px] text-accent" />}
        action={
          company.wonCents > 0 ? (
            <span
              className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums"
              style={{ background: "var(--green-soft)", color: "var(--green)" }}
            >
              {money(company.wonCents)} won
            </span>
          ) : company.openCents > 0 ? (
            <CardMeta>{money(company.openCents)} in play</CardMeta>
          ) : undefined
        }
      />

      {company.live.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {company.live.map((p) => (
            <ProjectRow key={p.id} project={p} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">
          Nothing live for this client right now.
          {company.history.length > 0 && " Their finished work is below."}
        </p>
      )}

      {company.history.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            aria-controls={historyId}
            className="btn-soft focus-ring mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-medium text-muted"
          >
            <ChevronDown className={clsx("h-3.5 w-3.5 transition-transform", showHistory && "rotate-180")} />
            {showHistory ? "Hide" : "Show"} {company.history.length} finished{" "}
            {company.history.length === 1 ? "project" : "projects"}
          </button>
          {showHistory && (
            <ul id={historyId} className="mt-2 flex flex-col gap-2">
              {company.history.map((p) => (
                <ProjectRow key={p.id} project={p} muted />
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function ProjectRow({ project, muted = false }: { project: Project; muted?: boolean }) {
  const meta = stageMeta(project.stage);

  return (
    <li
      className="flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-3"
      style={{ background: muted ? "var(--raise)" : "var(--surface-2)" }}
    >
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-xl"
        style={{ background: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}
        aria-hidden
      >
        <Briefcase className="h-4 w-4" />
      </span>

      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">{project.title}</span>
        {/* Who is carrying it and who it runs through — the two facts you need
            before picking up the phone about it. Each half appears only when it
            exists, so an unassigned project says so rather than rendering a
            dash. */}
        <span className="mt-0.5 block truncate text-xs text-faint">
          {[
            project.ownerName ?? "Unassigned",
            project.contactName,
            project.meetings > 0
              ? `${project.meetings} ${project.meetings === 1 ? "meeting" : "meetings"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>

      {/*
          Stage and value on their own line on a phone.

          `w-full` below 440px is what forces the wrap: the row is `flex-wrap`,
          so a full-width group cannot share the line and the title keeps the
          whole of the first one. The same fix as the Team row and the Reports
          deal row — measure the content, then decide the container.
      */}
      <span className="flex w-full items-center justify-end gap-2 @min-[440px]:w-auto">
        {project.valueCents > 0 && (
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {money(project.valueCents)}
          </span>
        )}
        <span
          className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{
            background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
            color: meta.color,
          }}
        >
          {meta.label}
        </span>
      </span>
    </li>
  );
}
