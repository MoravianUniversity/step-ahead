import { defineConfig } from "vite";

export default defineConfig({
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
