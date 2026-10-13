import type { ListSort, ListStatus } from "@bike/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import type { z } from "zod";
import { AuctionCard, CardSkeleton } from "@/components/auction-card";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/form";
import { Field } from "@/components/ui/field";
import { catalogueQuery, facetsQuery, type CatalogueFilters } from "@/lib/catalogue";
import { cn } from "@/lib/utils";

const STATUS_TABS: { value: z.infer<typeof ListStatus>; label: string }[] = [
  { value: "ACTIVE", label: "Live and upcoming" },
  { value: "LIVE", label: "Live now" },
  { value: "UPCOMING", label: "Upcoming" },
  { value: "ENDED", label: "Ended" },
];
const SORTS: { value: z.infer<typeof ListSort>; label: string }[] = [
  { value: "ending_soon", label: "Ending soon" },
  { value: "starting_soon", label: "Starting soon" },
  { value: "price_asc", label: "Lowest price" },
  { value: "price_desc", label: "Highest price" },
  { value: "newest", label: "Newest listings" },
];

export function AuctionsPage() {
  const search = useSearch({ from: "/auctions" });
  const navigate = useNavigate({ from: "/auctions" });
  const filters: CatalogueFilters = { status: "ACTIVE", ...search };
  const facets = useQuery(facetsQuery);
  const list = useInfiniteQuery(catalogueQuery(filters));
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<CatalogueFilters>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const activeCount = [
    "make",
    "q",
    "city",
    "yearMin",
    "yearMax",
    "ccMin",
    "ccMax",
    "priceMin",
    "priceMax",
  ].filter((k) => search[k as keyof typeof search] !== undefined).length;

  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    const s = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    set({
      q: s("q"),
      make: s("make"),
      city: s("city"),
      yearMin: n("yearMin"),
      yearMax: n("yearMax"),
      ccMin: n("ccMin"),
      ccMax: n("ccMax"),
      priceMin: n("priceMin"),
      priceMax: n("priceMax"),
    });
    setOpen(false);
  };

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-expanded text-3xl font-extrabold tracking-tight">Auctions</h1>
        <div className="w-48">
          <SelectField
            label="Sort by"
            value={search.sort ?? ""}
            onChange={(e) =>
              set({ sort: (e.target.value || undefined) as CatalogueFilters["sort"] })
            }
          >
            <option value="">Recommended</option>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Auction status"
        className="mt-6 flex gap-1 overflow-x-auto border-b border-rule"
      >
        {STATUS_TABS.map((t) => {
          const selected = (search.status ?? "ACTIVE") === t.value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={selected}
              onClick={() => set({ status: t.value === "ACTIVE" ? undefined : t.value })}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-4 py-3 text-sm font-semibold",
                selected
                  ? "border-hivis text-asphalt"
                  : "border-transparent text-steel hover:text-asphalt",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[16rem_1fr]">
        <div>
          <button
            type="button"
            className="mb-3 flex w-full items-center justify-between rounded-md border border-rule bg-paper px-4 py-3 font-semibold lg:hidden"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Filters{activeCount > 0 && ` (${activeCount})`}
            <span aria-hidden="true">{open ? "−" : "+"}</span>
          </button>
          <form
            key={JSON.stringify(search)}
            onSubmit={apply}
            aria-label="Filters"
            className={cn(
              "flex-col gap-4 rounded-xl border border-rule bg-paper p-4",
              open ? "flex" : "hidden lg:flex",
            )}
          >
            <Field
              label="Search"
              name="q"
              defaultValue={search.q ?? ""}
              placeholder="Model, e.g. Classic"
            />
            <SelectField label="Make" name="make" defaultValue={search.make ?? ""}>
              <option value="">Any make</option>
              {facets.data?.makes.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </SelectField>
            <SelectField label="City" name="city" defaultValue={search.city ?? ""}>
              <option value="">Any city</option>
              {facets.data?.cities.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </SelectField>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="mb-1.5 text-sm font-semibold">Year</legend>
              <Field
                label="From"
                name="yearMin"
                type="number"
                inputMode="numeric"
                defaultValue={search.yearMin ?? ""}
              />
              <Field
                label="To"
                name="yearMax"
                type="number"
                inputMode="numeric"
                defaultValue={search.yearMax ?? ""}
              />
            </fieldset>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="mb-1.5 text-sm font-semibold">Engine (cc)</legend>
              <Field
                label="Min"
                name="ccMin"
                type="number"
                inputMode="numeric"
                defaultValue={search.ccMin ?? ""}
              />
              <Field
                label="Max"
                name="ccMax"
                type="number"
                inputMode="numeric"
                defaultValue={search.ccMax ?? ""}
              />
            </fieldset>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="mb-1.5 text-sm font-semibold">Price (₹)</legend>
              <Field
                label="Min"
                name="priceMin"
                type="number"
                inputMode="numeric"
                defaultValue={search.priceMin ?? ""}
              />
              <Field
                label="Max"
                name="priceMax"
                type="number"
                inputMode="numeric"
                defaultValue={search.priceMax ?? ""}
              />
            </fieldset>
            <Button type="submit">Apply filters</Button>
            {activeCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  set({
                    q: undefined,
                    make: undefined,
                    city: undefined,
                    yearMin: undefined,
                    yearMax: undefined,
                    ccMin: undefined,
                    ccMax: undefined,
                    priceMin: undefined,
                    priceMax: undefined,
                  })
                }
              >
                Clear filters
              </Button>
            )}
          </form>
        </div>

        <div>
          {list.isPending ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : list.isError && !list.data ? (
            <div className="rounded-xl border border-danger/30 bg-paper p-8 text-center">
              <p className="font-semibold">Couldn't load auctions.</p>
              <Button className="mt-4" variant="secondary" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-steel/40 bg-paper px-6 py-12 text-center">
              <p className="text-lg font-semibold">No auctions match these filters</p>
              <p className="mt-2 text-steel">
                Widen the price or year range, or clear the filters.
              </p>
            </div>
          ) : (
            <>
              {list.isRefetchError && (
                <p
                  role="status"
                  className="mb-4 rounded-md bg-amber/15 px-3 py-2 text-sm font-semibold"
                >
                  Couldn't refresh. Prices shown may be out of date; retrying automatically.
                </p>
              )}
              <p className="mb-4 text-sm text-steel" aria-live="polite">
                {items.length}
                {list.hasNextPage ? "+" : ""} auctions
              </p>
              <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((a) => (
                  <li key={a.auctionId} className="flex">
                    <div className="w-full">
                      <AuctionCard a={a} stale={list.isRefetchError} />
                    </div>
                  </li>
                ))}
              </ul>
              {list.hasNextPage && (
                <div className="mt-8 text-center">
                  <Button
                    variant="secondary"
                    onClick={() => void list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                  >
                    {list.isFetchingNextPage ? "Loading…" : "Show more auctions"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
