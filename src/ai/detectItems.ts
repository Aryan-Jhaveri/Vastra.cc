import { generateJSONWithUsage, type UsageMetadata } from './client.js'
import { nanoid } from 'nanoid'
import { detectionModel } from './localModel.js'

const CROP_COLORS = ['#d4e8d4', '#d4d4e8', '#e8d4d4', '#e8e4d4', '#e4d4e8', '#e8d4e4', '#d4e8e8']

const PROMPT = `You are a clothing detection model. Detect every visible clothing item, shoe, or accessory in this photo.

Return ONLY valid JSON — an array of objects, no markdown:
[
  {
    "label": "blue denim jacket",
    "category": "tops|bottoms|shoes|outerwear|accessories|dresses|activewear|bags",
    "box_2d": [y1, x1, y2, x2]
  }
]

Rules:
- box_2d values are in 0–1000 scale (not pixels, not 0–1)
- y1 < y2 and x1 < x2
- Include every distinct garment/item visible
- For worn photos: detect items on the person's body
- For flat-lay photos: detect each item separately
- Return [] if no clothing is visible`

export interface RawDetection {
  id: string
  label: string
  category: string
  cropColor: string
  box: { x: number; y: number; w: number; h: number }
  kept: boolean
  alternatives: string[]
}

interface GeminiDetection {
  label: string
  category: string
  box_2d: [number, number, number, number]
}

const ALL_CATEGORIES = ['tops', 'bottoms', 'shoes', 'outerwear', 'accessories', 'dresses', 'bags', 'activewear']

function alternativesFor(category: string): string[] {
  return ALL_CATEGORIES.filter(c => c !== category).slice(0, 5)
}

export async function detectItems(imageBase64: string, hint?: string, bearerKey?: string): Promise<{ data: RawDetection[]; usage: UsageMetadata }> {
  const prompt = hint
    ? `${PROMPT}\n\nUser correction hint: "${hint}". Adjust your detections accordingly.`
    : PROMPT

  const { data: raw, usage } = await generateJSONWithUsage<GeminiDetection[]>(prompt, imageBase64, detectionModel(), bearerKey)

  if (!Array.isArray(raw)) return { data: [], usage }

  return {
    data: raw
      .filter(d => Array.isArray(d.box_2d) && d.box_2d.length === 4)
      .map((d, i) => {
        const [y1, x1, y2, x2] = d.box_2d
        const x = Math.max(0, Math.min(100, x1 / 10))
        const y = Math.max(0, Math.min(100, y1 / 10))
        const w = Math.max(1, Math.min(100 - x, (x2 - x1) / 10))
        const h = Math.max(1, Math.min(100 - y, (y2 - y1) / 10))

        return {
          id: nanoid(8),
          label: d.label ?? d.category,
          category: d.category ?? 'accessories',
          cropColor: CROP_COLORS[i % CROP_COLORS.length],
          box: { x, y, w, h },
          kept: true,
          alternatives: alternativesFor(d.category ?? 'accessories'),
        }
      }),
    usage,
  }
}
