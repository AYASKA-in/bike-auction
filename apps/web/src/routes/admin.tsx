import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { StatusBadge } from "@/components/status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { controlClass } from "@/components/ui/form";
import { PageHeader, StatTile } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import * as t from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { adminAuctionsQuery, type AdminAuctionRow } from "@/lib/admin";
import { apiGet, apiSend } from "@/lib/api";
import { formatINR, formatIST } from "@/lib/format";
import { authErrorMessage } from "@/lib/session";
import { AdminNav } from "./admin-ops";

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
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="desk" />
      <PageHeader
        className="mt-6"
        title="Auction desk"
        description="Listings, schedules and live auctions in one place."
        actions={
          <Button asChild>
            <Link to="/admin/bikes/new">Add motorcycle</Link>
          </Button>
        }
      />

      <ul
        aria-label="Auction counts (select one to filter the table)"
        className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        <li>
          <Kpi label="Motorcycles" value={overview.data?.bikes} />
        </li>
        {STATUSES.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setFilter(filter === s ? null : s)}
              aria-pressed={filter === s}
              className={cn(
                "h-full w-full rounded-xl text-left transition-shadow hover:shadow-lift",
                filter === s && "ring-2 ring-hivis ring-offset-2 ring-offset-concrete",
              )}
            >
              <StatTile
                label={
                  <>
                    {LABEL[s]}
                    {filter === s && (
                      <span className="font-semibold text-asphalt"> (filter on)</span>
                    )}
                  </>
                }
                value={overview.isPending ? "–" : count(s)}
              />
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex min-h-11 flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{filter ? LABEL[filter] : "All auctions"}</h2>
        {filter && (
          <Button variant="ghost" size="sm" onClick={() => setFilter(null)}>
            Show all auctions
          </Button>
        )}
      </div>
      <div className="mt-3">
        {auctions.isPending ? (
          <div className="space-y-2 rounded-xl border border-rule bg-paper p-4 shadow-card">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : auctions.isError ? (
          <LoadError
            title="Couldn't load auctions."
            detail={authErrorMessage(auctions.error)}
            onRetry={() => void auctions.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filter ? `No ${LABEL[filter].toLowerCase()} auctions` : "No auctions here yet"}
            body="Add a motorcycle, record its inspection, then create an auction from its page."
            action={
              <Button asChild variant="secondary">
                <Link to="/admin/bikes/new">Add motorcycle</Link>
              </Button>
            }
          />
        ) : (
          <t.TableFrame label={filter ? `${LABEL[filter]} auctions` : "All auctions"}>
            <table className={cn(t.table, "min-w-[56rem]")}>
              <caption className="sr-only">
                {filter ? LABEL[filter] : "All"} auctions with status, price, bids and schedule
              </caption>
              <thead className={t.thead}>
                <tr>
                  <th scope="col" className={t.th}>
                    Motorcycle
                  </th>
                  <th scope="col" className={t.th}>
                    Status
                  </th>
                  <th scope="col" className={cn(t.th, "text-right")}>
                    Price
                  </th>
                  <th scope="col" className={cn(t.th, "text-right")}>
                    Bids
                  </th>
                  <th scope="col" className={t.th}>
                    Starts
                  </th>
                  <th scope="col" className={t.th}>
                    Closes
                  </th>
                  <th scope="col" className={t.th}>
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
          </t.TableFrame>
        )}
      </div>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: number | undefined }) {
  return <StatTile label={label} value={value ?? "–"} />;
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
      <tr className={t.tr}>
        <th scope="row" className={cn(t.rowHeader, "min-w-44 align-middle")}>
          <Link
            to="/admin/bikes/$bikeId"
            params={{ bikeId: r.bikeId }}
            className="underline-offset-4 hover:underline"
          >
            {r.title}
          </Link>
        </th>
        <td className={cn(t.td, "align-middle")}>
          <StatusBadge status={r.status} outcome={r.outcome} />
        </td>
        <td className={cn(t.td, t.num, "align-middle font-semibold")}>
          {formatINR(r.currentPriceMinor ?? r.startPriceMinor)}
        </td>
        <td className={cn(t.td, t.num, "align-middle")}>{r.bidCount}</td>
        <td className={cn(t.td, "align-middle whitespace-nowrap tnum")}>{formatIST(r.startsAt)}</td>
        <td className={cn(t.td, "align-middle whitespace-nowrap tnum")}>{formatIST(r.closesAt)}</td>
        <td className={cn(t.td, "align-middle")}>
          <div className="flex justify-end gap-1">
            {r.status === "DRAFT" && (
              <>
                <Button size="sm" variant="ghost" className="whitespace-nowrap" asChild>
                  <Link to="/admin/bikes/$bikeId" params={{ bikeId: r.bikeId }} hash="auction">
                    Edit draft
                  </Link>
                </Button>
                <Button size="sm" onClick={() => schedule.mutate()} loading={schedule.isPending}>
                  {schedule.isPending ? "Scheduling…" : "Schedule"}
                </Button>
              </>
            )}
            {r.status !== "DRAFT" && (
              <Button size="sm" variant="ghost" asChild>
                <Link to="/admin/auctions/$auctionId" params={{ auctionId: r.auctionId }}>
                  View
                </Link>
              </Button>
            )}
            {open && (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
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
        <tr className="border-t border-rule bg-concrete/60">
          <td colSpan={7} className="px-4 py-4 sm:px-5">
            {schedule.isError && <Alert>{authErrorMessage(schedule.error)}</Alert>}
            {cancelling && (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  cancel.mutate();
                }}
              >
                <label className="flex min-w-64 flex-1 flex-col gap-1.5 text-sm font-semibold">
                  Reason for cancelling (shown to bidders)
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={3}
                    maxLength={500}
                    required
                    className={cn(controlClass, "h-11 font-normal")}
                  />
                </label>
                <Button
                  type="submit"
                  variant="danger"
                  loading={cancel.isPending}
                  disabled={reason.trim().length < 3}
                >
                  Cancel auction
                </Button>
                <Button type="button" variant="outline" onClick={() => setCancelling(false)}>
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
