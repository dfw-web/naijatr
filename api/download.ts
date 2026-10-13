import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDownload, splitApiUrl } from '../server/handlers.js'
import { readNextStreamConfig } from '../server/nextstream.js'

/** Vercel function for /api/download/* (routed here by vercel.json). */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  handleDownload(readNextStreamConfig(process.env), splitApiUrl(req.url ?? '', '/api/download').path, res)
}
