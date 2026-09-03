import Link from "next/link";
import { clsx } from "@/lib/clsx";

export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("card p-5", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  icon,
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("mb-4 flex items-center justify-between gap-3", className)}>
      {/* `min-w-0` so a long title yields to the action rather than shoving it.
          Without it both were being squeezed at once: on a phone "Where leads
          come from" wrapped to two lines AND its "6 deals" broke to "6" over
          "deals", because neither side would give. */}
      <div className="flex min-w-0 items-center gap-2.5">
        {icon}
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      </div>
      {action}
    </div>
  );
}

/**
 * A fact about the card, in its header.
 *
 * These used to be a bare `<span className="text-xs text-faint">` dropped into
 * the action slot — "6 deals", "Last 6 weeks", "0 booked". Unbounded text with
 * no ground under it reads as something left at the edge rather than placed
 * there, and it wrapped: at 393px "6 deals" broke across two lines beside a
 * title that was also wrapping.
 *
 * On a chip it has a shape of its own, and `shrink-0` with `whitespace-nowrap`
 * means the title gives way first — a two-word count should never be the thing
 * that breaks.
 *
 * Not for anything clickable. `ViewAll` below is the affordance for that, and a
 * chip that looks like a control but is not would be the worse mistake.
 */
export function CardMeta({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium text-muted"
      style={{ background: "var(--raise)" }}
    >
      {children}
    </span>
  );
}

/**
 * "View all" affordance. Always give it an `href` — a control that looks
 * clickable but does nothing is worse than no control at all.
 */
export function ViewAll({ href, children = "View all" }: { href: string; children?: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="focus-ring rounded-lg px-1 text-[13px] font-medium text-accent transition-opacity hover:opacity-80"
    >
      {children}
    </Link>
  );
}
