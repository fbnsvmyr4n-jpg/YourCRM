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
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      </div>
      {action}
    </div>
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
