/** True when TMDB credentials are configured server-side. Defined in vite.config.ts. */
declare const __TMDB_ENABLED__: boolean


/** Which NextStream player URL templates are configured server-side. Defined in vite.config.ts. */
declare const __PLAYBACK_ENABLED__: { movie: boolean; tv: boolean }

/** Which NextStream download URL templates are configured server-side. Defined in vite.config.ts. */
declare const __DOWNLOAD_ENABLED__: { movie: boolean; tv: boolean }

/** True when the naijatr-download-worker is configured server-side (server/workerDownloads.ts). Defined in vite.config.ts. */
declare const __WORKER_DOWNLOADS__: boolean
