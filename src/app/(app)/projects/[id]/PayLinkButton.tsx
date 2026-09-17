"use client";

import { createContext, useContext, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { invoicePayLinkAction } from "../actions";

/**
 * Whether this workspace can take card payment: Paystack connected, in a
 * currency Paystack settles. Decided once on the server for the page; a
 * context rather than a prop threaded through every document group.
 */
export const PaymentsReady = createContext(false);

/** Copy the client's pay link for a sent, unpaid invoice — for WhatsApp, or a reminder. */
export function PayLinkButton({ documentId }: { documentId: string }) {
  const ready = useContext(PaymentsReady);
  const [state, setState] = useState<"idle" | "busy" | "copied" | { error: string } | { url: string }>("idle");
  if (!ready) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          const out = await invoicePayLinkAction(documentId);
          if ("error" in out) return setState({ error: out.error });
          try {
            await navigator.clipboard.writeText(out.url);
            setState("copied");
            setTimeout(() => setState("idle"), 2000);
          } catch {
            /* No clipboard permission: show the link so it can be copied by hand. */
            setState({ url: out.url });
          }
        }}
        className="btn-soft focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-60"
      >
        {state === "copied" ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
        {state === "copied" ? "Pay link copied" : "Copy pay link"}
      </button>
      {typeof state === "object" && "error" in state && (
        <span className="text-xs" style={{ color: "var(--red)" }}>{state.error}</span>
      )}
      {typeof state === "object" && "url" in state && (
        <input readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} className="field-input !py-1 text-xs" aria-label="Pay link" />
      )}
    </span>
  );
}
