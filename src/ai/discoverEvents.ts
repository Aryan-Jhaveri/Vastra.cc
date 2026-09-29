import { db } from '../db/client.js'
import { discoverEvents } from '../db/schema.js'
import { nanoid } from 'nanoid'

export interface DiscoverEventInput {
  userId: string
  mode: 'prompt' | 'image' | 'shared'
  shortlistSource: 'text' | 'image' | 'hybrid' | 'full' | 'outfit_retrieval' | 'jev'
  itemCount: number
  shortlistedCount: number
  suggestionCount: number
  preFilterEnabled: boolean
  occasion?: string
  promptChars?: number
}

export function logDiscoverEvent(input: DiscoverEventInput): void {
  db.insert(discoverEvents).values({
    id: nanoid(),
    userId: input.userId,
    mode: input.mode,
    shortlistSource: input.shortlistSource,
    itemCount: input.itemCount,
    shortlistedCount: input.shortlistedCount,
    suggestionCount: input.suggestionCount,
    preFilterEnabled: input.preFilterEnabled ? 1 : 0,
    occasion: input.occasion ?? null,
    promptChars: input.promptChars ?? null,
    createdAt: Date.now(),
  }).run()
}
