export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ filter: "drop-shadow(0 6px 16px rgba(59,130,246,0.35))" }}
    >
      <defs>
        <linearGradient id="crmLogo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent-from)" />
          <stop offset="1" stopColor="var(--accent-to)" />
        </linearGradient>
      </defs>
      <rect x="22" y="22" width="56" height="56" rx="17" transform="rotate(45 50 50)" fill="url(#crmLogo)" />
      <rect x="39" y="39" width="22" height="22" rx="6" transform="rotate(45 50 50)" fill="var(--bg)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="text-[19px] font-semibold tracking-tight">
      Your<span className="accent-text">CRM</span>
    </span>
  );
}
