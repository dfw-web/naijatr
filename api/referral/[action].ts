import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleReferral, readReferralEnv } from '../../server/referral/handlers.js'

/**
 * Vercel function for /api/referral/* (the account-based referral program and
 * the ad-free check). SUPABASE_SERVICE_ROLE_KEY, AD_FREE_EMAILS and
 * ADMIN_PASSWORD stay server-side.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const action = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\/referral\/?/, '').replace(/\/+$/, '')
  await handleReferral(readReferralEnv(process.env), action, req, res)
}
