import { defineConfig } from "vite";

/** GitHub Pages `base_path` has no trailing slash (`/step-ahead`). Vite joins `%BASE_URL%` as a raw prefix, so the slash has to be present or `favicon.svg` becomes `step-aheadfavicon.svg`. */
function siteBase(): string {
  const base = process.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

export default defineConfig({
  // GitHub Pages project sites need a repo base path (set in CI via BASE_URL).
  base: siteBase(),
  // Add COOP/COEP headers later when SharedArrayBuffer interrupts are needed.
  assetsInclude: ["**/*.py"],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        trace: "trace.html",
      },
    },
  },
});
