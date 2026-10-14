import type { AuctionCard } from "@bike/contracts";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  CheckGlyph,
  ClockGlyph,
  CrossGlyph,
  DraftGlyph,
  FlagGlyph,
  InspectGlyph,
  MinusGlyph,
} from "./ui/icons";

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

const pill =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs leading-none font-bold";

/** Status is always text + icon (a pulsing dot for LIVE), never colour alone. */
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
  let icon: ReactNode;
  if (status === "LIVE")
    icon = (
      <span aria-hidden="true" className="relative flex size-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-on-hivis/50 motion-reduce:hidden" />
        <span className="relative size-2 rounded-full bg-on-hivis" />
      </span>
    );
  else if (status === "SCHEDULED") icon = <ClockGlyph className="size-3.5" />;
  else if (status === "ENDED")
    icon =
      outcome === "SOLD" ? (
        <CheckGlyph className="size-3.5" />
      ) : outcome === "RESERVE_NOT_MET" ? (
        <MinusGlyph className="size-3.5" />
      ) : (
        <FlagGlyph className="size-3.5" />
      );
  else if (status === "CANCELLED") icon = <CrossGlyph className="size-3.5" />;
  else icon = <DraftGlyph className="size-3.5" />;
  return (
    <span
      className={cn(
        pill,
        status === "LIVE" && "bg-hivis text-on-hivis",
        status === "SCHEDULED" && "bg-asphalt text-paper",
        status === "ENDED" &&
          (outcome === "SOLD"
            ? "border border-ledger/40 bg-paper text-ledger"
            : "border border-rule bg-paper text-steel"),
        (status === "DRAFT" || status === "CANCELLED") &&
          "border border-control/50 bg-paper text-steel",
        className,
      )}
    >
      {icon}
      {text}
    </span>
  );
}

/** Inspection grade from the yard team: icon + "Grade X" (or "Not inspected"). */
export function GradeBadge({ grade }: { grade: "A" | "B" | "C" | "D" | null }) {
  if (!grade)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs leading-none font-semibold whitespace-nowrap text-steel">
        Not inspected
      </span>
    );
  const tone =
    grade === "A"
      ? "border-ledger/45 text-ledger"
      : grade === "B"
        ? "border-control/60 text-asphalt"
        : "border-amber/50 text-amber";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border bg-paper px-2 py-1 text-xs leading-none font-bold whitespace-nowrap",
        tone,
      )}
    >
      <InspectGlyph className="size-3.5" />
      Grade {grade}
    </span>
  );
}

/** Original line drawing used when a listing has no photos (no third-party imagery). */
export function BikePlaceholder({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={`No photo yet: ${label}`}
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-concrete text-control",
        className,
      )}
    >
      <svg
        viewBox="0 0 160 96"
        className="w-1/2 max-w-48"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 88h148" strokeWidth="2" opacity=".5" />
        <circle cx="36" cy="66" r="19" />
        <circle cx="124" cy="66" r="19" />
        <circle cx="36" cy="66" r="4" />
        <circle cx="124" cy="66" r="4" />
        <path d="M36 66l24-28h34l30 28" />
        <path d="M60 38l-8-12h-12M94 38l12-16h14M106 22l6-4" />
        <path d="M68 38c4-8 20-8 26 0" />
        <path d="M64 38l-4 12h26" />
      </svg>
    </div>
  );
}
