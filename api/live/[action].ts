import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleLive, readLiveEnv } from '../../server/live/handlers.js'

/** Vercel function for /api/live/{heartbeat,count}. The Redis token and ADMIN_PASSWORD stay server-side. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const action = new URL(req.url ?? '', 'http://localhost').pathname.replace(/^\/api\/live\/?/, '').replace(/\/+$/, '')
  await handleLive(readLiveEnv(process.env), action, req, res)
}
