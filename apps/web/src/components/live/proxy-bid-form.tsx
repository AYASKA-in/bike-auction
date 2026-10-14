import { ConfirmBidDialog } from "./confirm-dialog";
import { SetMaxBidResult, type PublicAuctionView } from "@bike/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiSend } from "@/lib/api";
import { BidIntent, isUncertain } from "@/lib/bid-intent";
import { formatINR } from "@/lib/format";
import { checkMaxBid, maxBidErrorMessage, maxStatus } from "@/lib/proxy-bid";
import { useMe } from "@/lib/session";
import { PanelAlert } from "./panel-bits";

/**
 * Proxy (automatic) bidding: the buyer sets a hidden maximum and the server bids for them, one
 * step at a time, only as far as competition requires (ADR 004 › Proxy bidding). The maximum is
 * shown only to its owner (`view.viewer.myMaxMinor`). Self-contained: PUT /auctions/:id/max-bid
 * with an Idempotency-Key that is reused only when the outcome of a previous attempt is unknown.
 */
export function ProxyBidForm({
  auctionId,
  view,
  onAccepted,
}: {
  auctionId: string;
  view: PublicAuctionView;
  onAccepted?: (result: SetMaxBidResult) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const [rupees, setRupees] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [intent] = useState(() => new BidIntent());

  const save = useMutation({
    mutationFn: (maxMinor: number) =>
      apiSend(
        "PUT",
        `/auctions/${auctionId}/max-bid`,
        { maxMinor },
        (x) => SetMaxBidResult.parse(x),
        { "idempotency-key": intent.keyFor(maxMinor) },
        15_000,
      ),
    retry: false, // only the user retries, and only with the same key
    onSuccess: (r) => {
      intent.settle(null);
      setRupees("");
      onAccepted?.(r);
      void qc.invalidateQueries({ queryKey: ["view", auctionId] });
    },
    onError: (e) => {
      intent.settle(e);
      if (e instanceof ApiError && e.code === "AUTH_REQUIRED")
        void qc.invalidateQueries({ queryKey: ["me"] });
      if (!isUncertain(e)) void qc.invalidateQueries({ queryKey: ["view", auctionId] });
    },
  });

  if (view.status !== "LIVE" || !me.data || me.data.role === "ADMIN") return null;

  const min = view.minNextBidMinor ?? view.startPriceMinor;
  const myMax = view.viewer?.myMaxMinor ?? null;
  const status = maxStatus(view);

  const send = (maxMinor: number) => {
    setConfirming(null);
    save.mutate(maxMinor);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const c = checkMaxBid(rupees, view);
    if (!c.ok) {
      setLocalError(c.message);
      return;
    }
    setLocalError(null);
    if (c.needsConfirm && confirming !== c.maxMinor) {
      setConfirming(c.maxMinor);
      return;
    }
    send(c.maxMinor);
  };
  const retryAmount = save.isError && isUncertain(save.error) ? intent.pendingRetryAmount : null;

  return (
    <form
      onSubmit={submit}
      className="mt-2 mb-2 space-y-3"
      noValidate
      aria-labelledby="proxy-title"
    >
      <div>
        <h3 id="proxy-title" className="text-sm font-semibold">
          Set a maximum bid — we&apos;ll bid for you up to this amount
        </h3>
        <p className="mt-1 text-xs text-pit-ink/75">
          Only you can see your maximum. We bid the smallest amount needed to keep you ahead.
        </p>
      </div>

      {myMax !== null && (
        <p className="text-sm" data-testid="my-max">
          Your maximum: <span className="font-bold tnum">{formatINR(myMax)}</span>
          {status === "leading" && " · you're leading"}
          {status === "active" && " · active"}
          {status === "passed" && (
            <span className="text-caution">
              {" "}
              · passed. Set a higher maximum to keep bidding automatically.
            </span>
          )}
        </p>
      )}

      <label className="block text-sm font-semibold" htmlFor="proxy-max">
        {myMax === null ? "Your maximum in ₹" : "New maximum in ₹"} (at least {formatINR(min)})
      </label>
      <input
        id="proxy-max"
        inputMode="numeric"
        autoComplete="off"
        placeholder={String(min / 100)}
        value={rupees}
        aria-invalid={localError !== null}
        aria-describedby={localError ? "proxy-error" : undefined}
        onChange={(e) => {
          setRupees(e.target.value.replace(/[^\d]/g, ""));
          setConfirming(null);
          setLocalError(null);
        }}
        className="h-12 w-full min-w-0 rounded-md border border-pit-ink/25 bg-pit-field px-3 font-expanded text-lg font-bold text-pit-field-ink tnum placeholder:font-medium placeholder:text-steel aria-invalid:border-caution"
      />
      {localError && (
        <p id="proxy-error" className="text-sm font-semibold text-caution">
          {localError}
        </p>
      )}

      <ConfirmBidDialog
        kind="max"
        amountMinor={confirming}
        minMinor={min}
        onConfirm={(amount) => send(amount)}
        onDismiss={() => {
          setConfirming(null);
          document.getElementById("proxy-max")?.focus();
        }}
      />
      <Button type="submit" className="w-full" disabled={save.isPending || rupees === ""}>
        {save.isPending ? "Saving maximum…" : myMax === null ? "Set maximum" : "Update maximum"}
      </Button>

      {save.isError && (
        <PanelAlert>
          {maxBidErrorMessage(save.error)}
          {retryAmount !== null && (
            <button
              type="button"
              className="ml-2 font-semibold underline underline-offset-2"
              onClick={() => save.mutate(retryAmount)}
            >
              Retry {formatINR(retryAmount)}
            </button>
          )}
        </PanelAlert>
      )}
      {save.isSuccess && !save.isPending && (
        <p className="text-sm text-pit-ink/85" role="status" data-testid="max-confirmed">
          Maximum of {formatINR(save.data.maxMinor)} saved.{" "}
          {save.data.isLeading
            ? `You're leading at ${formatINR(save.data.currentPriceMinor)}.`
            : `Another bidder's maximum is higher or earlier; the price is now ${formatINR(save.data.currentPriceMinor)}.`}
        </p>
      )}
    </form>
  );
}
