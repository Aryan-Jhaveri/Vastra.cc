import { readFileSync } from 'fs'

// #315 — `make setup` checks for the hosted APIs a self-hoster can pick. They
// run from the operator's own machine, with the operator's own keys, before
// anything is written. Keys are never printed back: errors are redacted.
// The self-hosted model servers use src/ai/connectionChecks.ts instead (the
// same checks as the admin Test connection route).

export interface ApiCheck { name: string; ok: boolean; detail?: string }

type Fetch = typeof fetch
const TIMEOUT_MS = 15_000

function redact(text: string, secret?: string): string {
  const out = secret ? text.split(secret).join('[redacted]') : text
  return out.slice(0, 200)
}

async function get(fetchFn: Fetch, url: string, headers: Record<string, string>): Promise<Response> {
  return fetchFn(url, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: { message?: string } | string; message?: string; name?: string }
    const msg = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? body.name
    return msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function checkGeminiKey(key: string, fetchFn: Fetch = fetch): Promise<ApiCheck> {
  const name = 'Gemini API key'
  try {
    const res = await get(fetchFn, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key })
    if (res.ok) return { name, ok: true }
    return { name, ok: false, detail: redact(await errorText(res), key) }
  } catch (err) {
    return { name, ok: false, detail: redact((err as Error).message, key) }
  }
}

/** The key works, and (when given) the "vendor/model" id exists on OpenRouter. */
export async function checkOpenRouter(key: string, model: string | undefined, fetchFn: Fetch = fetch): Promise<ApiCheck> {
  const name = 'OpenRouter key'
  try {
    const res = await get(fetchFn, 'https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` })
    if (!res.ok) return { name, ok: false, detail: redact(await errorText(res), key) }
    if (!model) return { name, ok: true }
    const models = await get(fetchFn, 'https://openrouter.ai/api/v1/models', {})
    if (!models.ok) return { name, ok: true, detail: `key works; couldn't list models (${models.status})` }
    const list = await models.json() as { data?: Array<{ id?: string }> }
    const found = (list.data ?? []).some(m => m.id === model)
    return found ? { name, ok: true } : { name, ok: false, detail: `key works, but OpenRouter has no model "${model}"` }
  } catch (err) {
    return { name, ok: false, detail: redact((err as Error).message, key) }
  }
}

/** No network: the service-account JSON exists, parses, and has what Vertex auth needs. */
export function checkVertexCredentials(path: string, project: string | undefined): ApiCheck {
  const name = 'Vertex service account'
  let json: { type?: string; client_email?: string; private_key?: string; project_id?: string }
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { name, ok: false, detail: code === 'ENOENT' ? `no file at ${path}` : `not readable JSON (${code ?? 'parse error'})` }
  }
  if (json.type !== 'service_account' || !json.client_email || !json.private_key) {
    return { name, ok: false, detail: 'not a service-account key (needs type, client_email, private_key)' }
  }
  if (project && json.project_id && json.project_id !== project) {
    return { name, ok: true, detail: `key is from project ${json.project_id}, GCP_PROJECT_ID is ${project}: fine if it has access` }
  }
  return { name, ok: true }
}

export async function checkResendKey(key: string, fetchFn: Fetch = fetch): Promise<ApiCheck> {
  const name = 'Resend key'
  try {
    const res = await get(fetchFn, 'https://api.resend.com/domains', { Authorization: `Bearer ${key}` })
    if (res.ok) return { name, ok: true }
    const text = await errorText(res)
    // A sending-only key can't list domains, which still proves it's valid.
    if (res.status === 401 && /restricted/i.test(text)) return { name, ok: true, detail: 'sending-only key' }
    return { name, ok: false, detail: redact(text, key) }
  } catch (err) {
    return { name, ok: false, detail: redact((err as Error).message, key) }
  }
}
