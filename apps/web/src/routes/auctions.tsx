import type { ListSort, ListStatus } from "@bike/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import type { z } from "zod";
import { AuctionCard, CardSkeleton } from "@/components/auction-card";
import { StaleNotice } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { SelectField } from "@/components/ui/form";
import { CrossGlyph, FilterGlyph } from "@/components/ui/icons";
import { chipClass, tabClass, tabListClass } from "@/components/ui/tabs";
import { catalogueQuery, facetsQuery, type CatalogueFilters } from "@/lib/catalogue";
import { activeFilterChips, CC_BANDS } from "@/lib/catalogue-filters";
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
  { value: "recently_ended", label: "Recently ended" },
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

  const chips = activeFilterChips(search);

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
    <section className="mx-auto max-w-6xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-expanded text-3xl font-extrabold tracking-tight sm:text-4xl">
            Auctions
          </h1>
          <p className="mt-1.5 text-steel">
            Inspected used and repossessed two-wheelers. Prices in ₹, times in IST.
          </p>
        </div>
        <div className="w-full sm:w-52">
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

      <div role="tablist" aria-label="Auction status" className={cn("mt-6", tabListClass)}>
        {STATUS_TABS.map((t) => {
          const selected = (search.status ?? "ACTIVE") === t.value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={selected}
              onClick={() => set({ status: t.value === "ACTIVE" ? undefined : t.value })}
              className={tabClass(selected)}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-8">
        <div>
          <button
            type="button"
            className="mb-3 flex min-h-12 w-full items-center gap-2 rounded-md border border-control/50 bg-paper px-4 font-semibold lg:hidden"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <FilterGlyph className="size-4.5" />
            Filters{activeCount > 0 && ` (${activeCount})`}
            <span aria-hidden="true" className="ml-auto text-lg leading-none text-steel">
              {open ? "−" : "+"}
            </span>
          </button>
          <form
            key={JSON.stringify(search)}
            onSubmit={apply}
            aria-label="Filters"
            className={cn(
              "flex-col gap-4 rounded-xl border border-rule bg-paper p-4 shadow-card",
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
            <div role="group" aria-label="Engine size presets" className="flex flex-wrap gap-2">
              {CC_BANDS.map((b) => {
                const on = search.ccMin === b.min && search.ccMax === b.max;
                return (
                  <button
                    key={b.label}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        on
                          ? { ccMin: undefined, ccMax: undefined }
                          : { ccMin: b.min, ccMax: b.max },
                      )
                    }
                    className={chipClass(on)}
                  >
                    {b.label}
                    <span className="sr-only"> ({b.hint})</span>
                  </button>
                );
              })}
            </div>
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
          {chips.length > 0 && (
            <ul aria-label="Active filters" className="mb-4 flex flex-wrap gap-2">
              {chips.map((c) => (
                <li key={c.label}>
                  <button type="button" onClick={() => set(c.clear)} className={chipClass(false)}>
                    {c.label}
                    <CrossGlyph className="size-3.5 text-steel" />
                    <span className="sr-only">Remove filter</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.isPending ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : list.isError && !list.data ? (
            <LoadError title="Couldn't load auctions." onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              title="No auctions match these filters"
              body="Widen the price or year range, try another status tab, or clear the filters."
            />
          ) : (
            <>
              {list.isRefetchError && (
                <StaleNotice>
                  Couldn't refresh. Prices shown may be out of date; retrying automatically.
                </StaleNotice>
              )}
              <p className="mb-4 text-sm font-semibold text-steel tnum" aria-live="polite">
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
