import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the built dist/ can be served from any path (or opened
// alongside a contract.json the loop daemon emitted). The app fetches
// ./contract.json by default.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
});
