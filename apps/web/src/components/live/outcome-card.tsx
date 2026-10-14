import type { PublicAuctionView } from "@bike/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { CheckIcon } from "./icons";
import { outcomeCopy } from "./logic";

/** Ended / cancelled outcome (BLUEPRINT §11.3). The headline line carries data-testid="result". */
export function OutcomeCard({ view }: { view: PublicAuctionView }) {
  const c = outcomeCopy(view);
  if (!c) return null;
  const won = c.tone === "won";
  return (
    <section
      aria-labelledby="outcome-h"
      className={cn(
        "mt-5 rounded-lg px-4 py-3.5",
        won ? "bg-win text-white" : "bg-pit-2 text-pit-ink",
      )}
    >
      <h3 id="outcome-h" className="flex items-center gap-2 text-sm font-semibold">
        {won && <CheckIcon className="size-4" />}
        {c.title}
      </h3>
      <p data-testid="result" className="mt-1 text-lg leading-snug font-bold">
        {c.headline}
      </p>
      {c.detail && <p className="mt-1 text-sm">{c.detail}</p>}
      {won && (
        <Link
          to="/me/purchases"
          className="mt-2 inline-flex min-h-11 items-center gap-1 font-semibold underline underline-offset-4"
        >
          Complete your purchase <span aria-hidden="true">→</span>
        </Link>
      )}
    </section>
  );
}
