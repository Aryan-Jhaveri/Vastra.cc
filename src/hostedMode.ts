// #315 — HOSTED_MODE distinguishes the public SaaS (vastra.cc) from a
// self-hosted install. The flag gates billing, per-user OpenRouter key minting,
// admin metrics, the GCP_PROJECT_ID boot guard, and the personal API token
// surface. Reads `process.env.HOSTED_MODE === 'true'`.
//
// Lives at the repo root (not under transport/web/middleware) so core layers
// (billing, ai, jobs) can import it without depending up into the transport
// layer. middleware.ts re-exports it to keep its existing callers unchanged.

export function isHostedMode(): boolean {
  return process.env.HOSTED_MODE === 'true'
}
