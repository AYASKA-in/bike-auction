import type { PublicAuctionView } from "@bike/contracts";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { bidErrorMessage, checkBid, nextBidInput, quickBidChips } from "@/lib/bid-intent";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ConfirmBidDialog } from "./confirm-dialog";
import { CheckIcon, WarnIcon } from "./icons";
import { PanelAlert } from "./panel-bits";
import type { BidController } from "./use-bid-controller";

/**
 * Bid form. Enter submits; quick chips only fill the amount; a large bid opens a confirm dialog.
 * Success is shown only after the server's 201; a timeout never places a new bid.
 */
export function BidForm({
  auctionId,
  view,
  ctl,
  paused,
}: {
  auctionId: string;
  view: PublicAuctionView;
  ctl: BidController;
  paused: boolean;
}) {
  const { bid } = ctl;
  const min = ctl.minFor(view);
  const [rupees, setRupees] = useState(String(min / 100));
  const [seenMin, setSeenMin] = useState(min);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  if (min !== seenMin) {
    // New minimum (a bid arrived, or a rejection told us): keep a still-valid typed amount,
    // otherwise prefill the new minimum. Any open confirmation is for a stale comparison.
    setSeenMin(min);
    setRupees((r) => nextBidInput(r, min));
    setConfirming(null);
  }

  if (!ctl.user) {
    return (
      <div className="mt-4 space-y-2">
        {bid.error instanceof ApiError && bid.error.code === "AUTH_REQUIRED" && (
          <PanelAlert>Your session has expired. Sign in again to bid.</PanelAlert>
        )}
        <Link
          to="/login"
          search={{ redirect: `/auctions/${auctionId}` }}
          className="flex min-h-12 items-center justify-center rounded-md bg-hivis px-4 font-semibold text-on-hivis hover:bg-hivis-hover"
        >
          Sign in to bid
        </Link>
      </div>
    );
  }
  if (!ctl.canBid) return <p className="mt-4 text-sm text-pit-ink/75">Administrators can't bid.</p>;

  const leading = view.viewer?.isLeading === true;
  const chips = quickBidChips(min);
  const typedMinor = /^\d{1,9}$/.test(rupees) ? Number(rupees) * 100 : 0;
  const focusInput = () => inputRef.current?.focus();
  const send = (amountMinor: number) => {
    setConfirming(null);
    ctl.place(amountMinor);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (bid.isPending || paused || leading) return;
    const c = checkBid(rupees, min);
    if (!c.ok) {
      setLocalError(c.message);
      focusInput();
      return;
    }
    setLocalError(null);
    if (c.needsConfirm) {
      setConfirming(c.amountMinor);
      return;
    }
    send(c.amountMinor);
  };
  const describedBy = [localError ? "bid-error" : null, "bid-hint"].filter(Boolean).join(" ");

  return (
    <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
      <label className="block text-sm font-semibold" htmlFor="bid-amount">
        Your bid in ₹ (minimum <span className="tnum">{formatINR(min)}</span>)
      </label>
      <input
        id="bid-amount"
        ref={inputRef}
        inputMode="numeric"
        enterKeyHint="send"
        autoComplete="off"
        value={rupees}
        aria-invalid={localError !== null}
        aria-describedby={describedBy}
        onChange={(e) => {
          setRupees(e.target.value.replace(/[^\d]/g, ""));
          setConfirming(null);
          setLocalError(null);
        }}
        className="h-14 w-full min-w-0 rounded-md border border-pit-ink/25 bg-pit-field px-3 font-expanded text-2xl font-bold text-pit-field-ink tnum aria-invalid:border-caution"
      />
      <p id="bid-hint" className="sr-only">
        Press Enter to place the bid.
      </p>
      <div role="group" aria-label="Quick amounts" className="grid grid-cols-3 gap-2">
        {chips.map((c) => {
          const selected = typedMinor === c.amountMinor;
          return (
            <button
              key={c.steps}
              type="button"
              aria-pressed={selected}
              aria-label={`Fill ${formatINR(c.amountMinor)}, ${c.steps === 1 ? "the minimum" : `${c.steps} increments up`}`}
              onClick={() => {
                setRupees(String(c.amountMinor / 100));
                setConfirming(null);
                setLocalError(null);
                focusInput();
              }}
              className={cn(
                "flex min-h-12 flex-col items-center justify-center rounded-md border px-1 py-1 leading-tight transition-colors motion-reduce:transition-none",
                selected
                  ? "border-hivis bg-hivis/15 text-pit-ink"
                  : "border-pit-ink/25 text-pit-ink/90 hover:border-pit-ink/60",
              )}
            >
              <span className="text-[0.7rem] font-bold text-pit-ink/70">+{c.steps}</span>
              <span className="text-sm font-bold tnum">{formatINR(c.amountMinor)}</span>
            </button>
          );
        })}
      </div>
      {localError && (
        <p id="bid-error" className="flex items-start gap-1.5 text-sm font-semibold text-caution">
          <WarnIcon className="mt-px size-4" />
          {localError}
        </p>
      )}
      <Button
        type="submit"
        size="lg"
        className="h-14 w-full text-lg"
        disabled={paused || bid.isPending || leading}
      >
        {bid.isPending
          ? "Placing bid…"
          : leading
            ? "You have the highest bid"
            : paused
              ? "Bidding paused while reconnecting"
              : `Place bid ${formatINR(typedMinor)}`}
      </Button>
      {bid.isError && !bid.isPending && (
        <PanelAlert>
          {bidErrorMessage(bid.error)}
          {ctl.retryAmount !== null && (
            <button
              type="button"
              className="ml-1 inline-flex min-h-11 items-center px-1 underline underline-offset-2"
              onClick={() => ctl.retryAmount !== null && ctl.place(ctl.retryAmount)}
            >
              Retry {formatINR(ctl.retryAmount)}
            </button>
          )}
        </PanelAlert>
      )}
      {bid.isSuccess && !bid.isPending && (
        <p
          className="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-pit-ink"
          data-testid="bid-confirmed"
        >
          <CheckIcon className="size-4 text-go" />
          Bid of <span className="tnum">{formatINR(bid.data.amountMinor)}</span> accepted.
        </p>
      )}
      <ConfirmBidDialog
        amountMinor={confirming}
        minMinor={min}
        onConfirm={send}
        onDismiss={() => {
          setConfirming(null);
          focusInput();
        }}
      />
    </form>
  );
}
