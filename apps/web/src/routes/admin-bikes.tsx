import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BikePlaceholder, GradeBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { adminBikesQuery } from "@/lib/admin";
import { formatKm } from "@/lib/format";

export function AdminBikesPage() {
  const bikes = useQuery(adminBikesQuery);
  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/admin" className="text-sm text-steel underline underline-offset-4">
            Auction desk
          </Link>
          <h1 className="mt-1 font-expanded text-3xl font-extrabold tracking-tight">Motorcycles</h1>
        </div>
        <Button asChild>
          <Link to="/admin/bikes/new">Add motorcycle</Link>
        </Button>
      </div>
      {bikes.isPending ? (
        <div className="mt-8 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (bikes.data ?? []).length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-steel/40 bg-paper p-10 text-center text-steel">
          No motorcycles yet. Add the first one to start a listing.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-paper">
          {bikes.data!.map((b) => (
            <li key={b.id} className="relative flex items-center gap-4 p-3 hover:bg-concrete/50">
              {b.coverUrl ? (
                <img src={b.coverUrl} alt="" className="h-16 w-24 rounded-md object-cover" />
              ) : (
                <BikePlaceholder label="" className="h-16 w-24 rounded-md" />
              )}
              <div className="min-w-0 flex-1">
                <Link
                  to="/admin/bikes/$bikeId"
                  params={{ bikeId: b.id }}
                  className="font-semibold after:absolute after:inset-0"
                >
                  {b.manufactureYear} {b.make} {b.model} {b.variant ?? ""}
                </Link>
                <p className="text-sm text-steel">
                  {b.city}, {formatKm(b.kmDriven)}
                  {b.repossessed ? ", repossessed" : ""}, {b.imageCount} photos
                </p>
              </div>
              <GradeBadge grade={b.inspectionGrade as "A" | "B" | "C" | "D" | null} />
              <span className="hidden w-32 text-right text-sm sm:block">
                {b.openAuctionId ? "Open auction" : "No open auction"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
