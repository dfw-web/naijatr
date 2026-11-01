import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleAccount, readAccountEnv } from '../../server/account/handlers.js'

/** Vercel function for /api/account/{delete,stats}. SUPABASE_SERVICE_ROLE_KEY stays server-side. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const action = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\/account\/?/, '').replace(/\/+$/, '')
  await handleAccount(readAccountEnv(process.env), action, req, res)
}
