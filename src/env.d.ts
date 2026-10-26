/** True when TMDB credentials are configured server-side. Defined in vite.config.ts. */
declare const __TMDB_ENABLED__: boolean


/** Which NextStream player URL templates are configured server-side. Defined in vite.config.ts. */
declare const __PLAYBACK_ENABLED__: { movie: boolean; tv: boolean }

/** Which NextStream download URL templates are configured server-side. Defined in vite.config.ts. */
declare const __DOWNLOAD_ENABLED__: { movie: boolean; tv: boolean }

/** True when the MovieBox Worker secret is set server-side (the Download button's options). Defined in vite.config.ts. */
declare const __MOVIEBOX_DOWNLOADS__: boolean
