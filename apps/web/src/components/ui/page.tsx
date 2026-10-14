import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Page header used on every page: optional context line above (breadcrumb, back link or record
 * id), the h1, a one-line description, and actions on the right (wrapping under on phones).
 */
export function PageHeader({
  title,
  description,
  context,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  context?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}>
      <div className="min-w-0">
        {context && <div className="mb-1 text-sm text-steel">{context}</div>}
        <h1 className="font-expanded text-3xl leading-tight font-extrabold tracking-tight text-balance break-words sm:text-4xl">
          {title}
        </h1>
        {description && <p className="mt-1.5 max-w-prose text-steel">{description}</p>}
        {meta && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Section card: the one surface for grouped content (forms, panels, reports). */
export function Card({
  title,
  id,
  action,
  description,
  children,
  className,
  as: Tag = "section",
}: {
  title?: ReactNode;
  id?: string | undefined;
  action?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
  as?: "section" | "div";
}) {
  const headingId = id ? `${id}-h` : undefined;
  return (
    <Tag
      id={id}
      aria-labelledby={title && headingId ? headingId : undefined}
      className={cn(
        "scroll-mt-20 rounded-xl border border-rule bg-paper p-4 shadow-card sm:p-6",
        className,
      )}
    >
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h2 id={headingId} className="text-lg font-bold">
                {title}
              </h2>
            )}
            {description && <p className="mt-1 text-sm text-steel">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </Tag>
  );
}

/** Figure tile (KPIs). `tone="alert"` adds an icon and wording, never colour alone. */
export function StatTile({
  label,
  value,
  tone = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "default" | "alert";
  className?: string;
}) {
  return (
    // A span (display: block) so a tile can sit inside a <button> (the desk's filter tiles).
    <span
      className={cn(
        "block h-full rounded-xl border bg-paper p-4 shadow-card",
        tone === "alert" ? "border-danger/50" : "border-rule",
        className,
      )}
    >
      <span
        className={cn(
          "flex items-start gap-1.5 text-sm",
          tone === "alert" ? "font-semibold text-danger" : "text-steel",
        )}
      >
        {tone === "alert" && (
          <svg viewBox="0 0 20 20" aria-hidden="true" className="mt-0.5 size-4 shrink-0">
            <path
              d="M10 2.5l8.5 15h-17z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path
              d="M10 8v4.5M10 15v.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}
        <span>
          {label}
          {tone === "alert" && <span className="sr-only"> (needs attention)</span>}
        </span>
      </span>
      <span className="mt-1 block font-expanded text-3xl leading-tight font-extrabold tnum">
        {value}
      </span>
    </span>
  );
}

/** Label/value pair for <dl> grids. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-steel">{label}</dt>
      <dd className="mt-0.5 font-semibold break-words tnum">{children}</dd>
    </div>
  );
}

/** Inline success line ("Saved.") with an icon. */
export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-sm font-semibold text-ledger">
      <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4 shrink-0">
        <path
          d="M4.5 10.5l3.5 3.5 7.5-8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </p>
  );
}
