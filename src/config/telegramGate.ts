/**
 * The "Join our Telegram to watch" gate (src/gate). On by default; set
 * VITE_TELEGRAM_GATE_ENABLED=false in the Vercel project's environment
 * variables and redeploy to switch it off.
 */
export const TELEGRAM_GATE_ENABLED: boolean = import.meta.env.VITE_TELEGRAM_GATE_ENABLED !== 'false'

/** The bot behind the Telegram Login Widget (public; its token lives only on the server). */
export const TELEGRAM_BOT_USERNAME: string = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'naijatr_bot'

/** How often a verified visitor's membership is checked again, silently. */
export const GATE_RECHECK_DAYS = 30
