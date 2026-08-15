"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Bot,
  ChevronDown,
  KanbanSquare,
  Keyboard,
  LifeBuoy,
  Mail,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { FAQ_CATEGORIES, faqs, shortcuts, type FaqCategory } from "@/data/support";
import { clsx } from "@/lib/clsx";

const QUICK_LINKS = [
  {
    icon: KanbanSquare,
    title: "Deals Pipeline",
    body: "Drag deals between stages and watch your forecast update.",
    href: "/deals",
  },
  {
    icon: Bot,
    title: "Voice Agent",
    body: "Let Aria answer calls and book meetings automatically.",
    href: "/voice-agents",
  },
  {
    icon: Sparkles,
    title: "Chat Assistant",
    body: "Ask questions about your live pipeline and leads.",
    href: "/chat",
  },
  {
    icon: Settings,
    title: "Account Settings",
    body: "Update your profile, password and appearance.",
    href: "/settings",
  },
];

export function SupportView() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FaqCategory | "All">("All");
  const [open, setOpen] = useState<string | null>(faqs[0].q);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return faqs.filter((f) => {
      const inCategory = category === "All" || f.category === category;
      const inQuery = !q || f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q);
      return inCategory && inQuery;
    });
  }, [query, category]);

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-up">
      {/* Hero */}
      <Card className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(120% 140% at 0% 0%, var(--accent-soft), transparent 55%), radial-gradient(120% 140% at 100% 0%, var(--purple-soft), transparent 55%)",
          }}
        />
        <div className="relative text-center">
          <span
            className="mx-auto grid h-12 w-12 place-items-center rounded-2xl"
            style={{ background: "var(--accent-soft)" }}
          >
            <LifeBuoy className="h-6 w-6 text-accent" />
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">How can we help?</h1>
          <p className="mt-1.5 text-sm text-muted">
            Search the guides below, or ask the built-in assistant anything about your CRM.
          </p>

          <div className="relative mx-auto mt-5 max-w-xl">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search help articles…"
              className="focus-ring w-full rounded-2xl border border-[var(--border)] bg-[var(--panel-solid)]/60 py-3.5 pl-12 pr-4 text-sm outline-none transition-colors placeholder:text-faint focus:border-[var(--border-strong)]"
            />
          </div>
        </div>
      </Card>

      {/* Quick links */}
      <div className="mt-5 grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2 @min-[880px]:grid-cols-4">
        {QUICK_LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className="card focus-ring p-5 transition-colors hover:border-[var(--border-strong)]"
            >
              <span
                className="grid h-10 w-10 place-items-center rounded-xl"
                style={{ background: "var(--accent-soft)" }}
              >
                <Icon className="h-5 w-5 text-accent" />
              </span>
              <p className="mt-3 text-sm font-semibold">{l.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-faint">{l.body}</p>
            </Link>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 @min-[760px]:grid-cols-[minmax(0,1fr)_300px]">
        {/* FAQs */}
        <Card>
          <CardHeader title="Frequently asked questions" />

          {/* Category filter */}
          <div className="mb-4 flex flex-wrap gap-2">
            {(["All", ...FAQ_CATEGORIES] as const).map((c) => {
              const active = category === c;
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c as FaqCategory | "All")}
                  className={clsx(
                    "focus-ring rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                    active ? "text-accent" : "text-muted hover:text-[var(--text)]"
                  )}
                  style={active ? { background: "var(--accent-soft)" } : undefined}
                >
                  {c}
                </button>
              );
            })}
          </div>

          {results.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-muted">No articles match “{query}”.</p>
              <p className="mt-1 text-xs text-faint">
                Try the{" "}
                <Link href="/chat" className="text-accent hover:underline">
                  Chat Assistant
                </Link>{" "}
                — it can answer questions about your own data.
              </p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border)]">
              {results.map((f) => {
                const isOpen = open === f.q;
                return (
                  <div key={f.q}>
                    <button
                      onClick={() => setOpen(isOpen ? null : f.q)}
                      className="focus-ring flex w-full items-center justify-between gap-4 py-4 text-left"
                      aria-expanded={isOpen}
                    >
                      <span className="text-sm font-medium">{f.q}</span>
                      <ChevronDown
                        className={clsx(
                          "h-4 w-4 shrink-0 text-faint transition-transform",
                          isOpen && "rotate-180"
                        )}
                      />
                    </button>
                    {isOpen && (
                      <p className="pb-4 pr-8 text-sm leading-relaxed text-muted">{f.a}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Side rail */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Keyboard shortcuts"
              icon={<Keyboard className="h-[18px] w-[18px] text-accent" />}
            />
            <div className="flex flex-col gap-3">
              {shortcuts.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted">{s.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium text-muted"
                        style={{ background: "var(--raise)" }}
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Still stuck?" />
            <p className="text-sm leading-relaxed text-muted">
              Ask the assistant — it knows your live pipeline, leads and meetings and can answer
              questions specific to your account.
            </p>
            <Link
              href="/chat"
              className="btn-accent focus-ring mt-4 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold"
            >
              <Sparkles className="h-4 w-4" /> Ask the assistant
            </Link>
            <a
              href="mailto:support@yourcrm.com"
              className="btn-soft focus-ring mt-2.5 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
            >
              <Mail className="h-4 w-4" /> Email support
            </a>
          </Card>
        </div>
      </div>
    </div>
  );
}
