import type { PublicAuctionView } from "@bike/contracts";
import { useEffect, useState } from "react";
import {
  announcementFor,
  snapEquals,
  trackExtension,
  type AnnounceSnap,
  type ExtensionTrack,
} from "./logic";

const NBSP = String.fromCharCode(0xa0);

/**
 * Text for the page's single polite live region. Derived during render from what changed (React's
 * "adjust state when a prop changes" pattern), so there's no effect → setState cascade. The text
 * alternates a trailing no-break space so an identical message is announced again.
 */
export function useAnnouncement(snap: AnnounceSnap | null): string {
  const [prev, setPrev] = useState<AnnounceSnap | null>(snap);
  const [msg, setMsg] = useState({ text: "", n: 0 });
  if (snap !== null && (prev === null || !snapEquals(prev, snap))) {
    setPrev(snap);
    const text = announcementFor(prev, snap);
    if (text !== null) setMsg((m) => ({ text, n: m.n + 1 }));
  }
  return msg.n % 2 === 1 ? msg.text : msg.text + NBSP;
}

export type ExtensionChip = { ms: number; key: number };
const CHIP_MS = 6_000;

/** Transient "+2:00 extended" chip: appears when the deadline moves, gone after a few seconds. */
export function useExtensionChip(
  view: Pick<PublicAuctionView, "auctionId" | "closesAt" | "extensionCount"> | null,
): ExtensionChip | null {
  const [track, setTrack] = useState<ExtensionTrack | null>(() =>
    view ? trackExtension(null, view).track : null,
  );
  const [chip, setChip] = useState<ExtensionChip | null>(null);
  if (view) {
    const r = trackExtension(track, view);
    if (r.track !== track) {
      setTrack(r.track);
      const ms = r.extendedByMs;
      if (ms !== null) setChip((c) => ({ ms, key: (c?.key ?? 0) + 1 }));
    }
  }
  useEffect(() => {
    if (chip === null) return;
    const t = window.setTimeout(() => setChip(null), CHIP_MS);
    return () => window.clearTimeout(t);
  }, [chip]);
  return chip;
}
