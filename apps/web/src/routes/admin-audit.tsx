import type { AuditEntry } from "@bike/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { SelectField } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import * as t from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatIST } from "@/lib/format";
import {
  actionLabel,
  auditFacetsQuery,
  auditQuery,
  metadataSummary,
  type AuditSearch,
} from "@/lib/ops";
import { authErrorMessage } from "@/lib/session";
import { AdminNav } from "./admin-ops";

export function AdminAuditPage() {
  const search = useSearch({ from: "/admin/audit" });
  const navigate = useNavigate({ from: "/admin/audit" });
  const facets = useQuery(auditFacetsQuery);
  const page = useInfiniteQuery(auditQuery(search));
  const items = page.data?.pages.flatMap((p) => p.items) ?? [];
  const actorName = new Map((facets.data?.actors ?? []).map((a) => [a.id, a.name]));

  // Draft filters; applied to the URL on submit (shareable, back-button friendly).
  const [draft, setDraft] = useState<AuditSearch>(search);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (draft.fromDay && draft.toDay && draft.fromDay > draft.toDay) return;
    void navigate({ search: clean(draft) });
  };
  const filtered = !!(
    search.action ||
    search.actorId ||
    search.resourceId ||
    search.fromDay ||
    search.toDay
  );
  const badRange = !!(draft.fromDay && draft.toDay && draft.fromDay > draft.toDay);

  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="audit" />
      <PageHeader
        className="mt-6"
        title="Audit trail"
        description="Every admin change to motorcycles and auctions, newest first. Append-only."
      />

      <form
        onSubmit={apply}
        className="mt-6 grid gap-4 rounded-xl border border-rule bg-paper p-4 shadow-card sm:grid-cols-2 sm:p-5 lg:grid-cols-3 lg:items-start xl:grid-cols-6"
        aria-label="Filter the audit trail"
      >
        <SelectField
          label="Action"
          value={draft.action ?? ""}
          onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
        >
          <option value="">All actions</option>
          {(facets.data?.actions ?? []).map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Admin"
          value={draft.actorId ?? ""}
          onChange={(e) => setDraft({ ...draft, actorId: e.target.value || undefined })}
        >
          <option value="">All admins</option>
          {(facets.data?.actors ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name ?? a.id}
            </option>
          ))}
        </SelectField>
        <Field
          label="Record id"
          value={draft.resourceId ?? ""}
          placeholder="auc_… or bike_…"
          pattern="[A-Za-z0-9_\-]{1,64}"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setDraft({ ...draft, resourceId: e.target.value.trim() || undefined })}
        />
        <Field
          label="From (IST)"
          type="date"
          value={draft.fromDay ?? ""}
          onChange={(e) => setDraft({ ...draft, fromDay: e.target.value || undefined })}
        />
        <Field
          label="To (IST, inclusive)"
          type="date"
          value={draft.toDay ?? ""}
          error={badRange ? "\u201cFrom\u201d must be on or before \u201cTo\u201d." : undefined}
          onChange={(e) => setDraft({ ...draft, toDay: e.target.value || undefined })}
        />
        <div className="flex gap-2 lg:pt-7">
          <Button type="submit" disabled={badRange} className="flex-1 sm:flex-none">
            Apply
          </Button>
          {filtered && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft({});
                void navigate({ search: {} });
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </form>

      <div className="mt-6">
        {page.isPending ? (
          <div className="space-y-2 rounded-xl border border-rule bg-paper p-4 shadow-card">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : page.isError && items.length === 0 ? (
          <LoadError
            title="Couldn't load the audit trail."
            detail={authErrorMessage(page.error)}
            onRetry={() => void page.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={filtered ? "No entries match these filters." : "No admin actions recorded yet."}
            body={
              filtered
                ? "Widen the date range or clear the filters."
                : "Changes to motorcycles and auctions are recorded here as they happen."
            }
          />
        ) : (
          <>
            {page.isError && (
              <div className="mb-4">
                <Alert>{authErrorMessage(page.error)}</Alert>
              </div>
            )}
            <t.TableFrame label="Audit entries">
              <table className={cn(t.table, "min-w-[48rem]")}>
                <caption className="sr-only">
                  Admin audit entries{filtered ? " (filtered)" : ""}, newest first
                </caption>
                <thead className={t.thead}>
                  <tr>
                    <th scope="col" className={t.th}>
                      When
                    </th>
                    <th scope="col" className={t.th}>
                      Action
                    </th>
                    <th scope="col" className={t.th}>
                      Admin
                    </th>
                    <th scope="col" className={t.th}>
                      Record
                    </th>
                    <th scope="col" className={t.th}>
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id} className={t.tr}>
                      <td className={cn(t.td, "whitespace-nowrap tnum")}>
                        {formatIST(e.createdAt)}
                      </td>
                      <th scope="row" className={t.rowHeader}>
                        {actionLabel(e.action)}
                      </th>
                      <td className={t.td}>
                        {e.actor.name ?? actorName.get(e.actor.id) ?? "Unknown admin"}
                      </td>
                      <td className={cn(t.td, "py-1")}>
                        <RecordLink e={e} />
                      </td>
                      <td className={cn(t.td, "text-steel")}>
                        <span className="break-words">{metadataSummary(e.metadata)}</span>
                        <span className="mt-1 block font-mono text-xs" title="Request id">
                          {e.requestId}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </t.TableFrame>
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-steel tnum" aria-live="polite">
          {items.length > 0 && `${items.length} entr${items.length === 1 ? "y" : "ies"} shown`}
        </p>
        {page.hasNextPage && (
          <Button
            variant="secondary"
            onClick={() => void page.fetchNextPage()}
            loading={page.isFetchingNextPage}
          >
            {page.isFetchingNextPage ? "Loading…" : "Load older entries"}
          </Button>
        )}
      </div>
    </section>
  );
}

function RecordLink({ e }: { e: AuditEntry }) {
  const cls = "inline-flex min-h-11 items-center font-mono text-xs underline underline-offset-4";
  if (e.resourceType === "auction")
    return (
      <Link to="/admin/auctions/$auctionId" params={{ auctionId: e.resourceId }} className={cls}>
        Auction {e.resourceId}
      </Link>
    );
  if (e.resourceType === "bike")
    return (
      <Link to="/admin/bikes/$bikeId" params={{ bikeId: e.resourceId }} className={cls}>
        Bike {e.resourceId}
      </Link>
    );
  return (
    <span className="font-mono text-xs">
      {e.resourceType} {e.resourceId}
    </span>
  );
}

function clean(s: AuditSearch): AuditSearch {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v)) as AuditSearch;
}
