import { db } from '../db/client.js'
import { suggestEvents } from '../db/schema.js'
import { nanoid } from 'nanoid'

export interface SuggestEventInput {
  userId: string
  shortlistSource: 'text' | 'image' | 'hybrid' | 'full' | 'jev'
  itemCount: number
  shortlistedCount: number
  suggestionCount: number
  preFilterEnabled: boolean
  weather: string
  occasion?: string
  promptChars?: number
}

export function logSuggestEvent(input: SuggestEventInput): void {
  db.insert(suggestEvents).values({
    id: nanoid(),
    userId: input.userId,
    shortlistSource: input.shortlistSource,
    itemCount: input.itemCount,
    shortlistedCount: input.shortlistedCount,
    suggestionCount: input.suggestionCount,
    preFilterEnabled: input.preFilterEnabled ? 1 : 0,
    weather: input.weather,
    occasion: input.occasion ?? null,
    promptChars: input.promptChars ?? null,
    createdAt: Date.now(),
  }).run()
}
