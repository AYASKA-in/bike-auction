import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/format";

/**
 * Large-bid confirmation (fat-finger guard). A native modal <dialog> with role="alertdialog":
 * showModal() makes the rest of the page inert and traps focus; Esc cancels (native `cancel`);
 * focus starts on "Cancel" (the safe choice, so a double Enter can't confirm a typo) and returns
 * to the amount field when the dialog closes (`onDismiss`).
 */
export function ConfirmBidDialog({
  amountMinor,
  minMinor,
  onConfirm,
  onDismiss,
  kind = "bid",
}: {
  /** "max" confirms a hidden maximum for automatic bidding instead of a bid. */
  kind?: "bid" | "max";
  amountMinor: number | null;
  minMinor: number;
  onConfirm: (amountMinor: number) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = amountMinor !== null;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      cancelRef.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`confirm-${kind}-h`}
      aria-describedby={`confirm-${kind}-d`}
      onClose={onDismiss}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-rule bg-paper p-6 text-asphalt shadow-pop backdrop:bg-[#0b0d0fbf]"
    >
      {amountMinor !== null && (
        <>
          <h2 id={`confirm-${kind}-h`} className="font-expanded text-xl font-extrabold">
            {kind === "max"
              ? `Set a maximum of ${formatINR(amountMinor)}?`
              : `Bid ${formatINR(amountMinor)}?`}
          </h2>
          <p id={`confirm-${kind}-d`} className="mt-2 text-sm text-steel">
            That's well above the minimum of{" "}
            <span className="font-semibold text-asphalt tnum">{formatINR(minMinor)}</span>.{" "}
            {kind === "max"
              ? "We may bid up to this amount for you, automatically."
              : "Bids can't be withdrawn once accepted."}
          </p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              ref={cancelRef}
              type="button"
              size="lg"
              variant="outline"
              className="flex-1"
              onClick={onDismiss}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="lg"
              className="flex-1"
              onClick={() => onConfirm(amountMinor)}
            >
              {kind === "max"
                ? `Yes, set ${formatINR(amountMinor)}`
                : `Yes, bid ${formatINR(amountMinor)}`}
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
