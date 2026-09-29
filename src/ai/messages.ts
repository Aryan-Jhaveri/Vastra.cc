import type { UsageMetadata } from './client.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface ModelTool {
  name: string
  description?: string
  parameters: JsonObject
}

export interface ModelToolCall {
  id: string
  name: string
  arguments: JsonObject
}

export interface AssistantMessage {
  role: 'assistant'
  content: string
  toolCalls?: ModelToolCall[]
  /** Opaque, model-bound replay data (including Gemini thought signatures). Do not edit. */
  providerState?: { provider: 'gemini'; model: string; parts: JsonObject[] }
}

export type ModelMessage =
  | { role: 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; toolCallId: string; name: string; content: JsonValue }

/** Text and function tools only. No tool execution, images, reasoning, or built-in tools. */
export interface MessageRequest {
  messages: ModelMessage[]
  system?: string
  tools?: ModelTool[]
  toolChoice?: 'auto' | 'none' | 'required'
  signal?: AbortSignal
}

export interface MessageResponse {
  message: AssistantMessage
  usage: UsageMetadata
  finishReason: 'stop' | 'length' | 'tool_calls'
}

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  /** Deltas are untrusted fragments, never executable arguments. Gemini emits complete calls only. */
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments: string }
  | { type: 'usage'; usage: UsageMetadata }
  | { type: 'complete'; response: MessageResponse }

export interface AgentCallIdentity {
  runId?: string
  turnId?: string
  stepId?: string
  toolCallId?: string
}

/** Carries the last provider-reported usage even when parsing, streaming, or cancellation fails. */
export class ModelCallError extends Error {
  readonly usage: UsageMetadata
  readonly status?: number

  constructor(cause: unknown, usage: UsageMetadata) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = cause instanceof Error ? cause.name : 'ModelCallError'
    this.usage = { ...usage }
    if (cause && typeof cause === 'object' && 'status' in cause && typeof cause.status === 'number') this.status = cause.status
  }
}

export function usageFromError(error: unknown): UsageMetadata | undefined {
  if (error instanceof ModelCallError) return error.usage
  return undefined
}
