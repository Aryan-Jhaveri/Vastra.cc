import { describe, it, expect, vi } from 'vitest'

// MASTER_OPENROUTER_KEY is captured at module load. Clear OPENROUTER_API_KEY
// before importing client.ts so the fallback path is genuinely empty.
vi.hoisted(() => {
  process.env.OPENROUTER_API_KEY = ''
})

describe('client OpenRouter key resolution', () => {
  it('generateText throws when OpenRouter model has no bearerKey and no MASTER_OPENROUTER_KEY', async () => {
    const { generateText } = await import('../../src/ai/client.js')
    await expect(
      generateText('test prompt', undefined, 'openai/gpt-4o'),
    ).rejects.toThrow(/per-user key/)
  })

  it('generateTextWithUsage throws when OpenRouter model has no bearerKey and no MASTER_OPENROUTER_KEY', async () => {
    const { generateTextWithUsage } = await import('../../src/ai/client.js')
    await expect(
      generateTextWithUsage('test', undefined, 'mistralai/mistral-small'),
    ).rejects.toThrow(/per-user key/)
  })
})
