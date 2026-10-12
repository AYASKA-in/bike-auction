import { duration, formatIST } from "@/lib/format";
import { useServerNow } from "@/lib/server-time";

/** Server-synchronised countdown. Never announces every tick to screen readers. */
export function Countdown({
  status,
  startsAt,
  closesAt,
}: {
  status: string;
  startsAt: number;
  closesAt: number;
}) {
  const now = useServerNow(1000);
  if (status === "LIVE") {
    const left = closesAt - now;
    return (
      <span className={left < 120_000 ? "font-bold text-hivis-ink" : undefined}>
        {left > 0 ? (
          <>
            Ends in <span className="tnum">{duration(left)}</span>
          </>
        ) : (
          "Closing…"
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
            Starts in <span className="tnum">{duration(left)}</span>
          </>
        ) : (
          "Starting…"
        )}
      </span>
    );
  }
  return <span>Ended {formatIST(closesAt)}</span>;
}
