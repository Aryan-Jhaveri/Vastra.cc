import { Router, type Request, type Response, type NextFunction } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type Tool,
  type ListToolsResult,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  AGENT_TOOLS,
  executeTool,
  inputToJsonSchema,
  isToolAvailable,
  needsConfirmation,
  type AgentTool,
  type AgentToolScope,
} from '../../agent/tools.js'
import { requireApiToken, requireTokensEnabled } from '../web/middleware.js'
import { perTokenRateLimit } from '../web/middleware/perUserRateLimit.js'

// #317 — MCP server transport. Exposes the agent tool registry
// (`src/agent/tools.ts`) over Streamable HTTP at /mcp, mounted in the
// existing Express app. Any MCP client (Claude Desktop/Code, Home
// Assistant, other agents) can then search the closet, suggest outfits
// and save outfits using its own model.
//
// Design (issue #317 § Design + #316 § Rules):
// - Streamable HTTP, stateless. One Server + Transport per request — no
//   per-session server state is needed.
// - Auth: bearer `vst_…` through `requireApiToken` (#321). The token's
//   scopes filter BOTH `tools/list` and `tools/call`: a tool whose scope
//   isn't on the token is omitted from the list AND rejected on call
//   (MethodNotFound, not just hidden).
// - Mounted behind `requireTokensEnabled` so /mcp 404s in HOSTED_MODE,
//   exactly like the token routes. /mcp is NOT under /api, so it's
//   mounted BEFORE the SPA fallback in server.ts.
// - `ai`-scope tools go through `runInstrumented` (inside suggestOutfits)
//   carrying `ctx.identity.toolCallId` = the JSON-RPC request id, so
//   `ai_calls` records it. The registry's result projection is never
//   bypassed — `executeTool` returns the projected view (no `userId`).
// - Foreign ids return `not found` (via the registry), never
//   `forbidden` — no information leak.

const SERVER_INFO = { name: 'vastra', version: '1.0.0' }

// MCP clients render tool results as text, not the in-app cards, and users
// can't search or act on ids. Sent on `initialize`.
export const MCP_INSTRUCTIONS = [
  'Vastra is the user\'s wardrobe. Ids in tool results (items, outfits, collections, photos, products) are',
  'internal handles for chaining tool calls — never show them to the user and never ask the user for one;',
  'the user cannot search by id. Refer to an item by its colour, category and brand ("the navy chinos"),',
  'and to outfits and collections by name. When you list results, describe them in words; include an',
  'image or product link only when it appears in a tool result.',
].join(' ')

// 120 req/min per token. The limiter skips under VITEST (see
// perUserRateLimit.ts) so test suites aren't throttled; the rate-limit
// test opts back in by deleting process.env.VITEST.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 120
// `ai`-scope tool calls (suggest_outfit) spend the operator's model budget,
// and MCP bypasses the web routes' own limits, so they get a separate,
// stricter per-token budget on top of the general one (#321 design: 20/min).
const AI_RATE_LIMIT_MAX = 20

const AI_TOOL_NAMES = new Set(AGENT_TOOLS.filter(t => t.scope === 'ai').map(t => t.name))

/** True when the JSON-RPC body (single or batch) calls an `ai`-scope tool. */
function callsAiTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body]
  return messages.some(m => {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null
    return msg?.method === 'tools/call' && typeof msg.params?.name === 'string' && AI_TOOL_NAMES.has(msg.params.name)
  })
}

/** MCP tool annotations derived from the agent tool's scope. */
function toolAnnotations(tool: AgentTool<unknown>): Tool['annotations'] {
  // read + ai tools don't mutate the closet; suggest_outfit calls a model
  // but writes nothing. Write tools (outfits, collections) mutate; none delete.
  // try_on (ai, needs confirmation in chat) saves a Try On history row.
  if (needsConfirmation(tool)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }
  return { readOnlyHint: true }
}

/**
 * Build a fresh low-level MCP `Server` whose `tools/list` and `tools/call`
 * handlers are scoped to the caller's token scopes. Stateless: a new
 * Server is built per request (see handleMcpRequest).
 */
function buildMcpServer(userId: string, tokenScopes: AgentToolScope[]): Server {
  const allowed = AGENT_TOOLS.filter(t => tokenScopes.includes(t.scope) && isToolAvailable(t))
  const allowedNames = new Set(allowed.map(t => t.name))

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS })

  // tools/list — only the tools the token's scopes permit.
  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    const tools: Tool[] = allowed.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: inputToJsonSchema(t) as unknown as Tool['inputSchema'],
      annotations: toolAnnotations(t),
    }))
    return { tools }
  })

  // tools/call — a call to a tool the token's scopes don't cover is
  // rejected (MethodNotFound), not just hidden from tools/list.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    if (!allowedNames.has(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`)
    }
    // toolCallId = the JSON-RPC request id. ai-scope tools propagate this
    // into runInstrumented → ai_calls.tool_call_id (issue #316 § Rules).
    // read/write tools don't call runInstrumented, but setting it is
    // harmless and future-proofs any instrumented read/write tool.
    const identity = { toolCallId: String(extra.requestId) }
    try {
      const result = await executeTool(name, args, { userId, identity })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      // Handler error → isError result (not a JSON-RPC error). The
      // registry throws "not found" for foreign ids (no leak) and
      // descriptive errors for invalid input; both are surfaced to the
      // client's model as text.
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: message }], isError: true }
    }
  })

  return server
}

/** Stateless per-request MCP handler. Mounted on POST /mcp. */
async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const userId = req.userId!
  const tokenScopes = (req.tokenScopes ?? []) as AgentToolScope[]
  const server = buildMcpServer(userId, tokenScopes)
  // Stateless mode: no session id. A fresh transport per request. JSON
  // responses (not SSE) — the registry's tools are simple request/response
  // with no streaming or notifications, so a single JSON body per POST is
  // the simplest valid Streamable HTTP response. The SDK client and any
  // compliant client accept both JSON and SSE responses.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  // Clean up the per-request server + transport once the response is
  // closed (client disconnect or finished). Registered before handling so an
  // early disconnect is still caught. Stateless servers hold no state worth
  // keeping across requests.
  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })
  try {
    await server.connect(transport)
    // req.body is the JSON-parsed JSON-RPC message (express.json() runs
    // globally before this route). Pass it as the pre-parsed body so the
    // transport doesn't re-read the stream.
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
}

// GET / DELETE on the MCP endpoint aren't part of the stateless POST
// contract. Respond with a JSON-RPC error (method not allowed) so a probe
// gets a structured response instead of an HTML 404 from the SPA fallback.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  })
}

export interface CreateMcpRouterOptions {
  rateLimitWindowMs?: number
  rateLimitMax?: number
  /** Per-token budget for `ai`-scope tool calls, within the same window. */
  aiRateLimitMax?: number
}

/**
 * Build the /mcp router. Middleware order is load-bearing:
 *   1. requireTokensEnabled — 404 in HOSTED_MODE (before any MCP parsing).
 *   2. requireApiToken(['read']) — 401 without a valid token (before any
 *      MCP parsing). `read` is always granted at token creation, so this
 *      is the "valid token" gate; per-tool scope filtering happens inside.
 *   3. perTokenRateLimit — per-token throttle (keys on req.tokenId set by
 *      step 2). Mounted after auth so unauthenticated probes get a cheap
 *      401 instead of a rate-limit entry.
 *   4. ai limiter — a second, stricter per-token budget that only counts
 *      `tools/call` requests for `ai`-scope tools (its own store, so read
 *      calls never use it up).
 */
export function createMcpRouter(opts: CreateMcpRouterOptions = {}): Router {
  const router = Router()
  router.use(requireTokensEnabled)
  router.use(requireApiToken(['read']))
  const windowMs = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS
  router.use(perTokenRateLimit(windowMs, opts.rateLimitMax ?? RATE_LIMIT_MAX))
  const aiLimiter = perTokenRateLimit(windowMs, opts.aiRateLimitMax ?? AI_RATE_LIMIT_MAX)
  const limitAiCalls = (req: Request, res: Response, next: NextFunction) =>
    callsAiTool(req.body) ? aiLimiter(req, res, next) : next()
  router.post('/', limitAiCalls, handleMcpRequest)
  router.get('/', methodNotAllowed)
  router.delete('/', methodNotAllowed)
  return router
}

export const mcpRouter = createMcpRouter()
