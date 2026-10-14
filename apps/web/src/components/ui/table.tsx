import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Bordered frame for data tables. Wide tables scroll horizontally inside it (never the page);
 * the frame is a labelled, keyboard-focusable region so the scroll is reachable without a mouse.
 */
export function TableFrame({
  label,
  children,
  className,
  bare = false,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  /** No border/background: for a table that sits inside a Card. */
  bare?: boolean;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "relative overflow-x-auto",
        !bare && "rounded-xl border border-rule bg-paper shadow-card",
        bare && "-mx-4 sm:mx-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const table = "w-full border-collapse text-sm";
export const thead = "bg-concrete/70 text-left text-xs text-steel";
export const th = "px-4 py-2.5 font-semibold whitespace-nowrap first:pl-4 sm:first:pl-5";
export const tr = "border-t border-rule";
export const td = "px-4 py-3 align-top first:pl-4 sm:first:pl-5";
export const rowHeader = cn(td, "text-left font-semibold");
export const num = "text-right tnum";
