import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "theme";

function readChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Applies the choice the same way public/theme-init.js does before first paint. */
function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
}

const OPTIONS: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <>
        <circle cx="10" cy="10" r="3.25" />
        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" />
      </>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: <path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z" />,
  },
  {
    value: "system",
    label: "System",
    icon: (
      <>
        <rect x="2.75" y="3.75" width="14.5" height="9.5" rx="1.5" />
        <path d="M7 16.5h6M10 13.5v3" />
      </>
    ),
  },
];

/**
 * Light / Dark / System. A group of toggle buttons (aria-pressed) with visible icons and
 * accessible names; `labels` also shows the words (used in the mobile menu).
 */
export function ThemeToggle({
  labels = false,
  className,
}: {
  labels?: boolean;
  className?: string;
}) {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cn("inline-flex rounded-lg border border-rule bg-concrete p-0.5", className)}
    >
      {OPTIONS.map((o) => {
        const on = choice === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={`${o.label} theme`}
            onClick={() => {
              apply(o.value);
              setChoice(o.value);
            }}
            className={cn(
              "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm font-semibold transition-colors",
              labels && "flex-1 px-3",
              on
                ? "bg-paper text-asphalt shadow-[0_1px_2px_#0000001f]"
                : "text-steel hover:text-asphalt",
            )}
          >
            <svg
              viewBox="0 0 20 20"
              aria-hidden="true"
              className="size-4.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {o.icon}
            </svg>
            <span className={labels ? undefined : "sr-only"}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
