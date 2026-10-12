import { StatusResponse } from "@bike/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export function SystemFooter() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => apiGet("/status", (x) => StatusResponse.parse(x), signal),
    refetchInterval: 60_000,
    retry: 1,
  });
  return (
    <footer className="border-t border-rule bg-paper">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-steel sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Prices in Indian rupees. Auction times in IST.</p>
        <p aria-live="polite" className="tnum">
          {status.isPending && "Checking service status…"}
          {status.isError && "Service status unavailable."}
          {status.data &&
            `Service ${status.data.status === "ok" ? "operational" : "degraded"}, build ${status.data.version} (${status.data.environment})`}
        </p>
      </div>
    </footer>
  );
}
