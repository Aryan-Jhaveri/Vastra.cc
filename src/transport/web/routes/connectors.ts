import { Router } from 'express'
import { checkDecisions, checkLocalServer } from '../../../ai/connectionChecks.js'
import { modelServerConfig, modelServerLoad, redactKey } from '../../../ai/modelServers.js'
import { imageGenMaxRefs, imageGenModel, isLocalImageGen, localImageEdit } from '../../../ai/localImage.js'
import sharp from 'sharp'

// #289 — admin-only "Test connection" for the self-hosted model servers.
// Mounted behind requireSession + CSRF + requireAdmin in server.ts. The checks
// live in src/ai/connectionChecks.ts, shared with `make setup` (#315): they
// only probe configured URLs (a request can name a model, never a URL) and
// never echo a key back.

const router = Router()

router.post('/local/test', async (req, res) => {
  const result = await checkLocalServer(req.body?.model)
  res.status(result.status).json(result.body)
})

router.post('/decisions/test', async (_req, res) => {
  const result = await checkDecisions()
  res.status(result.status).json(result.body)
})

// #352 — Test connection for the image server (Qwen-Image-2.1 on vLLM-Omni).
// One small edit of a generated swatch at few steps: proves the multipart
// shape, auth and b64 response, and reports the latency and peak memory the
// server measured. Probe-only: the result is decoded, never stored.
const IMAGE_PROBE_STEPS = 4

router.post('/image/test', async (req, res) => {
  const model = imageGenModel()
  if (!isLocalImageGen(model)) {
    res.status(400).json({ ok: false, error: `IMAGE_GEN_MODEL is ${model}; set a local/ id (e.g. local/Qwen/Qwen-Image-2.1) to test a self-hosted image server` })
    return
  }
  let server
  try { server = modelServerConfig('image') } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message })
    return
  }
  const swatch = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 240, g: 240, b: 240 } } }).jpeg().toBuffer()
  const started = Date.now()
  try {
    const result = await localImageEdit({
      model,
      prompt: 'Turn this plain swatch into a navy blue fabric swatch.',
      images: [swatch.toString('base64')],
      // A probe must never be refused because the admin has a real job running.
      userId: `connector-probe:${req.userId ?? 'admin'}`,
      steps: IMAGE_PROBE_STEPS,
    })
    const meta = await sharp(Buffer.from(result.data, 'base64')).metadata()
    res.json({
      ok: true, model, endpoint: server.baseUrl, maxRefs: imageGenMaxRefs(), load: modelServerLoad('image'),
      checks: { edit: { ok: true, latencyMs: Date.now() - started, width: meta.width, height: meta.height, ...(result.peakMemoryMb !== undefined ? { peakMemoryMb: result.peakMemoryMb } : {}) } },
    })
  } catch (err) {
    const text = redactKey(err instanceof Error ? err.message : String(err), server).slice(0, 300)
    res.json({ ok: false, model, endpoint: server.baseUrl, checks: { edit: { ok: false, error: text, latencyMs: Date.now() - started } } })
  }
})

export default router
