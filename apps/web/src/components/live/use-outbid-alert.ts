import { useEffect } from "react";
import { baseTitle, flashStep, titleFor, type FlashState } from "./logic";

const VIBRATE_PATTERN = [180, 90, 180];

/**
 * Outbid side effects outside the page: the tab title flashes "(Outbid!) …" until the bidder
 * interacts with the visible page, and the phone vibrates once per new outbid (where the browser
 * supports and allows it). `outbidKey` changes for each new outbid (null when not outbid); the
 * original title is always restored on cleanup.
 */
export function useOutbidAlert(outbidKey: string | null): void {
  useEffect(() => {
    if (outbidKey === null || typeof document === "undefined") return;
    try {
      if (typeof navigator.vibrate === "function") navigator.vibrate(VIBRATE_PATTERN);
    } catch {
      // Not allowed (no user activation yet, or blocked by policy): the visual cues remain.
    }
    const base = baseTitle(document.title);
    let state: FlashState = { flashing: true };
    let tick = 0;
    const paint = () => {
      document.title = titleFor(base, state, tick);
    };
    const timer = window.setInterval(() => {
      tick++;
      paint();
    }, 1000);
    const stopListening = () => {
      window.removeEventListener("pointerdown", onInteract, true);
      window.removeEventListener("keydown", onInteract, true);
    };
    function onInteract() {
      state = flashStep(state, {
        type: "interact",
        visible: document.visibilityState === "visible",
      });
      if (!state.flashing) {
        window.clearInterval(timer);
        stopListening();
        document.title = base;
      }
    }
    window.addEventListener("pointerdown", onInteract, true);
    window.addEventListener("keydown", onInteract, true);
    paint();
    return () => {
      window.clearInterval(timer);
      stopListening();
      document.title = base;
    };
  }, [outbidKey]);
}
