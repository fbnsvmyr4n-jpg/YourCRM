"use client";

import { useState } from "react";
import { Building2, Landmark, Receipt } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader } from "@/components/ui/Card";
import { useKeptForm } from "@/lib/use-kept-form";
import { formatMoney } from "@/lib/money";
import { rateLabel, vatBreakdown } from "@/server/vat";
import type { Settings } from "@/server/repos/settings";
import { updateBusinessDetailsAction, type FormState } from "./actions";

/**
 * Who this business is, on the paperwork it hands to other people.
 *
 * The product could print a quotation long before it could print a document a
 * business could lawfully issue. A tax invoice in South Africa — and in most
 * markets this is sold into — has to carry the supplier's address, its company
 * registration number and its VAT number, and has to show the tax separately
 * from the amount before it. Without those the sheet is a nice-looking page a
 * bookkeeper sends back, and the business quietly goes back to Word.
 *
 * ── Why the VAT question is asked in words ────────────────────────────────
 *
 * "Prices include VAT" is a checkbox with a 15% consequence: the same typed
 * R1,000 is either R1,150 to pay or R1,000 to pay. Nothing on the screen would
 * look wrong either way, and the error only surfaces when a client queries an
 * invoice. So the control does not merely have a label — it shows both readings
 * of a real amount, in this workspace's own currency, updating as it is
 * ticked. Somebody setting this up sees the answer before they save it.
 *
 * ── Why it says what is still missing ─────────────────────────────────────
 *
 * Charging VAT without a registration number on the document produces an
 * invoice a client's accountant will reject. The card names exactly which
 * fields are still empty rather than saving happily and letting the discovery
 * happen at the other end.
 */

/** The figure the example is worked on: big enough to show cents honestly. */
const EXAMPLE_CENTS = 100000;

export function BusinessCard({
  settings,
  canManage,
}: {
  settings: Settings;
  /** Owners and finance. A member must not be able to change the bank account. */
  canManage: boolean;
}) {
  const { state, onSubmit: action, pending } = useKeptForm<FormState>(
    updateBusinessDetailsAction,
    undefined
  );

  /* Mirrored in state only so the example below can react as somebody types.
     What is SAVED is what the form posts — these are not a second source of
     truth, and the inputs stay uncontrolled so `useKeptForm` can restore them
     exactly as typed if the action comes back with a refusal. */
  const [ratePercent, setRatePercent] = useState(
    settings.vatRateBp ? String(settings.vatRateBp / 100) : "0"
  );
  const [inclusive, setInclusive] = useState(settings.pricesIncludeVat);

  const typedRate = Number(ratePercent);
  const rateBp =
    Number.isFinite(typedRate) && typedRate >= 0 && typedRate <= 100
      ? Math.round(typedRate * 100)
      : 0;
  const example = vatBreakdown(EXAMPLE_CENTS, rateBp, inclusive);
  const money = (cents: number) => formatMoney(cents, settings.currency, "cents");

  return (
    <Card className="card-q">
      <CardHeader
        title="Business details"
        icon={<Building2 className="h-[18px] w-[18px] text-accent" />}
      />

      {!canManage ? (
        /* Shown, not hidden. Somebody who cannot change these still needs to
           know what is on the documents going out in their name. */
        <ReadOnly settings={settings} />
      ) : (
        <form onSubmit={action} className="space-y-5">
          <Banner state={state} />

          <section className="space-y-4">
            <p className="text-xs text-faint">
              Printed at the top of every quotation, purchase order and invoice. Leave a field empty
              and it is left off the document rather than printed blank.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Trading address</span>
              <textarea
                name="businessAddress"
                rows={3}
                defaultValue={settings.businessAddress ?? ""}
                placeholder={"12 Main Road\nClaremont\nCape Town, 7708"}
                className="field-input resize-y"
              />
            </label>
            <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
              <Field
                label="Phone"
                name="businessPhone"
                defaultValue={settings.businessPhone ?? ""}
              />
              <Field
                label="Email on documents"
                name="businessEmail"
                type="email"
                defaultValue={settings.businessEmail ?? ""}
              />
              <Field
                label="Company registration number"
                name="registrationNumber"
                defaultValue={settings.registrationNumber ?? ""}
              />
              <Field
                label="VAT registration number"
                name="vatNumber"
                defaultValue={settings.vatNumber ?? ""}
              />
            </div>
          </section>

          {/* ---- VAT ---- */}
          <section className="space-y-3 rounded-xl border border-[var(--border)] p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Receipt className="h-4 w-4 text-accent" />
              VAT
            </p>

            <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Rate (%)</span>
                <input
                  name="vatRate"
                  inputMode="decimal"
                  value={ratePercent}
                  onChange={(e) => setRatePercent(e.target.value)}
                  placeholder="15"
                  className="field-input"
                />
              </label>
              <label className="flex cursor-pointer items-start gap-3 pt-6">
                <input
                  type="checkbox"
                  name="pricesIncludeVat"
                  checked={inclusive}
                  onChange={(e) => setInclusive(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                />
                <span className="text-sm">
                  Prices I type already include VAT
                  <span className="mt-0.5 block text-xs text-faint">
                    Tick this if the figures on your quotes are what the client pays.
                  </span>
                </span>
              </label>
            </div>

            {/* The consequence, in this workspace's own money, before saving. */}
            {rateBp > 0 && example ? (
              <div className="rounded-lg bg-[var(--sunken)] p-3 text-xs">
                {/* Through the product's own formatter, not `toLocaleString`:
                    this renders on the server and again in the browser, and the
                    two need not agree about what a thousand looks like. */}
                <p className="font-semibold">
                  A line typed as {formatMoney(EXAMPLE_CENTS, settings.currency, "whole")}:
                </p>
                <dl className="mt-2 space-y-1 tabular-nums">
                  <Row label="Before VAT" value={money(example.netCents)} />
                  <Row label={`VAT at ${rateLabel(rateBp)}`} value={money(example.vatCents)} />
                  <Row label="The client pays" value={money(example.grossCents)} strong />
                </dl>
              </div>
            ) : (
              <p className="text-xs text-faint">
                A rate of 0 means no VAT is shown anywhere — the right setting for a business that
                is not VAT registered.
              </p>
            )}

            {rateBp > 0 && <Missing settings={settings} />}
          </section>

          {/* ---- how to pay ---- */}
          <section className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Landmark className="h-4 w-4 text-accent" />
              How clients pay you
            </p>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Payment details</span>
              <textarea
                name="invoicePayTo"
                rows={3}
                defaultValue={settings.invoicePayTo ?? ""}
                placeholder={"Bank: Standard Bank\nAccount: 123 456 789\nBranch: 051001\nReference: your invoice number"}
                className="field-input resize-y"
              />
            </label>
            <p className="text-xs text-faint">
              Printed at the foot of every invoice and shown on the online payment page. Free text,
              because every country names these differently.
            </p>
          </section>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={pending}
              className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save business details"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * What a tax invoice still lacks.
 *
 * Named one by one rather than as "incomplete". A business that has filled in
 * three of four fields needs to know which one is missing, not that something
 * is — and it is said while somebody is on this screen with the details to
 * hand, rather than by a client's accountant three weeks later.
 */
function Missing({ settings }: { settings: Settings }) {
  const missing = [
    !settings.vatNumber && "your VAT registration number",
    !settings.businessAddress && "your trading address",
    !settings.registrationNumber && "your company registration number",
  ].filter(Boolean) as string[];

  if (missing.length === 0) return null;

  return (
    <p
      role="status"
      className="rounded-lg px-3 py-2 text-xs"
      style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
    >
      A tax invoice normally has to show {missing.join(", ")}. Until {missing.length === 1 ? "it is" : "they are"}{" "}
      saved, documents leave {missing.length === 1 ? "that line" : "those lines"} off rather than
      printing something made up.
    </p>
  );
}

function ReadOnly({ settings }: { settings: Settings }) {
  const rows: [string, string | null][] = [
    ["Trading address", settings.businessAddress],
    ["Phone", settings.businessPhone],
    ["Email", settings.businessEmail],
    ["Company registration", settings.registrationNumber],
    ["VAT number", settings.vatNumber],
    ["VAT rate", settings.vatRateBp > 0 ? rateLabel(settings.vatRateBp) : "Not charged"],
    [
      "Prices typed",
      settings.vatRateBp > 0
        ? settings.pricesIncludeVat
          ? "Include VAT"
          : "Exclude VAT"
        : null,
    ],
  ];

  return (
    <div className="space-y-2 text-sm">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-x-6 gap-y-0.5">
            <span className="text-muted">{label}</span>
            <span className="whitespace-pre-line text-right font-medium">{value}</span>
          </div>
        ))}
      <p className="pt-1 text-xs text-faint">
        These appear on every document this workspace issues. An owner or a finance user can change
        them.
      </p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className="text-muted">{label}</dt>
      <dd className={strong ? "font-bold" : "font-medium"}>{value}</dd>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <input name={name} type={type} defaultValue={defaultValue} className="field-input" />
    </label>
  );
}
