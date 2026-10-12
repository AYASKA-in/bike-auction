import { exports } from "cloudflare:workers";

export const BASE = "http://example.com";
export type Msg = Record<string, unknown> & { type: string };

export async function connect(id: string, opts: { origin?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { upgrade: "websocket", origin: opts.origin ?? BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await exports.default.fetch(`${BASE}/api/v1/auctions/${id}/stream`, { headers });
  const messages: Msg[] = [];
  const ws = res.webSocket;
  if (ws) {
    ws.addEventListener("message", (e) => {
      messages.push(JSON.parse(e.data as string) as Msg);
    });
    ws.accept();
  }
  return { res, ws, messages };
}

export async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
