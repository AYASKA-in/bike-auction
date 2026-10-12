import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";

const Overview = z.object({
  usersByRole: z.array(z.object({ role: z.string(), n: z.number() })),
  securityEvents24h: z.array(z.object({ type: z.string(), n: z.number() })),
});

const EVENT_LABELS: Record<string, string> = {
  "auth.sign_up": "New accounts",
  "auth.sign_in.succeeded": "Sign-ins",
  "auth.sign_in.failed": "Failed sign-ins",
  "auth.sign_in.locked": "Blocked by lockout",
  "auth.captcha_failed": "Failed bot checks",
  "auth.rate_limited": "Rate-limited requests",
  "admin.seed": "Demo seeding runs",
};

export function AdminPage() {
  const q = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: ({ signal }) => apiGet("/admin/overview", (x) => Overview.parse(x), signal),
    refetchInterval: 30_000,
  });
  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="font-expanded text-3xl font-extrabold tracking-tight">Auction desk</h1>
      <p className="mt-2 text-steel">
        Accounts and sign-in activity. Auction tools arrive with the catalogue.
      </p>
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Panel title="Accounts">
          {q.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : q.isError ? (
            <p className="text-danger">Couldn't load accounts.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-4">
              {(["USER", "ADMIN"] as const).map((role) => (
                <div key={role}>
                  <dt className="text-sm text-steel">
                    {role === "USER" ? "Buyers" : "Administrators"}
                  </dt>
                  <dd className="font-expanded text-3xl font-extrabold tnum">
                    {q.data.usersByRole.find((r) => r.role === role)?.n ?? 0}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
        <Panel title="Security activity, last 24 hours">
          {q.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : q.isError ? (
            <p className="text-danger">Couldn't load activity.</p>
          ) : q.data.securityEvents24h.length === 0 ? (
            <p className="text-steel">No activity yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {q.data.securityEvents24h.map((e) => (
                  <tr key={e.type} className="border-b border-rule last:border-0">
                    <th scope="row" className="py-2 text-left font-normal">
                      {EVENT_LABELS[e.type] ?? e.type}
                    </th>
                    <td className="py-2 text-right font-semibold tnum">{e.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-rule bg-paper p-6">
      <h2 className="mb-4 font-bold">{title}</h2>
      {children}
    </div>
  );
}
