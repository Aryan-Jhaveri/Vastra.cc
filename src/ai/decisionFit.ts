// #351 — fit decision text into a self-hosted model's context window.
//
// CLM-8B embeds the state and each question with a Qwen3-8B encoder whose
// window is `clm-serve --max-tokens` (2048 by default) and silently cuts
// anything longer from the end. A cut from the end drops whatever the blob
// lists last, which for an outfit is its last items: the model then ranks a
// different outfit from the one the user saved. So oversized text is shrunk
// here first, dropping the least useful fields everywhere before any item is
// lost, and only then cut.
//
// Only the `typesafe` provider applies this (DECISIONS_MAX_TOKENS, default
// 2048). Jev on OpenRouter has its own limits and gets the text unchanged.

import type { DecisionsQuestions, EntryType } from './decisions.js'

/**
 * Conservative characters-per-token for the JSON-heavy text we send. Qwen's
 * tokenizer averages ~3.5–4 chars/token on English prose and less on JSON
 * punctuation, so 3 keeps an estimate from overshooting the real window.
 */
export const CHARS_PER_TOKEN = 3

/** Field names dropped first to last, recursively, before any hard cut. */
export const DROP_ORDER = ['description', 'tags', 'wearContext', 'brand', 'material', 'season', 'colors'] as const

export const DEFAULT_DECISIONS_MAX_TOKENS = 2048

/** Token budget per state/question for the typesafe provider. */
export function decisionsMaxTokens(): number {
  const n = Number(process.env.DECISIONS_MAX_TOKENS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DECISIONS_MAX_TOKENS
}

function dropKey(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map(v => dropKey(v, key))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== key) out[k] = dropKey(v, key)
    }
    return out
  }
  return value
}

function hardCut(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Drop fields in DROP_ORDER until `render(value)` fits; returns the rendering. */
function shrinkJson(value: unknown, render: (v: unknown) => string, maxChars: number): string {
  let current = value
  let text = render(current)
  for (const key of DROP_ORDER) {
    if (text.length <= maxChars) return text
    current = dropKey(current, key)
    text = render(current)
  }
  return hardCut(text, maxChars)
}

/**
 * Fit a string. Text of the form "<question> <JSON>" (how every call site
 * builds its instructions) keeps the question and shrinks the JSON; other
 * text is cut.
 */
export function fitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const start = text.search(/[{[]/)
  if (start >= 0) {
    try {
      const prefix = text.slice(0, start)
      return shrinkJson(JSON.parse(text.slice(start)), v => prefix + JSON.stringify(v), maxChars)
    } catch {
      // Not trailing JSON after all: fall through to a plain cut.
    }
  }
  return hardCut(text, maxChars)
}

/** Fit a TypeSafe entry. Objects stay objects when shrinking is enough. */
export function fitEntry(entry: EntryType | undefined, maxChars: number): EntryType | undefined {
  if (entry === undefined || entry === null) return entry
  if (typeof entry === 'string') return fitText(entry, maxChars)
  if (JSON.stringify(entry).length <= maxChars) return entry
  const text = shrinkJson(entry, v => JSON.stringify(v), maxChars)
  try {
    return JSON.parse(text) as EntryType
  } catch {
    return text // hard-cut JSON is no longer parseable; send it as text
  }
}

export interface FitResult {
  state: EntryType
  questions: DecisionsQuestions
  /** How many of the state + question instructions had to shrink. */
  trimmed: number
}

/** Fit the state and every question's instructions to `maxTokens` each. */
export function fitDecisionsRequest(state: EntryType, questions: DecisionsQuestions, maxTokens: number): FitResult {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  let trimmed = 0
  const fittedState = fitEntry(state, maxChars) as EntryType
  if (fittedState !== state) trimmed++
  const fitted: DecisionsQuestions = {}
  for (const [id, q] of Object.entries(questions)) {
    const instructions = fitEntry(q.instructions, maxChars)
    if (instructions !== q.instructions) trimmed++
    fitted[id] = instructions === q.instructions ? q : { ...q, instructions } as typeof q
  }
  return { state: fittedState, questions: fitted, trimmed }
}
