import { isChatEnabled } from '../agent/chatEnabled.js'
import { signupsOpen } from '../auth/signups.js'
import { decisionsProviderInfo } from '../ai/decisionsProvider.js'
import { isHostedMode } from '../hostedMode.js'

// #315 Phase 2 — Settings › Instance: the admin's read-only view of the config
// `make setup` (or a hand-edited .env) produced. Secrets are reported as set
// or not, never their value; URLs lose any user:password part.

export interface ConfigEntry { key: string; set: boolean; value: string | null; secret?: true }
export interface ConfigGroup { title: string; entries: ConfigEntry[] }
export interface InstanceConfig {
  hostedMode: boolean
  signupsOpen: boolean
  chatEnabled: boolean
  decisions: string | null
  groups: ConfigGroup[]
}

const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Instance', keys: ['WEB_APP_URL', 'ALLOW_SIGNUPS'] },
  { title: 'Google', keys: ['GEMINI_API_KEY', 'GCP_PROJECT_ID', 'GCP_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'] },
  { title: 'Chat + vision', keys: ['VISION_MODEL', 'TEXT_MODEL', 'AGENT_MODEL', 'OPENROUTER_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY'] },
  { title: 'Images + embeddings', keys: ['MOCK_AI_IMAGE_GEN', 'IMAGE_GEN_MODEL', 'IMAGE_GEN_BASE_URL', 'MOCK_EMBEDDINGS', 'TEXT_EMBED_ENABLED', 'IMAGE_EMBED_ENABLED', 'EMBED_BASE_URL'] },
  { title: 'Decisions', keys: ['DECISIONS_PROVIDER', 'DECISIONS_URL', 'DECISIONS_MODEL', 'DECISIONS_API_KEY'] },
  { title: 'Email + push', keys: ['RESEND_API_KEY', 'RESEND_FROM_NOREPLY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] },
]

const SECRET = /(_KEY|SECRET|PASSWORD|TOKEN)$/

function stripUserinfo(value: string): string {
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value
  }
}

export function describeInstanceConfig(env: NodeJS.ProcessEnv = process.env): InstanceConfig {
  const groups = GROUPS.map(g => ({
    title: g.title,
    entries: g.keys.map((key): ConfigEntry => {
      const raw = env[key]?.trim()
      const set = !!raw
      // VAPID_PUBLIC_KEY is public by design, but a key is a key: report set only.
      if (SECRET.test(key)) return { key, set, value: null, secret: true }
      return { key, set, value: set ? (/_URL$/.test(key) ? stripUserinfo(raw!) : raw!) : null }
    }),
  }))
  const decisions = decisionsProviderInfo()
  return {
    hostedMode: isHostedMode(),
    signupsOpen: signupsOpen(),
    chatEnabled: isChatEnabled(),
    decisions: decisions ? `${decisions.kind} (${decisions.model})` : null,
    groups,
  }
}
