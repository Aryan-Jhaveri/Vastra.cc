import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRequest, ModelEvent, ModelTool } from '../../src/ai/messages.js'

const { generateContent, generateContentStream, fetchMock } = vi.hoisted(() => ({
  generateContent: vi.fn(), generateContentStream: vi.fn(), fetchMock: vi.fn(),
}))
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent, generateContentStream }
  },
}))

const tool: ModelTool = { name: 'lookup', description: 'Read one item', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
const request: MessageRequest = { system: 'Be helpful', messages: [{ role: 'user', content: 'Find a shirt' }], tools: [tool] }
const model = 'mistralai/mistral-small-3.2-24b-instruct'

function jsonResponse(message: unknown, finish = 'stop', usage = { prompt_tokens: 9, completion_tokens: 4 }) {
  return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }], usage }), { headers: { 'Content-Type': 'application/json' } })
}

function streamResponse(chunks: unknown[], done = true, bytesPerRead = 7) {
  const wire = ': heartbeat\r\n\r\n' + chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '')
  const bytes = new TextEncoder().encode(wire)
  const cancel = vi.fn()
  return { cancel, response: new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += bytesPerRead) controller.enqueue(bytes.slice(i, i + bytesPerRead))
      controller.close()
    }, cancel,
  })) }
}

const delta = (value: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta: value, finish_reason }] })
async function collect(events: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.resetModules()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OPENROUTER_DISABLED', '')
  vi.stubEnv('OPENROUTER_API_KEY', 'master-must-not-be-used')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('message adapters', () => {
  it('roundtrips OpenRouter assistant calls and tool results without executing them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":"shirt"}' } }] }, 'tool_calls'))
    const { generateMessages } = await import('../../src/ai/client.js')
    const first = await generateMessages(request, model, 'user-key')
    expect(first.message).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 'shirt' } }] })
    expect(first.usage).toEqual({ tokensIn: 9, tokensOut: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstOptions = fetchMock.mock.calls[0][1]
    expect(firstOptions.headers.Authorization).toBe('Bearer user-key')
    expect(JSON.parse(firstOptions.body)).toMatchObject({
      model, messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Find a shirt' }],
      provider: { require_parameters: true }, tools: [{ type: 'function', function: { name: 'lookup', parameters: tool.parameters } }],
    })
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: 'Your blue shirt' }))
    const second = await generateMessages({ ...request, messages: [...request.messages, first.message, { role: 'tool', name: 'lookup', toolCallId: 'call-1', content: { color: 'blue' } }] }, model, 'user-key')
    expect(second.message.content).toBe('Your blue shirt')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":"shirt"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"color":"blue"}' },
    ])
  })

  it('roundtrips Gemini parallel calls and preserves thought signatures exactly', async () => {
    const parts = [
      { functionCall: { name: 'lookup', args: { id: 'shirt' } }, thoughtSignature: 'opaque-signature' },
      { functionCall: { id: 'native-id', name: 'lookup', args: { id: 'coat' } } },
    ]
    generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 } })
    const { generateMessages } = await import('../../src/ai/client.js')
    const first = await generateMessages(request, 'gemini-2.5-flash')
    expect(first.usage).toEqual({ tokensIn: 5, tokensOut: 5 })
    expect(first.message.toolCalls).toHaveLength(2)
    expect(first.message.providerState?.parts).toEqual(parts)
    generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [{ text: 'Both work' }] }, finishReason: 'STOP' }] })
    await generateMessages({ ...request, messages: [...request.messages, first.message, ...first.message.toolCalls!.map(call => ({ role: 'tool' as const, name: call.name, toolCallId: call.id, content: { found: true } }))] }, 'gemini-2.5-flash')
    expect(generateContent.mock.calls[1][0]).toMatchObject({
      config: { systemInstruction: 'Be helpful', tools: [{ functionDeclarations: [{ name: 'lookup', parametersJsonSchema: tool.parameters }] }] },
      contents: [
        { role: 'user', parts: [{ text: 'Find a shirt' }] },
        { role: 'model', parts },
        { role: 'user', parts: [
          { functionResponse: { name: 'lookup', response: { output: { found: true } } } },
          { functionResponse: { id: 'native-id', name: 'lookup', response: { output: { found: true } } } },
        ] },
      ],
    })
  })

  it('assembles UTF-8 SSE, parallel argument fragments, finish and trailing usage chunks', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([
      delta({ role: 'assistant', content: '' }),
      delta({ content: 'caf\u00e9' }),
      delta({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"id":' } }, { index: 1, id: 'b', type: 'function', function: { name: 'lookup', arguments: '{' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '"id":"coat"}' } }, { index: 0, function: { arguments: '"shirt"}' } }] }),
      delta({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 12 } },
    ], true, 1).response)
    const { streamMessages } = await import('../../src/ai/client.js')
    const events = await collect(streamMessages(request, model, 'user-key'))
    expect(events).toContainEqual({ type: 'text_delta', text: 'caf\u00e9' })
    expect(events.filter(event => event.type === 'tool_call_delta')).toHaveLength(4)
    expect(events.at(-1)).toMatchObject({ type: 'complete', response: {
      message: { content: 'caf\u00e9', toolCalls: [{ id: 'a', arguments: { id: 'shirt' } }, { id: 'b', arguments: { id: 'coat' } }] },
      usage: { tokensIn: 20, tokensOut: 12 }, finishReason: 'tool_calls',
    } })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toEqual({ include_usage: true })
  })

  it('streams real Gemini text chunks and complete function calls, including cumulative usage', async () => {
    generateContentStream.mockImplementation(async function* () {
      yield { candidates: [{ content: { parts: [{ text: 'Let me ' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }
      yield { candidates: [{ content: { parts: [{ text: 'check' }, { functionCall: { name: 'lookup', args: { id: 'shirt' } }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } }
    })
    const { streamMessages } = await import('../../src/ai/client.js')
    const events = await collect(streamMessages(request, 'gemini-2.5-flash'))
    expect(events.filter(event => event.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'Let me ' }, { type: 'text_delta', text: 'check' }])
    expect(events.at(-1)).toMatchObject({ type: 'complete', response: { message: { content: 'Let me check', toolCalls: [{ name: 'lookup', arguments: { id: 'shirt' } }] }, usage: { tokensIn: 4, tokensOut: 6 } } })
    expect(generateContent).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed arguments', [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'lookup', arguments: '{' } }] }), delta({}, 'tool_calls')], /JSON/],
    ['provider error', [{ error: { message: 'upstream failed' } }], /upstream failed/],
    ['missing finish', [delta({ content: 'partial' })], /finish reason/],
    ['undeclared tool', [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'delete_everything', arguments: '{}' } }] }), delta({}, 'tool_calls')], /undeclared/],
    ['truncated tool', [delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'lookup', arguments: '{}' } }] }), delta({}, 'length')], /Incomplete/],
    ['reasoning', [delta({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] })], /Unsupported/],
  ])('rejects %s and preserves last reported usage', async (_name, chunks, error) => {
    fetchMock.mockResolvedValueOnce(streamResponse([{ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } }, ...chunks]).response)
    const { streamMessages } = await import('../../src/ai/client.js')
    await expect(collect(streamMessages(request, model, 'user-key'))).rejects.toMatchObject({ message: expect.stringMatching(error), usage: { tokensIn: 8, tokensOut: 2 } })
  })

  it('does not treat premature EOF as successful completion', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([delta({ content: 'partial' }, 'stop')], false).response)
    const { streamMessages } = await import('../../src/ai/client.js')
    await expect(collect(streamMessages(request, model, 'user-key'))).rejects.toThrow('before [DONE]')
  })

  it('cancels a blocked stream read on AbortSignal without waiting for another chunk', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\n')) },
      cancel,
    })))
    const { streamMessages } = await import('../../src/ai/client.js')
    const controller = new AbortController()
    const stream = streamMessages({ ...request, signal: controller.signal }, model, 'user-key')
    expect((await stream.next()).value).toEqual({ type: 'usage', usage: { tokensIn: 7, tokensOut: 1 } })
    const pending = stream.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', usage: { tokensIn: 7, tokensOut: 1 } })
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('aborts transport and cancels reader when the consumer stops early', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: 'hi' }))}\n\n`)) }, cancel,
    })))
    const { streamMessages } = await import('../../src/ai/client.js')
    const stream = streamMessages(request, model, 'user-key')
    await stream.next()
    await stream.return()
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('propagates Gemini cancellation and closes its iterator', async () => {
    const closed = vi.fn()
    generateContentStream.mockImplementation(async function* () {
      try { yield { candidates: [{ content: { parts: [{ text: 'hi' }] } }] } }
      finally { closed() }
    })
    const { streamMessages } = await import('../../src/ai/client.js')
    const controller = new AbortController()
    const stream = streamMessages({ ...request, signal: controller.signal }, 'gemini-2.5-flash')
    await stream.next()
    controller.abort()
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(closed).toHaveBeenCalledOnce()
    expect(generateContentStream.mock.calls[0][0].config.abortSignal.aborted).toBe(true)
  })

  it('does not call a provider when already aborted or when tool history is invalid', async () => {
    const { generateMessages } = await import('../../src/ai/client.js')
    await expect(generateMessages({ ...request, signal: AbortSignal.abort() }, model, 'user-key')).rejects.toMatchObject({ name: 'AbortError' })
    await expect(generateMessages({ ...request, messages: [{ role: 'tool', name: 'lookup', toolCallId: 'unknown', content: {} }] }, model, 'user-key')).rejects.toThrow('matching pending call')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not silently use a master key or reroute disabled conversations', async () => {
    let client = await import('../../src/ai/client.js')
    await expect(client.generateMessages(request, model)).rejects.toThrow('per-user OpenRouter key')
    vi.stubEnv('OPENROUTER_DISABLED', 'true')
    vi.resetModules()
    client = await import('../../src/ai/client.js')
    await expect(client.generateMessages(request, model, 'user-key')).rejects.toThrow('disabled')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(generateContent).not.toHaveBeenCalled()
  })

  it('rejects provider-bound history on another model and partial Gemini function arguments', async () => {
    const { generateMessages } = await import('../../src/ai/client.js')
    await expect(generateMessages({ messages: [{ role: 'assistant', content: 'hi', providerState: { provider: 'gemini', model: 'other-model', parts: [{ text: 'hi' }] } }] }, 'gemini-2.5-flash')).rejects.toThrow('different provider/model')
    generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', partialArgs: [] } }] }, finishReason: 'STOP' }] })
    await expect(generateMessages(request, 'gemini-2.5-flash')).rejects.toThrow('Partial Gemini')
  })

  it('preserves shipped text/JSON helpers and usage on parse failures', async () => {
    const { generateText, generateJSON, generateJSONWithUsage } = await import('../../src/ai/client.js')
    generateContent.mockResolvedValueOnce({ text: 'plain text' })
    expect(await generateText('hello')).toBe('plain text')
    generateContent.mockResolvedValueOnce({ text: '```json\n{"ok":true}\n```' })
    expect(await generateJSON('hello')).toEqual({ ok: true })
    generateContent.mockResolvedValueOnce({ text: 'not JSON', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
    await expect(generateJSONWithUsage('hello')).rejects.toMatchObject({ usage: { tokensIn: 10, tokensOut: 5 } })
  })
})
