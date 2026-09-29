import { generateJSONWithUsage, VISION_MODEL, type UsageMetadata } from './client.js'
import type { TagData } from '../types/index.js'

const SCAN_TAG_PROMPT = `Extract all information from this clothing care label image. Return ONLY valid JSON with no markdown:
{
  "brand": "brand name or null",
  "size": "size value or null",
  "material_composition": "e.g. 100% Cotton or null",
  "care_instructions": ["Machine wash cold", "Do not bleach"],
  "country_of_origin": "country or null"
}`

export async function scanTag(imageBase64: string): Promise<{ data: TagData; usage: UsageMetadata }> {
  return generateJSONWithUsage<TagData>(SCAN_TAG_PROMPT, imageBase64, VISION_MODEL)
}
