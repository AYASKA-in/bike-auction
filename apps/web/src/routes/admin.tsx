import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { StatusBadge } from "@/components/status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { adminAuctionsQuery, type AdminAuctionRow } from "@/lib/admin";
import { apiGet, apiSend } from "@/lib/api";
import { formatINR, formatIST } from "@/lib/format";
import { authErrorMessage } from "@/lib/session";

const Overview = z.object({
  bikes: z.number(),
  auctionsByStatus: z.array(z.object({ status: z.string(), n: z.number() })),
  usersByRole: z.array(z.object({ role: z.string(), n: z.number() })),
});
const STATUSES = ["DRAFT", "SCHEDULED", "LIVE", "ENDED", "CANCELLED"] as const;
const LABEL: Record<(typeof STATUSES)[number], string> = {
  DRAFT: "Drafts",
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
};

export function AdminPage() {
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: ({ signal }) => apiGet("/admin/overview", (x) => Overview.parse(x), signal),
    refetchInterval: 30_000,
  });
  const auctions = useQuery(adminAuctionsQuery);
  const [filter, setFilter] = useState<(typeof STATUSES)[number] | null>(null);
  const count = (s: string) => overview.data?.auctionsByStatus.find((r) => r.status === s)?.n ?? 0;
  const rows = (auctions.data ?? []).filter((r) => !filter || r.status === filter);

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-expanded text-3xl font-extrabold tracking-tight">Auction desk</h1>
          <p className="mt-1 text-steel">Listings, schedules and live auctions in one place.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link to="/admin/bikes">Motorcycles</Link>
          </Button>
          <Button asChild>
            <Link to="/admin/bikes/new">Add motorcycle</Link>
          </Button>
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Motorcycles" value={overview.data?.bikes} />
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(filter === s ? null : s)}
            aria-pressed={filter === s}
            className={`rounded-xl border bg-paper p-4 text-left transition-colors ${filter === s ? "border-hivis" : "border-rule hover:border-asphalt"}`}
          >
            <dt className="text-sm text-steel">{LABEL[s]}</dt>
            <dd className="font-expanded text-3xl font-extrabold tnum">
              {overview.isPending ? "–" : count(s)}
            </dd>
          </button>
        ))}
      </dl>

      <div className="mt-8 overflow-hidden rounded-xl border border-rule bg-paper">
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h2 className="font-bold">{filter ? LABEL[filter] : "All auctions"}</h2>
          {filter && (
            <button
              className="text-sm font-semibold underline underline-offset-4"
              onClick={() => setFilter(null)}
            >
              Show all
            </button>
          )}
        </div>
        {auctions.isPending ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-steel">
            No auctions here yet. Add a motorcycle, record its inspection, then create an auction
            from its page.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="text-left text-steel">
                <tr className="border-b border-rule">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Motorcycle
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Price
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Bids
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Starts
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Closes
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AuctionRow key={r.auctionId} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-xl border border-rule bg-asphalt p-4 text-paper">
      <dt className="text-sm text-paper/70">{label}</dt>
      <dd className="font-expanded text-3xl font-extrabold tnum">{value ?? "–"}</dd>
    </div>
  );
}

function AuctionRow({ r }: { r: AdminAuctionRow }) {
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const done = () => void qc.invalidateQueries({ queryKey: ["admin"] });
  const schedule = useMutation({
    mutationFn: () =>
      apiSend("POST", `/admin/auctions/${r.auctionId}/schedule`, undefined, (x) => x),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () =>
      apiSend("POST", `/admin/auctions/${r.auctionId}/cancel`, { reason }, (x) => x),
    onSuccess: () => {
      setCancelling(false);
      done();
    },
  });
  const open = r.status === "DRAFT" || r.status === "SCHEDULED" || r.status === "LIVE";
  return (
    <>
      <tr className="border-b border-rule last:border-0">
        <th scope="row" className="px-4 py-3 text-left font-semibold">
          <Link to="/admin/bikes/$bikeId" params={{ bikeId: r.bikeId }} className="hover:underline">
            {r.title}
          </Link>
        </th>
        <td className="px-4 py-3">
          <StatusBadge status={r.status} outcome={r.outcome} />
        </td>
        <td className="px-4 py-3 text-right font-semibold tnum">
          {formatINR(r.currentPriceMinor ?? r.startPriceMinor)}
        </td>
        <td className="px-4 py-3 text-right tnum">{r.bidCount}</td>
        <td className="px-4 py-3">{formatIST(r.startsAt)}</td>
        <td className="px-4 py-3">{formatIST(r.closesAt)}</td>
        <td className="px-4 py-3">
          <div className="flex justify-end gap-1">
            {r.status === "DRAFT" && (
              <>
                <Button size="md" variant="ghost" asChild>
                  <Link to="/admin/bikes/$bikeId" params={{ bikeId: r.bikeId }} hash="auction">
                    Edit draft
                  </Link>
                </Button>
                <Button size="md" onClick={() => schedule.mutate()} disabled={schedule.isPending}>
                  {schedule.isPending ? "Scheduling…" : "Schedule"}
                </Button>
              </>
            )}
            {r.status !== "DRAFT" && (
              <Button size="md" variant="ghost" asChild>
                <Link to="/auctions/$auctionId" params={{ auctionId: r.auctionId }}>
                  View
                </Link>
              </Button>
            )}
            {open && (
              <Button
                size="md"
                variant="ghost"
                onClick={() => setCancelling((c) => !c)}
                aria-expanded={cancelling}
              >
                Cancel…
              </Button>
            )}
          </div>
        </td>
      </tr>
      {(cancelling || schedule.isError) && (
        <tr className="border-b border-rule bg-concrete/60">
          <td colSpan={7} className="px-4 py-3">
            {schedule.isError && <Alert>{authErrorMessage(schedule.error)}</Alert>}
            {cancelling && (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  cancel.mutate();
                }}
              >
                <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm font-semibold">
                  Reason for cancelling (shown to bidders)
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={3}
                    maxLength={500}
                    required
                    className="h-11 rounded-md border border-steel/40 bg-white px-3 font-normal"
                  />
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={cancel.isPending || reason.trim().length < 3}
                >
                  Cancel auction
                </Button>
                <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>
                  Keep it
                </Button>
                {cancel.isError && (
                  <div className="w-full">
                    <Alert>{authErrorMessage(cancel.error)}</Alert>
                  </div>
                )}
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
