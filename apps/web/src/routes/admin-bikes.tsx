import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BikePlaceholder, GradeBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { PinGlyph } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { adminBikesQuery } from "@/lib/admin";
import { formatKm } from "@/lib/format";
import { authErrorMessage } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AdminNav } from "./admin-ops";

export function AdminBikesPage() {
  const bikes = useQuery(adminBikesQuery);
  const list = bikes.data ?? [];
  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="bikes" />
      <PageHeader
        className="mt-6"
        title="Motorcycles"
        description="Every listing with its inspection grade, photos and auction status."
        actions={
          <Button asChild>
            <Link to="/admin/bikes/new">Add motorcycle</Link>
          </Button>
        }
      />
      <div className="mt-6">
        {bikes.isPending ? (
          <ul
            aria-hidden="true"
            className="divide-y divide-rule rounded-xl border border-rule bg-paper shadow-card"
          >
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-4 p-3 sm:p-4">
                <Skeleton className="h-16 w-24 shrink-0 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
                <Skeleton className="h-6 w-16 rounded-md" />
              </li>
            ))}
          </ul>
        ) : bikes.isError ? (
          <LoadError
            title="Couldn't load motorcycles."
            detail={authErrorMessage(bikes.error)}
            onRetry={() => void bikes.refetch()}
          />
        ) : list.length === 0 ? (
          <EmptyState
            title="No motorcycles yet"
            body="Add the first one to start a listing: details, inspection, photos, then the auction."
            action={
              <Button asChild variant="secondary">
                <Link to="/admin/bikes/new">Add motorcycle</Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-paper shadow-card">
            {list.map((b) => (
              <li
                key={b.id}
                className="relative flex items-center gap-3 p-3 transition-colors hover:bg-concrete/60 has-[a:focus-visible]:outline-3 has-[a:focus-visible]:-outline-offset-3 has-[a:focus-visible]:outline-hivis sm:gap-4 sm:p-4"
              >
                {b.coverUrl ? (
                  <img
                    src={b.coverUrl}
                    alt=""
                    className="h-14 w-20 shrink-0 rounded-md object-cover sm:h-16 sm:w-24"
                  />
                ) : (
                  <BikePlaceholder
                    label=""
                    className="h-14 w-20 shrink-0 rounded-md sm:h-16 sm:w-24"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <Link
                    to="/admin/bikes/$bikeId"
                    params={{ bikeId: b.id }}
                    className="font-semibold after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    {b.manufactureYear} {b.make} {b.model} {b.variant ?? ""}
                  </Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-steel">
                    <span className="inline-flex items-center gap-1">
                      <PinGlyph className="size-3.5" />
                      {b.city}
                    </span>
                    <span className="tnum">{formatKm(b.kmDriven)}</span>
                    {b.repossessed && <span>Repossessed</span>}
                    <span className="tnum">
                      {b.imageCount} {b.imageCount === 1 ? "photo" : "photos"}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <GradeBadge grade={b.inspectionGrade as "A" | "B" | "C" | "D" | null} />
                  <span
                    className={cn(
                      "hidden rounded-full px-2.5 py-1 text-xs leading-none font-semibold sm:inline-flex",
                      b.openAuctionId
                        ? "border border-ledger/40 bg-ledger/10 text-ledger"
                        : "border border-rule text-steel",
                    )}
                  >
                    {b.openAuctionId ? "Open auction" : "No open auction"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
