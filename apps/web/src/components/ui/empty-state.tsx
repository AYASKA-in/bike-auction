import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Empty parking bay: a dashed outline where a bike would stand, bay markings and a hi-vis cone.
 * Original drawing for this project; themed with the colour tokens.
 */
export function EmptyBayArt({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 116"
      aria-hidden="true"
      className={cn("h-auto w-44", className)}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 104h184" className="stroke-rule" strokeWidth="3" />
      <path d="M30 110l14-46M170 110l-14-46" className="stroke-control/45" strokeWidth="4" />
      <g className="stroke-steel" strokeWidth="2.5" strokeDasharray="5 5">
        <circle cx="68" cy="86" r="16" />
        <circle cx="132" cy="86" r="16" />
        <path d="M68 86l20-24h24l20 24M88 62l-6-9h-9M112 62l8-11h11M100 62l-7 24H80" />
      </g>
      <path d="M178 104l-7-30h-2l-7 30z" className="fill-hivis" />
      <path d="M163.5 97h15M165.2 89.5h11.6" className="stroke-paper" strokeWidth="3" />
      <rect x="157" y="102" width="27" height="4" rx="1" className="fill-asphalt" />
    </svg>
  );
}

/** Designed empty state: art, a direct title, what to do next, and one action. */
export function EmptyState({
  title,
  body,
  action,
  art,
  className,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  art?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed border-control/50 bg-paper px-6 py-10 text-center sm:py-12",
        className,
      )}
    >
      {art ?? <EmptyBayArt />}
      <p className="mt-5 text-lg font-bold text-balance">{title}</p>
      {body && <p className="mt-2 max-w-md text-pretty text-steel">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/** Load failure with a retry (same frame as the empty state, so the page doesn't jump). */
export function LoadError({
  title,
  detail = "Check your connection, then try again.",
  onRetry,
  className,
}: {
  title: string;
  detail?: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center rounded-xl border border-danger/35 bg-paper px-6 py-10 text-center",
        className,
      )}
    >
      <p className="font-bold">{title}</p>
      <p className="mt-1 max-w-md text-sm text-steel">{detail}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex min-h-11 items-center rounded-md bg-asphalt px-4 text-sm font-semibold text-paper hover:bg-asphalt-2"
      >
        Try again
      </button>
    </div>
  );
}
