import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Error (default) or caution notice. Icon + text, never colour alone. */
export function Alert({
  children,
  tone = "danger",
  className,
}: {
  children: ReactNode;
  tone?: "danger" | "caution";
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-3 rounded-md border px-4 py-3 text-sm",
        tone === "danger"
          ? "border-danger/35 bg-danger/8 text-danger"
          : "border-amber/40 bg-amber/10 text-asphalt",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 5v6M10 14v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="min-w-0 font-medium">{children}</div>
    </div>
  );
}

/** Non-blocking "data may be stale" notice used above lists (role=status, not an alert). */
export function StaleNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="mb-4 flex items-center gap-2 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-sm font-semibold"
    >
      <svg viewBox="0 0 20 20" className="size-4 shrink-0 text-amber" aria-hidden="true">
        <path
          d="M10 2.5l8.5 15h-17z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M10 8v4.5M10 15v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {children}
    </p>
  );
}

/** Static notice (not announced): caution for locks/limits, info for neutral context. */
export function Callout({
  children,
  tone = "caution",
  className,
}: {
  children: ReactNode;
  tone?: "caution" | "info";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-md border px-4 py-3 text-sm font-medium",
        tone === "caution" ? "border-amber/40 bg-amber/10" : "border-rule bg-concrete",
        className,
      )}
    >
      <svg
        viewBox="0 0 20 20"
        className={cn("mt-0.5 size-4 shrink-0", tone === "caution" ? "text-amber" : "text-steel")}
        aria-hidden="true"
      >
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 9v5M10 6v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
