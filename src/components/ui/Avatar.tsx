import { clsx } from "@/lib/clsx";

const GRADIENTS: Record<string, string> = {
  blue: "linear-gradient(135deg,#3b82f6,#06b6d4)",
  green: "linear-gradient(135deg,#22c55e,#15a34a)",
  amber: "linear-gradient(135deg,#f59e0b,#d97706)",
  purple: "linear-gradient(135deg,#8b5cf6,#6366f1)",
  pink: "linear-gradient(135deg,#ec4899,#8b5cf6)",
  teal: "linear-gradient(135deg,#14b8a6,#0891b2)",
};

export type AvatarColor = keyof typeof GRADIENTS;

const SIZES = { sm: 32, md: 38, lg: 44 } as const;

export function Avatar({
  initials,
  color = "blue",
  size = "md",
  className,
}: {
  initials: string;
  color?: AvatarColor;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  return (
    <span
      className={clsx(
        "grid shrink-0 place-items-center rounded-xl font-semibold text-white",
        className
      )}
      style={{
        width: px,
        height: px,
        fontSize: px * 0.34,
        backgroundImage: GRADIENTS[color],
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
      }}
    >
      {initials}
    </span>
  );
}
