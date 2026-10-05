# Step Ahead

Interactive Python code-tracing practice. Predict each step — assignments, calls, returns, and print output — before the program advances.

This repository (`auto-trace-table`) also includes **Auto Trace Table**, a step-through viewer for exploring execution as nested trace tables.

| Page | Entry |
| --- | --- |
| Step Ahead (game) | [`index.html`](index.html) — `/` |
| Auto Trace Table | [`trace.html`](trace.html) — `/trace.html` |

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173/`).

```bash
npm run build    # typecheck + production build → dist/
npm run preview  # serve the production build locally
```

## Problems

Game levels live in [`problems/*.problem`](problems/). Each file has metadata (`id`, `title`, `description`, optional `order` / `enable`) plus a `[code]` Python template. Optional `[random]` bindings can vary values between runs.

## License

Copyright (C) 2026 Jeffrey Bush

This program is free software under the [GNU Affero General Public License v3.0](LICENSE) only (`AGPL-3.0-only`). If you modify it and run it as a network service, you must offer users the corresponding source (see AGPL §13).
