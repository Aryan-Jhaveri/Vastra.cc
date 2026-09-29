import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

// #352 — try-on / Make Pretty on the operator's image server. The fake below
// follows vLLM-Omni's documented /v1/images/edits contract (multipart, repeated
// `image` fields, data[0].b64_json), so the real FormData encoding is tested.
const { saveImage } = vi.hoisted(() => ({ saveImage: vi.fn(async (_b64: string, folder: string) => `images/${folder}/generated.jpg`) }))
vi.mock('../../src/storage/images.js', () => ({ saveImageFromBase64: saveImage, getUserImagesDir: vi.fn() }))

import {
  __resetImageGenUsers, ImageGenUserBusyError, imageGenMaxRefs, localImageEdit, selectGarmentViews, TooManyReferencesError,
} from '../../src/ai/localImage.js'
import { __resetModelServerSlots } from '../../src/ai/modelServers.js'
import { generateTryOn } from '../../src/ai/tryon.js'
import { generateHeroImage } from '../../src/ai/heroImage.js'

interface Seen { auth?: string; fields: Record<string, string>; images: Array<{ name: string; type: string; bytes: string }> }
const seen: Seen[] = []
let active = 0
let peak = 0
let delayMs = 0
let reply: () => { status: number; body: unknown } = () => ({ status: 200, body: { data: [{ b64_json: 'R0VORVJBVEVE' }], metrics: { peak_memory_mb: 30720 } } })
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer(async (req, res) => {
    active++
    peak = Math.max(peak, active)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData()
    const entry: Seen = { auth: req.headers.authorization, fields: {}, images: [] }
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') entry.fields[key] = value
      else entry.images.push({ name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()).toString('base64') })
    }
    seen.push({ ...entry, fields: { ...entry.fields, _path: req.url ?? '' } })
    await new Promise(r => setTimeout(r, delayMs))
    const { status, body } = reply()
    active--
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => new Promise<void>(r => server.close(() => r())))

beforeEach(() => {
  seen.length = 0
  active = 0
  peak = 0
  delayMs = 0
  reply = () => ({ status: 200, body: { data: [{ b64_json: 'R0VORVJBVEVE' }], metrics: { peak_memory_mb: 30720 } } })
  __resetModelServerSlots()
  __resetImageGenUsers()
  saveImage.mockClear()
  vi.stubEnv('IMAGE_GEN_BASE_URL', base)
  vi.stubEnv('IMAGE_GEN_API_KEY', 'img-key')
  vi.stubEnv('IMAGE_GEN_MODEL', 'local/Qwen/Qwen-Image-2.1')
  for (const n of ['IMAGE_GEN_MAX_REFS', 'IMAGE_GEN_STEPS', 'IMAGE_GEN_TRUE_CFG', 'IMAGE_GEN_SEED', 'IMAGE_GEN_SIZE', 'IMAGE_GEN_MAX_PER_USER', 'IMAGE_GEN_MAX_CONCURRENCY', 'MOCK_AI_IMAGE_GEN']) vi.stubEnv(n, '')
})
afterEach(() => vi.unstubAllEnvs())

const b64 = (s: string) => Buffer.from(s).toString('base64')
const edit = (over: Partial<Parameters<typeof localImageEdit>[0]> = {}) =>
  localImageEdit({ model: 'local/Qwen/Qwen-Image-2.1', prompt: 'dress them', images: [b64('garment'), b64('person')], userId: 'alice', ...over })

describe('localImageEdit — wire format', () => {
  it('posts multipart to /images/edits with repeated image fields and the vLLM-Omni form fields', async () => {
    const result = await edit({ steps: 40, trueCfgScale: 1 })
    expect(result).toEqual({ data: 'R0VORVJBVEVE', peakMemoryMb: 30720 })
    const [req] = seen
    expect(req.fields._path).toBe('/v1/images/edits')
    expect(req.auth).toBe('Bearer img-key')
    expect(req.fields).toMatchObject({
      model: 'Qwen/Qwen-Image-2.1', prompt: 'dress them', n: '1', response_format: 'b64_json', output_format: 'jpeg',
      num_inference_steps: '40', true_cfg_scale: '1',
    })
    expect(req.fields.size).toBeUndefined()
    expect(req.images.map(i => [i.name, i.type, i.bytes])).toEqual([
      ['ref-1.jpg', 'image/jpeg', b64('garment')],
      ['ref-2.jpg', 'image/jpeg', b64('person')],
    ])
  })

  it('operator env overrides steps / cfg / seed / size', async () => {
    vi.stubEnv('IMAGE_GEN_STEPS', '20')
    vi.stubEnv('IMAGE_GEN_TRUE_CFG', '4')
    vi.stubEnv('IMAGE_GEN_SEED', '7')
    vi.stubEnv('IMAGE_GEN_SIZE', '1024x1024')
    await edit({ steps: 40, trueCfgScale: 1 })
    expect(seen[0].fields).toMatchObject({ num_inference_steps: '20', true_cfg_scale: '4', seed: '7', size: '1024x1024' })
  })

  it('never puts the user id on the wire', async () => {
    await edit({ userId: 'user-secret-id' })
    expect(JSON.stringify(seen)).not.toContain('user-secret-id')
  })

  it('refuses more references than IMAGE_GEN_MAX_REFS before sending anything', async () => {
    expect(imageGenMaxRefs()).toBe(4)
    await expect(edit({ images: Array(5).fill(b64('x')) })).rejects.toBeInstanceOf(TooManyReferencesError)
    expect(seen).toHaveLength(0)
  })

  it('fails clearly on a response without data[0].b64_json, and on HTTP errors (key redacted)', async () => {
    reply = () => ({ status: 200, body: { data: [] } })
    await expect(edit()).rejects.toThrow(/data\[0\]\.b64_json/)
    reply = () => ({ status: 422, body: { detail: "Field 'image' or 'url' is required img-key" } })
    await expect(edit()).rejects.toMatchObject({ status: 422, message: expect.stringContaining('[redacted]') })
  })
})

describe('localImageEdit — load', () => {
  it('runs one generation at a time on the server by default', async () => {
    delayMs = 30
    await Promise.all([edit({ userId: 'a' }), edit({ userId: 'b' }), edit({ userId: 'c' })])
    expect(seen).toHaveLength(3)
    expect(peak).toBe(1)
  })

  it('a user gets one generation in flight; a second is refused (429) while others still queue', async () => {
    delayMs = 30
    const first = edit({ userId: 'alice' })
    const second = edit({ userId: 'alice' })
    const other = edit({ userId: 'bob' })
    await expect(second).rejects.toBeInstanceOf(ImageGenUserBusyError)
    await expect(first).resolves.toMatchObject({ data: 'R0VORVJBVEVE' })
    await expect(other).resolves.toMatchObject({ data: 'R0VORVJBVEVE' })
    // alice can go again once her first finished, even if it failed
    reply = () => ({ status: 500, body: {} })
    await expect(edit({ userId: 'alice' })).rejects.toMatchObject({ status: 500 })
    reply = () => ({ status: 200, body: { data: [{ b64_json: 'QQ==' }] } })
    await expect(edit({ userId: 'alice' })).resolves.toEqual({ data: 'QQ==' })
  })
})

describe('selectGarmentViews', () => {
  it('gives every garment its first view before any second view, and counts what was dropped', () => {
    const groups = [['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1']]
    expect(selectGarmentViews(groups, 3)).toEqual({ selected: ['a1', 'b1', 'c1'], droppedViews: 3 })
    expect(selectGarmentViews(groups, 5)).toEqual({ selected: ['a1', 'a2', 'b1', 'b2', 'c1'], droppedViews: 1 })
    expect(selectGarmentViews(groups, 10)).toEqual({ selected: ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'], droppedViews: 0 })
  })

  it('refuses more garments than slots instead of silently leaving one out', () => {
    expect(() => selectGarmentViews([['a'], ['b'], ['c'], ['d']], 3)).toThrow(TooManyReferencesError)
  })
})

describe('try-on and Make Pretty on the local image server', () => {
  it('try-on sends garments first and the person last, with the try-on prompt, and saves the result', async () => {
    const uri = await generateTryOn(b64('person'), [b64('top'), b64('jeans')], 'alice', ['Top: tee', 'Bottom: jeans'])
    expect(uri).toBe('images/tryon/generated.jpg')
    expect(saveImage).toHaveBeenCalledWith('R0VORVJBVEVE', 'tryon', 'alice')
    expect(seen[0].images.map(i => i.bytes)).toEqual([b64('top'), b64('jeans'), b64('person')])
    expect(seen[0].fields.prompt).toContain('Image 3 (the LAST image) is the PERSON')
  })

  it('Make Pretty uses the recipe settings (40 steps, true CFG 1.0) and saves into items', async () => {
    const uri = await generateHeroImage([b64('front'), b64('back')], 'alice', 'Item: tops')
    expect(uri).toBe('images/items/generated.jpg')
    expect(seen[0].fields).toMatchObject({ num_inference_steps: '40', true_cfg_scale: '1' })
    expect(seen[0].fields.prompt).toContain('from 2 reference photo(s)')
    expect(seen[0].fields.prompt).toContain('Additional instruction: Item: tops')
  })
})
