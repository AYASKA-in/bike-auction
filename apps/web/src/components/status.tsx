import type { AuctionCard } from "@bike/contracts";
import { cn } from "@/lib/utils";

type Status = AuctionCard["status"];
type Outcome = AuctionCard["outcome"];

const LABEL: Record<Status, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Upcoming",
  LIVE: "Live",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
};
const OUTCOME: Record<NonNullable<Outcome>, string> = {
  SOLD: "Sold",
  RESERVE_NOT_MET: "Reserve not met",
  NO_BIDS: "No bids",
};

/** Status is always text (+ a dot for LIVE), never colour alone. */
export function StatusBadge({
  status,
  outcome,
  className,
}: {
  status: Status;
  outcome?: Outcome;
  className?: string;
}) {
  const text = status === "ENDED" && outcome ? OUTCOME[outcome] : LABEL[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold",
        status === "LIVE" && "bg-hivis text-white",
        status === "SCHEDULED" && "bg-asphalt text-paper",
        status === "ENDED" && "bg-rule text-asphalt",
        (status === "DRAFT" || status === "CANCELLED") &&
          "border border-steel/40 bg-paper text-steel",
        className,
      )}
    >
      {status === "LIVE" && (
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-white" />
      )}
      {text}
    </span>
  );
}

export function GradeBadge({ grade }: { grade: "A" | "B" | "C" | "D" | null }) {
  if (!grade)
    return (
      <span className="rounded border border-rule px-2 py-0.5 text-xs font-semibold text-steel">
        Not inspected
      </span>
    );
  const tone =
    grade === "A"
      ? "border-ledger text-ledger"
      : grade === "B"
        ? "border-asphalt text-asphalt"
        : "border-amber text-amber";
  return (
    <span className={cn("rounded border px-2 py-0.5 text-xs font-bold", tone)}>Grade {grade}</span>
  );
}

/** Original line drawing used when a listing has no photos (no third-party imagery). */
export function BikePlaceholder({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={`No photo yet: ${label}`}
      className={cn("flex items-center justify-center bg-concrete text-steel/60", className)}
    >
      <svg
        viewBox="0 0 120 64"
        className="w-1/2 max-w-40"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="24" cy="44" r="14" />
        <circle cx="96" cy="44" r="14" />
        <path d="M24 44l18-20h26l10 20M42 24l-6-8h-8M68 24l8-10h12M60 24l-6 20h-12" />
      </svg>
    </div>
  );
}
