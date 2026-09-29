import { z } from 'zod'
import type { items, outfits, userPhotos, tryonResults, collections } from '../db/schema.js'

// ─── DB row types ─────────────────────────────────────────────────────────────

export type Item = typeof items.$inferSelect
export type NewItem = typeof items.$inferInsert

export type Outfit = typeof outfits.$inferSelect
export type NewOutfit = typeof outfits.$inferInsert

export type UserPhoto = typeof userPhotos.$inferSelect
export type NewUserPhoto = typeof userPhotos.$inferInsert

export type TryonResult = typeof tryonResults.$inferSelect
export type NewTryonResult = typeof tryonResults.$inferInsert

export type Collection = typeof collections.$inferSelect
export type NewCollection = typeof collections.$inferInsert

// ─── Parsed types (JSON fields hydrated) ─────────────────────────────────────

export type ItemParsed = Omit<Item, 'colors' | 'careInstructions' | 'season' | 'tags' | 'occasion'> & {
  colors: string[]
  careInstructions: string[]
  season: string[]
  tags: string[]
  occasion: string[]
}

export type OutfitParsed = Omit<Outfit, 'itemIds' | 'season' | 'tags' | 'weatherContext'> & {
  itemIds: string[]
  season: string[]
  tags: string[]
  weatherContext: Record<string, unknown> | null
}

// ─── Categories ───────────────────────────────────────────────────────────────

export const ITEM_CATEGORIES = [
  'tops', 'bottoms', 'dresses', 'outerwear', 'shoes', 'accessories', 'activewear', 'underwear',
] as const

export type ItemCategory = typeof ITEM_CATEGORIES[number]

export const OCCASIONS = ['casual', 'work', 'formal', 'outdoor', 'date'] as const
export type Occasion = typeof OCCASIONS[number]

export const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all'] as const
export type Season = typeof SEASONS[number]

// ─── Zod schemas (for tool input validation + MCP inputSchema) ────────────────

// Free-text input caps — prevent context-window DoS via unbounded user strings.
// .trim() so whitespace-padding can't smuggle bytes past the limit.
const str50 = z.string().trim().max(50)   // tags, season, occasion, colors, careInstructions
const str100 = z.string().trim().max(100) // material, brand, size, subcategory, category, primaryColor, names
const str500 = z.string().trim().max(500) // outfit notes, collection description
const str1000 = z.string().trim().max(1000) // aiDescription, wearContext
const idStr = z.string().max(50)
const facetArray = z.array(str50).max(20)  // season / occasion / colors / careInstructions arrays
const tagsArray = z.array(str50).max(50)   // tags arrays
const itemIdsArray = z.array(idStr).max(50)

// Preprocessor for JSON-string fields in multipart/form-data.
// Safely parses JSON strings, returning the original value if parse fails
// (Zod's subsequent validation will then catch the malformed input).
const jsonParsePreprocess = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return v }
  },
  z.unknown(),
)

export const AddItemInputSchema = z.object({
  imageBase64: z.string().optional(),
  imagePath: z.string().optional(),
  category: str100.optional(),
  subcategory: str100.optional(),
  primaryColor: str100.optional(),
  colors: jsonParsePreprocess.pipe(facetArray).optional(),
  material: str100.optional(),
  careInstructions: jsonParsePreprocess.pipe(facetArray).optional(),
  brand: str100.optional(),
  size: str100.optional(),
  season: jsonParsePreprocess.pipe(facetArray).optional(),
  tags: jsonParsePreprocess.pipe(tagsArray).optional(),
  aiDescription: str1000.optional(),
  occasion: jsonParsePreprocess.pipe(facetArray).optional(),
  wearContext: str1000.nullable().optional(),
  autoAnalyze: z.boolean().default(true),
})
export type AddItemInput = z.infer<typeof AddItemInputSchema>

export const ListItemsInputSchema = z.object({
  category: z.string().optional(),
  categories: z.array(z.string()).optional(),
  color: z.string().optional(),
  season: z.string().optional(),
  occasion: z.string().optional(),
  brand: z.string().optional(),
  subcategory: z.string().optional(),
  material: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sortBy: z.enum(['created', 'worn', 'name']).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
})
export type ListItemsInput = z.infer<typeof ListItemsInputSchema>

export const UpdateItemInputSchema = z.object({
  id: z.string(),
  category: str100.optional(),
  // Nullable fields let the UI clear a value by sending `null` (backspace-and-save).
  // Without `.nullable()`, Zod rejects null and the PATCH 400s, leaving the stale
  // value in place — surfaced in ItemDetail's material/brand/size/subcategory inputs.
  subcategory: str100.nullable().optional(),
  primaryColor: str100.nullable().optional(),
  colors: facetArray.optional(),
  material: str100.nullable().optional(),
  materialSource: z.enum(['ocr', 'manual']).optional(),
  careInstructions: facetArray.optional(),
  brand: str100.nullable().optional(),
  size: str100.nullable().optional(),
  season: facetArray.optional(),
  tags: tagsArray.optional(),
  aiDescription: str1000.nullable().optional(),
  occasion: facetArray.optional(),
})
export type UpdateItemInput = z.infer<typeof UpdateItemInputSchema>

export const CreateOutfitInputSchema = z.object({
  name: str100.min(1),
  itemIds: itemIdsArray.min(1),
  occasion: str50.optional(),
  season: facetArray.optional(),
  tags: tagsArray.optional(),
  notes: str500.optional(),
  aiGenerated: z.boolean().optional(),
  weatherContext: z.record(z.string(), z.unknown()).optional(),
})
export type CreateOutfitInput = z.infer<typeof CreateOutfitInputSchema>

export const UpdateOutfitInputSchema = z.object({
  name: str100.min(1).optional(),
  occasion: str50.optional(),
  season: facetArray.optional(),
  tags: tagsArray.optional(),
  notes: str500.optional(),
  itemIds: itemIdsArray.optional(),
})
export type UpdateOutfitInput = z.infer<typeof UpdateOutfitInputSchema>

export const CreateCollectionInputSchema = z.object({
  name: str100.min(1),
  description: str500.optional(),
  season: facetArray.optional(),
  tags: tagsArray.optional(),
})
export type CreateCollectionInput = z.infer<typeof CreateCollectionInputSchema>

export const UpdateCollectionInputSchema = z.object({
  name: str100.min(1).optional(),
  description: str500.nullable().optional(),
  season: facetArray.optional(),
  tags: tagsArray.optional(),
})
export type UpdateCollectionInput = z.infer<typeof UpdateCollectionInputSchema>

export const AddUserPhotoInputSchema = z.object({
  imageBase64: z.string().optional(),
  imagePath: z.string().optional(),
  label: z.string().optional(),
  isPrimary: z.boolean().optional(),
})
export type AddUserPhotoInput = z.infer<typeof AddUserPhotoInputSchema>

// ─── AI result types ──────────────────────────────────────────────────────────

export const ItemClassificationSchema = z.object({
  category: z.string(),
  subcategory: z.string(),
  primary_color: z.string(),
  colors: z.array(z.string()),
  material: z.string(),
  season: z.array(z.string()),
  ai_description: z.string(),
  suggested_tags: z.array(z.string()),
  wear_context: z.string().nullable().optional(),
})
export type ItemClassification = z.infer<typeof ItemClassificationSchema>

export const TagDataSchema = z.object({
  brand: z.string().nullable(),
  size: z.string().nullable(),
  material_composition: z.string().nullable(),
  care_instructions: z.array(z.string()),
  country_of_origin: z.string().nullable(),
})
export type TagData = z.infer<typeof TagDataSchema>

export const OutfitSuggestionSchema = z.object({
  item_ids: z.array(z.string()),
  name: z.string(),
  occasion: z.string(),
  reasoning: z.string(),
})
export type OutfitSuggestion = z.infer<typeof OutfitSuggestionSchema>

// ─── Weather types ────────────────────────────────────────────────────────────

export interface WeatherData {
  temperature: number
  weatherCode: number
  condition: string
  precipitation: number
  windSpeed: number
  icon: string
  /** IANA zone of the location, when the provider reports it (Open-Meteo timezone=auto). */
  timezone?: string
}

/** One day of an Open-Meteo daily forecast (local date at the location). */
export interface ForecastDay {
  date: string
  tempMax: number
  tempMin: number
  weatherCode: number
  condition: string
  icon: string
  precipitationProbability: number | null
  precipitationSum: number
  windSpeedMax: number
}
