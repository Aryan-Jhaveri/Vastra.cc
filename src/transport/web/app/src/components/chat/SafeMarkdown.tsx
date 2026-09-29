import { Fragment, type ReactNode } from 'react'

// #328 threat #6 — model text is plain text plus a small markdown subset:
// paragraphs, "- " and "1." lists, **bold**, *italic*, `code` and [text](url) links.
// No images (`![alt](src)` renders as its alt text) and no raw HTML (tags are
// stripped; everything else goes through React's text escaping). A link is
// tappable only when its URL is on the allowlist — the app's own paths or a
// URL that appeared in a tool result — so a model can't smuggle data out
// through an auto-loaded or disguised link. Nothing is ever auto-loaded.

interface Props {
  text: string
  /** Absolute URLs seen in this thread's tool results. */
  allowedUrls?: ReadonlySet<string>
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g

export function isAllowedLink(url: string, allowedUrls?: ReadonlySet<string>): boolean {
  // Browsers read "\" as "/" and drop tabs/newlines, so "/\evil.com" is
  // protocol-relative: an app path must start with "/" + a plain path character.
  if (/^\/([A-Za-z0-9_\-.~?#]|$)/.test(url) && !/[\\\s]/.test(url)) return true
  return Boolean(allowedUrls?.has(url)) && /^https:\/\//.test(url)
}

function clean(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
}

function inline(text: string, allowedUrls: ReadonlySet<string> | undefined, keyBase: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const key = `${keyBase}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key} className="font-mono text-[0.9em] bg-surface-dim px-1 rounded-sm">{part.slice(1, -1)}</code>
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) {
      const [, label, url] = link
      if (!isAllowedLink(url, allowedUrls)) return <Fragment key={key}>{label}</Fragment>
      return (
        <a key={key} href={url} target={url.startsWith('/') ? undefined : '_blank'} rel="noopener noreferrer nofollow" className="underline font-bold">
          {label}
        </a>
      )
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

const ORDERED = /^\s*\d+[.)]\s+/
const BULLET = /^\s*[-*•]\s+/

type Segment = { kind: 'p' | 'ol' | 'ul'; lines: string[] }

/** Splits a block into runs of paragraph / numbered / bulleted lines, so an
 *  intro line directly above a list ("Try these:\n1. …") still renders a list. */
function segments(block: string): Segment[] {
  const out: Segment[] = []
  for (const line of block.split('\n')) {
    const kind = ORDERED.test(line) ? 'ol' : BULLET.test(line) ? 'ul' : 'p'
    const last = out.at(-1)
    if (last?.kind === kind) last.lines.push(line)
    else out.push({ kind, lines: [line] })
  }
  return out
}

export function SafeMarkdown({ text, allowedUrls }: Props) {
  const blocks = clean(text).split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  return (
    <div className="flex flex-col gap-2">
      {blocks.flatMap((block, i) => segments(block).map((seg, k) => {
        const key = `${i}-${k}`
        if (seg.kind === 'p') {
          return <p key={key} className="whitespace-pre-wrap break-words">{inline(seg.lines.join('\n'), allowedUrls, key)}</p>
        }
        const marker = seg.kind === 'ol' ? ORDERED : BULLET
        const items = seg.lines.map((l, j) => <li key={j}>{inline(l.replace(marker, ''), allowedUrls, `${key}-${j}`)}</li>)
        return seg.kind === 'ol'
          ? <ol key={key} className="list-decimal pl-5 flex flex-col gap-0.5">{items}</ol>
          : <ul key={key} className="list-disc pl-5 flex flex-col gap-0.5">{items}</ul>
      }))}
    </div>
  )
}

/** Collects every https URL in a tool result, for the link allowlist. */
export function collectUrls(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (/^https:\/\/\S+$/.test(value)) into.add(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, into)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectUrls(v, into)
  }
  return into
}
