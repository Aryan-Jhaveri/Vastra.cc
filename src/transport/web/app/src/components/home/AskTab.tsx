import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { History, Plus, Send, Square, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { SafeMarkdown, collectUrls } from '../chat/SafeMarkdown'
import { ToolResultView, toolDoneLabel, toolLabel } from '../chat/ToolResultView'
import { useChat, type ChatEntry, type ConfirmEntry, type ToolEntry } from '../../hooks/useChat'
import { useShopEnabled } from '../../hooks/useShopEnabled'
import { deleteChatThread, fetchChatAllowance, listChatThreads, type ChatAllowance, type ChatThreadSummary } from '../../api/chat'

// #328 — the Ask tab: chat with Vastra's agent. The server owns history,
// billing and confirmations; write tools (outfits, collections) only run
// after the user taps Confirm on the card.

export const STARTER_PROMPTS = [
  'What should I wear today?',
  'What goes with my navy chinos?',
  'Plan outfits for a 3-day trip',
] as const

/** Only while the shop is on (SHOP_ROW_ENABLED) — #341. */
export const SHOP_STARTER = 'Show me shop items like this'

/** Composer row: 44px controls + py-2 + border-t-2. */
const COMPOSER_HEIGHT = 62

const MAX_CHARS = 2_000

/** Fallback when the server sent no summary (older pending actions). */
function describeArgs(args: Record<string, unknown>): string | null {
  const name = typeof args.name === 'string' ? args.name : null
  const count = Array.isArray(args.item_ids) ? args.item_ids.length : null
  if (!name) return null
  return count ? `“${name}” · ${count} item${count === 1 ? '' : 's'}` : `“${name}”`
}

function ConfirmCard({ entry, onConfirm, onCancel }: { entry: ConfirmEntry; onConfirm: () => void; onCancel: () => void }) {
  const summary = entry.summary ?? describeArgs(entry.args)
  return (
    <div data-testid="confirm-card" className="border-2 border-ink bg-surface-dim shadow-flat-xs rounded-base p-3 flex flex-col gap-2">
      <span className="self-start border-2 border-error bg-error text-on-error px-1.5 text-[11px] font-bold font-mono uppercase tracking-[0.08em] rounded-base">
        {toolLabel(entry.toolName)} · confirm
      </span>
      {summary && <p className="text-[14px] font-bold">{summary}</p>}
      {entry.status === 'pending' || entry.status === 'working' ? (
        <div className="flex gap-2">
          <Button onClick={onConfirm} loading={entry.status === 'working'} disabled={!entry.actionId} className="flex-1">Confirm</Button>
          <Button variant="secondary" onClick={onCancel} disabled={entry.status === 'working' || !entry.actionId} className="flex-1">Cancel</Button>
        </div>
      ) : entry.status === 'confirmed' ? (
        <ToolResultView name={entry.toolName} result={entry.result} />
      ) : (
        <p className="text-[13px] font-mono uppercase text-muted" data-testid="confirm-declined">
          {entry.status === 'expired' ? 'Expired — not saved' : entry.status === 'failed' ? `Failed — ${entry.error ?? 'not saved'}` : 'Declined — not saved'}
        </p>
      )}
    </div>
  )
}

function Bubble({ who, children }: { who: 'You' | 'Vastra'; children: ReactNode }) {
  const mine = who === 'You'
  return (
    <div className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
      <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-muted px-0.5">{who}</span>
      <div
        data-testid={mine ? 'user-message' : 'assistant-message'}
        className={`border-2 border-ink shadow-flat-xs rounded-base px-3 py-2 text-[15px] leading-relaxed max-w-[92%] break-words ${mine ? 'bg-accent text-accent-on whitespace-pre-wrap' : 'bg-paper text-ink'}`}
      >
        {children}
      </div>
    </div>
  )
}

/** Consecutive tool calls → one activity pill, then each finished result. */
function ToolGroup({ tools }: { tools: ToolEntry[] }) {
  const running = tools.some(t => t.status === 'running')
  const labels = tools.map(t => (t.status === 'running' ? `${toolLabel(t.name)}…` : toolDoneLabel(t.name)))
  const failed = tools.filter(t => t.status === 'error').length
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="tool-pill" className="self-start flex items-center gap-2 border-2 border-ink bg-surface-container rounded-base px-3 py-1.5 text-[13px] font-bold font-mono uppercase tracking-[0.06em] text-muted">
        {running && <Spinner size={12} />}
        {[...new Set(labels)].join(' · ')}
        {failed > 0 && <span className="normal-case">— {failed === tools.length ? 'couldn’t finish' : `${failed} couldn’t finish`}</span>}
      </p>
      {tools.map(t => (t.status === 'done' ? <ToolResultView key={t.key} name={t.name} result={t.result} /> : null))}
    </div>
  )
}

type Block = { kind: 'entry'; entry: Exclude<ChatEntry, ToolEntry> } | { kind: 'tools'; key: string; tools: ToolEntry[] }

export function groupEntries(entries: ChatEntry[]): Block[] {
  const blocks: Block[] = []
  for (const e of entries) {
    const last = blocks.at(-1)
    if (e.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(e)
      else blocks.push({ kind: 'tools', key: e.key, tools: [e] })
    } else {
      blocks.push({ kind: 'entry', entry: e })
    }
  }
  return blocks
}

function Entry({ entry, allowedUrls, onConfirm, onCancel }: {
  entry: Exclude<ChatEntry, ToolEntry>
  allowedUrls: ReadonlySet<string>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
}) {
  switch (entry.kind) {
    case 'user':
      return <Bubble who="You">{entry.text}</Bubble>
    case 'assistant':
      return <Bubble who="Vastra"><SafeMarkdown text={entry.text} allowedUrls={allowedUrls} /></Bubble>
    case 'confirm':
      return (
        <ConfirmCard
          entry={entry}
          onConfirm={() => entry.actionId && onConfirm(entry.actionId)}
          onCancel={() => entry.actionId && onCancel(entry.actionId)}
        />
      )
    case 'notice':
      return <p className="self-center text-[13px] font-mono text-muted text-center" role="status">{entry.text}</p>
  }
}

/**
 * Where the fixed composer goes: aligned to the content column, directly above
 * the mobile bottom nav (whose height includes the safe-area inset), or at the
 * bottom of the viewport on desktop where the nav is hidden.
 */
function useFooterBox(): { left: number; width: number; bottom: number } | null {
  const [box, setBox] = useState<{ left: number; width: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    const column = document.getElementById('main-column')
    const nav = document.getElementById('bottom-nav')
    const measure = () => {
      const rect = column?.getBoundingClientRect()
      setBox({
        left: rect?.width ? rect.left : 0,
        width: rect?.width ? rect.width : window.innerWidth,
        bottom: nav?.offsetHeight ?? 0,
      })
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (column) ro?.observe(column)
    if (nav) ro?.observe(nav)
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  return box
}

/** True while the page is scrolled to (near) the bottom. Read before new content lands. */
function useStickToBottom() {
  const atBottom = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement
      atBottom.current = window.innerHeight + window.scrollY >= doc.scrollHeight - 80
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return atBottom
}

function allowanceHint(a: ChatAllowance | null): string | null {
  if (!a || !a.billing) return null
  return `${a.tokensPerMessage} token per message · ${a.freeLeft} free today`
}

function ThreadList({ onOpen, activeId, onClose }: { onOpen: (id: string) => void; activeId: string | null; onClose: () => void }) {
  const [threads, setThreads] = useState<ChatThreadSummary[] | null>(null)
  useEffect(() => {
    listChatThreads().then(r => setThreads(r.threads)).catch(() => setThreads([]))
  }, [])
  async function remove(id: string) {
    await deleteChatThread(id).catch(() => {})
    setThreads(prev => prev?.filter(t => t.id !== id) ?? null)
  }
  return (
    <div data-testid="thread-list" className="border-2 border-ink rounded-base bg-paper divide-y-2 divide-ink">
      {threads === null && <div className="p-3 flex justify-center"><Spinner size={14} /></div>}
      {threads?.length === 0 && <p className="p-3 text-[13px] text-muted">No past chats.</p>}
      {threads?.map(t => (
        <div key={t.id} className={`flex items-center ${t.id === activeId ? 'bg-surface-dim' : ''}`}>
          <button className="flex-1 text-left px-3 py-2.5 truncate hover:bg-hover" onClick={() => { onOpen(t.id); onClose() }}>
            {t.title || 'Untitled chat'}
          </button>
          <button aria-label={`Delete ${t.title ?? 'chat'}`} className="px-3 py-2.5 hover:bg-hover" onClick={() => remove(t.id)}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function AskTab() {
  const chat = useChat()
  const shopEnabled = useShopEnabled()
  const [draft, setDraft] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [allowance, setAllowance] = useState<ChatAllowance | null>(null)
  const footer = useFooterBox()
  const atBottom = useStickToBottom()

  const allowedUrls = useMemo(() => {
    const urls = new Set<string>()
    for (const e of chat.entries) if ((e.kind === 'tool' || e.kind === 'confirm') && e.result) collectUrls(e.result, urls)
    return urls
  }, [chat.entries])

  const blocks = useMemo(() => groupEntries(chat.entries), [chat.entries])

  // Refresh the free-turn count when a turn finishes (and on first open).
  useEffect(() => {
    if (chat.busy) return
    let cancelled = false
    fetchChatAllowance().then(a => { if (!cancelled && a) setAllowance(a) }).catch(() => {})
    return () => { cancelled = true }
  }, [chat.busy])

  // Follow new output only while the user is already at the bottom.
  useEffect(() => {
    if (!atBottom.current || !chat.entries.length) return
    window.scrollTo?.({ top: document.documentElement.scrollHeight })
  }, [chat.entries, atBottom])

  function submit(text: string) {
    if (!text.trim() || chat.busy) return
    setDraft('')
    atBottom.current = true
    void chat.send(text)
  }

  const waitingForFirstToken = chat.busy && chat.entries.at(-1)?.kind === 'user'
  const starters = shopEnabled ? [...STARTER_PROMPTS, SHOP_STARTER] : [...STARTER_PROMPTS]
  const hint = allowanceHint(allowance)

  const composer = (
    <form
      data-testid="composer"
      onSubmit={e => { e.preventDefault(); submit(draft) }}
      className="fixed z-20 flex items-center gap-2 px-3 py-2 bg-paper border-t-2 border-ink"
      style={{ left: footer?.left ?? 0, width: footer?.width ?? '100%', bottom: footer?.bottom ?? 0, height: COMPOSER_HEIGHT }}
    >
      {/* Attach button hidden until #340 (image + camera) ships. */}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value.slice(0, MAX_CHARS))}
        maxLength={MAX_CHARS}
        placeholder="Ask Vastra…"
        aria-label="Message"
        enterKeyHint="send"
        className="flex-1 min-w-0 h-11 border-2 border-ink rounded-base px-3 text-[15px] outline-none focus:bg-surface-dim bg-paper"
      />
      {chat.busy ? (
        <button type="button" onClick={chat.stop} aria-label="Stop" className="w-11 h-11 flex-none flex items-center justify-center border-2 border-ink rounded-base shadow-flat-xs bg-paper">
          <Square className="w-4 h-4" />
        </button>
      ) : (
        <button type="submit" aria-label="Send" disabled={!draft.trim()} className="w-11 h-11 flex-none flex items-center justify-center border-2 border-ink rounded-base shadow-flat-xs bg-accent text-accent-on disabled:opacity-40">
          <Send className="w-4 h-4" />
        </button>
      )}
    </form>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 truncate text-[13px] font-mono font-bold uppercase tracking-[0.06em]">{chat.title ?? 'New chat'}</p>
        <button aria-label="Past chats" onClick={() => setShowHistory(v => !v)} className="border-2 border-ink rounded-base p-2 shadow-flat-xs hover:bg-hover">
          <History className="w-4 h-4" />
        </button>
        <button aria-label="New chat" onClick={() => { chat.newChat(); setShowHistory(false) }} className="border-2 border-ink rounded-base p-2 shadow-flat-xs hover:bg-hover">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {showHistory && <ThreadList onOpen={chat.openThread} activeId={chat.threadId} onClose={() => setShowHistory(false)} />}

      {chat.loading ? (
        <div className="flex justify-center py-8"><Spinner size={16} /></div>
      ) : chat.entries.length === 0 ? (
        <div className="flex flex-col gap-2" data-testid="ask-empty">
          <p className="text-[12px] font-mono uppercase tracking-[0.08em] text-muted">Ask Vastra</p>
          {starters.map(p => (
            <Button
              key={p}
              type="button"
              variant="secondary"
              onClick={() => submit(p)}
              className="justify-start normal-case font-mono font-medium tracking-normal text-left"
            >
              {p}
            </Button>
          ))}
          {hint && <p data-testid="allowance-hint" className="text-[12px] font-mono text-muted mt-1">{hint}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="transcript">
          {blocks.map(b => (b.kind === 'tools'
            ? <ToolGroup key={b.key} tools={b.tools} />
            : <Entry key={b.entry.key} entry={b.entry} allowedUrls={allowedUrls} onConfirm={chat.confirm} onCancel={chat.cancel} />
          ))}
          {waitingForFirstToken && <div className="self-start"><Spinner size={14} /></div>}
        </div>
      )}

      {/* Keeps the last message clear of the fixed composer. */}
      <div aria-hidden style={{ height: COMPOSER_HEIGHT }} />
      {createPortal(composer, document.body)}
    </div>
  )
}
