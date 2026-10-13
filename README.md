# NEXTSTREAM

A movie and TV-series discovery site built with React, TypeScript and Vite.

## Scripts

| Command           | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm run dev`     | Start the dev server at http://localhost:5173  |
| `npm run build`   | Type-check and build for production            |
| `npm run preview` | Serve the production build locally             |
| `npm run lint`    | Lint with oxlint                               |
| `npm test`        | Run the Vitest test suite once                 |

## Catalogue data

By default the app uses a bundled, fictional sample catalogue
(`src/data/sampleData.ts`) with images from Lorem Picsum (Unsplash licence).

### Connecting TMDB (optional, free)

1. Create a free account and get API credentials at
   https://www.themoviedb.org/settings/api
2. Copy `.env.example` to `.env.local` and set **one** of:
   - `TMDB_READ_ACCESS_TOKEN` (preferred, the "API Read Access Token"), or
   - `TMDB_API_KEY` or `VITE_TMDB_API_KEY` (the v3 "API Key")
3. Restart `npm run dev`.

The credential is used only by the Vite dev/preview server, which proxies
`/api/tmdb/*` to `api.themoviedb.org` and attaches it server-side. It is never
bundled into the frontend. **Never** read these variables from `src/` via
`import.meta.env`, as that would expose them to the browser.

## Deploying to Vercel

`/api/tmdb`, `/api/play` and `/api/download` are served in production by the
Vercel functions in `api/`, which share their logic with the dev server
(`server/handlers.ts`). `vercel.json` routes `/api/*/…` to them and sends any
other unknown path to `index.html`.

1. Import the repository in Vercel. The settings in `vercel.json` (Vite,
   `npm run build`, output `dist`) are picked up automatically.
2. In **Project → Settings → Environment Variables**, add the same variables
   you use in `.env.local` (see `.env.example`) for Production (and Preview if
   wanted): `TMDB_READ_ACCESS_TOKEN` or `TMDB_API_KEY`, plus `NEXTSTREAM_*`.
   Prefer `TMDB_API_KEY` over `VITE_TMDB_API_KEY` there; both work.
3. Redeploy after changing variables. They are read at **build time** (to
   switch TMDB, Play and Download on in the UI) and at **runtime** by the
   functions, so a build without them ships the sample catalogue.

## Installable app

The site is a Progressive Web App: `public/manifest.webmanifest` and the icons in `public/icons/` let Chrome, Edge and Android install it (an **Install app** button appears in the navbar when the browser offers it; on iPhone use Share → Add to Home Screen). `public/sw.js` caches the app shell (page, built assets, icons, fonts) so the installed app opens offline, showing the sample catalogue. It never caches `/api`, TMDB data or video players, and is only registered in production builds.

## Structure

- `src/types/media.ts` — `MediaItem` and the `CatalogProvider` interface
- `src/data/localProvider.ts` / `tmdbProvider.ts` — the two data sources
- `src/data/provider.ts` — picks the provider; React context for overriding it
- `src/hooks/` — data loading (`useAsync`, `useCatalog`) with cancellation and retry
- `src/components/` — UI components, each with its own CSS file
