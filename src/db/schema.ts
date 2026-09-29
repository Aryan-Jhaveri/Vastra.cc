import { sqliteTable, text, integer, real, primaryKey, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash'),
  createdAt: integer('created_at').notNull(),
  openrouterKeyHash: text('openrouter_key_hash'),
  openrouterKeyEncrypted: text('openrouter_key_encrypted'),
  openrouterLimitUsd: real('openrouter_limit_usd'),
  openrouterKeyCreatedAt: integer('openrouter_key_created_at'),
  acceptedTermsAt: integer('accepted_terms_at'),
  emailVerifiedAt: integer('email_verified_at'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // #360 — SHA-256 hex of the session token; the token itself lives only in
  // the client's cookie / bearer header.
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

export const loginTokens = sqliteTable('login_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
})

export const oauthAccounts = sqliteTable('oauth_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerId: text('provider_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  providerUnq: uniqueIndex('oauth_provider_unique').on(table.provider, table.providerId),
}))

export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  imageUri: text('image_uri').notNull(),
  tagImageUri: text('tag_image_uri'),

  category: text('category').notNull(),
  subcategory: text('subcategory'),
  primaryColor: text('primary_color'),
  colors: text('colors').default('[]'),
  material: text('material'),
  careInstructions: text('care_instructions').default('[]'),
  brand: text('brand'),
  size: text('size'),
  season: text('season').default('[]'),
  tags: text('tags').default('[]'),
  aiDescription: text('ai_description'),
  occasion: text('occasion').default('[]'),
  wearContext: text('wear_context'),

  materialSource: text('material_source'),

  timesWorn: integer('times_worn').default(0),
  lastWornAt: integer('last_worn_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const outfits = sqliteTable('outfits', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  name: text('name').notNull(),
  itemIds: text('item_ids').notNull(),
  occasion: text('occasion'),
  season: text('season').default('[]'),
  aiGenerated: integer('ai_generated').default(0),
  weatherContext: text('weather_context'),
  notes: text('notes'),
  coverImageUri: text('cover_image_uri'),
  tags: text('tags').default('[]'),
  timesWorn: integer('times_worn').default(0),
  lastWornAt: integer('last_worn_at'),
  createdAt: integer('created_at').notNull(),
  // #376 — last metadata change. The embeddings reconciler re-embeds an
  // outfit whose text vector is older than this. Wearing it does not bump it.
  updatedAt: integer('updated_at').notNull().default(0),
})

export const userPhotos = sqliteTable('user_photos', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  imageUri: text('image_uri').notNull(),
  label: text('label'),
  isPrimary: integer('is_primary').default(0),
  createdAt: integer('created_at').notNull(),
})

export const tryonResults = sqliteTable('tryon_results', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  userPhotoId: text('user_photo_id').notNull(),
  outfitId: text('outfit_id'),
  itemIds: text('item_ids').notNull(),
  resultImageUri: text('result_image_uri').notNull(),
  promptInstruction: text('prompt_instruction'),
  createdAt: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').notNull(),
  userId: text('user_id').notNull().default('self'),
  value: text('value').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.key, table.userId] }),
}))

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  name: text('name').notNull(),
  // registered key in the job registry (e.g. 'daily_outfit')
  type: text('type').notNull(),
  // cron expression ('0 8 * * *') or ISO 8601 date string for one-shot runs
  schedule: text('schedule').notNull(),
  // JSON blob — job-type-specific params (chatId, lat, lon, theme, etc.)
  params: text('params').notNull().default('{}'),
  enabled: integer('enabled').notNull().default(1),
  lastRunAt: integer('last_run_at'),
  createdAt: integer('created_at').notNull(),
  // Durable execution cursor + claim fence (agent-readiness hardening).
  // A run is only executed by the worker holding an unexpired claim_token.
  nextRunAt: integer('next_run_at'),
  claimToken: text('claim_token'),
  claimExpiresAt: integer('claim_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  retryAt: integer('retry_at'),
  // 'idle' | 'running' | 'retry' | 'manual_recovery'
  runState: text('run_state').notNull().default('idle'),
  lastError: text('last_error'),
})

export const collections = sqliteTable('collections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  name: text('name').notNull(),
  description: text('description'),
  coverImageUri: text('cover_image_uri'),
  season: text('season').default('[]'),
  tags: text('tags').default('[]'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const itemImages = sqliteTable('item_images', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  itemId: text('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  imageUri: text('image_uri').notNull(),
  // 'crop' | 'source' | 'reference' | 'generated'
  role: text('role'),
  // 'front' | 'back' | 'side' | 'detail' | null
  view: text('view'),
  position: integer('position').notNull().default(0),
  isPrimary: integer('is_primary').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

export const collectionOutfits = sqliteTable('collection_outfits', {
  collectionId: text('collection_id').notNull(),
  outfitId: text('outfit_id').notNull(),
  position: integer('position').notNull().default(0),
  addedAt: integer('added_at').notNull(),
}, t => ({ pk: primaryKey({ columns: [t.collectionId, t.outfitId] }) }))

export const jobRuns = sqliteTable('job_runs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  jobId: text('job_id').notNull(),
  firedAt: integer('fired_at').notNull(),
  status: text('status').notNull(),      // 'success' | 'failed' | 'skipped'
  resultJson: text('result_json'),       // JSON OutfitSuggestion[] for daily_outfit
  error: text('error'),
})

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  endpoint: text('endpoint').notNull().unique(),
  keys: text('keys').notNull(),          // JSON: { auth, p256dh }
  createdAt: integer('created_at').notNull(),
})

export const sharePayloads = sqliteTable('share_payloads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  createdByUserId: text('created_by_user_id').notNull().default('self'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
  source: text('source').notNull(),              // 'outfit' | 'suggestion' | 'inspiration' | 'manual' | 'share_inbox'
  sourceRef: text('source_ref'),
  description: text('description').notNull(),
  imageUris: text('image_uris').notNull().default('[]'),  // JSON array of copied image paths
  senderHandle: text('sender_handle'),
  visibility: text('visibility').notNull().default('link'),  // 'link' | 'recipient'
  recipientUserId: text('recipient_user_id'),
  openedAt: integer('opened_at'),
  openCount: integer('open_count').notNull().default(0),
  intendedAction: text('intended_action'),       // 'unspecified' | 'tryon' | 'find_similar' | null (Phase 2 / Capacitor populates directly)
  claimToken: text('claim_token'),                // short-lived; only set on anonymous share_inbox rows
})

export const embeddings = sqliteTable('embeddings', {
  id: text('id').primaryKey(),
  level: text('level').notNull(),
  refId: text('ref_id').notNull(),
  userId: text('user_id').notNull().default('self'),
  variant: text('variant').notNull().default('main'),
  modelVersion: text('model_version').notNull(),
  vector: blob('vector').notNull(),
  sourceBlob: text('source_blob').notNull(),
  createdAt: integer('created_at').notNull(),
})

// Per-user query-vector cache. The plaintext query is never persisted: the
// hash covers (userId, text, modelVersion) so one user's cache row can never
// be probed or reused by another.
export const queryEmbeddings = sqliteTable('query_embeddings', {
  queryHash: text('query_hash').notNull(),
  userId: text('user_id').notNull(),
  modelVersion: text('model_version').notNull(),
  vector: blob('vector').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.userId, table.queryHash] }),
}))

export const suggestEvents = sqliteTable('suggest_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  shortlistSource: text('shortlist_source').notNull(),
  itemCount: integer('item_count').notNull(),
  shortlistedCount: integer('shortlisted_count').notNull(),
  suggestionCount: integer('suggestion_count').notNull(),
  preFilterEnabled: integer('pre_filter_enabled').notNull().default(0),
  weather: text('weather'),
  occasion: text('occasion'),
  promptChars: integer('prompt_chars'),
  createdAt: integer('created_at').notNull(),
})

export const discoverEvents = sqliteTable('discover_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().default('self'),
  mode: text('mode').notNull(),
  shortlistSource: text('shortlist_source').notNull(),
  itemCount: integer('item_count').notNull(),
  shortlistedCount: integer('shortlisted_count').notNull(),
  suggestionCount: integer('suggestion_count').notNull(),
  preFilterEnabled: integer('pre_filter_enabled').notNull().default(0),
  occasion: text('occasion'),
  promptChars: integer('prompt_chars'),
  createdAt: integer('created_at').notNull(),
})

export const userWallets = sqliteTable('user_wallets', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balanceTokens: integer('balance_tokens').notNull().default(0),
  lifetimePurchased: integer('lifetime_purchased').notNull().default(0),
  lifetimeSpentTokens: integer('lifetime_spent_tokens').notNull().default(0),
  subscriptionTier: text('subscription_tier'),
  subscriptionStatus: text('subscription_status'),
  monthlyGrantTokens: integer('monthly_grant_tokens').notNull().default(0),
  nextGrantAt: integer('next_grant_at'),
  stripeCustomerId: text('stripe_customer_id').unique(),
  updatedAt: integer('updated_at').notNull(),
})

export const walletLedger = sqliteTable('wallet_ledger', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deltaTokens: integer('delta_tokens').notNull(),
  reason: text('reason').notNull(),
  aiCallId: text('ai_call_id'),
  stripeEventId: text('stripe_event_id').unique(),
  // Optional caller-supplied dedupe key (admin grants, monthly refill cron).
  // A plain UNIQUE index (migration 0023) enforces this — SQLite treats NULL
  // as distinct, so ad-hoc rows without a key stay unconstrained.
  idempotencyKey: text('idempotency_key'),
  metadata: text('metadata').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
}, table => ({
  userCreatedIdx: index('ledger_user_idx').on(table.userId, table.createdAt),
}))

export const aiCalls = sqliteTable('ai_calls', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemId: text('item_id').references(() => items.id, { onDelete: 'set null' }),
  outfitId: text('outfit_id').references(() => outfits.id, { onDelete: 'set null' }),
  task: text('task').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  wholesaleCostCentsX100: integer('wholesale_cost_cents_x100').notNull().default(0),
  // #345 — 0 when the provider/model had no configured price (cost unknown, not free).
  costKnown: integer('cost_known').notNull().default(1),
  // #344 — the PRICE_SCHEDULES id the estimate came from, 'provider-reported'
  // when the provider billed the amount, NULL for rows recorded before #344.
  priceScheduleId: text('price_schedule_id'),
  billedTokens: integer('billed_tokens').notNull().default(0),
  latencyMs: integer('latency_ms'),
  success: integer('success').notNull().default(1),
  parseSuccess: integer('parse_success').notNull().default(1),
  errorMessage: text('error_message'),
  // #189 — backlinks for granular activity detail cards. Soft links (plain
  // nullable text, no FK) keep the additive migration trivial, mirroring the
  // existing walletLedger.aiCallId precedent; the listActivity LEFT JOINs
  // tolerate dangling references gracefully.
  tryonResultId: text('tryon_result_id'),
  jobId: text('job_id'),
  outputImageUri: text('output_image_uri'),
  // Reserved for #189 Phase 2 (opt-in prompt snippet). Intentionally NOT
  // populated yet — storing prompts has multi-user privacy implications that
  // need a product decision first. Column added now so Phase 2 needs no migration.
  promptSnippet: text('prompt_snippet'),
  // Agent execution identity. Nullable: non-agent calls leave these unset.
  runId: text('run_id'),
  turnId: text('turn_id'),
  stepId: text('step_id'),
  toolCallId: text('tool_call_id'),
  createdAt: integer('created_at').notNull(),
}, table => ({
  userCreatedIdx: index('ai_calls_user_idx').on(table.userId, table.createdAt),
  taskCreatedIdx: index('ai_calls_task_idx').on(table.task, table.createdAt),
  runIdx: index('ai_calls_run_idx').on(table.runId),
}))

export const analyticsEvents = sqliteTable('analytics_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  eventType: text('event_type').notNull(),
  route: text('route'),
  properties: text('properties').notNull().default('{}'),
  pwaMode: integer('pwa_mode').notNull().default(0),
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at').notNull(),
}, table => ({
  userCreatedIdx: index('analytics_user_idx').on(table.userId, table.createdAt),
  typeCreatedIdx: index('analytics_type_idx').on(table.eventType, table.createdAt),
  sessionIdx: index('analytics_session_idx').on(table.sessionId),
}))

export const likedProducts = sqliteTable('liked_products', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Shopify Global Catalog product GID (gid://shopify/p/…). Only the id is
  // stored — Shopify's policy forbids caching catalog results, so title,
  // price, availability and image are read live via lookup_catalog (#324).
  productId: text('product_id').notNull(),
  // Links to the closet item created from this like via "Add to closet" (#324).
  // SET NULL when the item is deleted, so the card reverts to "Add to closet".
  savedItemId: text('saved_item_id').references(() => items.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
}, table => ({
  // One like per (user, product) — prevents duplicate likes.
  userProductUnq: uniqueIndex('liked_products_user_product').on(table.userId, table.productId),
  userCreatedIdx: index('liked_products_user_created').on(table.userId, table.createdAt),
}))

// Personal API tokens (#321). Non-browser clients (Claude Desktop via MCP,
// Home Assistant, scripts) authenticate as a user with a scoped bearer token.
// The plaintext token is shown ONCE at creation; only the SHA-256 hash is
// stored. `prefix` is `vst_` + 6 chars for display in the Settings list so the
// user can identify a token without the secret. Scopes: read | write | ai.
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // SHA-256 hex of the plaintext token. Looked up by exact match on a unique
  // index — no per-row comparison loop, so timing is constant-ish; the
  // middleware additionally asserts timingSafeEqual as a guard.
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  // JSON array of scopes, e.g. '["read","write"]'.
  scopes: text('scopes').notNull().default('["read"]'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  expiresAt: integer('expires_at'),
  revokedAt: integer('revoked_at'),
}, table => ({
  userCreatedIdx: index('api_tokens_user_idx').on(table.userId, table.createdAt),
}))

// ─── Agent chat (#318) ─────────────────────────────────────────────────────────
// The agent loop (`src/agent/loop.ts`) owns these tables; #328's Ask tab and a
// future Telegram transport (#319) reuse them. History is always loaded
// server-side by (userId, threadId) — the client never sends history or tool
// results. Deleting a thread cascades to its messages and pending actions;
// account deletion cascades through user_id.
export const chatThreads = sqliteTable('chat_threads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // First user message, trimmed to 60 chars. No model call.
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => ({
  userIdx: index('chat_threads_user_idx').on(table.userId, table.updatedAt),
}))

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Groups a turn; context trimming drops whole turns only.
  turnId: text('turn_id').notNull(),
  // 'user' | 'assistant' | 'tool'
  role: text('role').notNull(),
  // Text for user/assistant rows; JSON string for tool rows.
  content: text('content').notNull(),
  // JSON [{ id, name, arguments }] on assistant rows.
  toolCalls: text('tool_calls'),
  // JSON; replayed verbatim for Gemini (messageAdapters.ts).
  providerState: text('provider_state'),
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  // Monotonic within a thread. created_at alone can tie inside one millisecond.
  seq: integer('seq').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => ({
  threadIdx: index('chat_messages_thread_idx').on(table.userId, table.threadId, table.seq),
}))

// A write-scope tool call waiting for an explicit user tap. The stored `args`
// are what runs on confirm — never client-supplied ones. Single-use: the
// pending → confirmed/cancelled/expired move is one conditional UPDATE.
export const agentPendingActions = sqliteTable('agent_pending_actions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  assistantMessageId: text('assistant_message_id').notNull().references(() => chatMessages.id, { onDelete: 'cascade' }),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  args: text('args').notNull(),
  // 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'superseded'
  status: text('status').notNull().default('pending'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => ({
  threadStatusIdx: index('agent_pending_actions_thread_idx').on(table.userId, table.threadId, table.status),
}))

// #332 — "Find related" request log + daily cap. See src/db/relatedRequests.ts.
export const relatedRequests = sqliteTable('related_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  targetId: text('target_id').notNull(),
  status: text('status').notNull(),
  countsTowardCap: integer('counts_toward_cap').notNull(),
  candidateCount: integer('candidate_count'),
  result: text('result'),
  fingerprint: text('fingerprint'),
  batchCount: integer('batch_count'),
  latencyMs: integer('latency_ms'),
  costX100: integer('cost_x100'),
  createdAt: integer('created_at').notNull(),
}, table => ({
  userTimeIdx: index('idx_related_requests_user_time').on(table.userId, table.createdAt),
  targetIdx: index('idx_related_requests_target').on(table.userId, table.kind, table.targetId, table.createdAt),
}))

// #347 — POST /api/items idempotency keys. A lease while itemId is null, a
// replay record once set. See src/db/itemCreateKeys.ts.
export const itemCreateKeys = sqliteTable('item_create_keys', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  itemId: text('item_id').references(() => items.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.userId, table.key] }),
}))

// One chat turn in flight per user. Taken inside BEGIN IMMEDIATE (the
// src/jobs/claims.ts pattern); a crashed turn frees itself when the lease
// expires. Derived state — no audit value, so the row is deleted on release.
export const chatTurnLeases = sqliteTable('chat_turn_leases', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  expiresAt: integer('expires_at').notNull(),
})
