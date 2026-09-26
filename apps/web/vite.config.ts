import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // Follows the API's port, so SKIFF_PORT=3000 pnpm dev just works.
        target: `http://127.0.0.1:${process.env.SKIFF_PORT || 8080}`,
        ws: true,
      },
    },
  },
});
