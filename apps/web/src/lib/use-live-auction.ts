import { WS_RESYNC, WsServerMessage, type PublicAuctionView } from "@bike/contracts";
import { useEffect, useReducer, useRef } from "react";
import { applyMessage, initialLive, type LiveState } from "./live-auction";

type Action =
  | { kind: "msg"; msg: WsServerMessage; at: number }
  | { kind: "seed"; view: PublicAuctionView }
  | { kind: "status"; status: LiveState["status"] };

function reducer(s: LiveState, a: Action): LiveState {
  // An HTTP view at the SAME seq still carries personal fields (viewer.isLeading), so apply it;
  // only an older one is ignored: it must never override newer authoritative state.
  if (a.kind === "seed")
    return s.view && s.lastSeq > a.view.seq ? s : { ...s, view: a.view, lastSeq: a.view.seq };
  if (a.kind === "status") return { ...s, status: a.status };
  return applyMessage(s, a.msg, a.at);
}

/**
 * Live auction state from the WebSocket feed (authoritative DO), with snapshot-on-reconnect,
 * gap detection → resync, and exponential back-off with jitter. `seed` is an HTTP view used until
 * the socket delivers; it never overrides a newer seq.
 */
export function useLiveAuction(auctionId: string, seed: PublicAuctionView | undefined) {
  const [state, dispatch] = useReducer(reducer, initialLive);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (seed) dispatch({ kind: "seed", view: seed });
  }, [seed]);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/v1/auctions/${auctionId}/stream`);
      wsRef.current = ws;
      dispatch({ kind: "status", status: "connecting" });
      ws.onmessage = (e) => {
        const parsed = WsServerMessage.safeParse(JSON.parse(String(e.data)));
        if (!parsed.success) return; // unknown/newer message type: ignore safely
        attempt = 0;
        dispatch({ kind: "msg", msg: parsed.data, at: Date.now() });
      };
      ws.onclose = () => {
        if (closed) return;
        dispatch({ kind: "status", status: "stale" });
        const delay = Math.min(8000, 250 * 2 ** attempt++) * (0.5 + Math.random());
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    const onVisible = () => {
      if (document.visibilityState === "visible" && wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(WS_RESYNC);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      wsRef.current?.close();
    };
  }, [auctionId]);

  // A detected gap: ask for a fresh snapshot.
  useEffect(() => {
    if (state.status === "stale" && state.view && wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(WS_RESYNC);
  }, [state.status, state.view]);

  return state;
}
