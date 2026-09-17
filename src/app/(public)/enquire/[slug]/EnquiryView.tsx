"use client";


import { useKeptForm } from "@/lib/use-kept-form";
import { enquireAction, type EnquireState } from "./actions";

/**
 * Four fields and a button.
 *
 * Nothing more, because every extra field on a public form is somebody who
 * gives up. Phone is optional and says so. The message box is the one that
 * matters: it is what the business reads before deciding how to reply.
 *
 * The trap field is positioned off-screen rather than `display: none`, because
 * the simplest bots skip fields that are not displayed, and hidden from
 * assistive technology so a screen reader user is never asked to fill it.
 */
export function EnquiryView({ slug, workspaceName }: { slug: string; workspaceName: string }) {
  const { state, onSubmit: action, pending } = useKeptForm<EnquireState>(enquireAction, undefined);

  if (state?.ok) {
    return (
      <Shell>
        <div className="flex flex-col gap-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">Sent</p>
          <h1 className="text-2xl font-semibold text-balance">Thanks — your message is in</h1>
          <p className="text-sm text-muted">{state.workspaceName} has your enquiry and will be in touch.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-faint">{workspaceName}</p>
        <h1 className="text-2xl font-semibold text-balance">Send us an enquiry</h1>
        <p className="text-sm text-muted">Tell us what you need and we will get back to you.</p>
      </header>

      <form onSubmit={action} className="flex flex-col gap-3">
        <input type="hidden" name="slug" value={slug} />

        <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
          <label>
            Leave this empty
            <input type="text" name="company_fax" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <input name="name" required maxLength={80} autoComplete="name" className="field-input" />
        </label>
        <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Email</span>
            <input name="email" type="email" required maxLength={160} autoComplete="email" className="field-input" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Phone <span className="text-faint">(optional)</span>
            </span>
            <input name="phone" type="tel" maxLength={40} autoComplete="tel" className="field-input" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">How can we help?</span>
          <textarea name="message" required maxLength={2000} rows={5} className="field-input resize-y" />
        </label>

        {state && !state.ok && (
          <p
            role="alert"
            className="rounded-xl px-4 py-3 text-sm"
            style={{ background: "var(--red-soft)", color: "var(--red)" }}
          >
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="btn-accent focus-ring mt-1 rounded-xl px-5 py-3 text-sm font-semibold disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send enquiry"}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="@container relative flex min-h-dvh items-start justify-center px-4 py-10 @min-[640px]:items-center">
      <div className="card flex w-full max-w-lg flex-col gap-6 rounded-2xl p-6">{children}</div>
    </main>
  );
}
