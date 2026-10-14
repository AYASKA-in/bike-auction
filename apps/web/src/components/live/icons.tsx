import { cn } from "@/lib/utils";

/** Decorative icons: every state they mark also has text, so they're hidden from assistive tech. */
type P = { className?: string };

export function CheckIcon({ className }: P) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={cn("size-5 shrink-0", className)}>
      <path
        d="M4 10.5l4 4 8-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WarnIcon({ className }: P) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={cn("size-5 shrink-0", className)}>
      <path
        d="M10 2.5l8.5 15h-17z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10 8v4.5M10 15v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ClockIcon({ className }: P) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={cn("size-4 shrink-0", className)}>
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 5.5V10l3 2" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function ChevronIcon({ open, className }: P & { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={cn(
        "size-5 shrink-0 transition-transform motion-reduce:transition-none",
        open && "rotate-90",
        className,
      )}
    >
      <path d="M7.5 4.5L13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
