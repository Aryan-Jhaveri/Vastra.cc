import { generateJSONWithUsage, VISION_MODEL, type UsageMetadata } from './client.js'
import type { ItemClassification } from '../types/index.js'

const BASE_PROMPT = `Analyze this clothing item image. Return ONLY valid JSON with no markdown:
{
  "category": "tops|bottoms|shoes|outerwear|accessories|dresses|activewear|underwear",
  "subcategory": "specific type — for accessories use: turban|hijab|keffiyeh|dupatta|tichel|headband|baseball cap|beanie|beret|bucket hat|bandana|belt|bag|watch|sunglasses|jewelry|scarf|gloves|socks|tie|bow tie|other; for tops: t-shirt|shirt|blouse|sweater|hoodie|tank top|polo|other; for bottoms: jeans|trousers|shorts|skirt|leggings|other; for shoes: sneakers|boots|heels|sandals|loafers|other; for outerwear: jacket|coat|trenchcoat|blazer|puffer|other; for dresses: dress|jumpsuit|romper|other; for activewear: sports top|sports shorts|leggings|swimwear|other",
  "primary_color": "single color name",
  "colors": ["color1", "color2"],
  "material": "fabric type or null",
  "season": ["spring", "summer", "fall", "winter"],
  "ai_description": "1-sentence style description",
  "suggested_tags": ["casual", "formal", "streetwear"],
  "wear_context": "brief note on how item is worn if non-obvious (e.g. 'wrapped around head as turban', 'draped over shoulders as hijab') — null if standard garment"
}

STRICT RULES (the description and all output):
- Describe ONLY the garment/accessory. Never reference a person, model, wearer, body, hand, head, or pose.
- Use neutral, factual language. Never use negative, critical, or judgmental words ("worn", "faded" → fine if accurate; "ugly", "cheap", "dated", "unflattering" → never).
- If the image looks cropped or close-up, assume that is intentional. Do not comment on framing, crop, or missing context. Describe only what is visible.
- "ai_description" must be a single sentence, ≤ 20 words, item-only.`

export function buildPrompt(existingTags: string[], existingSubcategories: string[]): string {
  let prompt = BASE_PROMPT
  if (existingSubcategories.length > 0) {
    prompt += `\nExisting subcategories in this wardrobe — reuse the exact spelling if this item matches one: ${existingSubcategories.join(', ')}`
  }
  if (existingTags.length > 0) {
    prompt += `\nExisting tags in this wardrobe — reuse these when they fit, only add a new tag if none apply: ${existingTags.join(', ')}`
  }
  return prompt
}

export async function categorizeItem(imageBase64: string, existingTags: string[] = [], existingSubcategories: string[] = []): Promise<{ data: ItemClassification; usage: UsageMetadata }> {
  return generateJSONWithUsage<ItemClassification>(
    buildPrompt(existingTags, existingSubcategories),
    imageBase64,
    VISION_MODEL,
  )
}
