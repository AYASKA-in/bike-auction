import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { WarnIcon } from "./icons";

/**
 * Error message for the dark bid panel (the shared <Alert> is styled for light surfaces).
 * role="alert": a rejected bid is a direct answer to the bidder's action and must be heard.
 */
export function PanelAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md bg-danger-solid px-3 py-2.5 text-sm font-semibold text-white"
    >
      <WarnIcon className="mt-px size-4" />
      <div>{children}</div>
    </div>
  );
}

/**
 * Restarts a short highlight whenever `value` changes (not on first paint). The animation is a
 * background pulse only, and is switched off under prefers-reduced-motion (styles.css).
 */
export function FlashOnChange({
  value,
  children,
  className,
}: {
  value: number | string;
  children: ReactNode;
  className?: string;
}) {
  const [seen, setSeen] = useState(value);
  const [n, setN] = useState(0);
  if (value !== seen) {
    setSeen(value);
    setN(n + 1);
  }
  return (
    <span key={n} className={cn("inline-block rounded-md", n > 0 && "live-flash", className)}>
      {children}
    </span>
  );
}
