import { StatusResponse } from "@bike/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";

const link =
  "inline-flex min-h-9 items-center text-sm text-steel underline-offset-4 hover:text-asphalt hover:underline";

export function SystemFooter() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => apiGet("/status", (x) => StatusResponse.parse(x), signal),
    refetchInterval: 60_000,
    retry: 1,
  });
  const ok = status.data?.status === "ok";
  return (
    <footer className="border-t border-rule bg-paper">
      <div className="mx-auto max-w-6xl px-4 pt-10 pb-8 sm:px-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="col-span-2 sm:col-span-1">
            <p className="font-expanded font-extrabold tracking-tight">Bike Auction</p>
            <p className="mt-2 max-w-xs text-sm text-steel">
              Live auctions for inspected used and repossessed two-wheelers from banks and lenders
              across India.
            </p>
          </div>
          <nav aria-label="Browse">
            <p className="text-sm font-bold">Browse</p>
            <ul className="mt-2">
              <li>
                <Link to="/auctions" search={{ status: "LIVE" }} className={link}>
                  Live now
                </Link>
              </li>
              <li>
                <Link to="/auctions" search={{ status: "UPCOMING" }} className={link}>
                  Upcoming
                </Link>
              </li>
              <li>
                <Link to="/auctions" search={{ status: "ENDED" }} className={link}>
                  Recently closed
                </Link>
              </li>
            </ul>
          </nav>
          <nav aria-label="Your account">
            <p className="text-sm font-bold">Your account</p>
            <ul className="mt-2">
              <li>
                <Link to="/me/bids" className={link}>
                  My bids
                </Link>
              </li>
              <li>
                <Link to="/me/watchlist" className={link}>
                  Watchlist
                </Link>
              </li>
              <li>
                <Link to="/register" className={link}>
                  Create an account
                </Link>
              </li>
              <li>
                <Link to="/account" className={link}>
                  Account and data
                </Link>
              </li>
            </ul>
          </nav>
          <nav aria-label="Help">
            <p className="text-sm font-bold">Help</p>
            <ul className="mt-2">
              <li>
                <Link to="/" hash="how-it-works" className={link}>
                  How bidding works
                </Link>
              </li>
              <li>
                <Link to="/login" className={link}>
                  Sign in
                </Link>
              </li>
              <li>
                <Link to="/privacy" className={link}>
                  Privacy
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        <div className="mt-8 flex flex-col gap-2 border-t border-rule pt-5 text-sm text-steel sm:flex-row sm:items-center sm:justify-between">
          <p className="font-semibold text-asphalt">Prices in ₹ · Times in IST</p>
          <p aria-live="polite" className="inline-flex items-center gap-2 tnum">
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-full",
                status.data ? (ok ? "bg-ledger" : "bg-amber") : "bg-control",
              )}
            />
            {status.isPending && "Checking service status…"}
            {status.isError && "Service status unavailable."}
            {status.data &&
              `Service ${ok ? "operational" : "degraded"}, build ${status.data.version} (${status.data.environment})`}
          </p>
        </div>
      </div>
    </footer>
  );
}
