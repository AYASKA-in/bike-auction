import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronIcon } from "./icons";
import { DESKTOP, useMediaQuery } from "./use-media-query";

/**
 * Accordion section: on mobile the heading is a disclosure button (aria-expanded/aria-controls,
 * 44 px target); on desktop the section is always expanded and the heading is plain text.
 */
export function Collapsible({
  id,
  title,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const desktop = useMediaQuery(DESKTOP);
  const [open, setOpen] = useState(false);
  const expanded = desktop || open;
  const headingId = `${id}-h`;
  const panelId = `${id}-panel`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "rounded-xl border border-rule bg-paper px-4 py-2 shadow-card lg:p-6",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="min-w-0 flex-1 text-lg font-bold">
          {desktop ? (
            title
          ) : (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((o) => !o)}
              className="flex min-h-11 w-full items-center gap-2 text-left"
            >
              <ChevronIcon open={open} />
              {title}
            </button>
          )}
        </h2>
        {aside}
      </div>
      <div id={panelId} hidden={!expanded} className="pb-3 lg:pb-0">
        {children}
      </div>
    </section>
  );
}
