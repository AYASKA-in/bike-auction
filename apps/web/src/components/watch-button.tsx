import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useToggleWatch, watchErrorMessage, watchlistIdsQuery } from "@/lib/me";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * Watch / Watching toggle. Optimistic (rolls back on error), `aria-pressed` carries the state for
 * assistive tech and the label changes too (never colour alone). Signed-out → /login with a
 * redirect back here. Hidden for administrators (they don't bid or watch).
 *
 * `card`: compact pill for a card's photo corner (sits above the card's full-card link overlay).
 * `panel`: full-width button for the auction page's side panel.
 */
export function WatchButton({
  auctionId,
  variant = "card",
  className,
}: {
  auctionId: string;
  variant?: "card" | "panel";
  className?: string;
}) {
  const me = useMe();
  const userId = me.data?.role === "USER" ? me.data.id : null;
  const ids = useQuery({ ...watchlistIdsQuery(userId ?? "-"), enabled: userId !== null });
  const toggle = useToggleWatch(userId ?? "-");
  const navigate = useNavigate();
  const here = useRouterState({ select: (s) => s.location.href });
  const [error, setError] = useState<string | null>(null);

  if (me.isPending || me.data?.role === "ADMIN") return null;
  const watching = userId !== null && (ids.data?.ids.includes(auctionId) ?? false);
  const busy = userId !== null && ids.isPending;

  const onClick = () => {
    setError(null);
    if (userId === null) {
      void navigate({ to: "/login", search: { redirect: here } });
      return;
    }
    toggle.mutate(
      { auctionId, watch: !watching },
      { onError: (err) => setError(watchErrorMessage(err)) },
    );
  };

  const label = watching ? "Watching" : "Watch";
  return (
    <div
      className={cn(
        variant === "card" ? "relative z-10 flex flex-col items-end gap-1" : "w-full sm:w-auto",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={watching}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={onClick}
        title={watching ? "Remove from your watchlist" : "Add to your watchlist"}
        className={cn(
          "inline-flex min-h-11 items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 motion-reduce:transition-none",
          variant === "card"
            ? "min-w-11 rounded-full px-3.5 text-sm shadow-[0_1px_3px_#00000033] backdrop-blur"
            : "w-full rounded-md border px-4 text-sm sm:w-auto",
          variant === "card" &&
            (watching
              ? "bg-asphalt text-paper hover:bg-asphalt-2"
              : "bg-paper/95 text-asphalt hover:bg-paper hover:text-hivis-ink"),
          variant === "panel" &&
            (watching
              ? "border-asphalt bg-asphalt text-paper hover:bg-asphalt-2"
              : "border-control/70 bg-paper text-asphalt hover:border-asphalt"),
        )}
      >
        <BookmarkIcon filled={watching} />
        <span>{label}</span>
        {variant === "card" && <span className="sr-only"> this auction</span>}
      </button>
      <p
        role="status"
        className={cn(
          error
            ? variant === "card"
              ? "max-w-48 rounded-md bg-paper/95 px-2 py-1 text-xs font-semibold text-danger shadow-sm"
              : "mt-2 text-sm font-semibold text-danger"
            : "sr-only",
        )}
      >
        {error ?? ""}
      </p>
    </div>
  );
}

function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("size-4 shrink-0", filled ? "text-hivis" : "text-current")}
      aria-hidden="true"
    >
      <path
        d="M5 2.75h10a.75.75 0 0 1 .75.75v13.6a.4.4 0 0 1-.63.33L10 13.9l-5.12 3.53a.4.4 0 0 1-.63-.33V3.5A.75.75 0 0 1 5 2.75z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
