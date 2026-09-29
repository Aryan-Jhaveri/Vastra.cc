#!/usr/bin/env tsx
/**
 * #296 Phase 0 — measure the self-hosted model stack on a rented GPU, so the
 * paid hours go on measuring, not setting up. It calls the models through
 * Vastra's own clients (the same code path users hit), reads the model
 * servers from .env exactly like the app, and samples GPU memory with
 * nvidia-smi while it runs.
 *
 *   node --import tsx scripts/bench-models.ts <command> [options]
 *
 * Commands
 *   latency            p50/p95 per capability at each concurrency level
 *   export-decisions   build a decisions fixture from a user's saved outfits (run where the DB is)
 *   decisions          run a fixture on the configured provider; compare to a saved baseline
 *   export-recall      build a retrieval fixture (+ images) from a user's items (run where the DB is)
 *   recall             recall@10 / MRR of the configured embedding model on a fixture
 *   tryon              try-on for every person × garment set; writes a rating sheet
 *   all                latency + every fixture given, one report
 *
 * Options
 *   --out DIR              results folder (default bench-results/<timestamp>)
 *   --only a,b             latency: chat,image,embed,decisions (default: every local one)
 *   --runs N               latency: requests per level (default 8)
 *   --concurrency 1,4      latency: in-flight levels (default 1,4)
 *   --steps N              image steps (default 40, the Make Pretty recipe)
 *   --user ID              export-*: whose data (default self)
 *   --fixture PATH         decisions / recall input
 *   --baseline PATH        decisions: saved answers (e.g. Jev); recall: saved results
 *   --save-answers PATH    decisions: save this run's answers (make a baseline)
 *   --dir PATH             tryon: persons/*.jpg and garments/<set>/*.jpg
 *   --decisions-fixture, --decisions-baseline, --recall-fixture, --recall-baseline, --tryon-dir   for `all`
 *
 * The Jev baseline: run `decisions --fixture f --save-answers jev.json` on a
 * machine with OPENROUTER_API_KEY and DECISIONS_PROVIDER unset (Jev), then on
 * the GPU box `decisions --fixture f --baseline jev.json` with CLM configured.
 * The Vertex recall baseline works the same way with the Google embedding env.
 *
 * Fixtures come from your own closet and stay private: keep them out of git
 * (bench-results/ is ignored). Nothing identifying a user goes into a
 * fixture: questions are keyed by item/outfit ids, as in production.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import sharp from 'sharp'
import {
  mean, meanAbsDiff, parseNvidiaSmiLine, reciprocalRank, recallAtK, spearman, summarize, topK, topKOverlap,
  validateDecisionsFixture, validateRecallFixture,
  type DecisionsAnswers, type DecisionsFixture, type GpuSample, type LatencySummary, type RecallFixture,
} from './bench/metrics.js'

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' }, only: { type: 'string' }, runs: { type: 'string' }, concurrency: { type: 'string' },
    steps: { type: 'string' }, user: { type: 'string' }, fixture: { type: 'string' }, baseline: { type: 'string' },
    'save-answers': { type: 'string' }, dir: { type: 'string' },
    'decisions-fixture': { type: 'string' }, 'decisions-baseline': { type: 'string' },
    'recall-fixture': { type: 'string' }, 'recall-baseline': { type: 'string' }, 'tryon-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const command = positionals[0]
if (!command || opts.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 40).map(l => l.replace(/^ \*\/?\s?/, '')).join('\n'))
  process.exit(command ? 0 : 2)
}

// export-* commands write their fixture to --out (a file for decisions, a
// folder for recall); every other command writes a results folder there.
const isExport = command.startsWith('export-')
const outDir = resolve(opts.out && !isExport ? opts.out : join('bench-results', new Date().toISOString().replace(/[:.]/g, '-')))
if (!isExport) mkdirSync(outDir, { recursive: true })
const report: string[] = [`# Model benchmark — ${new Date().toISOString()}`, '', `Command: \`${process.argv.slice(2).join(' ')}\``, '']
const results: Record<string, unknown> = { startedAt: new Date().toISOString(), command: process.argv.slice(2) }

const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '—')
const num = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '—')
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

// ─── GPU sampling ────────────────────────────────────────────────────────────

class GpuSampler {
  private proc: ChildProcess | null = null
  private peak = new Map<number, GpuSample>()
  available = false

  start(): void {
    try {
      this.proc = spawn('nvidia-smi', ['--query-gpu=index,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits', '-lms', '500'])
    } catch { return }
    this.proc.on('error', () => { this.available = false })
    let buf = ''
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = parseNvidiaSmiLine(line)
        if (!s) continue
        this.available = true
        const prev = this.peak.get(s.index)
        if (!prev || s.usedMb > prev.usedMb) this.peak.set(s.index, s)
      }
    })
  }

  stop(): GpuSample[] {
    // Only signal a child that really started. A spawn that failed (no
    // nvidia-smi, e.g. on a Mac) has no pid yet in the same tick, and killing
    // it then signals our own process group, taking the shell down with it.
    if (this.proc?.pid !== undefined && this.proc.exitCode === null && !this.proc.killed) this.proc.kill()
    return [...this.peak.values()].sort((a, b) => a.index - b.index)
  }
}

// ─── Latency ─────────────────────────────────────────────────────────────────

type Capability = 'chat' | 'image' | 'embed' | 'decisions'

async function probeImage(size: number, shade: number): Promise<string> {
  const buf = await sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 200 - shade / 2, b: 180 } } }).jpeg().toBuffer()
  return buf.toString('base64')
}

async function capabilityCalls(): Promise<Partial<Record<Capability, (i: number) => Promise<{ peakMemoryMb?: number }>>>> {
  const { isLocalModel } = await import('../src/ai/localModel.js')
  const calls: Partial<Record<Capability, (i: number) => Promise<{ peakMemoryMb?: number }>>> = {}

  const vision = process.env.VISION_MODEL ?? ''
  if (isLocalModel(vision)) {
    const { generateTextWithUsage } = await import('../src/ai/client.js')
    const img = await probeImage(512, 40)
    calls.chat = async () => { await generateTextWithUsage('Describe this garment in one short sentence.', img, vision); return {} }
  }

  const { imageGenModel, isLocalImageGen, localImageEdit } = await import('../src/ai/localImage.js')
  if (isLocalImageGen()) {
    const steps = Number(opts.steps ?? 40)
    const garment = await probeImage(768, 120)
    const person = await probeImage(1024, 200)
    calls.image = async (i) => localImageEdit({
      model: imageGenModel(), prompt: 'Dress the person in image 2 in the garment from image 1.',
      images: [garment, person], userId: `bench-${i}`, steps,
    })
  }

  const emb = await import('../src/storage/embeddings.js')
  if (isLocalModel(emb.TEXT_EMBED_MODEL) || isLocalModel(emb.IMAGE_EMBED_MODEL)) {
    const { localEmbedText, localEmbedImage } = await import('../src/ai/localEmbed.js')
    const img = Buffer.from(await probeImage(512, 90), 'base64')
    calls.embed = async (i) => {
      if (isLocalModel(emb.TEXT_EMBED_MODEL)) await localEmbedText(`navy wool overcoat, variant ${i}`, emb.TEXT_EMBED_MODEL, emb.TEXT_EMBED_DIM)
      if (isLocalModel(emb.IMAGE_EMBED_MODEL)) await localEmbedImage(img, emb.IMAGE_EMBED_MODEL, emb.IMAGE_EMBED_DIM)
      return {}
    }
  }

  const { decisionsProviderInfo, generateDecisions } = await import('../src/ai/decisions.js')
  const info = decisionsProviderInfo()
  if (info?.kind === 'typesafe') {
    const questions = Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`q${k}`, {
      type: 'noul' as const,
      instructions: `Is this outfit a good pick for the given context? Outfit JSON: ${JSON.stringify({ name: `Look ${k}`, items: [{ category: 'tops', subcategory: k % 2 ? 'wool jumper' : 'linen shirt' }] })}`,
    }]))
    calls.decisions = async () => { await generateDecisions({ weather: { temperature_c: 4, condition: 'Rain' }, occasion: 'work' }, questions); return {} }
  }
  return calls
}

const LIMIT_ENV: Record<Capability, string> = {
  chat: 'OPENAI_COMPAT_MAX_CONCURRENCY', image: 'IMAGE_GEN_MAX_CONCURRENCY', embed: 'EMBED_MAX_CONCURRENCY', decisions: 'DECISIONS_MAX_CONCURRENCY',
}

async function runLatency(): Promise<void> {
  const runs = Number(opts.runs ?? 8)
  const levels = (opts.concurrency ?? '1,4').split(',').map(Number).filter(n => n > 0)
  const only = opts.only ? new Set(opts.only.split(',')) : null
  const calls = await capabilityCalls()
  const table: Array<{ capability: Capability; concurrency: number; summary: LatencySummary; errors: number; peakMemoryMb?: number }> = []

  for (const cap of Object.keys(calls) as Capability[]) {
    if (only && !only.has(cap)) continue
    const call = calls[cap]!
    const saved = process.env[LIMIT_ENV[cap]]
    try { await call(-1) } catch (err) { console.warn(`[${cap}] warm-up failed: ${(err as Error).message}`) }
    for (const c of levels) {
      // Let the app-side limiter admit `c` at once, so this measures the server.
      process.env[LIMIT_ENV[cap]] = String(c)
      process.env.IMAGE_GEN_MAX_PER_USER = String(c)
      const times: number[] = []
      let errors = 0
      let peak: number | undefined
      let next = 0
      await Promise.all(Array.from({ length: c }, async () => {
        while (next < runs) {
          const i = next++
          const t = performance.now()
          try {
            const r = await call(i)
            times.push(performance.now() - t)
            if (r.peakMemoryMb !== undefined) peak = Math.max(peak ?? 0, r.peakMemoryMb)
          } catch (err) {
            errors++
            console.warn(`[${cap} c=${c}] ${(err as Error).message}`)
          }
        }
      }))
      const summary = summarize(times)
      table.push({ capability: cap, concurrency: c, summary, errors, peakMemoryMb: peak })
      console.log(`[${cap} c=${c}] p50 ${ms(summary.p50)} p95 ${ms(summary.p95)} errors ${errors}`)
    }
    if (saved === undefined) delete process.env[LIMIT_ENV[cap]]
    else process.env[LIMIT_ENV[cap]] = saved
  }

  results.latency = table
  report.push('## Latency', '', '| Capability | In flight | n | p50 | p95 | mean | errors | server peak MB |', '|---|---|---|---|---|---|---|---|')
  for (const r of table) {
    report.push(`| ${r.capability} | ${r.concurrency} | ${r.summary.n} | ${ms(r.summary.p50)} | ${ms(r.summary.p95)} | ${ms(r.summary.mean)} | ${r.errors} | ${r.peakMemoryMb ?? '—'} |`)
  }
  if (!table.length) report.push('', 'No local capability is configured (set local/ models and their *_BASE_URL).')
  report.push('')
}

// ─── Decisions agreement ─────────────────────────────────────────────────────

async function exportDecisions(): Promise<void> {
  const userId = opts.user ?? 'self'
  const { listItems } = await import('../src/tools/items.js')
  const { listOutfits } = await import('../src/tools/outfits.js')
  const { outfitDecisionBlob } = await import('../src/ai/decisionText.js')
  const { buildJevState, suggestOutfitQuestion } = await import('../src/ai/suggest.js')
  const items = await listItems({}, userId)
  const byId = new Map(items.map(i => [i.id, i]))
  const questions: DecisionsFixture['cases'][number]['questions'] = {}
  for (const outfit of await listOutfits({}, userId)) {
    const blob = outfitDecisionBlob(outfit, byId)
    if (blob.items.length) questions[`q_${outfit.id}`] = suggestOutfitQuestion(blob)
  }
  if (!Object.keys(questions).length) throw new Error(`user ${userId} has no outfits with items to rank`)
  const contexts: Array<[string, Parameters<typeof buildJevState>]> = [
    ['rainy_work_morning', [{ temperature: 9, condition: 'Rain', precipitation: 6, windSpeed: 18 } as never, undefined, 'work', 'morning', 'Tuesday']],
    ['hot_weekend_afternoon', [{ temperature: 31, condition: 'Clear sky', precipitation: 0, windSpeed: 6 } as never, undefined, 'casual', 'afternoon', 'Saturday']],
    ['cold_evening_party', [{ temperature: -3, condition: 'Snow', precipitation: 2, windSpeed: 12 } as never, undefined, 'party', 'evening', 'Friday']],
    ['mild_date_night', [{ temperature: 16, condition: 'Partly cloudy', precipitation: 0, windSpeed: 9 } as never, 'date night', undefined, 'evening', 'Friday']],
    ['windy_travel_day', [{ temperature: 12, condition: 'Overcast', precipitation: 0, windSpeed: 35 } as never, undefined, 'travel', 'morning', 'Sunday']],
  ]
  const fixture: DecisionsFixture = { version: 1, cases: contexts.map(([id, args]) => ({ id, state: buildJevState(...args), questions })) }
  const file = resolve(opts.out ?? join(outDir, 'decisions-fixture.json'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(fixture, null, 2))
  console.log(`Wrote ${file}: ${fixture.cases.length} contexts × ${Object.keys(questions).length} outfits`)
}

async function runDecisions(fixturePath: string, baselinePath?: string): Promise<void> {
  const fixture = validateDecisionsFixture(readJson(fixturePath))
  const { decisionsProviderInfo, generateDecisions } = await import('../src/ai/decisions.js')
  const info = decisionsProviderInfo()
  if (!info) throw new Error('No decision provider configured')
  const answers: DecisionsAnswers = { version: 1, provider: info.kind, model: info.model, cases: {} }
  const times: number[] = []
  for (const c of fixture.cases) {
    const t = performance.now()
    const r = await generateDecisions(c.state as never, c.questions as never)
    times.push(performance.now() - t)
    answers.cases[c.id] = Object.fromEntries(Object.entries(r.answers).filter(([, a]) => a.type === 'noul').map(([q, a]) => [q, (a as { noul: number }).noul]))
  }
  if (opts['save-answers']) writeFileSync(resolve(opts['save-answers']), JSON.stringify(answers, null, 2))
  writeFileSync(join(outDir, 'decisions-answers.json'), JSON.stringify(answers, null, 2))

  const lat = summarize(times)
  report.push('## Decisions', '', `Provider: ${info.kind} (${info.model}); ${fixture.cases.length} cases; per-call p50 ${ms(lat.p50)}, p95 ${ms(lat.p95)}.`, '')
  const out: Record<string, unknown> = { provider: info, latency: lat }
  if (baselinePath) {
    const base = readJson(baselinePath) as DecisionsAnswers
    const rows = fixture.cases.map(c => {
      const a = answers.cases[c.id] ?? {}
      const b = base.cases?.[c.id] ?? {}
      return {
        id: c.id, spearman: spearman(a, b), top1: topK(a, 1)[0] !== undefined && topK(a, 1)[0] === topK(b, 1)[0] ? 1 : 0,
        top3: topKOverlap(a, b, 3), top5: topKOverlap(a, b, 5), meanAbsDiff: meanAbsDiff(a, b),
      }
    })
    out.agreement = { baseline: { provider: base.provider, model: base.model }, rows,
      mean: { spearman: mean(rows.map(r => r.spearman)), top1: mean(rows.map(r => r.top1)), top3: mean(rows.map(r => r.top3)), top5: mean(rows.map(r => r.top5)), meanAbsDiff: mean(rows.map(r => r.meanAbsDiff)) } }
    report.push(`Agreement with ${base.provider} (${base.model}):`, '', '| Case | Spearman | Top-1 same | Top-3 overlap | Top-5 overlap | Mean abs diff |', '|---|---|---|---|---|---|')
    for (const r of rows) report.push(`| ${r.id} | ${num(r.spearman)} | ${r.top1 ? 'yes' : 'no'} | ${num(r.top3, 2)} | ${num(r.top5, 2)} | ${num(r.meanAbsDiff)} |`)
    const m = (out.agreement as { mean: Record<string, number> }).mean
    report.push(`| **mean** | **${num(m.spearman)}** | **${num(m.top1, 2)}** | **${num(m.top3, 2)}** | **${num(m.top5, 2)}** | **${num(m.meanAbsDiff)}** |`, '')
  }
  results.decisions = out
}

// ─── Retrieval recall ────────────────────────────────────────────────────────

async function exportRecall(): Promise<void> {
  const userId = opts.user ?? 'self'
  const { listItems } = await import('../src/tools/items.js')
  const { textItemSourceBlob } = await import('../src/ai/embed.js')
  const { resolveImagePath } = await import('../src/storage/images.js')
  const dir = resolve(opts.out ?? join(outDir, 'recall-fixture'))
  mkdirSync(join(dir, 'images'), { recursive: true })
  const items = await listItems({}, userId)
  const docs: RecallFixture['docs'] = []
  for (const item of items) {
    const doc: RecallFixture['docs'][number] = { id: item.id, text: textItemSourceBlob(item) }
    const src = item.imageUri ? resolveImagePath(item.imageUri, userId) : ''
    if (src && existsSync(src)) {
      const rel = join('images', `${item.id}${extname(src) || '.jpg'}`)
      copyFileSync(src, join(dir, rel))
      doc.image = rel
    }
    docs.push(doc)
  }
  const groups = new Map<string, { kind: string; text: string; ids: string[] }>()
  const add = (key: string, kind: string, text: string, id: string) => {
    const g = groups.get(key) ?? { kind, text, ids: [] }
    g.ids.push(id)
    groups.set(key, g)
  }
  for (const item of items) {
    let occasions: string[] = []
    try { occasions = JSON.parse(item.occasion ?? '[]') } catch { /* ignore */ }
    for (const o of occasions) add(`occasion:${o}`, 'occasion', `something to wear for ${o}`, item.id)
    if (item.subcategory) add(`subcategory:${item.subcategory}`, 'subcategory', `a ${item.subcategory}`, item.id)
    if (item.primaryColor && item.category) add(`colour:${item.primaryColor}:${item.category}`, 'colour', `${item.primaryColor} ${item.category}`, item.id)
  }
  const queries = [...groups.entries()]
    // Skip queries nearly everything answers (they'd score well by chance).
    .filter(([, g]) => g.ids.length >= 2 && g.ids.length <= Math.max(2, Math.floor(items.length / 2)))
    .map(([key, g]) => ({ id: key, kind: g.kind, text: g.text, relevant: g.ids }))
  const fixture: RecallFixture = { version: 1, docs, queries }
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2))
  console.log(`Wrote ${dir}/fixture.json: ${docs.length} docs (${docs.filter(d => d.image).length} with images), ${queries.length} queries`)
}

function cosineRank(query: Float32Array, docs: Map<string, Float32Array>): string[] {
  const scored: Array<[string, number]> = []
  for (const [id, v] of docs) {
    let dot = 0
    for (let i = 0; i < Math.min(query.length, v.length); i++) dot += query[i] * v[i]
    scored.push([id, dot])
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

async function runRecall(fixturePath: string, baselinePath?: string): Promise<void> {
  const fixture = validateRecallFixture(readJson(fixturePath))
  const root = dirname(resolve(fixturePath))
  const { embedText } = await import('../src/ai/embed.js')
  const { embedImage } = await import('../src/ai/embedImage.js')
  const emb = await import('../src/storage/embeddings.js')
  const textDocs = new Map<string, Float32Array>()
  const imageDocs = new Map<string, Float32Array>()
  const times: number[] = []
  for (const d of fixture.docs) {
    if (d.text) { const t = performance.now(); textDocs.set(d.id, await embedText(d.text)); times.push(performance.now() - t) }
    if (d.image) { const t = performance.now(); imageDocs.set(d.id, await embedImage(readFileSync(join(root, d.image)))); times.push(performance.now() - t) }
  }
  // Text → image only makes sense when both live in one space (same model + dim).
  const shared = emb.TEXT_EMBED_MODEL_VERSION === emb.IMAGE_EMBED_MODEL_VERSION
  const modes: Array<[string, Map<string, Float32Array>]> = [['text→text', textDocs]]
  if (shared && imageDocs.size) modes.push(['text→image', imageDocs])
  const rows: Array<{ mode: string; kind: string; n: number; recall10: number; mrr: number }> = []
  const queryVecs = new Map<string, Float32Array>()
  for (const q of fixture.queries) queryVecs.set(q.id, await embedText(q.text))
  for (const [mode, docs] of modes) {
    if (!docs.size) continue
    const byKind = new Map<string, { r: number[]; m: number[] }>()
    for (const q of fixture.queries) {
      const ranked = cosineRank(queryVecs.get(q.id)!, docs)
      const rel = new Set(q.relevant.filter(id => docs.has(id)))
      if (!rel.size) continue
      for (const kind of [q.kind, 'all']) {
        const g = byKind.get(kind) ?? { r: [], m: [] }
        g.r.push(recallAtK(ranked, rel, 10))
        g.m.push(reciprocalRank(ranked, rel))
        byKind.set(kind, g)
      }
    }
    for (const [kind, g] of byKind) rows.push({ mode, kind, n: g.r.length, recall10: mean(g.r), mrr: mean(g.m) })
  }
  const out = { textModel: emb.TEXT_EMBED_MODEL_VERSION, imageModel: emb.IMAGE_EMBED_MODEL_VERSION, embedLatency: summarize(times), rows }
  writeFileSync(join(outDir, 'recall-results.json'), JSON.stringify(out, null, 2))
  results.recall = out
  const base = baselinePath ? readJson(baselinePath) as typeof out : null
  const baseRow = (mode: string, kind: string) => base?.rows.find(r => r.mode === mode && r.kind === kind)
  report.push('## Retrieval', '', `Text model ${out.textModel}, image model ${out.imageModel}; per-embed p50 ${ms(out.embedLatency.p50)}.${base ? ` Baseline: ${base.textModel} / ${base.imageModel}.` : ''}`, '',
    `| Mode | Queries | n | recall@10 | MRR |${base ? ' baseline recall@10 | Δ |' : ''}`, `|---|---|---|---|---|${base ? '---|---|' : ''}`)
  for (const r of rows) {
    const b = baseRow(r.mode, r.kind)
    report.push(`| ${r.mode} | ${r.kind} | ${r.n} | ${num(r.recall10)} | ${num(r.mrr)} |${base ? ` ${b ? num(b.recall10) : '—'} | ${b ? num(r.recall10 - b.recall10) : '—'} |` : ''}`)
  }
  report.push('')
}

// ─── Try-on rating sheet ─────────────────────────────────────────────────────

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const imagesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(f => IMAGE_EXT.has(extname(f).toLowerCase())).sort().map(f => join(dir, f)) : [])

async function runTryon(dir: string): Promise<void> {
  const { buildPrompt } = await import('../src/ai/tryon.js')
  const { imageGenMaxRefs, imageGenModel, isLocalImageGen, localImageEdit } = await import('../src/ai/localImage.js')
  if (!isLocalImageGen()) throw new Error('IMAGE_GEN_MODEL is not a local/ model')
  const persons = imagesIn(join(dir, 'persons'))
  const sets = existsSync(join(dir, 'garments')) ? readdirSync(join(dir, 'garments')).filter(s => imagesIn(join(dir, 'garments', s)).length) : []
  if (!persons.length || !sets.length) throw new Error(`${dir} needs persons/*.jpg and garments/<set>/*.jpg`)
  const outImages = join(outDir, 'tryon')
  mkdirSync(outImages, { recursive: true })
  const steps = Number(opts.steps ?? 40)
  // Match the app: garments compressed to 1200px JPEG, person padded square.
  const garment = async (p: string) => (await sharp(p).rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()).toString('base64')
  const person = async (p: string) => (await sharp(p).rotate().resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 90 }).toBuffer()).toString('base64')

  const rows: string[] = ['person,garment_set,output,latency_ms,server_peak_mb,error,identity_1to5,garment_fidelity_1to5,pose_1to5,artifacts_1to5,overall_1to5,notes']
  const cells: string[] = []
  for (const p of persons) {
    const personB64 = await person(p)
    for (const set of sets) {
      const garments = await Promise.all(imagesIn(join(dir, 'garments', set)).slice(0, imageGenMaxRefs() - 1).map(garment))
      const name = `${basename(p, extname(p))}__${set}.jpg`
      const t = performance.now()
      let error = ''
      let peak = ''
      try {
        const r = await localImageEdit({ model: imageGenModel(), prompt: buildPrompt(garments.length), images: [...garments, personB64], userId: 'bench', steps })
        writeFileSync(join(outImages, name), Buffer.from(r.data, 'base64'))
        peak = r.peakMemoryMb !== undefined ? String(r.peakMemoryMb) : ''
      } catch (err) {
        error = (err as Error).message.replace(/[,\n]/g, ' ')
      }
      const latency = Math.round(performance.now() - t)
      console.log(`[tryon] ${name} ${latency} ms ${error || 'ok'}`)
      rows.push([basename(p), set, error ? '' : `tryon/${name}`, latency, peak, error, '', '', '', '', '', ''].join(','))
      cells.push(`<figure><img src="tryon/${name}" alt=""><figcaption>${basename(p)} × ${set} · ${latency} ms${error ? ` · ${error}` : ''}</figcaption></figure>`)
    }
  }
  writeFileSync(join(outDir, 'tryon-ratings.csv'), rows.join('\n') + '\n')
  writeFileSync(join(outDir, 'tryon-sheet.html'), `<!doctype html><meta charset="utf-8"><title>Try-on rating sheet</title>
<style>body{font:14px system-ui;margin:16px}div{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}img{width:100%;border:1px solid #ccc}figure{margin:0}</style>
<h1>Try-on rating sheet</h1><p>Rate each result 1–5 in tryon-ratings.csv (identity, garment fidelity, pose, artifacts, overall). Gate (#352): overall ≥ 4 across ≥ 5 person photos, and no group rated worse than the others.</p>
<div>${cells.join('\n')}</div>`)
  results.tryon = { persons: persons.length, sets: sets.length, results: rows.length - 1 }
  report.push('## Try-on', '', `${persons.length} person photos × ${sets.length} garment sets at ${steps} steps. Rate them in \`tryon-ratings.csv\` using \`tryon-sheet.html\`.`, '')
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sampler = new GpuSampler()
sampler.start()
try {
  switch (command) {
    case 'latency': await runLatency(); break
    case 'export-decisions': await exportDecisions(); break
    case 'decisions': await runDecisions(opts.fixture ?? '', opts.baseline); break
    case 'export-recall': await exportRecall(); break
    case 'recall': await runRecall(opts.fixture ?? '', opts.baseline); break
    case 'tryon': await runTryon(opts.dir ?? ''); break
    case 'all':
      await runLatency()
      if (opts['decisions-fixture']) await runDecisions(opts['decisions-fixture'], opts['decisions-baseline'])
      if (opts['recall-fixture']) await runRecall(opts['recall-fixture'], opts['recall-baseline'])
      if (opts['tryon-dir']) await runTryon(opts['tryon-dir'])
      break
    default:
      console.error(`unknown command: ${command} (see --help)`)
      process.exitCode = 2
  }
} finally {
  const gpus = sampler.stop()
  results.gpu = sampler.available ? gpus : 'nvidia-smi not available (run on the GPU box to record VRAM)'
  if (!isExport) {
    report.push('## GPU memory (peak while running)', '')
    if (sampler.available) {
      report.push('| GPU | Peak used | Total | Util at peak |', '|---|---|---|---|')
      for (const g of gpus) report.push(`| ${g.index} | ${g.usedMb} MB | ${g.totalMb} MB | ${g.utilPct}% |`)
    } else report.push(String(results.gpu))
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(outDir, 'report.md'), report.join('\n') + '\n')
    console.log(`\nReport: ${join(outDir, 'report.md')}`)
  }
}
