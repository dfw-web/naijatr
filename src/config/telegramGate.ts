/**
 * The "Join our Telegram to watch" gate (src/gate): asked once per phone or
 * tablet, nothing is checked. On by default; set
 * VITE_TELEGRAM_GATE_ENABLED=false in the Vercel project's environment
 * variables and redeploy to switch it off.
 */
export const TELEGRAM_GATE_ENABLED: boolean = import.meta.env.VITE_TELEGRAM_GATE_ENABLED !== 'false'
