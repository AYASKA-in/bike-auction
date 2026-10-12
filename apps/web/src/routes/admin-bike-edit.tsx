import {
  BikeInput,
  INSPECTION_SECTIONS,
  InspectionInput,
  type AuctionCard as Card,
  type PublicBike,
} from "@bike/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { AuctionCard } from "@/components/auction-card";
import { StatusBadge } from "@/components/status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { CheckboxField, SelectField, TextAreaField } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { adminAuctionQuery, adminBikeQuery } from "@/lib/admin";
import { ApiError, apiSend, apiUpload } from "@/lib/api";
import { formatINR, formatIST, isoToIstLocal, istLocalToIso, rupeesToPaise } from "@/lib/format";
import { preparePhoto } from "@/lib/image-prep";
import { authErrorMessage } from "@/lib/session";

const asNum = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : Number(v));
const asNullNum = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));
const asNull = (v: unknown) => (v === "" || v === undefined ? null : v);

function errMsg(e: unknown) {
  if (e instanceof ApiError && e.code === "VALIDATION_FAILED")
    return e.detail ?? "Check the highlighted fields.";
  if (e instanceof ApiError && e.detail) return e.detail;
  return authErrorMessage(e);
}

export function AdminBikeNewPage() {
  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link to="/admin/bikes" className="text-sm text-steel underline underline-offset-4">
        Motorcycles
      </Link>
      <h1 className="mt-1 font-expanded text-3xl font-extrabold tracking-tight">Add motorcycle</h1>
      <p className="mt-1 text-steel">
        Step 1 of 4: details. Inspection, photos and the auction come next.
      </p>
      <BikeForm />
    </section>
  );
}

export function AdminBikeEditPage() {
  const { bikeId } = useParams({ from: "/admin/bikes/$bikeId" });
  const q = useQuery(adminBikeQuery(bikeId));
  if (q.isPending)
    return (
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-10">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (q.isError)
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <Alert>{errMsg(q.error)}</Alert>
      </div>
    );
  const { bike, lockedReason, auctions } = q.data;
  const open = auctions.find(
    (a) => a.active === 1 && a.status && ["DRAFT", "SCHEDULED", "LIVE"].includes(a.status),
  );
  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link to="/admin/bikes" className="text-sm text-steel underline underline-offset-4">
        Motorcycles
      </Link>
      <h1 className="mt-1 font-expanded text-3xl font-extrabold tracking-tight">
        {bike.manufactureYear} {bike.make} {bike.model} {bike.variant ?? ""}
      </h1>
      {lockedReason && (
        <p className="mt-3 rounded-md border border-amber/40 bg-amber/10 px-4 py-3 text-sm font-medium">
          {lockedReason}.
        </p>
      )}
      <nav aria-label="Listing steps" className="mt-6 flex flex-wrap gap-2 text-sm">
        {[
          ["details", "1. Details"],
          ["inspection", `2. Inspection${bike.inspection ? " ✓" : ""}`],
          ["photos", `3. Photos (${bike.images.length})`],
          ["auction", "4. Auction"],
        ].map(([h, l]) => (
          <a
            key={h}
            href={`#${h}`}
            className="rounded-full border border-rule bg-paper px-3 py-1.5 font-semibold hover:border-asphalt"
          >
            {l}
          </a>
        ))}
      </nav>
      <Section id="details" title="Details">
        <BikeForm bike={bike} locked={!!lockedReason} />
      </Section>
      <Section id="inspection" title="Inspection report">
        <InspectionForm bike={bike} locked={!!lockedReason} />
      </Section>
      <Section id="photos" title="Photos">
        <Photos bike={bike} locked={!!lockedReason} />
      </Section>
      <Section id="auction" title="Auction">
        {open ? <OpenAuction auctionId={open.auctionId} /> : <CreateAuction bike={bike} />}
        {auctions.filter((a) => a !== open).length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-steel">Previous auctions</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {auctions
                .filter((a) => a !== open)
                .map((a) => (
                  <li key={a.auctionId} className="flex items-center gap-3">
                    {a.status && <StatusBadge status={a.status as Card["status"]} />}
                    <span>{a.closesAt ? `closed ${formatIST(a.closesAt)}` : a.auctionId}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </Section>
    </section>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="mt-8 scroll-mt-6 rounded-xl border border-rule bg-paper p-5 sm:p-6"
    >
      <h2 id={`${id}-h`} className="mb-5 text-xl font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BikeForm({ bike, locked = false }: { bike?: PublicBike; locked?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm({
    resolver: zodResolver(BikeInput),
    defaultValues: bike
      ? (({ id: _i, images: _im, inspection: _in, registrationState: _r, ...rest }) => rest)(bike)
      : {
          fuel: "PETROL",
          rcStatus: "ORIGINAL",
          hypothecation: "NONE",
          ownerCount: 1,
          repossessed: false,
          asIsWhereIs: true,
          description: "",
        },
  });
  const save = useMutation({
    mutationFn: (v: unknown) =>
      bike
        ? apiSend("PATCH", `/admin/bikes/${bike.id}`, v, (x) => x as PublicBike)
        : apiSend("POST", "/admin/bikes", v, (x) => x as PublicBike),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      if (!bike)
        void navigate({ to: "/admin/bikes/$bikeId", params: { bikeId: b.id }, hash: "inspection" });
    },
  });
  const e = form.formState.errors as Record<string, { message?: string } | undefined>;
  const r = form.register;
  const onSubmit = form.handleSubmit((v) => {
    const {
      id: _i,
      images: _im,
      inspection: _in,
      registrationState: _r,
      ...body
    } = v as Record<string, unknown>;
    save.mutate(body);
  });
  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-6">
      <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Vehicle</legend>
        <Field label="Make" {...r("make")} error={e.make?.message} placeholder="Royal Enfield" />
        <Field label="Model" {...r("model")} error={e.model?.message} placeholder="Classic 350" />
        <Field
          label="Variant (optional)"
          {...r("variant", { setValueAs: asNull })}
          error={e.variant?.message}
        />
        <Field
          label="Manufacturing year"
          type="number"
          {...r("manufactureYear", { setValueAs: asNum })}
          error={e.manufactureYear?.message}
        />
        <Field
          label="Registration year"
          type="number"
          {...r("registrationYear", { setValueAs: asNum })}
          error={e.registrationYear?.message}
        />
        <SelectField label="Fuel" {...r("fuel")}>
          <option value="PETROL">Petrol</option>
          <option value="ELECTRIC">Electric</option>
        </SelectField>
        <Field
          label="Engine (cc)"
          type="number"
          {...r("engineCc", { setValueAs: asNullNum })}
          error={e.engineCc?.message}
          hint="Leave blank for electric"
        />
        <Field
          label="Kilometres driven"
          type="number"
          {...r("kmDriven", { setValueAs: asNum })}
          error={e.kmDriven?.message}
        />
        <Field
          label="Previous owners"
          type="number"
          {...r("ownerCount", { setValueAs: asNum })}
          error={e.ownerCount?.message}
        />
        <Field
          label="Colour (optional)"
          {...r("colour", { setValueAs: asNull })}
          error={e.colour?.message}
        />
      </fieldset>
      <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Registration and documents</legend>
        <Field
          label="RTO code"
          {...r("rtoCode")}
          error={e.rtoCode?.message}
          hint="State + RTO, e.g. DL-3C. Never the full number."
        />
        <SelectField label="RC status" {...r("rcStatus")}>
          <option value="ORIGINAL">Original RC</option>
          <option value="DUPLICATE">Duplicate RC</option>
          <option value="PENDING_TRANSFER">Transfer pending</option>
        </SelectField>
        <SelectField label="Loan / NOC" {...r("hypothecation")}>
          <option value="NONE">No loan</option>
          <option value="ACTIVE">Loan active (NOC pending)</option>
          <option value="NOC_ISSUED">Loan closed, NOC issued</option>
        </SelectField>
        <Field
          label="Insurance valid till"
          type="date"
          {...r("insuranceValidTill", { setValueAs: asNull })}
          error={e.insuranceValidTill?.message}
        />
        <Field label="City" {...r("city")} error={e.city?.message} />
        <Field
          label="Storage yard"
          {...r("yard")}
          error={e.yard?.message}
          placeholder="Okhla Phase II yard"
        />
      </fieldset>
      <fieldset disabled={locked} className="space-y-4">
        <legend className="mb-2 font-semibold">Sale conditions</legend>
        <CheckboxField
          label="Repossessed vehicle"
          hint="Recovered by a bank or lender."
          {...r("repossessed")}
        />
        <CheckboxField
          label="Sold as is, where is"
          hint="The buyer accepts the condition described in the inspection."
          {...r("asIsWhereIs")}
        />
        <TextAreaField
          label="Description and condition notes"
          {...r("description")}
          error={e.description?.message}
          rows={4}
        />
      </fieldset>
      {save.isError && <Alert>{errMsg(save.error)}</Alert>}
      {save.isSuccess && bike && (
        <p role="status" className="text-sm font-semibold text-ledger">
          Saved.
        </p>
      )}
      {!locked && (
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : bike ? "Save details" : "Save and continue"}
        </Button>
      )}
    </form>
  );
}

const SECTION_LABEL: Record<string, string> = {
  engine: "Engine",
  transmission: "Transmission",
  electricals: "Electricals",
  battery: "Battery",
  brakes: "Brakes",
  tyres: "Tyres",
  suspension: "Suspension",
  frame: "Frame",
  body: "Body and paint",
};

function InspectionForm({ bike, locked }: { bike: PublicBike; locked: boolean }) {
  const qc = useQueryClient();
  const current = bike.inspection;
  const form = useForm({
    resolver: zodResolver(InspectionInput),
    defaultValues: current
      ? {
          grade: current.grade,
          sections: current.sections,
          visibleDamage: current.visibleDamage,
          mechanicalIssues: current.mechanicalIssues,
          inspectorNotes: current.inspectorNotes,
          inspectorName: current.inspectorName,
          inspectedAt: current.inspectedAt,
        }
      : {
          grade: "B",
          sections: Object.fromEntries(
            INSPECTION_SECTIONS.map((k) => [k, { condition: "GOOD", note: "" }]),
          ),
          inspectedAt: new Date().toISOString().slice(0, 10),
        },
  });
  const save = useMutation({
    mutationFn: (v: unknown) => apiSend("PUT", `/admin/bikes/${bike.id}/inspection`, v, (x) => x),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }),
  });
  const e = form.formState.errors as {
    grade?: { message?: string };
    sections?: Record<string, { note?: { message?: string } }>;
    inspectorName?: { message?: string };
    inspectedAt?: { message?: string };
  };
  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="space-y-5">
      {current && (
        <p className="text-sm text-steel">
          Current report: version {current.version}. Saving creates version {current.version + 1};
          history is kept.
        </p>
      )}
      <fieldset disabled={locked} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Overall grade" {...form.register("grade")} error={e.grade?.message}>
            <option value="A">A: excellent</option>
            <option value="B">B: good</option>
            <option value="C">C: fair, needs work</option>
            <option value="D">D: poor</option>
          </SelectField>
          <Field
            label="Inspector"
            {...form.register("inspectorName")}
            error={e.inspectorName?.message}
          />
          <Field
            label="Inspection date"
            type="date"
            {...form.register("inspectedAt")}
            error={e.inspectedAt?.message}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {INSPECTION_SECTIONS.map((k) => (
            <div
              key={k}
              className="grid grid-cols-[8rem_1fr] items-start gap-2 rounded-md border border-rule p-3"
            >
              <SelectField
                label={SECTION_LABEL[k]!}
                {...form.register(`sections.${k}.condition` as const)}
              >
                <option value="GOOD">Good</option>
                <option value="FAIR">Fair</option>
                <option value="POOR">Poor</option>
              </SelectField>
              <Field
                label="Note"
                {...form.register(`sections.${k}.note` as const)}
                error={e.sections?.[k]?.note?.message}
              />
            </div>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextAreaField label="Visible damage" {...form.register("visibleDamage")} />
          <TextAreaField label="Mechanical issues" {...form.register("mechanicalIssues")} />
          <TextAreaField label="Inspector notes" {...form.register("inspectorNotes")} />
        </div>
      </fieldset>
      {save.isError && <Alert>{errMsg(save.error)}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm font-semibold text-ledger">
          Inspection saved.
        </p>
      )}
      {!locked && (
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save inspection"}
        </Button>
      )}
    </form>
  );
}

function Photos({ bike, locked }: { bike: PublicBike; locked: boolean }) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin"] });
  const title = `${bike.manufactureYear} ${bike.make} ${bike.model}`;
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    let i = bike.images.length;
    for (const f of Array.from(files)) {
      i += 1;
      setProgress(`Preparing and uploading ${f.name}…`);
      try {
        const blob = await preparePhoto(f);
        await apiUpload(
          `/admin/bikes/${bike.id}/images?alt=${encodeURIComponent(`${title}, photo ${i}`)}`,
          blob,
          (x) => x,
        );
      } catch (err) {
        setError(
          err instanceof ApiError
            ? `${f.name}: ${errMsg(err)}`
            : `${f.name}: ${(err as Error).message}`,
        );
        break;
      } finally {
        refresh();
      }
    }
    setProgress(null);
  };
  const order = useMutation({
    mutationFn: (ids: string[]) =>
      apiSend("PUT", `/admin/bikes/${bike.id}/images/order`, { imageIds: ids }, (x) => x),
    onSuccess: refresh,
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      apiSend("DELETE", `/admin/bikes/${bike.id}/images/${id}`, undefined, (x) => x),
    onSuccess: refresh,
  });
  const ids = bike.images.map((x) => x.id);
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    order.mutate(next);
  };
  return (
    <div>
      <p className="text-sm text-steel">
        Photos are resized to at most 2000 px and re-encoded in your browser before upload, which
        removes location and camera data. Up to 12 photos; the first is the cover.
      </p>
      {!locked && (
        <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-steel/40 bg-concrete/40 px-6 py-8 text-center hover:border-asphalt">
          <span className="font-semibold">Choose photos</span>
          <span className="text-sm text-steel">JPEG, PNG or WebP</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            onChange={(ev) => void onFiles(ev.target.files)}
            disabled={!!progress}
          />
        </label>
      )}
      {progress && (
        <p role="status" className="mt-3 text-sm">
          {progress}
        </p>
      )}
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {(order.isError || del.isError) && (
        <div className="mt-3">
          <Alert>{errMsg(order.error ?? del.error)}</Alert>
        </div>
      )}
      {bike.images.length === 0 ? (
        <p className="mt-4 text-sm text-steel">No photos yet. Buyers will see a placeholder.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {bike.images.map((im, idx) => (
            <li key={im.id} className="overflow-hidden rounded-lg border border-rule">
              <div className="relative aspect-[4/3] bg-concrete">
                <img src={im.url} alt={im.alt} className="size-full object-cover" />
                {idx === 0 && (
                  <span className="absolute left-2 top-2 rounded bg-hivis px-2 py-0.5 text-xs font-bold text-white">
                    Cover
                  </span>
                )}
              </div>
              {!locked && (
                <div className="flex flex-wrap gap-1 p-2 text-xs">
                  {idx > 0 && (
                    <button
                      type="button"
                      className="rounded px-2 py-1 font-semibold hover:bg-concrete"
                      onClick={() => move(idx, 0)}
                    >
                      Make cover
                    </button>
                  )}
                  {idx > 0 && (
                    <button
                      type="button"
                      className="rounded px-2 py-1 hover:bg-concrete"
                      aria-label="Move earlier"
                      onClick={() => move(idx, idx - 1)}
                    >
                      ←
                    </button>
                  )}
                  {idx < ids.length - 1 && (
                    <button
                      type="button"
                      className="rounded px-2 py-1 hover:bg-concrete"
                      aria-label="Move later"
                      onClick={() => move(idx, idx + 1)}
                    >
                      →
                    </button>
                  )}
                  <button
                    type="button"
                    className="ml-auto rounded px-2 py-1 font-semibold text-danger hover:bg-danger/10"
                    onClick={() => del.mutate(im.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function previewCard(
  bike: PublicBike,
  startPriceMinor: number,
  startsAt: number,
  closesAt: number,
): Card {
  return {
    auctionId: "preview",
    status: "SCHEDULED",
    outcome: null,
    title: "",
    make: bike.make,
    model: bike.model,
    variant: bike.variant,
    manufactureYear: bike.manufactureYear,
    kmDriven: bike.kmDriven,
    ownerCount: bike.ownerCount,
    fuel: bike.fuel,
    engineCc: bike.engineCc,
    city: bike.city,
    inspectionGrade: bike.inspection?.grade ?? null,
    repossessed: bike.repossessed,
    startPriceMinor,
    currentPriceMinor: null,
    bidCount: 0,
    startsAt,
    closesAt,
    hasReserve: false,
    reserveMet: false,
    coverUrl: bike.images[0]?.url ?? null,
  };
}

function AuctionFields({
  defaults,
}: {
  defaults: {
    start: string;
    reserve: string;
    startsAt: string;
    closesAt: string;
    terms: string;
    antiSniping: boolean;
    showAnti: boolean;
  };
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Starting bid (₹)"
          name="start"
          inputMode="numeric"
          defaultValue={defaults.start}
          required
        />
        <Field
          label="Hidden reserve (₹, optional)"
          name="reserve"
          inputMode="numeric"
          defaultValue={defaults.reserve}
          hint="Buyers only see whether it's met."
        />
        <Field
          label="Starts (IST)"
          name="startsAt"
          type="datetime-local"
          defaultValue={defaults.startsAt}
          required
        />
        <Field
          label="Closes (IST)"
          name="closesAt"
          type="datetime-local"
          defaultValue={defaults.closesAt}
          required
        />
      </div>
      {defaults.showAnti && (
        <CheckboxField
          name="antiSniping"
          defaultChecked={defaults.antiSniping}
          label="Anti-sniping"
          hint="A bid in the last 2 minutes extends the close by 2 minutes, up to 30 minutes in total."
        />
      )}
      <TextAreaField
        label="Auction description and bidding conditions"
        name="terms"
        defaultValue={defaults.terms}
        rows={3}
      />
    </>
  );
}

function readAuctionForm(f: FormData) {
  const reserve = String(f.get("reserve") ?? "").trim();
  return {
    startPriceMinor: rupeesToPaise(Number(f.get("start"))),
    reserveMinor: reserve ? rupeesToPaise(Number(reserve)) : null,
    startsAt: istLocalToIso(String(f.get("startsAt"))),
    closesAt: istLocalToIso(String(f.get("closesAt"))),
    terms: String(f.get("terms") ?? ""),
  };
}

function CreateAuction({ bike }: { bike: PublicBike }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Card | null>(null);
  const create = useMutation({
    mutationFn: (body: unknown) => apiSend("POST", "/admin/auctions", body, (x) => x),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }),
  });
  const [now] = useState(() => Date.now());
  if (!bike.inspection)
    return (
      <p className="text-steel">Record an inspection first. Buyers need it before they bid.</p>
    );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      bikeId: bike.id,
      ...readAuctionForm(f),
      antiSniping: f.get("antiSniping") === "on",
    });
  };
  return (
    <form
      onSubmit={submit}
      onChange={(e) => {
        const f = new FormData(e.currentTarget);
        const v = readAuctionForm(f);
        setPreview(
          previewCard(
            bike,
            v.startPriceMinor || 100,
            Date.parse(v.startsAt) || now,
            Date.parse(v.closesAt) || now,
          ),
        );
      }}
      className="space-y-4"
    >
      <p className="text-sm text-steel">
        The auction is created as a draft. Review it, then schedule it from here or the Auction
        desk.
      </p>
      <AuctionFields
        defaults={{
          start: "",
          reserve: "",
          startsAt: isoToIstLocal(now + 3_600_000),
          closesAt: isoToIstLocal(now + 25 * 3_600_000),
          terms: "Sold as is, where is. Inspection at the yard by appointment.",
          antiSniping: true,
          showAnti: true,
        }}
      />
      {create.isError && <Alert>{errMsg(create.error)}</Alert>}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create draft auction"}
      </Button>
      {preview && (
        <div className="max-w-sm pt-4">
          <p className="mb-2 text-sm font-semibold">Buyer preview</p>
          <div className="pointer-events-none">
            <AuctionCard a={preview} />
          </div>
        </div>
      )}
    </form>
  );
}

function OpenAuction({ auctionId }: { auctionId: string }) {
  const qc = useQueryClient();
  const q = useQuery(adminAuctionQuery(auctionId));
  const done = () => void qc.invalidateQueries({ queryKey: ["admin"] });
  const update = useMutation({
    mutationFn: (body: unknown) => apiSend("PATCH", `/admin/auctions/${auctionId}`, body, (x) => x),
    onSuccess: done,
  });
  const schedule = useMutation({
    mutationFn: () => apiSend("POST", `/admin/auctions/${auctionId}/schedule`, undefined, (x) => x),
    onSuccess: done,
  });
  if (!q.data) return <Skeleton className="h-40 w-full" />;
  const s = q.data.state;
  const status = s.status as Card["status"];
  if (status !== "DRAFT") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={status} />
        <span className="text-sm">
          {formatINR(s.startPriceMinor)} start, {formatIST(s.startsAt)} → {formatIST(s.closesAt)}
        </span>
        <Link
          to="/auctions/$auctionId"
          params={{ auctionId }}
          className="font-semibold underline underline-offset-4"
        >
          View public page
        </Link>
        <Link to="/admin" className="text-sm underline underline-offset-4">
          Manage on the Auction desk
        </Link>
      </div>
    );
  }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    update.mutate(readAuctionForm(new FormData(e.currentTarget)));
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center gap-3">
        <StatusBadge status="DRAFT" />
        <span className="text-sm text-steel">Not visible to buyers until scheduled.</span>
      </div>
      <AuctionFields
        defaults={{
          start: String(s.startPriceMinor / 100),
          reserve: s.reserveMinor ? String(s.reserveMinor / 100) : "",
          startsAt: isoToIstLocal(s.startsAt),
          closesAt: isoToIstLocal(s.closesAt),
          terms: q.data.listing?.terms ?? "",
          antiSniping: s.rules.softClose !== null,
          showAnti: false,
        }}
      />
      <p className="text-sm text-steel">
        Anti-sniping: {s.rules.softClose ? "on" : "off"} (set when the draft was created).
      </p>
      {(update.isError || schedule.isError) && (
        <Alert>{errMsg(update.error ?? schedule.error)}</Alert>
      )}
      {update.isSuccess && (
        <p role="status" className="text-sm font-semibold text-ledger">
          Draft saved.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={update.isPending}>
          Save draft
        </Button>
        <Button type="button" onClick={() => schedule.mutate()} disabled={schedule.isPending}>
          {schedule.isPending ? "Scheduling…" : "Schedule auction"}
        </Button>
      </div>
    </form>
  );
}
