import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages project sites need a repo base path (set in CI via BASE_URL).
  base: process.env.BASE_URL || "/",
  // Add COOP/COEP headers later when SharedArrayBuffer interrupts are needed.
  assetsInclude: ["**/*.py"],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        game: "game.html",
      },
    },
  },
});
