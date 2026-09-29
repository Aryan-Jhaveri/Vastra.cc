export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    if (typeof t !== 'string') continue
    const n = t.trim().toLowerCase()
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}
