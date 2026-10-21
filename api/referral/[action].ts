import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleReferral, readReferralEnv } from '../../server/referral/handlers.js'

/**
 * Vercel function for /api/referral/* (the referral program and the Invite &
 * Win contest). TELEGRAM_BOT_TOKEN, CLAIM_ENCRYPTION_KEY, the Redis token and
 * ADMIN_PASSWORD stay server-side.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const action = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\/referral\/?/, '').replace(/\/+$/, '')
  await handleReferral(readReferralEnv(process.env), action, req, res)
}
