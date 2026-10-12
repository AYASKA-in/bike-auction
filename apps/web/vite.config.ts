import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the SPA runs on :5173 and proxies the API (incl. WebSockets) to `wrangler dev`
// on :8787. In production both are served from one Worker origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true, changeOrigin: false } },
  },
  build: { sourcemap: true, target: "es2022" },
});
