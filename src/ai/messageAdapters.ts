import type { Content, FunctionCallingConfigMode, GenerateContentParameters, GoogleGenAI } from '@google/genai'
import { nanoid } from 'nanoid'
import {
  ModelCallError,
  type JsonObject,
  type MessageRequest,
  type MessageResponse,
  type ModelEvent,
  type ModelToolCall,
} from './messages.js'
import type { UsageMetadata } from './client.js'
import { isLocalModel, localChatCompletion, localModelName, readLocalJson } from './localModel.js'

type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a model JSON object')
  return value as ObjectValue
}

export function validate(request: MessageRequest, gemini: boolean, model: string): void {
  if (!request.messages.length) throw new Error('At least one message is required')
  if (request.toolChoice && !['auto', 'none', 'required'].includes(request.toolChoice)) throw new Error('Unsupported tool choice')
  const tools = new Set<string>()
  for (const tool of request.tools ?? []) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || tools.has(tool.name)) throw new Error('Invalid or duplicate tool name')
    if (tool.parameters.type !== 'object') throw new Error('Tool parameters must be an object JSON schema')
    tools.add(tool.name)
  }
  if (request.toolChoice === 'required' && !tools.size) throw new Error('Required tool choice needs tools')
  const pending = new Map<string, string>()
  const seen = new Set<string>()
  for (const message of request.messages) {
    if (message.role === 'tool') {
      if (pending.get(message.toolCallId) !== message.name) throw new Error('Tool result has no matching pending call')
      pending.delete(message.toolCallId)
    } else {
      if (pending.size) throw new Error('All tool calls need results before the next message')
      if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('Only text messages are supported')
      if (message.role === 'assistant') {
        if (message.providerState && (!gemini || message.providerState.provider !== 'gemini' || message.providerState.model !== model)) {
          throw new Error('Cannot replay provider state with a different provider/model')
        }
        for (const call of message.toolCalls ?? []) {
          if (!call.id || seen.has(call.id) || !tools.has(call.name)) throw new Error('Invalid, duplicate, or undeclared tool call')
          object(call.arguments)
          seen.add(call.id)
          pending.set(call.id, call.name)
        }
      }
    }
  }
  if (pending.size) throw new Error('All tool calls need results before requesting a response')
}

function geminiContents(request: MessageRequest): Content[] {
  const contents: Content[] = []
  const providerIds = new Map<string, string | undefined>()
  for (const message of request.messages) {
    if (message.role === 'user') contents.push({ role: 'user', parts: [{ text: message.content }] })
    if (message.role === 'assistant') {
      const parts: JsonObject[] = message.providerState?.parts ?? [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ functionCall: { id: call.id, name: call.name, args: call.arguments } })),
      ]
      const rawCalls = parts.filter(part => part.functionCall).map(part => object(part.functionCall))
      for (const [i, call] of (message.toolCalls ?? []).entries()) {
        providerIds.set(call.id, rawCalls[i]?.id as string | undefined)
      }
      contents.push({ role: 'model', parts })
    }
    if (message.role === 'tool') {
      const part = { functionResponse: { id: providerIds.get(message.toolCallId), name: message.name, response: { output: message.content } } }
      // Parallel function responses belong to one user turn in Gemini.
      const last = contents.at(-1)
      if (last?.role === 'user' && last.parts?.[0]?.functionResponse) last.parts.push(part)
      else contents.push({ role: 'user', parts: [part] })
    }
  }
  return contents
}

function openRouterMessages(request: MessageRequest): ObjectValue[] {
  return [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...request.messages.map(message => {
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: JSON.stringify(message.content) }
      if (message.role === 'user') return { role: 'user', content: message.content }
      return {
        role: 'assistant', content: message.content || null,
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
          id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) } : {}),
      }
    }),
  ]
}

/** SSE frames may span reads, UTF-8 code points, and CRLF boundaries. Never split on transport chunks. */
async function* sse(response: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('OpenRouter returned no stream body')
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        yield JSON.parse(data)
      }
      if (buffer.length > 1_048_576) throw new Error('Model stream frame exceeds 1 MiB')
      if (done) throw new Error('OpenRouter stream ended before [DONE]')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Internal transport adapter. Application callers use the instrumented entry points. */
export async function* messageEvents(
  request: MessageRequest,
  options: { model: string; gemini: GoogleGenAI; openrouterKey?: string; stream: boolean },
): AsyncGenerator<ModelEvent> {
  const isGemini = !options.model.includes('/')
  // `local/` ids speak the same OpenAI chat shape as OpenRouter, against the
  // operator's own server (#289): no OpenRouter key, no provider routing field.
  const isLocal = isLocalModel(options.model)
  const usage: UsageMetadata = { tokensIn: 0, tokensOut: 0 }
  let outputTokens = 0
  let thoughtTokens = 0
  const controller = new AbortController()
  const abort = () => controller.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) abort()
  const signal = controller.signal
  try {
    signal.throwIfAborted()
    validate(request, isGemini, options.model)
    let chunks: AsyncIterable<unknown>
    if (isGemini) {
      const params: GenerateContentParameters = {
        model: options.model,
        contents: geminiContents(request),
        config: {
          abortSignal: signal,
          systemInstruction: request.system,
          ...(request.tools?.length ? {
            tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }],
            toolConfig: { functionCallingConfig: { mode: ({ auto: 'AUTO', none: 'NONE', required: 'ANY' } as const)[request.toolChoice ?? 'auto'] as FunctionCallingConfigMode } },
          } : {}),
        },
      }
      if (options.stream) chunks = await options.gemini.models.generateContentStream(params)
      else {
        const response = await options.gemini.models.generateContent(params)
        chunks = (async function* () { yield response })()
      }
    } else {
      if (!isLocal && !options.openrouterKey) throw new Error('Message calls require a per-user OpenRouter key from instrumentation')
      const body = {
        model: isLocal ? localModelName(options.model) : options.model, messages: openRouterMessages(request), stream: options.stream,
        ...(isLocal ? {} : { provider: { require_parameters: true } }),
        ...(options.stream ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools?.length ? {
          tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
          tool_choice: request.toolChoice ?? 'auto',
        } : {}),
      }
      let response: Response
      if (isLocal) response = await localChatCompletion(body, signal)
      else {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${options.openrouterKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw Object.assign(new Error(`OpenRouter HTTP ${response.status}`), { status: response.status })
      }
      if (options.stream) chunks = sse(response, signal)
      else {
        const json: unknown = isLocal ? await readLocalJson(response) : await response.json()
        chunks = (async function* () { yield json })()
      }
    }

    let text = ''
    let finish: string | undefined
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    const geminiParts: JsonObject[] = []
    for await (const raw of chunks) {
      signal.throwIfAborted()
      const chunk = object(raw)
      const metadata = isGemini ? chunk.usageMetadata : chunk.usage
      if (metadata) {
        const data = object(metadata)
        const tokensIn = isGemini ? data.promptTokenCount : data.prompt_tokens
        const tokensOut = isGemini ? data.candidatesTokenCount : data.completion_tokens
        const thoughts = isGemini ? data.thoughtsTokenCount : undefined
        for (const count of [tokensIn, tokensOut, thoughts]) {
          if (count != null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid provider usage count')
        }
        if (typeof tokensIn === 'number') usage.tokensIn = tokensIn
        if (typeof tokensOut === 'number') outputTokens = tokensOut
        if (typeof thoughts === 'number') thoughtTokens = thoughts
        usage.tokensOut = outputTokens + thoughtTokens
        yield { type: 'usage', usage: { ...usage } }
      }
      signal.throwIfAborted()
      if (chunk.error) throw new Error(`Model stream error: ${String(object(chunk.error).message ?? 'provider failure')}`)
      if (isGemini) {
        const candidates = (chunk.candidates ?? []) as ObjectValue[]
        if (candidates.length > 1) throw new Error('Multiple model candidates are not supported')
        const candidate = candidates[0]
        if (!candidate) {
          if (chunk.promptFeedback) throw new Error('Gemini blocked the prompt')
          continue
        }
        if (candidate.finishReason) finish = String(candidate.finishReason)
        const parts = (candidate.content ? object(candidate.content).parts ?? [] : []) as JsonObject[]
        for (const part of parts) {
          if (Object.keys(part).some(key => !['text', 'functionCall', 'thought', 'thoughtSignature'].includes(key))) throw new Error('Unsupported Gemini response part')
          geminiParts.push(part)
          if (typeof part.text === 'string' && !part.thought) {
            text += part.text
            yield { type: 'text_delta', text: part.text }
          }
          if (part.functionCall) {
            const call = object(part.functionCall)
            if (Object.keys(call).some(key => !['id', 'name', 'args'].includes(key))) throw new Error('Partial Gemini tool arguments are not supported')
            const index = calls.size
            calls.set(index, { id: typeof call.id === 'string' ? call.id : nanoid(), name: String(call.name ?? ''), arguments: JSON.stringify(call.args ?? {}) })
          }
        }
      } else {
        const choices = (chunk.choices ?? []) as ObjectValue[]
        if (choices.length > 1 || (choices[0]?.index != null && choices[0].index !== 0)) throw new Error('Multiple model choices are not supported')
        const choice = choices[0]
        if (!choice) continue // Usage-only chunk after finish_reason is normal.
        if (choice.finish_reason) finish = String(choice.finish_reason)
        const delta = object((options.stream ? choice.delta : choice.message) ?? {})
        // Local reasoning models (Qwen3 on llama.cpp/vLLM) stream their thinking
        // as reasoning/reasoning_content. Drop it, as Gemini thought parts are
        // dropped above; OpenRouter still fails closed on it.
        const reasoning = !isLocal && (delta.reasoning || delta.reasoning_content || (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length))
        if (delta.function_call || reasoning || delta.refusal) {
          throw new Error('Unsupported OpenRouter reasoning, refusal, or legacy function call response')
        }
        if (delta.content != null && typeof delta.content !== 'string') throw new Error('Only text responses are supported')
        if (typeof delta.content === 'string') {
          text += delta.content
          yield { type: 'text_delta', text: delta.content }
        }
        for (const [position, rawCall] of ((delta.tool_calls ?? []) as ObjectValue[]).entries()) {
          const index = options.stream ? rawCall.index : position
          if (!Number.isInteger(index) || Number(index) < 0 || (rawCall.type && rawCall.type !== 'function')) throw new Error('Invalid streamed tool call')
          const call = calls.get(Number(index)) ?? { id: '', name: '', arguments: '' }
          const fn = object(rawCall.function ?? {})
          if (rawCall.id != null) {
            if (typeof rawCall.id !== 'string' || (call.id && call.id !== rawCall.id)) throw new Error('Conflicting streamed tool call id')
            call.id = rawCall.id
          }
          if (fn.name != null) {
            if (typeof fn.name !== 'string' || (call.name && call.name !== fn.name)) throw new Error('Conflicting streamed tool name')
            call.name = fn.name
          }
          if (fn.arguments != null && typeof fn.arguments !== 'string') throw new Error('Tool arguments must be JSON text')
          const fragment = (fn.arguments ?? '') as string
          call.arguments += fragment
          if (call.arguments.length > 1_048_576) throw new Error('Tool arguments exceed 1 MiB')
          calls.set(Number(index), call)
          yield { type: 'tool_call_delta', index: Number(index), id: call.id || undefined, name: call.name || undefined, arguments: fragment }
        }
      }
    }
    signal.throwIfAborted()
    const stop = isGemini ? 'STOP' : 'stop'
    const length = isGemini ? 'MAX_TOKENS' : 'length'
    if (finish !== stop && finish !== length && !(!isGemini && finish === 'tool_calls')) throw new Error(`Unsupported or missing model finish reason: ${finish}`)
    if (calls.size && (finish === length || (!isGemini && finish !== 'tool_calls'))) throw new Error('Incomplete tool call response')
    if (request.toolChoice === 'none' && calls.size) throw new Error('Model returned tools despite toolChoice none')
    if ((request.toolChoice === 'required' || finish === 'tool_calls') && !calls.size) throw new Error('Model did not return required tool calls')
    const ids = new Set<string>()
    const toolCalls: ModelToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
      if (!call.id || ids.has(call.id) || !request.tools?.some(tool => tool.name === call.name)) throw new Error('Invalid or undeclared model tool call')
      ids.add(call.id)
      return { id: call.id, name: call.name, arguments: object(JSON.parse(call.arguments)) as JsonObject }
    })
    const response: MessageResponse = {
      message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}),
        ...(isGemini ? { providerState: { provider: 'gemini', model: options.model, parts: geminiParts } as const } : {}),
      },
      usage: { ...usage }, finishReason: toolCalls.length ? 'tool_calls' : finish === length ? 'length' : 'stop',
    }
    yield { type: 'complete', response }
  } catch (error) {
    throw new ModelCallError(error, usage)
  } finally {
    controller.abort()
    request.signal?.removeEventListener('abort', abort)
  }
}
