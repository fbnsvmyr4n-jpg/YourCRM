"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CornerDownLeft,
  Handshake,
  Home,
  Inbox,
  KanbanSquare,
  Search,
  Settings,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import type { SearchItem } from "@/app/api/search/route";
import { clsx } from "@/lib/clsx";

export const OPEN_COMMAND_EVENT = "open-command-palette";

type PageItem = {
  id: string;
  type: "Page";
  title: string;
  subtitle: string;
  href: string;
  icon: LucideIcon;
};

const PAGES: PageItem[] = [
  { id: "page-home", type: "Page", title: "Dashboard", subtitle: "Home overview", href: "/", icon: Home },
  { id: "page-deals", type: "Page", title: "Deals Pipeline", subtitle: "Kanban board", href: "/deals", icon: KanbanSquare },
  { id: "page-contacts", type: "Page", title: "Contacts", subtitle: "People & companies", href: "/contacts", icon: Users },
  { id: "page-leads", type: "Page", title: "Leads", subtitle: "Sales targets", href: "/leads", icon: Target },
  { id: "page-meetings", type: "Page", title: "Meetings", subtitle: "Scheduling & dashboard", href: "/meetings", icon: Handshake },
  { id: "page-inbox", type: "Page", title: "Inbox", subtitle: "Messages", href: "/inbox", icon: Inbox },
  { id: "page-calendar", type: "Page", title: "Calendar", subtitle: "Tasks & events", href: "/calendar", icon: CalendarDays },
  { id: "page-settings", type: "Page", title: "Settings", subtitle: "Preferences", href: "/settings", icon: Settings },
];

type AnyItem = SearchItem | PageItem;

const TYPE_ORDER: Record<string, number> = { Page: 0, Contact: 1, Deal: 2, Lead: 3, Meeting: 4, Message: 5 };

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<SearchItem[] | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Guarded so concurrent opens only ever trigger one fetch.
  const loadedRef = useRef(false);
  const loadIndex = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      const res = await fetch("/api/search", { cache: "no-store" });
      const data = await res.json();
      setRecords(data.items ?? []);
    } catch {
      setRecords([]);
    }
  }, []);

  // open triggers: ⌘K / Ctrl+K, custom event. The query resets here (in the
  // event handler) rather than in an effect, so opening is a single render pass.
  useEffect(() => {
    const reset = () => {
      setQuery("");
      setActive(0);
      loadIndex(); // lazily fetch the index the first time it's needed
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        reset();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => {
      reset();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_EVENT, onOpen);
    };
  }, [loadIndex]);

  // Focus the input once the palette is on screen.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const results = useMemo<AnyItem[]>(() => {
    const all: AnyItem[] = [...PAGES, ...(records ?? [])];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (it) =>
            it.title.toLowerCase().includes(q) ||
            it.subtitle.toLowerCase().includes(q) ||
            it.type.toLowerCase().includes(q)
        )
      : all;
    return filtered
      .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9))
      .slice(0, 40);
  }, [query, records]);

  // Rows carry their flat index plus whether they start a new type group,
  // computed during render (never by mutating across renders).
  const rows = useMemo(
    () =>
      results.map((item, i) => ({
        item,
        i,
        showHeading: i === 0 || results[i - 1].type !== item.type,
      })),
    [results]
  );

  // Keep the highlighted row inside the current result range.
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const select = useCallback(
    (item: AnyItem) => {
      setOpen(false);
      router.push(item.href);
    },
    [router]
  );

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) select(item);
    }
  };

  // keep active item visible
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12dvh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="glass relative z-10 w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--border-strong)] shadow-2xl">
        {/* Input */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4">
          <Search className="h-[18px] w-[18px] text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onListKey}
            placeholder="Search contacts, deals, meetings, or jump to…"
            className="h-14 w-full bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <kbd className="hidden rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium text-faint sm:block">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[60dvh] overflow-y-auto p-2">
          {records === null && (
            <p className="px-3 py-6 text-center text-sm text-faint">Loading…</p>
          )}
          {records !== null && results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-faint">
              No results for “{query}”.
            </p>
          )}
          {rows.map(({ item, i, showHeading }) => {
            const isActive = i === activeIndex;
            return (
              <div key={item.id}>
                {showHeading && (
                  <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-faint">
                    {item.type === "Page" ? "Go to" : item.type + "s"}
                  </p>
                )}
                <button
                  data-idx={i}
                  onClick={() => select(item)}
                  onMouseMove={() => setActive(i)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                    isActive ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--raise)]"
                  )}
                >
                  {item.type === "Page" ? (
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                      style={{ background: "var(--accent-soft)" }}
                    >
                      <item.icon className="h-4 w-4 text-accent" />
                    </span>
                  ) : (
                    <Avatar initials={item.initials} color={item.color} size="sm" />
                  )}
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="truncate text-xs text-faint">{item.subtitle}</p>
                  </div>
                  {isActive && <CornerDownLeft className="h-4 w-4 shrink-0 text-faint" />}
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 border-t border-[var(--border)] px-4 py-2.5 text-[11px] text-faint">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="ml-auto flex items-center gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--border)] bg-[var(--raise)] px-1.5 py-0.5 font-medium text-muted">
      {children}
    </kbd>
  );
}
