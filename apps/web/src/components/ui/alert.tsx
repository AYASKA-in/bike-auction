import type { ReactNode } from "react";

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
    >
      <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 5v6M10 14v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div>{children}</div>
    </div>
  );
}
