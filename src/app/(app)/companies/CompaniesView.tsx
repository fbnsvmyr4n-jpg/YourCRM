"use client";

import { useMemo, useState } from "react";
import { Building2, Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Overlay } from "@/components/ui/Overlay";
import { clsx } from "@/lib/clsx";
import type { CompanyRollup } from "@/server/repos/companies";
import {
  addCompanyAction,
  removeCompanyAction,
  renameCompanyAction,
} from "./actions";

/**
 * Managing companies.
 *
 * This screen exists because of what the backfill had to do. The company name
 * lived in a text column that had been used for two different things — a
 * company for some contacts, a note for others ("Looking for Sales Automation",
 * "makes coffee") — and turning that column into rows produced both.
 *
 * Without a way to rename or remove them, the entity would be worse than the
 * string it replaced: the same mess, now with a list of its own. So the two
 * operations that matter are the two that clean it up.
 *
 * Removal is soft and says so. The contacts keep every record; they simply stop
 * showing a company. The first thing anybody does here is delete in bulk, and
 * "I removed the wrong one" has to be survivable.
 */

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

export function CompaniesView({ companies }: { companies: CompanyRollup[] }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CompanyRollup | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((c) => c.name.toLowerCase().includes(q));
  }, [companies, query]);

  /**
   * Companies nobody works at and nobody has ever sold to.
   *
   * Almost always a note the backfill turned into a company. Counted rather
   * than hidden — hiding them would leave somebody scrolling a list wondering
   * why it is full of sentences, and deleting them automatically would be a
   * guess about which of their records are real.
   */
  const empties = companies.filter((c) => c.contacts === 0 && c.wonCents === 0 && c.openDeals === 0);

  async function run<T>(fn: () => Promise<T | { error?: string }>) {
    setBusy(true);
    setError(null);
    const result = (await fn()) as { error?: string };
    setBusy(false);
    if (result?.error) setError(result.error);
    return result;
  }

  return (
    <div className="mx-auto max-w-[900px] animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-5 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Companies</h1>
          <p className="mt-1 text-sm text-muted">
            Every deal for one company, across everyone who works there.
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
        >
          <Plus className="h-4 w-4" /> Add company
        </button>
      </div>

      {error && (
        <p
          className="mb-4 rounded-xl px-3.5 py-2.5 text-sm"
          style={{ background: "var(--red-soft)", color: "var(--red)" }}
        >
          {error}
        </p>
      )}

      {companies.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            No companies yet. They are created automatically when you import
            contacts, and you can add one here.
          </p>
        </Card>
      ) : (
        <>
          {empties.length > 0 && (
            /* Named plainly. The backfill turned an overloaded text column
               into rows, and this is how many of them look like notes rather
               than companies. */
            <p
              className="mb-4 rounded-xl px-3.5 py-2.5 text-sm"
              style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
            >
              {empties.length} {empties.length === 1 ? "company has" : "companies have"} nobody at
              them and no deals. If they came from an old notes field, remove them — the contacts
              keep everything.
            </p>
          )}

          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search companies"
              className="field-input pl-10"
              aria-label="Search companies"
            />
          </div>

          <Card>
            <ul className="flex flex-col">
              {shown.map((c, i) => (
                <li
                  key={c.id}
                  className={clsx(
                    "flex flex-wrap items-center gap-3 py-3",
                    i > 0 && "border-t border-[var(--border)]"
                  )}
                >
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                  >
                    <Building2 className="h-4 w-4" />
                  </span>

                  {editing === c.id ? (
                    <form
                      className="flex flex-1 items-center gap-2"
                      action={async (formData: FormData) => {
                        const r = await run(() => renameCompanyAction(c.id, formData));
                        if (!("error" in r) || !r.error) setEditing(null);
                      }}
                    >
                      <input
                        name="name"
                        defaultValue={c.name}
                        required
                        autoFocus
                        className="field-input flex-1"
                        aria-label="Company name"
                      />
                      <button
                        type="submit"
                        disabled={busy}
                        className="btn-accent focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-medium"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1 leading-tight">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="mt-0.5 truncate text-xs text-faint tabular-nums">
                          {c.contacts === 0
                            ? "Nobody here yet"
                            : `${c.contacts} ${c.contacts === 1 ? "person" : "people"}`}
                          {c.openDeals > 0 &&
                            ` · ${c.openDeals} open worth ${money(c.openCents)}`}
                        </p>
                      </div>

                      <span
                        className="shrink-0 text-sm font-semibold tabular-nums"
                        style={{ color: c.wonCents > 0 ? "var(--green)" : "var(--muted)" }}
                      >
                        {money(c.wonCents)}
                      </span>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => setEditing(c.id)}
                          className="focus-ring rounded p-1.5 text-faint transition-colors hover:text-accent"
                          aria-label={`Rename ${c.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setConfirming(c)}
                          className="focus-ring rounded p-1.5 text-faint transition-colors hover:text-[var(--red)]"
                          aria-label={`Remove ${c.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>

            {shown.length === 0 && (
              <p className="py-2 text-sm text-muted">Nothing matches “{query}”.</p>
            )}
          </Card>
        </>
      )}

      {adding && (
        <Overlay>
          <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setAdding(false)} />
            <div className="modal-surface relative z-10 w-full max-w-sm p-6">
              <h2 className="text-lg font-semibold tracking-tight">Add a company</h2>
              <p className="mt-0.5 text-xs text-faint">
                If the name already exists you will be taken to it rather than
                creating a second one.
              </p>
              <form
                className="mt-4"
                action={async (formData: FormData) => {
                  const r = await run(() => addCompanyAction(formData));
                  if (!("error" in r) || !r.error) setAdding(false);
                }}
              >
                <input name="name" required autoFocus placeholder="Acme Ltd" className="field-input" aria-label="Company name" />
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setAdding(false)} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
                    Cancel
                  </button>
                  <button type="submit" disabled={busy} className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
                    Add
                  </button>
                </div>
              </form>
            </div>
          </div>
        </Overlay>
      )}

      {confirming && (
        <Overlay>
          <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirming(null)} />
            <div className="modal-surface relative z-10 w-full max-w-sm p-6">
              <h2 className="text-lg font-semibold tracking-tight">Remove {confirming.name}?</h2>
              {/* Says exactly what happens, including what does NOT. Somebody
                  clearing out twenty rows needs to know the contacts are safe
                  before the first one, not after the twentieth. */}
              <p className="mt-2 text-sm text-muted">
                {confirming.contacts > 0
                  ? `${confirming.contacts} ${confirming.contacts === 1 ? "person" : "people"} will stay exactly as they are — they just stop showing a company.`
                  : "Nobody is attached to it, so nothing else changes."}
                {confirming.wonCents > 0 &&
                  ` The ${money(confirming.wonCents)} of won work stays on the deals.`}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirming(null)} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const r = await run(() => removeCompanyAction(confirming.id));
                    if (!("error" in r) || !r.error) setConfirming(null);
                  }}
                  className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-semibold text-red disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
