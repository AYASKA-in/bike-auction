import { useCallback, useSyncExternalStore } from "react";

/** Live `matchMedia` result (false where matchMedia is unavailable). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const get = useCallback(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, get, () => false);
}

/** Tailwind's `lg` breakpoint (64rem): desktop layout with the sticky side panel. */
export const DESKTOP = "(min-width: 64rem)";
