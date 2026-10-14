import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./button";

/**
 * Confirmation for consequential actions, matching the live page's large-bid confirmation: a
 * native modal <dialog> (role="alertdialog") that makes the page inert and traps focus, starts on
 * the safe choice, and closes on Esc. Focus returns to whatever opened it.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      cancelRef.current?.focus();
    } else if (!open && d.open) {
      d.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${id}-t`}
      aria-describedby={children ? `${id}-d` : undefined}
      onClose={() => open && onCancel()}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-rule bg-paper p-6 text-asphalt shadow-pop backdrop:bg-[#0b0d0fbf]"
    >
      {open && (
        <>
          <h2 id={`${id}-t`} className="font-expanded text-xl font-extrabold">
            {title}
          </h2>
          {children && (
            <div id={`${id}-d`} className="mt-2 text-sm text-steel">
              {children}
            </div>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              ref={cancelRef}
              type="button"
              size="lg"
              variant="outline"
              className="flex-1"
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              size="lg"
              variant={tone === "danger" ? "danger" : "primary"}
              className="flex-1"
              loading={busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
