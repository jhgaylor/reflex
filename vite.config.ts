import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser only ever talks to Reflex's own server (same origin in prod).
// In dev, `bun run server` on :8080 and vite forwards /api there.
const appCommit = (process.env.GITHUB_SHA ?? "dev").slice(0, 7);

export default defineConfig({
  define: { __APP_COMMIT__: JSON.stringify(appCommit) },
  plugins: [react()],
  server: {
    port: 5183,
    proxy: { "/api": { target: process.env.REFLEX_SERVER ?? "http://localhost:8080", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true },
});
