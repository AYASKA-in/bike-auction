import { useEffect, useRef } from "react";
import { duration, durationFull, formatIST } from "@/lib/format";
import { useServerNow } from "@/lib/server-time";

/**
 * Server-synchronised countdown (shared 1 s ticker; only this leaf re-renders). It never shows a
 * negative time and never declares an auction ended: past the deadline it says "confirming" until
 * the server's status arrives. `onDue` fires once when the deadline passes (e.g. to refetch).
 */
export function Countdown({
  status,
  startsAt,
  closesAt,
  full = false,
  onDue,
}: {
  status: string;
  startsAt: number;
  closesAt: number;
  full?: boolean;
  onDue?: () => void;
}) {
  const now = useServerNow();
  const due = status === "LIVE" ? closesAt : status === "SCHEDULED" ? startsAt : null;
  const passed = due !== null && due - now <= 0;
  const fired = useRef<number | null>(null);
  useEffect(() => {
    if (passed && due !== null && fired.current !== due) {
      fired.current = due;
      onDue?.();
    }
  }, [passed, due, onDue]);
  const fmt = full ? durationFull : duration;
  if (status === "LIVE") {
    const left = closesAt - now;
    return (
      <span className={left < 120_000 ? "font-bold" : undefined}>
        {left > 0 ? (
          <>
            Ends in <span className="tnum">{fmt(left)}</span>
          </>
        ) : (
          "Closing… confirming result"
        )}
      </span>
    );
  }
  if (status === "SCHEDULED") {
    const left = startsAt - now;
    return (
      <span>
        {left > 0 ? (
          <>
            Starts in <span className="tnum">{fmt(left)}</span>
          </>
        ) : (
          "Starting…"
        )}
      </span>
    );
  }
  if (status === "CANCELLED") return <span>Cancelled</span>;
  return <span>Ended {formatIST(closesAt)}</span>;
}
