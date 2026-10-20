import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleFeedback, readFeedbackEnv } from '../../server/feedback/handlers.js'

/**
 * Vercel function for /api/feedback/{send,list,update}. The Redis token,
 * TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_CHAT_ID and ADMIN_PASSWORD stay server-side.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const action = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\/feedback\/?/, '').replace(/\/+$/, '')
  await handleFeedback(readFeedbackEnv(process.env), action, req, res)
}
