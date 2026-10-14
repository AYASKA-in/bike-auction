import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Small stroke icons drawn for this project (20×20 grid). Decorative: every place they appear
 * also has text, so they're hidden from assistive tech.
 */
function Icon({ className, children }: { className?: string | undefined; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
type P = { className?: string | undefined };

export const ClockGlyph = ({ className }: P) => (
  <Icon className={className}>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 6v4l2.75 1.75" />
  </Icon>
);
export const CheckGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </Icon>
);
export const MinusGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M5 10h10" />
  </Icon>
);
export const FlagGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M5 17.5V3M5 3.5h9.5l-2 3.25 2 3.25H5" />
  </Icon>
);
export const CrossGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </Icon>
);
export const DraftGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M12.5 3.5l4 4-9 9h-4v-4z" />
  </Icon>
);
/** Inspected at the yard: a clipboard with a tick. */
export const InspectGlyph = ({ className }: P) => (
  <Icon className={className}>
    <rect x="4" y="3.5" width="12" height="14" rx="1.5" />
    <path d="M7.5 3.5V2.5h5v1M7 11l2 2 4-4.5" />
  </Icon>
);
/** Paperwork: RC / NOC. */
export const DocGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M5 2.75h6.5l3.5 3.5v11H5z" />
    <path d="M11.5 2.75v3.5H15M7.5 10.5h5M7.5 13.5h5" />
  </Icon>
);
/** Server-timed bidding: a stopwatch. */
export const TimerGlyph = ({ className }: P) => (
  <Icon className={className}>
    <circle cx="10" cy="11" r="6.25" />
    <path d="M10 11V7.5M8 2.5h4M15 5.5l1.25-1.25" />
  </Icon>
);
export const ChevronGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M7.5 4.5L13 10l-5.5 5.5" />
  </Icon>
);
export const MenuGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M3 5.5h14M3 10h14M3 14.5h14" />
  </Icon>
);
export const FilterGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M3 5h14M5.5 10h9M8 15h4" />
  </Icon>
);
export const PinGlyph = ({ className }: P) => (
  <Icon className={className}>
    <path d="M10 17.5s5.5-5.2 5.5-9.25a5.5 5.5 0 0 0-11 0C4.5 12.3 10 17.5 10 17.5z" />
    <circle cx="10" cy="8.25" r="2" />
  </Icon>
);
