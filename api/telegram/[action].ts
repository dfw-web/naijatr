import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleGate, readGateEnv } from '../../server/telegramGate.js'

/** Vercel function for /api/telegram/{config,verify,recheck}. TELEGRAM_BOT_TOKEN and NAIJATR_GATE_SECRET stay server-side. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleGate(readGateEnv(process.env), req, res)
}
