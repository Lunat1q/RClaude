import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.RCLAUDE_DEV_BACKEND ?? "http://localhost:3000";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      "/api": backend,
      "/mcp": backend,
      "/ws": { target: backend, ws: true },
    },
  },
});
