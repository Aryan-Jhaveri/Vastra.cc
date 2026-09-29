/**
 * AI models often wrap JSON responses in markdown code fences.
 * This helper strips the fences and parses the JSON safely.
 * Provider-agnostic — works with Gemini, OpenRouter, and others.
 */
export function parseAIJSON<T = unknown>(text: string | null | undefined): T {
  if (!text) throw new Error('Empty AI response')

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  try {
    return JSON.parse(stripped) as T
  } catch {
    // Fallback: the first complete JSON object or array. Models sometimes add
    // prose, a second object or a stray fence after the JSON; a greedy
    // first-"{"-to-last-"}" match swallowed that and failed (prod, 2026-09-28:
    // "Unexpected non-whitespace character after JSON" on bulk detect).
    const first = firstJSONValue(stripped)
    if (first !== null) {
      try { return JSON.parse(first) as T } catch { /* fall through */ }
    }
    throw new Error(`Failed to parse AI JSON response: ${text.slice(0, 200)}`)
  }
}

/** The first balanced {...} or [...] in text (string-aware), or null. */
export function firstJSONValue(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null
      if (!stack.length) return text.slice(start, i + 1)
    }
  }
  return null
}

/** @deprecated Use parseAIJSON instead */
export const parseGeminiJSON = parseAIJSON

/**
 * Extract the base64 image data from a Gemini image generation response.
 * Returns { data, mimeType } or throws if no image was returned.
 */
export function extractGeminiImage(
  response: { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> }
): { data: string; mimeType: string } {
  const parts = response.candidates?.[0]?.content?.parts ?? []

  // Check for safety block
  if (!response.candidates?.length) {
    const block = (response as Record<string, unknown>)?.promptFeedback as Record<string, unknown> | undefined
    if (block?.blockReason) {
      throw new Error(`Gemini blocked the request: ${block.blockReason}`)
    }
    throw new Error('No candidates in Gemini image response')
  }

  for (const part of parts) {
    if (part.inlineData && typeof part.inlineData === 'object') {
      const { data, mimeType } = part.inlineData as { data: string; mimeType: string }
      if (data) return { data, mimeType: mimeType ?? 'image/png' }
    }
  }

  throw new Error('No image data found in Gemini response')
}
