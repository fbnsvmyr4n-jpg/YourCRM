"use client";

import { useRef, useState } from "react";
import { ClipboardPaste, FileUp, Truck } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { useKeptForm } from "@/lib/use-kept-form";
import { useMoney } from "@/components/money/CurrencyProvider";
import { useCanWrite } from "@/components/shell/CanWrite";
import { clsx } from "@/lib/clsx";
import {
  applyPriceListAction,
  previewPriceListAction,
  type FormState,
  type ImportPreview,
} from "@/app/(app)/pricing/actions";
import type { Supplier } from "@/server/repos/suppliers";

/**
 * Loading a supplier's price list by pasting or dropping it in.
 *
 * A supplier emails a PDF or a spreadsheet. Nobody is going to retype forty
 * rows into a form, and a product that asks them to is a product quoting last
 * year's prices — so the whole lot goes in at once and the app works out what
 * it says.
 *
 * ── Why it previews instead of just doing it ──────────────────────────────
 *
 * Every quotation this business sends is built from these numbers. Pasting the
 * wrong column, or last quarter's file, re-prices the lot. So nothing is
 * written until somebody has read one sentence — "47 new, 12 with a new price,
 * 3 we could not read" — and pressed the button under it.
 *
 * The lines it could not read are shown in full, never as a count alone. A row
 * dropped out of a price list is a rate somebody quotes from memory next month.
 */
export function SupplierImport({
  suppliers,
  prefill = null,
}: {
  suppliers: Supplier[];
  /**
   * A list carried here from a supplier's message.
   *
   * Opens the box with their text already in it and their name chosen, and
   * then behaves exactly like a paste — same preview, same confirm. The
   * automation removes the typing, not the looking.
   */
  prefill?: { supplierId: string; text: string } | null;
}) {
  const canWrite = useCanWrite();
  const { format } = useMoney();
  const money = (cents: number) => format(cents, "exact");

  /*
     Held, but never trusted on its own.

     This was `useState(suppliers[0]?.id ?? "")`, which reads the list ONCE —
     and the first supplier a workspace adds arrives after this component has
     already mounted with an empty list. So the select showed "Stone Yard"
     while the form posted "", and reading a pasted list answered "choose which
     supplier this is from" with the supplier plainly chosen on screen. Found
     by adding the first supplier and immediately pasting, which is exactly the
     order anybody does it in.

     Falling back to the first means the control and the form always agree,
     whatever order the data turned up in.
  */
  const [held, setSupplierId] = useState(prefill?.supplierId ?? "");
  const supplierId = suppliers.some((s) => s.id === held) ? held : (suppliers[0]?.id ?? "");
  const [pasted, setPasted] = useState(prefill?.text ?? "");
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const preview = useKeptForm<ImportPreview | FormState>(previewPriceListAction, undefined);
  const apply = useKeptForm<FormState>(applyPriceListAction, undefined);

  /* The preview is only about the text that produced it. Typing again after
     looking at one must not leave an old plan on screen to be applied. */
  const plan =
    preview.state && "changes" in preview.state && preview.state.supplierId === supplierId
      ? preview.state
      : null;

  if (!canWrite || suppliers.length === 0) return null;

  /**
   * A dropped file.
   *
   * Read as text in the browser, because that is all this parser wants and it
   * means nothing is uploaded anywhere to find out whether it is readable. A
   * .csv or a .txt lands perfectly; a PDF arrives as the binary it is, which is
   * why the box says what it accepts rather than letting somebody find out.
   */
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPasted(text);
    boxRef.current?.focus();
  }

  return (
    <Card className="mb-4">
      <CardHeader
        title="Load a supplier's price list"
        icon={<Truck className="h-[18px] w-[18px] text-accent" />}
      />

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Whose list is this?</span>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="field-input"
          >
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.listUpdatedOn ? ` — last loaded ${s.listUpdatedOn}` : " — never loaded"}
              </option>
            ))}
          </select>
        </label>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={clsx(
            "rounded-xl border border-dashed p-2 transition-colors",
            dragging ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)]"
          )}
        >
          <textarea
            ref={boxRef}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={7}
            aria-label="The supplier's price list"
            placeholder={"Paste their list here, or drop a CSV or text file on this box.\n\nPaving stone 50mm\tm²\t450.00\nSite labour\tday\t1 800,00"}
            className="field-input resize-y font-mono text-[13px] leading-relaxed"
          />
          <p className="px-1 pb-1 text-xs text-faint">
            <ClipboardPaste className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            Straight out of a spreadsheet, an email or a PDF table. It works out which column is the
            price.
          </p>
        </div>

        {/* Two forms over the same text. Looking is not doing. */}
        <form onSubmit={preview.onSubmit} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="supplierId" value={supplierId} />
          <input type="hidden" name="pasted" value={pasted} />
          <button
            type="submit"
            disabled={preview.pending || !pasted.trim()}
            className="btn-soft focus-ring flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            <FileUp className="h-4 w-4" />
            {preview.pending ? "Reading…" : "Read it"}
          </button>
          {preview.state && "error" in preview.state && preview.state.error && (
            <Banner state={{ error: preview.state.error }} />
          )}
        </form>

        {plan && (
          <div className="rounded-xl p-3" style={{ background: "var(--sunken)" }}>
            <p className="text-sm font-semibold">{plan.summary}</p>

            {plan.changes.length > 0 && (
              <ul className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto text-xs">
                {plan.changes.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0 flex-1 truncate">
                      {c.line.name}
                      <span className="text-faint"> · {c.line.unit}</span>
                    </span>
                    {c.kind === "changed" ? (
                      /* Both numbers, because the change is the point — a rate
                         that doubled is something to look at twice. */
                      <span className="shrink-0 tabular-nums">
                        <span className="text-faint line-through">{money(c.fromCents)}</span>{" "}
                        <span className="font-semibold text-[var(--amber)]">
                          {money(c.line.unitCents)}
                        </span>
                      </span>
                    ) : (
                      <span
                        className={clsx(
                          "shrink-0 tabular-nums",
                          c.kind === "new" ? "font-semibold text-[var(--green)]" : "text-faint"
                        )}
                      >
                        {money(c.line.unitCents)}
                        {c.kind === "same" && " · unchanged"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* In full, never as a count on its own. */}
            {plan.unread.length > 0 && (
              <div
                className="mt-3 rounded-lg px-3 py-2"
                style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
              >
                <p className="text-xs font-semibold">
                  {plan.unread.length} line{plan.unread.length === 1 ? "" : "s"} could not be read, and
                  nothing will be saved for {plan.unread.length === 1 ? "it" : "them"}:
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                  {plan.unread.slice(0, 12).map((u, i) => (
                    <li key={i} className="truncate font-mono">
                      {u.source} <span className="opacity-70">— {u.reason}</span>
                    </li>
                  ))}
                  {plan.unread.length > 12 && (
                    <li className="opacity-70">…and {plan.unread.length - 12} more</li>
                  )}
                </ul>
              </div>
            )}

            <form onSubmit={apply.onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="supplierId" value={supplierId} />
              <input type="hidden" name="pasted" value={pasted} />
              <button
                type="submit"
                disabled={apply.pending}
                className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {apply.pending ? "Loading…" : "Load these prices"}
              </button>
              <span className="text-xs text-faint">
                Nothing is withdrawn — anything missing from this list stays as it is.
              </span>
            </form>
          </div>
        )}

        {apply.state && <Banner state={apply.state} />}
      </div>
    </Card>
  );
}
