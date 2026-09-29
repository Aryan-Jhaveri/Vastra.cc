import { z } from 'zod'
import type { AgentCallIdentity, JsonValue } from '../ai/messages.js'
import { requireUserId } from '../db/queries.js'
import { hasShopRankContext, rankShopProductsWithJev } from '../ai/shopRank.js'
import { listLikedProductIds } from '../commerce/likes.js'
import { lookupGlobalCatalog, searchGlobalCatalog } from '../commerce/shopify/catalog.js'
import { isShopEnabled as shopEnabled } from '../commerce/shopify/enabled.js'
import { userCountry, userShopGender } from '../commerce/shopify/userPrefs.js'
import { takeShopCall } from './shopBudget.js'
import { isHostedMode } from '../hostedMode.js'
import { localTime } from '../time/zone.js'
import type { Collection, Item, Outfit, UserPhoto } from '../types/index.js'

// ─── Agent tool registry (issue #316) ──────────────────────────────────────────
//
// One definition for MCP and any future in-app chat. Each
// tool is a thin wrapper over `src/tools/*` and `src/ai/*` — it adds a zod
// input schema, a scope, a model-facing description, and a handler that always
// pulls `userId` from `AgentContext` (never from tool input).
//
// Invariants (issue #316 § Rules):
//   - `userId` comes ONLY from `ctx`. No tool accepts `userId` / `user_id` /
//     `email` in its input schema. Same rail as `src/ai/decisions.ts`.
//   - `ai`-scope handlers go through `runInstrumented` with `ctx.identity`,
//     so `ai_calls` gets run_id/turn_id/step_id/tool_call_id.
//   - Handler output is JSON with image URLs, never raw bytes. List results
//     are capped (e.g. 25 items). Rows are projected through an explicit
//     field allowlist (`itemView` / `outfitView`) — never return a raw DB row,
//     which carries `userId` to the model provider.
//   - Foreign ids return `not found`, never `forbidden` (no information leak).
//   - Tool results contain user-written text (notes, names) — treat as data
//     in every agent prompt.

export type AgentToolScope = 'read' | 'write' | 'ai'

export interface AgentContext {
  userId: string
  identity: AgentCallIdentity
  signal?: AbortSignal
  /** The user's IANA zone (chat sends the browser's). Validated; absent on MCP. */
  timeZone?: string
}

export interface AgentTool<I> {
  /** snake_case, stable: it's a public API once MCP ships. */
  name: string
  /** Written for a model, not a human. */
  description: string
  /** Zod input schema → JSON Schema via z.toJSONSchema() for ModelTool / MCP. */
  input: z.ZodType<I>
  /** 'ai' = spends model calls (billed in HOSTED_MODE). */
  scope: AgentToolScope
  handler(input: I, ctx: AgentContext): Promise<JsonValue>
  /**
   * Write tools: rejects a call that would fail or shouldn't be proposed
   * (foreign ids, a 9-item "outfit", a copy of a saved outfit) by throwing.
   * Runs before a Confirm card is shown (#337) and again at execution.
   */
  precheck?(input: I, ctx: AgentContext): Promise<void>
  /** Write tools: one line for the Confirm card, with names looked up. Never ids. */
  summarize?(input: I, ctx: AgentContext): Promise<string>
  /**
   * Non-write tools that still need the user's Confirm tap in chat, e.g. a
   * paid `ai` tool (try_on spends wallet tokens). Write tools always do.
   */
  requiresConfirmation?: boolean
  /** Declared only while this returns true (e.g. shop tools behind SHOP_ROW_ENABLED). Read per request. */
  available?(): boolean
  /**
   * What chat history stores instead of the full result. Shop results must not
   * be cached (Shopify catalog policy), so shop tools keep product ids only.
   * The live stream event and the current request still see the full result.
   */
  persistView?(result: JsonValue): JsonValue
  /** Rebuilds a displayable result from `persistView` output (thread reload), e.g. a live catalog lookup. */
  hydrateView?(persisted: JsonValue, ctx: AgentContext): Promise<JsonValue>
}

/** True when chat must stop for a Confirm card before running this tool. */
export function needsConfirmation(tool: AgentTool<unknown> | undefined): boolean {
  return !!tool && (tool.scope === 'write' || tool.requiresConfirmation === true)
}

/** A tool is declared (to a model or an MCP client) only while it's available. */
export function isToolAvailable(tool: AgentTool<unknown>): boolean {
  return tool.available?.() ?? true
}

// ─── JSON Schema conversion ────────────────────────────────────────────────────

/**
 * Convert a tool's zod schema to a JSON Schema object suitable for
 * `ModelTool.parameters` or an MCP `inputSchema`. Uses Zod v4's built-in
 * `z.toJSONSchema`. Strips the `$schema` draft annotation (MCP/ModelTool
 * expect a bare schema object).
 */
export function inputToJsonSchema(tool: AgentTool<unknown>): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input)
  const { $schema: _omit, ...rest } = schema as Record<string, unknown>
  return rest
}

/** Convert a tool to the `ModelTool` shape consumed by `src/ai/messages.ts`. */
export function toModelTool(tool: AgentTool<unknown>): {
  name: string
  description?: string
  parameters: Record<string, unknown>
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: inputToJsonSchema(tool),
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const MAX_LIST_RESULTS = 25

function notFound(what: string, id: string): never {
  throw new Error(`${what} ${id} not found`)
}

/** Cap a list at MAX_LIST_RESULTS and report truncation. */
function capList<T>(rows: T[]): { results: T[]; truncated: boolean; total: number } {
  return {
    results: rows.slice(0, MAX_LIST_RESULTS),
    truncated: rows.length > MAX_LIST_RESULTS,
    total: rows.length,
  }
}

function sameItems(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(id => set.has(id))
}

/**
 * Throws unless `itemIds` is a wearable outfit of the caller's own items that
 * isn't already saved. `selfId` excludes the outfit being edited.
 */
async function checkOutfitItems(itemIds: string[], ctx: AgentContext, selfId?: string): Promise<void> {
  if (new Set(itemIds).size !== itemIds.length) throw new Error('item_ids contains the same item twice.')
  const { getItem } = await import('../tools/items.js')
  const counts = new Map<string, number>()
  for (const id of itemIds) {
    const item = await getItem(id, ctx.userId)
    if (!item) notFound('Item', id)
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  }
  for (const [category, n] of counts) {
    const limit = SLOT_LIMITS[category]
    if (limit !== undefined && n > limit) {
      throw new Error(
        `An outfit has at most ${limit} ${category} item${limit === 1 ? '' : 's'} (got ${n}). ` +
        'Pick one item per slot: top, bottom or dress, optional outer layer, shoes, up to 2 accessories.',
      )
    }
  }
  const { listOutfits } = await import('../tools/outfits.js')
  for (const o of await listOutfits({}, ctx.userId)) {
    if (o.id === selfId) continue
    const ids = parseJsonColumn(o.itemIds)
    if (Array.isArray(ids) && sameItems(ids as string[], itemIds)) {
      throw new Error(
        `These are the same items as the saved outfit "${o.name}" (id ${o.id}). ` +
        'Refer the user to that outfit, or add it to a collection, instead of saving a copy.',
      )
    }
  }
}

async function ownedOutfit(id: string, ctx: AgentContext): Promise<Outfit> {
  const { getOutfit } = await import('../tools/outfits.js')
  const outfit = await getOutfit(id, ctx.userId)
  if (!outfit) notFound('Outfit', id)
  return outfit
}

async function ownedCollection(id: string, ctx: AgentContext): Promise<Collection> {
  const { getCollection } = await import('../tools/collections.js')
  const collection = await getCollection(id, ctx.userId)
  if (!collection) notFound('Collection', id)
  return collection
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Parse a JSON-text column; malformed or null values become `fallback`. */
function parseJsonColumn(value: string | null | undefined, fallback: JsonValue = []): JsonValue {
  if (value == null) return fallback
  try { return JSON.parse(value) as JsonValue } catch { return fallback }
}

/** Model-facing item projection. Explicit allowlist — no userId, no internal paths. */
function itemView(i: Item): { [key: string]: JsonValue } {
  return {
    id: i.id,
    imageUri: i.imageUri,
    category: i.category,
    subcategory: i.subcategory,
    primaryColor: i.primaryColor,
    colors: parseJsonColumn(i.colors),
    material: i.material,
    brand: i.brand,
    size: i.size,
    season: parseJsonColumn(i.season),
    occasion: parseJsonColumn(i.occasion),
    tags: parseJsonColumn(i.tags),
    aiDescription: i.aiDescription,
    timesWorn: i.timesWorn,
    lastWornAt: i.lastWornAt,
  }
}

/** Model-facing outfit projection. Explicit allowlist — no userId. */
function outfitView(o: Outfit): { [key: string]: JsonValue } {
  return {
    id: o.id,
    name: o.name,
    itemIds: parseJsonColumn(o.itemIds),
    occasion: o.occasion,
    season: parseJsonColumn(o.season),
    tags: parseJsonColumn(o.tags),
    notes: o.notes,
    coverImageUri: o.coverImageUri,
    aiGenerated: o.aiGenerated === 1,
    timesWorn: o.timesWorn,
    lastWornAt: o.lastWornAt,
  }
}

// ─── Input schemas ─────────────────────────────────────────────────────────────
//
// Deliberately do NOT include userId/user_id/email in any schema. The
// `assertNoIdentityFields` test scans every registered tool's JSON Schema to
// enforce this at build time.

const idStr = z.string().min(1).max(50)

// ─── Outfit composition (#337) ─────────────────────────────────────────────────
//
// An outfit is something one person wears at once: one item per slot. Checked
// before a Confirm card is shown, so the model gets the error and can fix the
// proposal instead of the user confirming a 9-item "outfit". A second top
// is allowed for layering (tee under an open shirt). Other categories
// (activewear, underwear) are only bounded by the total.

export const MAX_OUTFIT_ITEMS = 6
const SLOT_LIMITS: Record<string, number> = {
  tops: 2, bottoms: 1, dresses: 1, outerwear: 1, shoes: 1, accessories: 2,
}

const SearchClosetInput = z.object({
  query: z.string().trim().max(200).optional().describe(
    'Free-text search across category, subcategory, brand, colors, tags and AI description. ' +
    'Every word must match; spaces/hyphens are ignored ("trenchcoat" = "trench coat"). ' +
    'When set, only `size` still applies (other filters are ignored). If it returns nothing, retry once with fewer words ' +
    'or with only `category` before telling the user nothing matched.',
  ),
  category: z.string().max(50).optional().describe(
    'Filter by category: tops, bottoms, dresses, outerwear, shoes, accessories, activewear, underwear.',
  ),
  color: z.string().max(50).optional().describe('Filter by color (partial match, e.g. "blue").'),
  season: z.string().max(50).optional().describe('Filter by season: spring, summer, fall, winter.'),
  occasion: z.string().max(50).optional().describe('Filter by occasion: casual, work, formal, outdoor, date.'),
  brand: z.string().max(100).optional().describe('Filter by exact brand name.'),
  size: z.string().trim().min(1).max(30).optional().describe(
    'Filter by the item\'s own size (case- and space-insensitive, e.g. "M", "32x30", "US 10"). ' +
    'Items with no size never match.',
  ),
})
type SearchClosetInput = z.infer<typeof SearchClosetInput>

const GetItemInput = z.object({
  id: idStr.describe('The item ID.'),
})
type GetItemInput = z.infer<typeof GetItemInput>

const ListOutfitsInput = z.object({
  occasion: z.string().max(50).optional().describe('Filter by occasion.'),
  season: z.string().max(50).optional().describe('Filter by season.'),
})
type ListOutfitsInput = z.infer<typeof ListOutfitsInput>

const GetOutfitInput = z.object({
  id: idStr.describe('The outfit ID.'),
})
type GetOutfitInput = z.infer<typeof GetOutfitInput>

const ListCollectionsInput = z.object({}).describe('List the user’s collections (no filters).')
type ListCollectionsInput = z.infer<typeof ListCollectionsInput>

// ─── Location input (#333) ─────────────────────────────────────────────────────
//
// `get_weather` and `suggest_outfit` accept an optional location: either a
// place name (`location`, geocoded with the same Open-Meteo geocoder the
// Settings location picker uses) OR explicit `lat`+`lon`. The two forms are
// mutually exclusive — a mix is rejected at the schema level, and partial
// coords (one of lat/lon) are rejected too. Omitting all three falls back to
// the user's saved `serverLocation`.
//
// Resolution order: explicit input → saved `serverLocation` → error that
// mentions both options. An input location is NEVER persisted (no settings
// write, no job-param snapshot — issue #333). Coordinates go out, never
// `userId`.

const LocationFields = z.object({
  location: z.string().trim().max(100).optional().describe(
    'Place name to geocode (e.g. "Toronto", "Paris, France"). Max 100 chars. ' +
    'Mutually exclusive with lat/lon. Omit (along with lat/lon) to use the saved location.',
  ),
  lat: z.number().min(-90).max(90).optional().describe(
    'Latitude in decimal degrees (-90..90). Must be paired with lon. Mutually exclusive with location.',
  ),
  lon: z.number().min(-180).max(180).optional().describe(
    'Longitude in decimal degrees (-180..180). Must be paired with lat. Mutually exclusive with location.',
  ),
})

/** Refine: allow exactly one of {name} | {lat+lon} | {none}. Reject a mix and partial coords. */
function locationRefine(d: { location?: string; lat?: number; lon?: number }): boolean {
  const hasName = !!d.location && d.location.length > 0
  const hasLat = d.lat != null
  const hasLon = d.lon != null
  if (hasLat !== hasLon) return false // partial coords
  if (hasName && hasLat) return false // mix of both forms
  return true
}

const LOCATION_REFINE_MSG =
  'Provide either `location` (place name) or both `lat` and `lon` — not a mix, not partial coordinates.'

const NO_LOCATION_MSG =
  'No location provided. Pass `location` (place name) or `lat`+`lon` to the tool, ' +
  'or save a location in Settings → Location.'

interface ResolvedLocation {
  name: string
  lat: number
  lon: number
}

/**
 * Resolve a location for `get_weather` / `suggest_outfit`. Explicit input wins
 * over the saved `serverLocation`; both missing throws an error mentioning
 * both options. Never persists the input (#333). The geocoder receives the
 * place name only — `userId` is never sent to Open-Meteo.
 */
async function resolveLocation(
  input: { location?: string; lat?: number; lon?: number },
  ctx: AgentContext,
): Promise<ResolvedLocation> {
  if (input.location && input.location.length > 0) {
    const { geocodeCity } = await import('../tools/weather.js')
    const geo = await geocodeCity(input.location)
    return { name: geo.name, lat: geo.lat, lon: geo.lon }
  }
  if (input.lat !== undefined && input.lon !== undefined) {
    return {
      name: `${input.lat.toFixed(2)}, ${input.lon.toFixed(2)}`,
      lat: input.lat,
      lon: input.lon,
    }
  }
  const { getSettings } = await import('../settings.js')
  const settings = getSettings(ctx.userId)
  const loc = settings.serverLocation
  if (loc && loc.enabled) {
    return { name: loc.name, lat: loc.lat, lon: loc.lon }
  }
  throw new Error(NO_LOCATION_MSG)
}

const GetWeatherInput = LocationFields.extend({}).describe(
  'Current weather at a location. Pass `location` (place name) or `lat`+`lon` ' +
  'to override the saved location; omit all three to use the saved location ' +
  'from the user\'s settings. Coords are rounded to ~0.5° before the upstream call.',
).refine(locationRefine, { message: LOCATION_REFINE_MSG })
type GetWeatherInput = z.infer<typeof GetWeatherInput>

const SuggestOutfitInput = LocationFields.extend({
  occasion: z.string().trim().max(200).optional().describe(
    'Optional context, e.g. "job interview", "date night", "hiking".',
  ),
}).describe(
  'AI outfit suggestions based on weather and the user\'s wardrobe. Pass `location` ' +
  '(place name) or `lat`+`lon` to override the saved location; omit to use the saved ' +
  'location. Optional occasion/theme guides the suggestion.',
).refine(locationRefine, { message: LOCATION_REFINE_MSG })
type SuggestOutfitInput = z.infer<typeof SuggestOutfitInput>

const CreateOutfitInput = z.object({
  name: z.string().trim().min(1).max(100).describe('A short name for the outfit.'),
  item_ids: z.array(idStr).min(1).max(MAX_OUTFIT_ITEMS).describe(
    'IDs of the items: one per slot (top, bottom or dress, optional outer layer, shoes, up to 2 accessories).',
  ),
  occasion: z.string().trim().max(50).optional().describe('casual, work, formal, outdoor, date.'),
  season: z.array(z.string().trim().max(50)).max(20).optional().describe('Seasons the outfit suits.'),
  notes: z.string().trim().max(500).optional().describe('Free-text notes about the outfit.'),
})
type CreateOutfitInput = z.infer<typeof CreateOutfitInput>

const UpdateOutfitInput = z.object({
  id: idStr.describe('The saved outfit to change.'),
  name: z.string().trim().min(1).max(100).optional().describe('New name.'),
  item_ids: z.array(idStr).min(1).max(MAX_OUTFIT_ITEMS).optional().describe(
    'The complete new list of item IDs (replaces the current items). To swap one piece, send the current ' +
    'ids with that one replaced.',
  ),
  occasion: z.string().trim().max(50).optional().describe('casual, work, formal, outdoor, date.'),
  season: z.array(z.string().trim().max(50)).max(20).optional().describe('Seasons the outfit suits.'),
  notes: z.string().trim().max(500).optional().describe('Free-text notes (replaces the current notes).'),
}).refine(d => Object.keys(d).some(k => k !== 'id' && d[k as keyof typeof d] !== undefined), {
  message: 'Change at least one field.',
})
type UpdateOutfitInput = z.infer<typeof UpdateOutfitInput>

const GetCollectionInput = z.object({
  id: idStr.describe('The collection ID.'),
})
type GetCollectionInput = z.infer<typeof GetCollectionInput>

const CreateCollectionInput = z.object({
  name: z.string().trim().min(1).max(100).describe('A short name, e.g. "Toronto trip".'),
  description: z.string().trim().max(500).optional().describe('Optional one-line description.'),
  outfit_ids: z.array(idStr).max(50).optional().describe('Saved outfits to put in the new collection.'),
})
type CreateCollectionInput = z.infer<typeof CreateCollectionInput>

const CollectionOutfitsInput = z.object({
  collection_id: idStr.describe('The collection ID.'),
  outfit_ids: z.array(idStr).min(1).max(50).describe('Saved outfit IDs.'),
})
type CollectionOutfitsInput = z.infer<typeof CollectionOutfitsInput>

const UpdateCollectionInput = z.object({
  id: idStr.describe('The collection ID.'),
  name: z.string().trim().min(1).max(100).optional().describe('New name.'),
  description: z.string().trim().max(500).optional().describe('New description; an empty string clears it.'),
}).refine(d => d.name !== undefined || d.description !== undefined, { message: 'Change the name or the description.' })
type UpdateCollectionInput = z.infer<typeof UpdateCollectionInput>

// Open-Meteo serves 16 days ahead; a trip plan rarely needs more than a week.
const MAX_FORECAST_DAYS = 7
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date.')

const GetForecastInput = LocationFields.extend({
  start_date: isoDate.optional().describe('First day (YYYY-MM-DD, within the next 16 days). Defaults to today.'),
  days: z.number().int().min(1).max(MAX_FORECAST_DAYS).optional().describe(
    `Number of days, 1–${MAX_FORECAST_DAYS}. Defaults to 3.`,
  ),
}).describe(
  'Daily forecast (high/low, conditions, rain chance) for up to 7 days. Same location rules as get_weather.',
).refine(locationRefine, { message: LOCATION_REFINE_MSG })
type GetForecastInput = z.infer<typeof GetForecastInput>

// ─── Shop (#341) ───────────────────────────────────────────────────────────────
//
// Live Shopify Global Catalog search, same country / "Shop for" filters as the
// Related shop row. Nothing personal goes out: the model writes garment words,
// and item/outfit ids for ranking are resolved server-side and scored by Jev
// (master key, ZDR), never sent to Shopify. No like / buy tools — the ♡ on each
// card is the user's own tap on the existing likes route.

const SHOP_RESULTS = 10
const SHOP_RANK_POOL = 24
const MAX_LIKED_LOOKUP = 50

const MAX_SHOP_PRICE = 1_000_000
const shopPrice = z.number().positive().max(MAX_SHOP_PRICE)

const SearchShopInput = z.object({
  query: z.string().trim().min(1).max(200).describe(
    'Garment words only, e.g. "red linen shirt" or "white leather sneakers". Never names, sizes, prices, ' +
    'places or anything else about the user — those go in their own fields.',
  ),
  intent: z.string().trim().max(200).optional().describe('Optional short purpose, e.g. "for a summer wedding".'),
  item_ids: z.array(idStr).max(8).optional().describe(
    'Closet item ids the products should go with. Used to rank results; never sent to the shop.',
  ),
  outfit_ids: z.array(idStr).max(4).optional().describe(
    'Saved outfit ids the products should go with. Used to rank results; never sent to the shop.',
  ),
  min_price: shopPrice.optional().describe('Lowest price, in whole currency units (e.g. 50 = $50). Needs `currency`.'),
  max_price: shopPrice.optional().describe(
    'Highest price / budget cap, in whole currency units (e.g. 120 = $120). Needs `currency`.',
  ),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code, e.g. CAD')
    .optional().describe(
      'ISO 4217 currency of min_price / max_price and of the returned prices, e.g. "CAD", "USD", "INR". ' +
      'Required with a price; use the currency the user named, else the one for their country.',
    ),
  budget: z.array(z.enum(['low', 'medium', 'high'])).min(1).max(2).optional().describe(
    'Price tier relative to similar products, for a loose budget with no number ("something cheap" → ["low"], ' +
    '"mid-range" → ["medium"], "not too pricey" → ["low","medium"]). Prefer max_price when the user gives an amount.',
  ),
  sizes: z.array(z.string().trim().min(1).max(20)).min(1).max(4).optional().describe(
    'Only products offered in one of these sizes, as shops label them ("M", "32", "10.5"). Only when the user ' +
    'asks for a size or "my size" — then take it from their own items (search_closet / get_item) or get_my_sizes. ' +
    'Never guess one.',
  ),
  location: z.string().trim().min(1).max(100).optional().describe(
    'A place the user wants it shipped to ("Mumbai", "London") — only its country is sent to the shop. ' +
    'Mutually exclusive with `country`. Omit both to use the saved location.',
  ),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2 code, e.g. CA')
    .optional().describe('ISO 3166-1 alpha-2 country to ship to, e.g. "IN". Mutually exclusive with `location`.'),
})
  .refine(d => !(d.location && d.country), { message: 'Pass `location` or `country`, not both.' })
  .refine(d => (d.min_price === undefined && d.max_price === undefined) || d.currency !== undefined, {
    message: 'A price needs `currency` (ISO 4217, e.g. "CAD").',
  })
  .refine(d => d.min_price === undefined || d.max_price === undefined || d.min_price <= d.max_price, {
    message: 'min_price must not be above max_price.',
  })
type SearchShopInput = z.infer<typeof SearchShopInput>

/** Whole units → ISO 4217 minor units (JPY has 0 decimals, KWD 3, most 2). */
export function toMinorUnits(amount: number, currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  return Math.round(amount * 10 ** digits)
}

/**
 * The ship-to country for a shop search: explicit country → a place name's
 * country (geocoded; only the country goes on) → the saved location's country.
 * Never persisted; coordinates never reach the shop.
 */
async function resolveShopCountry(
  input: { location?: string; country?: string },
  ctx: AgentContext,
): Promise<string | undefined> {
  if (input.country) return input.country.toUpperCase()
  if (input.location) {
    const { geocodeCity } = await import('../tools/weather.js')
    const geo = await geocodeCity(input.location)
    if (!geo.countryCode) throw new Error(`Couldn't tell which country "${input.location}" is in. Pass \`country\` instead.`)
    return geo.countryCode
  }
  return userCountry(ctx.userId)
}

const ListLikedProductsInput = z.object({}).describe('The shop products the user has liked (♡), newest first.')
type ListLikedProductsInput = z.infer<typeof ListLikedProductsInput>

// ─── Sizes (#329) ──────────────────────────────────────────────────────────────
//
// `get_my_sizes` returns the user's own per-category sizes only while the
// Settings › Sizes "Use my sizes in Ask" toggle (`sizesAgentContext`) is on.
// Agents never write sizes: they read item sizes (search_closet / get_item)
// as the primary reference and point the user to Settings › Sizes or the
// item's details to change one. Sizes go nowhere except back to the agent.

export const SIZES_EDIT_PATH = '/settings/sizes'

const GetMySizesInput = z.object({}).describe('The user’s own clothing sizes (no input).')
type GetMySizesInput = z.infer<typeof GetMySizesInput>

// ─── Find related / Discover / Try on ─────────────────────────────────────────
//
// Agents never add items or upload media: try-on uses the user's own photos
// (list_my_photos) and closet items. find_related is the detail-card "Find
// related" (#332, Jev, free, same daily cap). discover_closet is Discover's
// embedding retrieval only — no LLM ranking or generation. try_on is paid and
// always waits for the user's Confirm tap in chat (requiresConfirmation).

export const TRYON_PATH = '/tryon'
export const MAX_TRYON_ITEMS = 8
const DISCOVER_ITEM_RESULTS = 12
const DISCOVER_OUTFIT_RESULTS = 6

const FindRelatedInput = z.object({
  kind: z.enum(['item', 'outfit', 'collection']).describe(
    '"item": other closet items that pair with this item. "outfit": saved outfits close to this outfit. ' +
    '"collection": saved outfits that belong in this collection.',
  ),
  id: idStr.describe('The item, outfit or collection ID.'),
})
type FindRelatedInput = z.infer<typeof FindRelatedInput>

const DiscoverClosetInput = z.object({
  query: z.string().trim().min(1).max(300).describe(
    'What the user is looking for, in their words, e.g. "all yellow", "cosy rainy day", "linen for a beach wedding".',
  ),
})
type DiscoverClosetInput = z.infer<typeof DiscoverClosetInput>

const ListMyPhotosInput = z.object({}).describe('The user’s own photos for try-on (no input).')
type ListMyPhotosInput = z.infer<typeof ListMyPhotosInput>

const TryOnInput = z.object({
  photo_id: idStr.optional().describe('A photo id from list_my_photos. Omit to use the user\'s primary photo.'),
  item_ids: z.array(idStr).min(1).max(MAX_TRYON_ITEMS).optional().describe(
    'Closet item ids to try on together. Pass this or outfit_id, not both.',
  ),
  outfit_id: idStr.optional().describe('A saved outfit to try on. Pass this or item_ids, not both.'),
  instruction: z.string().trim().max(300).optional().describe(
    'Optional styling note for the image, e.g. "tuck the shirt in".',
  ),
}).refine(d => Number(!!d.item_ids?.length) + Number(!!d.outfit_id) === 1, {
  message: 'Pass either item_ids or outfit_id (exactly one).',
})
type TryOnInput = z.infer<typeof TryOnInput>

// ─── Tool handlers ─────────────────────────────────────────────────────────────

/** search_closet row. `size` is the item's own size field (#329). */
function closetRow(i: {
  id: string; imageUri: string; category: string; subcategory: string | null
  primaryColor: string | null; brand: string | null; size: string | null
}): { [key: string]: JsonValue } {
  return {
    id: i.id,
    imageUri: i.imageUri,
    category: i.category,
    subcategory: i.subcategory,
    primaryColor: i.primaryColor,
    brand: i.brand,
    size: i.size,
  }
}

/** "32 × 30" and "32x30" and " m " compare equal; null never matches. */
function normalizeSize(v: string | null): string | null {
  if (!v) return null
  const n = v.toLowerCase().replace(/×/g, 'x').replace(/\s+/g, '')
  return n.length > 0 ? n : null
}

async function searchClosetHandler(input: SearchClosetInput, ctx: AgentContext): Promise<JsonValue> {
  const { listItems, listItemCards, searchItems } = await import('../tools/items.js')
  const wanted = input.size ? normalizeSize(input.size) : null
  const bySize = <T extends { size: string | null }>(rows: T[]): T[] =>
    wanted ? rows.filter(r => normalizeSize(r.size) === wanted) : rows
  if (input.query) {
    const rows = await searchItems(input.query, ctx.userId)
    return capList(bySize(rows).map(closetRow))
  }
  if (input.brand) {
    const rows = await listItems({
      category: input.category,
      color: input.color,
      season: input.season,
      occasion: input.occasion,
      brand: input.brand,
    }, ctx.userId)
    return capList(bySize(rows).map(closetRow))
  }
  // No DB-level limit: capList handles capping + truncation detection.
  // Personal closets are small enough that fetching all rows is fine.
  // listItemCards is the fast path (fewer columns); it carries brand + size.
  const cards = await listItemCards({
    category: input.category,
    color: input.color,
    season: input.season,
    occasion: input.occasion,
  }, ctx.userId)
  return capList(bySize(cards).map(closetRow))
}

async function getItemHandler(input: GetItemInput, ctx: AgentContext): Promise<JsonValue> {
  const { getItem } = await import('../tools/items.js')
  const item = await getItem(input.id, ctx.userId)
  if (!item) notFound('Item', input.id)
  return itemView(item)
}

async function listOutfitsHandler(input: ListOutfitsInput, ctx: AgentContext): Promise<JsonValue> {
  const { listOutfits } = await import('../tools/outfits.js')
  const rows = await listOutfits({ occasion: input.occasion, season: input.season }, ctx.userId)
  return capList(rows.map(o => ({
    id: o.id,
    name: o.name,
    occasion: o.occasion,
    coverImageUri: o.coverImageUri,
  })))
}

async function getOutfitHandler(input: GetOutfitInput, ctx: AgentContext): Promise<JsonValue> {
  const { getOutfitWithItems } = await import('../tools/outfits.js')
  const result = await getOutfitWithItems(input.id, ctx.userId)
  if (!result) notFound('Outfit', input.id)
  return { ...outfitView(result), items: result.items.map(itemView) }
}

async function listCollectionsHandler(_input: ListCollectionsInput, ctx: AgentContext): Promise<JsonValue> {
  const { listCollections } = await import('../tools/collections.js')
  const rows = await listCollections(ctx.userId)
  return capList(rows.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
  })))
}

async function getWeatherHandler(input: GetWeatherInput, ctx: AgentContext): Promise<JsonValue> {
  const { getCurrentWeather } = await import('../tools/weather.js')
  const loc = await resolveLocation(input, ctx)
  const weather = await getCurrentWeather(loc.lat, loc.lon)
  return {
    location: { name: loc.name, lat: loc.lat, lon: loc.lon },
    weather: weather as unknown as JsonValue,
  }
}

async function suggestOutfitHandler(input: SuggestOutfitInput, ctx: AgentContext): Promise<JsonValue> {
  const { listItems } = await import('../tools/items.js')
  const { getCurrentWeather } = await import('../tools/weather.js')
  const { suggestOutfits } = await import('../ai/suggest.js')

  const loc = await resolveLocation(input, ctx)
  const weather = await getCurrentWeather(loc.lat, loc.lon)
  const allItems = await listItems({}, ctx.userId)
  if (allItems.length < 2) {
    return {
      location: { name: loc.name, lat: loc.lat, lon: loc.lon },
      suggestions: [],
      reason: 'Closet has fewer than 2 items.',
    }
  }

  // Local wall-clock at the user: the browser's zone in chat, else the
  // location's zone from the weather lookup, else UTC (the server's clock).
  const local = localTime(new Date(), ctx.timeZone ?? weather.timezone)
  // suggest_outfit is an 'ai'-scope tool. suggestOutfits calls runInstrumented
  // / runInstrumentedDecisions internally; ctx.identity is passed through so
  // ai_calls records run_id/turn_id/step_id/tool_call_id (issue #316 § Rules).
  const suggestions = await suggestOutfits(
    weather,
    allItems,
    ctx.userId,
    undefined,
    input.occasion,
    local.hour,
    local.weekday,
    undefined,
    ctx.identity,
  )

  const byId = new Map(allItems.map(i => [i.id, i]))
  return {
    location: { name: loc.name, lat: loc.lat, lon: loc.lon },
    suggestions: suggestions.map(s => suggestionView(s, byId)),
  }
}

/**
 * Model-facing suggestion. Hydrates `item_ids` into item views, so the model
 * can describe the pieces (instead of reciting ids) and the Ask tab can render
 * them. Jev-ranked saved outfits carry an internal score string in
 * `reasoning` ("Jev-Noul score 0.79 for …") — that's telemetry, not a reason,
 * so it's dropped and the suggestion is flagged as a saved outfit instead.
 */
export function suggestionView(
  s: { item_ids: string[]; name: string; occasion?: string | null; reasoning?: string | null },
  byId: Map<string, Item>,
): { [key: string]: JsonValue } {
  const jev = /^Jev-Noul score\b/.test(s.reasoning ?? '')
  return {
    name: s.name,
    occasion: s.occasion ?? null,
    reasoning: jev ? null : s.reasoning ?? null,
    savedOutfit: jev,
    item_ids: s.item_ids,
    items: s.item_ids.flatMap(id => {
      const item = byId.get(id)
      return item ? [itemView(item)] : []
    }),
  }
}

async function createOutfitHandler(input: CreateOutfitInput, ctx: AgentContext): Promise<JsonValue> {
  const { createOutfit } = await import('../tools/outfits.js')
  const outfit = await createOutfit({
    name: input.name,
    itemIds: input.item_ids,
    occasion: input.occasion,
    season: input.season,
    notes: input.notes,
  }, ctx.userId)
  return outfitView(outfit)
}

async function updateOutfitHandler(input: UpdateOutfitInput, ctx: AgentContext): Promise<JsonValue> {
  const { updateOutfit, getOutfitWithItems } = await import('../tools/outfits.js')
  await updateOutfit(input.id, {
    name: input.name,
    itemIds: input.item_ids,
    occasion: input.occasion,
    season: input.season,
    notes: input.notes,
  }, ctx.userId)
  const result = await getOutfitWithItems(input.id, ctx.userId)
  if (!result) notFound('Outfit', input.id)
  return { ...outfitView(result), items: result.items.map(itemView) }
}

/**
 * A collection with its outfits. Outfit items use the lean search_closet row,
 * not the full itemView: 25 outfits × 6 full items would crowd out the rest
 * of the conversation.
 */
async function collectionDetail(id: string, ctx: AgentContext): Promise<JsonValue> {
  const { getOutfitIdsInCollection } = await import('../tools/collections.js')
  const { getOutfitWithItems } = await import('../tools/outfits.js')
  const collection = await ownedCollection(id, ctx)
  const ids = await getOutfitIdsInCollection(id, ctx.userId)
  const outfits: JsonValue[] = []
  for (const outfitId of ids.slice(0, MAX_LIST_RESULTS)) {
    const o = await getOutfitWithItems(outfitId, ctx.userId)
    if (o) outfits.push({ ...outfitView(o), items: o.items.map(closetRow) })
  }
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    coverImageUri: collection.coverImageUri,
    season: parseJsonColumn(collection.season),
    tags: parseJsonColumn(collection.tags),
    outfits,
    truncated: ids.length > MAX_LIST_RESULTS,
    total: ids.length,
  }
}

async function getCollectionHandler(input: GetCollectionInput, ctx: AgentContext): Promise<JsonValue> {
  return collectionDetail(input.id, ctx)
}

async function createCollectionHandler(input: CreateCollectionInput, ctx: AgentContext): Promise<JsonValue> {
  const { createCollection, addOutfitsToCollection, deleteCollection } = await import('../tools/collections.js')
  const collection = await createCollection({ name: input.name, description: input.description }, ctx.userId)
  if (input.outfit_ids?.length) {
    try {
      await addOutfitsToCollection(collection.id, input.outfit_ids, ctx.userId)
    } catch (err) {
      // Don't leave an empty collection behind for a request that failed.
      await deleteCollection(collection.id, ctx.userId)
      throw err
    }
  }
  return collectionDetail(collection.id, ctx)
}

async function addOutfitsHandler(input: CollectionOutfitsInput, ctx: AgentContext): Promise<JsonValue> {
  const { addOutfitsToCollection } = await import('../tools/collections.js')
  await addOutfitsToCollection(input.collection_id, input.outfit_ids, ctx.userId)
  return collectionDetail(input.collection_id, ctx)
}

async function removeOutfitsHandler(input: CollectionOutfitsInput, ctx: AgentContext): Promise<JsonValue> {
  const { removeOutfitFromCollection } = await import('../tools/collections.js')
  for (const outfitId of input.outfit_ids) {
    await removeOutfitFromCollection(input.collection_id, outfitId, ctx.userId)
  }
  return collectionDetail(input.collection_id, ctx)
}

async function updateCollectionHandler(input: UpdateCollectionInput, ctx: AgentContext): Promise<JsonValue> {
  const { updateCollection } = await import('../tools/collections.js')
  await updateCollection(input.id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description || null } : {}),
  }, ctx.userId)
  return collectionDetail(input.id, ctx)
}

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function getForecastHandler(input: GetForecastInput, ctx: AgentContext): Promise<JsonValue> {
  const { getForecast } = await import('../tools/weather.js')
  const loc = await resolveLocation(input, ctx)
  const start = input.start_date ?? localTime(new Date(), ctx.timeZone).date
  const days = await getForecast(loc.lat, loc.lon, start, addDays(start, (input.days ?? 3) - 1))
  return {
    location: { name: loc.name, lat: loc.lat, lon: loc.lon },
    days: days as unknown as JsonValue,
  }
}

// ─── Find related / Discover / Try on handlers ─────────────────────────────────


async function findRelatedHandler(input: FindRelatedInput, ctx: AgentContext): Promise<JsonValue> {
  const { runRelatedFind, relatedPlan, keywordRelatedHits, RelatedNotFoundError } = await import('../ai/related.js')
  const { getItem, getOutfitWithItems } = await import('../db/queries.js')
  const label = input.kind === 'item' ? 'Item' : input.kind === 'outfit' ? 'Outfit' : 'Collection'
  let outcome
  try {
    // A saved result is reused while nothing it depends on changed: free,
    // and it doesn't use up the daily Find related cap.
    outcome = await runRelatedFind(input.kind, input.id, ctx.userId, {
      reuseFresh: true,
      identity: { turnId: ctx.identity.turnId, stepId: ctx.identity.stepId, toolCallId: ctx.identity.toolCallId },
    })
    // No decision provider (self-host without Jev): fall back to plain
    // search-string matching over the same user-scoped candidates.
    if (outcome.status === 'unavailable') {
      const hits = keywordRelatedHits(relatedPlan(input.kind, input.id, ctx.userId))
      outcome = { status: hits.length ? 'success' as const : 'empty' as const, hits, foundAt: Date.now(), method: 'keyword' as const }
    }
  } catch (err) {
    if (err instanceof RelatedNotFoundError) notFound(label, input.id)
    throw err
  }
  switch (outcome.status) {
    case 'busy': throw new Error('Another Find related is still running. Try again in a moment.')
    case 'capped':
      return { kind: input.kind, status: 'capped', message: 'Daily Find related limit reached.', resetsAt: outcome.quota.resetsAt }
    case 'error': throw new Error('Find related failed. Try again later.')
  }
  const scores = new Map(outcome.hits.map(h => [h.id, h.score]))
  const base = {
    kind: input.kind, status: outcome.status,
    ...('reused' in outcome && outcome.reused ? { reused: true } : {}),
    ...('method' in outcome ? { method: outcome.method } : {}),
  }
  if (input.kind === 'item') {
    const items = outcome.hits.map(h => getItem(h.id, ctx.userId)).filter((i): i is Item => i != null)
    return { ...base, items: items.map(i => ({ ...itemView(i), score: scores.get(i.id) ?? null })) }
  }
  const outfits = outcome.hits.map(h => getOutfitWithItems(h.id, ctx.userId)).filter(o => o != null)
  return { ...base, outfits: outfits.map(o => ({ ...outfitView(o), items: o.items.map(closetRow), score: scores.get(o.id) ?? null })) }
}

async function discoverClosetHandler(input: DiscoverClosetInput, ctx: AgentContext): Promise<JsonValue> {
  const { listItems, searchItems } = await import('../tools/items.js')
  const { listOutfits } = await import('../tools/outfits.js')
  const { getAllEmbeddings } = await import('../storage/embeddings.js')
  const { textItemShortlist, embeddingOutfitIds, itemSeededOutfitIds, fuseOutfitSignals, OUTFIT_POOL_K } =
    await import('../ai/discoverRetrieval.js')

  const items = await listItems({}, ctx.userId)
  if (!items.length) return { query: input.query, items: [], outfits: [], itemSource: 'none', outfitSource: 'none' }
  const byId = new Map(items.map(i => [i.id, i]))

  // Items: Discover's text-embedding pre-filter; keyword search when the
  // closet has no item vectors yet (or the embedding call fails).
  let matched: Item[] = []
  let itemSource: 'embedding' | 'keyword' | 'none' = 'none'
  if (getAllEmbeddings(ctx.userId, 'item', 'main').size > 0) {
    try {
      const ids = await textItemShortlist(input.query, ctx.userId, DISCOVER_ITEM_RESULTS)
      matched = ids.flatMap(id => byId.get(id) ?? [])
      if (matched.length) itemSource = 'embedding'
    } catch (err) {
      console.warn('[agent/discover_closet] embedding retrieval failed, using keyword search:', (err as Error).message ?? String(err))
    }
  }
  if (!matched.length) {
    matched = (await searchItems(input.query, ctx.userId)).slice(0, DISCOVER_ITEM_RESULTS)
    if (matched.length) itemSource = 'keyword'
  }

  // Outfits: Discover's non-Jev related-outfit signals (embedding match +
  // outfits built from the matched items, fused with RRF, recency-padded).
  const saved = await listOutfits({}, ctx.userId)
  let signal1: string[] = []
  try {
    signal1 = await embeddingOutfitIds(input.query, ctx.userId, [], OUTFIT_POOL_K)
  } catch { /* item-seeded signal alone */ }
  const none = new Set<string>()
  const signal2 = itemSeededOutfitIds(saved, matched.map(i => i.id), none, OUTFIT_POOL_K)
  const outfitIds = fuseOutfitSignals(signal1, signal2, saved, none, OUTFIT_POOL_K).slice(0, DISCOVER_OUTFIT_RESULTS)
  const outfitById = new Map(saved.map(o => [o.id, o]))
  const outfits = outfitIds.flatMap(id => {
    const o = outfitById.get(id)
    if (!o) return []
    const ids = parseJsonColumn(o.itemIds)
    const members = (Array.isArray(ids) ? ids : []).flatMap(x => (typeof x === 'string' && byId.get(x)) || [])
    return [{ ...outfitView(o), items: members.map(closetRow) }]
  })
  const outfitSource = signal1.length && signal2.length ? 'fused' : signal1.length ? 'embedding' : signal2.length ? 'item-seeded' : 'none'

  return {
    query: input.query,
    items: matched.map(itemView),
    outfits,
    itemSource,
    outfitSource,
    note: itemSource === 'embedding'
      ? 'Items are the closest matches by similarity, best first; not every one may fit — use their details.'
      : null,
  }
}

const NO_PHOTOS_MSG =
  'You have no photos for try-on yet. Add one in the app: Try On → add a photo of yourself. ' +
  'The assistant cannot upload photos.'

function photoView(p: UserPhoto): { [key: string]: JsonValue } {
  return { id: p.id, imageUri: p.imageUri, label: p.label, isPrimary: p.isPrimary === 1, createdAt: p.createdAt }
}

async function listMyPhotosHandler(_input: ListMyPhotosInput, ctx: AgentContext): Promise<JsonValue> {
  const { getUserPhotos } = await import('../db/queries.js')
  const photos = getUserPhotos(ctx.userId)
  if (!photos.length) return { photos: [], message: NO_PHOTOS_MSG, addAt: TRYON_PATH }
  return { photos: photos.slice(0, MAX_LIST_RESULTS).map(photoView), total: photos.length, addAt: TRYON_PATH }
}

interface ResolvedTryOn { photo: UserPhoto; itemIds: string[]; outfit: Outfit | null }

/** Loads the photo, items or outfit by (id, userId). Foreign ids → not found. */
async function resolveTryOn(input: TryOnInput, ctx: AgentContext): Promise<ResolvedTryOn> {
  const { getUserPhotos } = await import('../db/queries.js')
  const { getItem } = await import('../tools/items.js')
  const photos = getUserPhotos(ctx.userId)
  if (!photos.length) throw new Error(NO_PHOTOS_MSG)
  const photo = input.photo_id
    ? photos.find(p => p.id === input.photo_id)
    : photos.find(p => p.isPrimary === 1) ?? photos[0]
  if (!photo) notFound('Photo', input.photo_id!)

  if (input.outfit_id) {
    const outfit = await ownedOutfit(input.outfit_id, ctx)
    const ids = parseJsonColumn(outfit.itemIds)
    const itemIds: string[] = []
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === 'string' && await getItem(id, ctx.userId)) itemIds.push(id)
    }
    if (!itemIds.length) throw new Error(`Outfit "${outfit.name}" has no items left to try on.`)
    return { photo, itemIds: itemIds.slice(0, MAX_TRYON_ITEMS), outfit }
  }
  const itemIds = input.item_ids ?? []
  if (new Set(itemIds).size !== itemIds.length) throw new Error('item_ids contains the same item twice.')
  for (const id of itemIds) {
    if (!await getItem(id, ctx.userId)) notFound('Item', id)
  }
  return { photo, itemIds, outfit: null }
}

async function tryOnCostNow(): Promise<number> {
  const { tryOnCost } = await import('../tools/tryon.js')
  // Self-host never debits (no-op billing); hosted debits the wallet.
  return isHostedMode() ? tryOnCost() : 0
}

async function checkTryOn(input: TryOnInput, ctx: AgentContext): Promise<void> {
  await resolveTryOn(input, ctx)
  const cost = await tryOnCostNow()
  if (cost > 0) {
    const { getBilling } = await import('../hostedHooks.js')
    const balance = getBilling().balance(ctx.userId)
    if (balance < cost) {
      throw new Error(`Not enough tokens for a try-on: it costs ${cost}, the balance is ${balance}. Top up in Settings.`)
    }
  }
}

async function summarizeTryOn(input: TryOnInput, ctx: AgentContext): Promise<string> {
  const { photo, itemIds, outfit } = await resolveTryOn(input, ctx)
  const what = outfit ? `“${outfit.name}”` : plural(itemIds.length, 'item')
  const on = photo.label ? `your photo “${photo.label}”` : photo.isPrimary === 1 ? 'your primary photo' : 'your photo'
  const cost = await tryOnCostNow()
  return `Try on ${what} on ${on}${cost > 0 ? ` (costs ${plural(cost, 'token')})` : ''}`
}

async function tryOnHandler(input: TryOnInput, ctx: AgentContext): Promise<JsonValue> {
  const { runTryOn } = await import('../tools/tryon.js')
  const { photo, itemIds, outfit } = await resolveTryOn(input, ctx)
  const cost = await tryOnCostNow()
  // Same path as POST /api/tryon: runInstrumented (wallet in hosted mode,
  // mock image gen respected), garment contexts, saved to Try On history.
  const result = await runTryOn({
    userId: ctx.userId,
    userPhotoId: photo.id,
    itemIds,
    userInstruction: input.instruction,
    outfitId: outfit?.id,
    identity: ctx.identity,
  })
  return {
    tryonId: result.tryonId,
    resultImageUri: result.resultImageUri,
    photoId: photo.id,
    itemIds,
    outfitId: outfit?.id ?? null,
    outfitName: outfit?.name ?? null,
    wearSuggestions: (result.wearSuggestions ?? []) as JsonValue,
    tokensCharged: cost,
    historyAt: TRYON_PATH,
  }
}

// ─── Shop handlers (#341) ─────────────────────────────────────────────────────

async function searchShopHandler(input: SearchShopInput, ctx: AgentContext): Promise<JsonValue> {
  const limited = takeShopCall(ctx.userId, { turnId: ctx.identity.turnId, search: true })
  if (limited) throw new Error(limited)

  // Shop modules are imported statically (top of file): parallel tool calls
  // doing a first dynamic import of the catalog client raced module mocks in
  // tests and reached the live catalog.
  const { getItem } = await import('../tools/items.js')

  const items = (await Promise.all((input.item_ids ?? []).map(id => getItem(id, ctx.userId))))
    .filter((i): i is Item => Boolean(i))
  const outfits: Outfit[] = []
  for (const id of input.outfit_ids ?? []) {
    const { getOutfit } = await import('../tools/outfits.js')
    const o = await getOutfit(id, ctx.userId)
    if (o) outfits.push(o)
  }
  const outfitItemsById = new Map<string, Item>()
  for (const o of outfits) {
    const ids = parseJsonColumn(o.itemIds)
    for (const id of Array.isArray(ids) ? ids : []) {
      const item = typeof id === 'string' ? await getItem(id, ctx.userId) : null
      if (item) outfitItemsById.set(item.id, item)
    }
  }
  const rankContext = { query: input.query, intent: input.intent, items, outfits, outfitItemsById, recommendations: [] }
  const rank = hasShopRankContext(rankContext)

  const country = await resolveShopCountry(input, ctx)
  const currency = input.currency?.toUpperCase()
  const sizes = input.sizes?.length ? [...new Set(input.sizes)] : undefined
  const filters = {
    ...(country ? { country } : {}),
    ...(currency ? { currency } : {}),
    ...(input.min_price !== undefined ? { minPrice: input.min_price } : {}),
    ...(input.max_price !== undefined ? { maxPrice: input.max_price } : {}),
    ...(input.budget?.length ? { budget: input.budget } : {}),
    ...(sizes ? { sizes } : {}),
  }

  let result
  try {
    result = await searchGlobalCatalog({
      query: input.query,
      intent: input.intent,
      country,
      gender: userShopGender(ctx.userId),
      currency,
      minPriceMinor: input.min_price !== undefined && currency ? toMinorUnits(input.min_price, currency) : undefined,
      maxPriceMinor: input.max_price !== undefined && currency ? toMinorUnits(input.max_price, currency) : undefined,
      priceTiers: input.budget?.length ? [...new Set(input.budget)] : undefined,
      sizes,
      limit: rank ? SHOP_RANK_POOL : SHOP_RESULTS,
    })
  } catch (err) {
    console.warn('[agent/search_shop] catalog error:', String((err as Error).message ?? err))
    throw new Error('The shop is unavailable right now. Try again later.')
  }

  let products = result.products
  let ranked = false
  if (rank && products.length >= 2) {
    try {
      products = await rankShopProductsWithJev({ userId: ctx.userId, context: rankContext, products, details: result.details ?? {} })
      ranked = true
    } catch (err) {
      // Jev down / no master key → catalog order.
      console.warn('[agent/search_shop] jev rank failed, using catalog order:', String((err as Error).message ?? err))
    }
  }
  return {
    query: input.query,
    filters,
    products: products.slice(0, SHOP_RESULTS) as unknown as JsonValue,
    nextCursor: result.nextCursor,
    ranked,
  }
}

async function listLikedProductsHandler(_input: ListLikedProductsInput, ctx: AgentContext): Promise<JsonValue> {
  const limited = takeShopCall(ctx.userId, { turnId: ctx.identity.turnId, search: false })
  if (limited) throw new Error(limited)
  const { ids, total } = listLikedProductIds(ctx.userId, MAX_LIKED_LOOKUP)
  if (!ids.length) return { products: [], gone: [], total }
  return { ...(await lookupProducts(ids, ctx)), total }
}

/** Live catalog lookup, in the given order. Delisted ids come back in `gone`, never faked. */
async function lookupProducts(ids: string[], ctx: AgentContext): Promise<{ [key: string]: JsonValue }> {
  try {
    const result = await lookupGlobalCatalog({ ids, country: userCountry(ctx.userId) })
    const byId = new Map(result.products.map(p => [p.id, p]))
    return {
      products: ids.flatMap(id => byId.get(id) ?? []) as unknown as JsonValue,
      gone: result.notFound,
    }
  } catch (err) {
    console.warn('[agent/shop] catalog lookup error:', String((err as Error).message ?? err))
    return { products: [], gone: [], unavailable: true }
  }
}

/** Shop results are stored as product ids only (Shopify catalog policy: no caching). */
function shopPersistView(result: JsonValue): JsonValue {
  const r = (result ?? {}) as { query?: JsonValue; filters?: JsonValue; products?: { id: string }[]; total?: JsonValue }
  const productIds = (r.products ?? []).map(p => p.id)
  return {
    ...(r.query !== undefined ? { query: r.query } : {}),
    ...(r.filters !== undefined ? { filters: r.filters } : {}),
    ...(r.total !== undefined ? { total: r.total } : {}),
    productIds,
    note: `${plural(productIds.length, 'product')} shown to the user as cards; details are not kept.`,
  }
}

async function shopHydrateView(persisted: JsonValue, ctx: AgentContext): Promise<JsonValue> {
  const p = (persisted ?? {}) as { query?: JsonValue; filters?: JsonValue; total?: JsonValue; productIds?: unknown }
  const ids = Array.isArray(p.productIds) ? p.productIds.filter((id): id is string => typeof id === 'string') : []
  const base = {
    ...(p.query !== undefined ? { query: p.query } : {}),
    ...(p.filters !== undefined ? { filters: p.filters } : {}),
    ...(p.total !== undefined ? { total: p.total } : {}),
  }
  if (!ids.length) return { ...base, products: [], gone: [] }
  return { ...base, ...(await lookupProducts(ids.slice(0, MAX_LIKED_LOOKUP), ctx)) }
}

// ─── Pre-confirm checks + Confirm card summaries (#337, #338) ─────────────────

async function checkOutfitIdsOwned(ids: string[], ctx: AgentContext): Promise<void> {
  for (const id of ids) await ownedOutfit(id, ctx)
}

const writeChecks = {
  create_outfit: {
    precheck: (i: CreateOutfitInput, ctx: AgentContext) => checkOutfitItems(i.item_ids, ctx),
    summarize: async (i: CreateOutfitInput) => `“${i.name}” · ${plural(i.item_ids.length, 'item')}`,
  },
  update_outfit: {
    precheck: async (i: UpdateOutfitInput, ctx: AgentContext) => {
      await ownedOutfit(i.id, ctx)
      if (i.item_ids) await checkOutfitItems(i.item_ids, ctx, i.id)
    },
    summarize: async (i: UpdateOutfitInput, ctx: AgentContext) => {
      const outfit = await ownedOutfit(i.id, ctx)
      const changes = [
        i.name !== undefined && `rename to “${i.name}”`,
        i.item_ids && `items → ${plural(i.item_ids.length, 'item')}`,
        i.occasion !== undefined && 'occasion',
        i.season && 'season',
        i.notes !== undefined && 'notes',
      ].filter(Boolean)
      return `Update “${outfit.name}”: ${changes.join(', ')}`
    },
  },
  create_collection: {
    precheck: async (i: CreateCollectionInput, ctx: AgentContext) => {
      const { listCollections } = await import('../tools/collections.js')
      const existing = (await listCollections(ctx.userId)).find(c => c.name.trim().toLowerCase() === i.name.toLowerCase())
      if (existing) {
        throw new Error(
          `A collection named "${existing.name}" already exists (id ${existing.id}). ` +
          'Add the outfits to it with add_outfits_to_collection instead of making a second one.',
        )
      }
      await checkOutfitIdsOwned(i.outfit_ids ?? [], ctx)
    },
    summarize: async (i: CreateCollectionInput) =>
      i.outfit_ids?.length ? `“${i.name}” · ${plural(i.outfit_ids.length, 'outfit')}` : `“${i.name}”`,
  },
  add_outfits_to_collection: {
    precheck: async (i: CollectionOutfitsInput, ctx: AgentContext) => {
      await ownedCollection(i.collection_id, ctx)
      await checkOutfitIdsOwned(i.outfit_ids, ctx)
    },
    summarize: async (i: CollectionOutfitsInput, ctx: AgentContext) =>
      `Add ${plural(i.outfit_ids.length, 'outfit')} to “${(await ownedCollection(i.collection_id, ctx)).name}”`,
  },
  remove_outfits_from_collection: {
    precheck: async (i: CollectionOutfitsInput, ctx: AgentContext) => {
      const { getOutfitIdsInCollection } = await import('../tools/collections.js')
      await ownedCollection(i.collection_id, ctx)
      const members = new Set(await getOutfitIdsInCollection(i.collection_id, ctx.userId))
      const missing = i.outfit_ids.find(id => !members.has(id))
      if (missing) throw new Error(`Outfit ${missing} is not in this collection`)
    },
    summarize: async (i: CollectionOutfitsInput, ctx: AgentContext) =>
      `Remove ${plural(i.outfit_ids.length, 'outfit')} from “${(await ownedCollection(i.collection_id, ctx)).name}”`,
  },
  update_collection: {
    precheck: async (i: UpdateCollectionInput, ctx: AgentContext) => { await ownedCollection(i.id, ctx) },
    summarize: async (i: UpdateCollectionInput, ctx: AgentContext) => {
      const current = (await ownedCollection(i.id, ctx)).name
      if (i.name !== undefined && i.description !== undefined) return `Rename “${current}” to “${i.name}” and update its description`
      if (i.name !== undefined) return `Rename “${current}” to “${i.name}”`
      return `Update the description of “${current}”`
    },
  },
}

type WriteHooks = Pick<AgentTool<unknown>, 'precheck' | 'summarize'>
const hooks = (name: keyof typeof writeChecks) => writeChecks[name] as unknown as WriteHooks

async function getMySizesHandler(_input: GetMySizesInput, ctx: AgentContext): Promise<JsonValue> {
  const { getSettings, isSizesAgentContextEnabled } = await import('../settings.js')
  const settings = getSettings(ctx.userId)
  if (!isSizesAgentContextEnabled(settings)) return { disabled: true, editAt: SIZES_EDIT_PATH }
  return { sizes: (settings.userSizes ?? {}) as { [key: string]: JsonValue }, editAt: SIZES_EDIT_PATH }
}

// ─── Registry ──────────────────────────────────────────────────────────────────

export const AGENT_TOOLS: AgentTool<unknown>[] = [
  {
    name: 'search_closet',
    description:
      "Browse the user's wardrobe. Returns a summary of matching items (id, image, category, color, brand, size). " +
      'Use filters to narrow results, or a free-text query to search across brand, tags and AI description. ' +
      'Item sizes are the best reference for what fits the user, but many items have none (hijabs, kurtis, ' +
      'accessories, anything without a size) — a missing size is normal; never guess one. Results are capped at 25.',
    input: SearchClosetInput as z.ZodType<unknown>,
    scope: 'read',
    handler: searchClosetHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'get_item',
    description: 'Get full details of a single wardrobe item by ID, including image URL, colors, material, brand, size and tags.',
    input: GetItemInput as z.ZodType<unknown>,
    scope: 'read',
    handler: getItemHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'list_outfits',
    description: 'List the user’s saved outfits, optionally filtered by occasion or season. Returns id, name, occasion and cover image.',
    input: ListOutfitsInput as z.ZodType<unknown>,
    scope: 'read',
    handler: listOutfitsHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'get_outfit',
    description: 'Get a saved outfit with its constituent items hydrated (id, name, items[] with image URLs).',
    input: GetOutfitInput as z.ZodType<unknown>,
    scope: 'read',
    handler: getOutfitHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'list_collections',
    description: 'List the user’s outfit collections (curated bundles of saved outfits). Returns id, name and description.',
    input: ListCollectionsInput as z.ZodType<unknown>,
    scope: 'read',
    handler: listCollectionsHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'get_weather',
    description:
      "Get current weather conditions at a location. Pass `location` (a place name to geocode) " +
      "or `lat`+`lon` to override the user's saved location; omit all three to use the saved " +
      "location from the user's settings. Coords are rounded to ~0.5° before the upstream call.",
    input: GetWeatherInput as z.ZodType<unknown>,
    scope: 'read',
    handler: getWeatherHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'get_forecast',
    description:
      'Get the daily forecast (high/low °C, conditions, rain chance, wind) for up to 7 days from `start_date` ' +
      '(default today, within the next 16 days). Use it for trips and plans on other days. Same location ' +
      'rules as get_weather; coords are rounded to ~0.5° before the upstream call.',
    input: GetForecastInput as z.ZodType<unknown>,
    scope: 'read',
    handler: getForecastHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'suggest_outfit',
    description:
      'Get AI-generated outfit suggestions based on current weather and the user’s wardrobe. ' +
      'Pass `location` (place name) or `lat`+`lon` to override the saved location; omit to use ' +
      'the saved location. Optional occasion/theme guides the suggestion (e.g. "job interview", ' +
      '"date night"). Returns 2 suggestions with item_ids, names and reasoning.',
    input: SuggestOutfitInput as z.ZodType<unknown>,
    scope: 'ai',
    handler: suggestOutfitHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'create_outfit',
    description:
      'Save a new outfit from item IDs: one wearable look, one item per slot (top, bottom or dress, ' +
      'optional outer layer, shoes, up to 2 accessories), 3–6 items. Rejected if it has too many items ' +
      'in a slot or copies a saved outfit. The user confirms in the app before it is saved.',
    input: CreateOutfitInput as z.ZodType<unknown>,
    scope: 'write',
    handler: createOutfitHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    ...hooks('create_outfit'),
  },
  {
    name: 'update_outfit',
    description:
      'Change a saved outfit: rename it, swap items (send the full new item_ids list), or set occasion, ' +
      'season or notes. Same composition rules as create_outfit. The user confirms in the app first.',
    input: UpdateOutfitInput as z.ZodType<unknown>,
    scope: 'write',
    handler: updateOutfitHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    ...hooks('update_outfit'),
  },
  {
    name: 'get_collection',
    description: 'Get a collection with its saved outfits (each with its items). Outfits are capped at 25.',
    input: GetCollectionInput as z.ZodType<unknown>,
    scope: 'read',
    handler: getCollectionHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'create_collection',
    description:
      'Create a collection (a named bundle of saved outfits, e.g. a trip packing list), optionally with ' +
      'saved outfits in it. Rejected if a collection with that name exists — add to it instead. ' +
      'The user confirms in the app first.',
    input: CreateCollectionInput as z.ZodType<unknown>,
    scope: 'write',
    handler: createCollectionHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    ...hooks('create_collection'),
  },
  {
    name: 'add_outfits_to_collection',
    description: 'Add saved outfits to an existing collection. Outfits already in it are skipped. The user confirms first.',
    input: CollectionOutfitsInput as z.ZodType<unknown>,
    scope: 'write',
    handler: addOutfitsHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    ...hooks('add_outfits_to_collection'),
  },
  {
    name: 'remove_outfits_from_collection',
    description:
      'Take saved outfits out of a collection. The outfits themselves are kept. The user confirms first.',
    input: CollectionOutfitsInput as z.ZodType<unknown>,
    scope: 'write',
    handler: removeOutfitsHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    ...hooks('remove_outfits_from_collection'),
  },
  {
    name: 'update_collection',
    description: 'Rename a collection or change its description. The user confirms first.',
    input: UpdateCollectionInput as z.ZodType<unknown>,
    scope: 'write',
    handler: updateCollectionHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    ...hooks('update_collection'),
  },
  {
    name: 'search_shop',
    description:
      'Search shop products (live Shopify catalog) for things the user could buy. `query` is garment words ' +
      'only ("red linen shirt"), never anything about the user. Pass item_ids / outfit_ids from the closet to ' +
      'rank results by how well they go with those pieces. Filter by price (min_price / max_price + currency), ' +
      'a loose budget tier (budget), sizes, and where it ships (location or country; default: the saved ' +
      'location). Returns up to 10 products shown as cards with a ♡ the user can tap, plus the `filters` ' +
      'applied; you cannot like or buy for them. No results with filters → say which filter to loosen. ' +
      'At most 2 searches per message.',
    input: SearchShopInput as z.ZodType<unknown>,
    scope: 'read',
    handler: searchShopHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    available: () => shopEnabled(),
    persistView: shopPersistView,
    hydrateView: shopHydrateView,
  },
  {
    name: 'list_liked_products',
    description:
      'List the shop products the user liked (♡), newest first, with live prices. Products the shop no longer ' +
      'lists come back in `gone` — say so; never describe them.',
    input: ListLikedProductsInput as z.ZodType<unknown>,
    scope: 'read',
    handler: listLikedProductsHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    available: () => shopEnabled(),
    persistView: shopPersistView,
    hydrateView: shopHydrateView,
  },
  {
    name: 'find_related',
    description:
      'Find related pieces for something in the closet (the app\'s "Find related"): kind "item" returns other ' +
      'closet items that pair well with that item; "outfit" returns saved outfits close to that outfit; ' +
      '"collection" returns saved outfits that belong in that collection. Scored, best first. When the ' +
      'server has no decision model it falls back to word matching (method "keyword"): treat those as ' +
      'looser leads. Returns { status: "capped" } when the daily limit is reached — say so.',
    input: FindRelatedInput as z.ZodType<unknown>,
    scope: 'read',
    handler: findRelatedHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'discover_closet',
    description:
      'Search the closet by meaning, like the app\'s Discover: a free-text idea ("all yellow", "cosy rainy day") ' +
      'returns the closest items (up to 12) and saved outfits related to them (up to 6). Retrieval only: it ' +
      'doesn\'t compose new outfits — pick from the results yourself, or use suggest_outfit.',
    input: DiscoverClosetInput as z.ZodType<unknown>,
    scope: 'read',
    handler: discoverClosetHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'list_my_photos',
    description:
      'List the user\'s own photos used for virtual try-on (id, label, primary). If there are none, tell the ' +
      'user to add one in the app (Try On); you cannot upload photos.',
    input: ListMyPhotosInput as z.ZodType<unknown>,
    scope: 'read',
    handler: listMyPhotosHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
  {
    name: 'try_on',
    description:
      'Generate a virtual try-on image of the user wearing closet items (item_ids) or a saved outfit (outfit_id), ' +
      'on one of their photos (photo_id from list_my_photos; default: primary photo). Costs tokens: the user ' +
      'confirms in the app first. The result is saved to Try On history.',
    input: TryOnInput as z.ZodType<unknown>,
    scope: 'ai',
    requiresConfirmation: true,
    handler: tryOnHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
    precheck: checkTryOn as (input: unknown, ctx: AgentContext) => Promise<void>,
    summarize: summarizeTryOn as (input: unknown, ctx: AgentContext) => Promise<string>,
  },
  {
    name: 'get_my_sizes',
    description:
      "Get the user's optional reference sizes per category (e.g. tops M, bottoms 32 × 30), as entered in " +
      'Settings › Sizes. Prefer the sizes on their own items (search_closet with `size`, get_item) — these are a ' +
      'fallback and may be empty or incomplete. Returns { sizes, editAt } or { disabled: true, editAt } when the ' +
      'user turned off "Use my sizes in Ask" — then say so and do not guess. You cannot change sizes: tell the ' +
      'user to update them at `editAt` (Settings › Sizes) or in the item\'s details.',
    input: GetMySizesInput as z.ZodType<unknown>,
    scope: 'read',
    handler: getMySizesHandler as (input: unknown, ctx: AgentContext) => Promise<JsonValue>,
  },
]

/** Look up a tool by name. Returns undefined if not found. */
export function getTool(name: string): AgentTool<unknown> | undefined {
  return AGENT_TOOLS.find(t => t.name === name)
}

/**
 * Parse + execute a tool call. Validates input against the tool’s zod schema,
 * then dispatches to the handler with `ctx`. Throws on unknown tool, invalid
 * input, or handler error.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: AgentContext,
): Promise<JsonValue> {
  // Runtime guard, not just the type: fail before any handler runs, so a
  // tool never reaches a core function (suggestOutfits() defaults to 'self')
  // with an empty identity. getSettings() also validates its own userId.
  requireUserId(ctx.userId)
  const { tool, input } = parseToolInput(name, rawInput)
  await tool.precheck?.(input, ctx)
  return tool.handler(input, ctx)
}

function parseToolInput(name: string, rawInput: unknown): { tool: AgentTool<unknown>; input: unknown } {
  const tool = getTool(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  if (!isToolAvailable(tool)) throw new Error(`Tool ${name} is not available`)
  const parsed = tool.input.safeParse(rawInput)
  if (!parsed.success) {
    throw new Error(`Invalid input for ${name}: ${parsed.error.message}`)
  }
  return { tool, input: parsed.data }
}

/**
 * Validate a proposed write before the user sees a Confirm card (#337): a
 * call that would fail anyway (bad input, foreign id, a 9-item outfit, a copy
 * of a saved outfit) comes back as an error for the model to fix. On success,
 * returns the Confirm card summary.
 */
export async function prepareWrite(
  name: string,
  rawInput: unknown,
  ctx: AgentContext,
): Promise<{ ok: true; summary: string | null } | { ok: false; error: string }> {
  requireUserId(ctx.userId)
  try {
    const { tool, input } = parseToolInput(name, rawInput)
    await tool.precheck?.(input, ctx)
    return { ok: true, summary: (await tool.summarize?.(input, ctx)) ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Confirm card summary for a stored pending action (thread reload). Null if it no longer applies. */
export async function describeAction(name: string, rawInput: unknown, ctx: AgentContext): Promise<string | null> {
  requireUserId(ctx.userId)
  try {
    const { tool, input } = parseToolInput(name, rawInput)
    return (await tool.summarize?.(input, ctx)) ?? null
  } catch {
    return null
  }
}
