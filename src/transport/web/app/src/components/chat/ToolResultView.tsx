import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AuthImage } from '../AuthImage'
import { fetchLikedProductIds, fetchRelatedShop, likeProduct, unlikeProduct, type ShopProduct } from '../../api/shop'
import { Button } from '../ui/Button'
import { ProductCard } from '../ProductCard'
import type { HydratedCollection } from '../../api/collections'
import { fetchItem, type Item } from '../../api/items'
import { fetchOutfit, type HydratedOutfit, type WeatherData } from '../../api/outfits'
import { ItemDetail } from '../../modals/ItemDetail'
import { OutfitDetail } from '../../modals/OutfitDetail'
import { CollectionCard } from '../CollectionCard'
import { ClosetItemMini } from '../home/ClosetItemMini'
import { SavedOutfitCard } from '../SavedOutfitCard'
import { WeatherCard } from '../WeatherCard'

// #328 — tool results render as the app's own components, not as markdown.
// Payloads are the model-facing projections from src/agent/tools.ts
// (itemView / outfitView), so arrays arrive as arrays, not JSON strings.

export const TOOL_LABELS: Record<string, string> = {
  search_closet: 'Searching your closet',
  get_item: 'Looking at an item',
  list_outfits: 'Checking your outfits',
  get_outfit: 'Opening an outfit',
  list_collections: 'Checking your collections',
  get_collection: 'Opening a collection',
  get_weather: 'Checking the weather',
  get_forecast: 'Checking the forecast',
  suggest_outfit: 'Putting outfits together',
  create_outfit: 'Save outfit',
  update_outfit: 'Edit outfit',
  create_collection: 'New collection',
  add_outfits_to_collection: 'Add to collection',
  remove_outfits_from_collection: 'Remove from collection',
  update_collection: 'Edit collection',
  get_my_sizes: 'Checking your sizes',
  search_shop: 'Searching shop items',
  list_liked_products: 'Checking your liked items',
  find_related: 'Finding related pieces',
  discover_closet: 'Discovering in your closet',
  list_my_photos: 'Checking your photos',
  try_on: 'Try on',
}

/** Past tense for the grouped activity pill ("Checked weather · Searched your closet"). */
export const TOOL_DONE_LABELS: Record<string, string> = {
  search_closet: 'Searched your closet',
  get_item: 'Looked at an item',
  list_outfits: 'Checked your outfits',
  get_outfit: 'Opened an outfit',
  list_collections: 'Checked your collections',
  get_collection: 'Opened a collection',
  get_weather: 'Checked weather',
  get_forecast: 'Checked the forecast',
  suggest_outfit: 'Put outfits together',
  get_my_sizes: 'Checked your sizes',
  search_shop: 'Searched shop items',
  list_liked_products: 'Checked your liked items',
  find_related: 'Found related pieces',
  discover_closet: 'Discovered in your closet',
  list_my_photos: 'Checked your photos',
  try_on: 'Tried on',
}

export function toolDoneLabel(name: string): string {
  return TOOL_DONE_LABELS[name] ?? toolLabel(name)
}

// ─── Shop results (#341) ───────────────────────────────────────────────────────
// Liked state is fetched once per page load and shared by every result grid.
// The ♡ calls the existing likes route directly — the user's tap is the
// consent, so there's no agent tool or Confirm card for it.

let likedIds: Set<string> | null = null
let likedLoad: Promise<Set<string>> | null = null
const likedListeners = new Set<(ids: Set<string>) => void>()

function loadLikedIds(): Promise<Set<string>> {
  if (!likedLoad) {
    likedLoad = fetchLikedProductIds()
      .then(ids => (likedIds = new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => { likedLoad = null; return (likedIds = new Set()) })
  }
  return likedLoad
}

function setLiked(id: string, liked: boolean) {
  const next = new Set(likedIds ?? [])
  if (liked) next.add(id)
  else next.delete(id)
  likedIds = next
  for (const l of likedListeners) l(next)
}

/** Test hook. */
export function resetLikedIds(): void {
  likedIds = null
  likedLoad = null
}

function useLikedIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(likedIds ?? new Set())
  useEffect(() => {
    likedListeners.add(setIds)
    void loadLikedIds().then(setIds)
    return () => { likedListeners.delete(setIds) }
  }, [])
  return ids
}

function ShopResults({ result }: { result: Record<string, unknown> }) {
  const liked = useLikedIds()
  const [extra, setExtra] = useState<ShopProduct[]>([])
  const [cursor, setCursor] = useState<string | null>(typeof result.nextCursor === 'string' ? result.nextCursor : null)
  const [loadingMore, setLoadingMore] = useState(false)
  const products = [...((result.products as ShopProduct[] | undefined) ?? []), ...extra]
  const gone = Array.isArray(result.gone) ? result.gone.length : 0

  async function toggle(p: ShopProduct) {
    const next = !liked.has(p.id)
    setLiked(p.id, next)
    try {
      await (next ? likeProduct(p.id) : unlikeProduct(p.id))
    } catch {
      setLiked(p.id, !next)
    }
  }

  async function more() {
    if (!cursor || typeof result.query !== 'string') return
    setLoadingMore(true)
    try {
      const page = await fetchRelatedShop({ query: result.query }, cursor)
      setExtra(prev => [...prev, ...page.products])
      setCursor(page.nextCursor)
    } catch {
      setCursor(null)
    } finally {
      setLoadingMore(false)
    }
  }

  if (result.unavailable === true) return <p className="text-[13px] text-muted">The shop is unavailable right now.</p>
  return (
    <div data-testid="tool-shop" className="flex flex-col gap-2">
      {products.length ? (
        <div className="grid gap-3 grid-cols-2">
          {products.map(p => (
            <ProductCard key={p.id} product={p} variant="grid" liked={liked.has(p.id)} onLike={() => void toggle(p)} />
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-muted">No products found.</p>
      )}
      {gone > 0 && (
        <p className="text-[12px] font-mono text-muted">{gone} product{gone === 1 ? ' is' : 's are'} no longer listed.</p>
      )}
      {cursor && typeof result.query === 'string' && (
        <Button variant="secondary" onClick={() => void more()} loading={loadingMore} className="self-start">More</Button>
      )}
    </div>
  )
}

type CollectionViewPayload = {
  id: string; name: string; description?: string | null; coverImageUri?: string | null
  season?: unknown; tags?: unknown; outfits?: OutfitViewPayload[]
}

/** Collection tool result → the HydratedCollection shape CollectionCard expects. */
export function toHydratedCollection(c: CollectionViewPayload): HydratedCollection {
  const outfits = (c.outfits ?? []).map(toHydratedOutfit)
  return {
    id: c.id, name: c.name, description: c.description ?? null, coverImageUri: c.coverImageUri ?? null,
    season: asJson(c.season), tags: asJson(c.tags), createdAt: 0, updatedAt: 0,
    outfitCount: outfits.length, outfits,
  }
}

type ForecastDay = {
  date: string; tempMax: number; tempMin: number; condition: string; precipitationProbability: number | null
}

/** CollectionCard is itself a <button>, so it navigates on click rather than sitting in a <Link>. */
function CollectionResult({ collection }: { collection: CollectionViewPayload }) {
  const navigate = useNavigate()
  return (
    <div data-testid="tool-collection" className="max-w-[12rem]">
      <CollectionCard collection={toHydratedCollection(collection)} onClick={() => navigate('/outfits')} />
    </div>
  )
}

function ForecastList({ days, locationName }: { days: ForecastDay[]; locationName?: string }) {
  if (!days.length) return <p className="text-[13px] text-muted">No forecast.</p>
  return (
    <div data-testid="tool-forecast" className="border-2 border-ink rounded-base p-2 bg-paper flex flex-col gap-1">
      {locationName && <p className="text-[12px] font-mono uppercase text-muted">{locationName}</p>}
      {days.map(d => (
        <div key={d.date} className="flex items-center justify-between gap-2 text-[13px]">
          <span className="font-mono w-24 shrink-0">
            {new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}
          </span>
          <span className="flex-1 truncate">{d.condition}</span>
          {d.precipitationProbability != null && <span className="font-mono text-muted">{d.precipitationProbability}%</span>}
          <span className="font-mono font-bold shrink-0">{Math.round(d.tempMax)}° / {Math.round(d.tempMin)}°</span>
        </div>
      ))}
    </div>
  )
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ')
}

type OutfitViewPayload = {
  id: string; name: string; occasion?: string | null; coverImageUri?: string | null
  season?: unknown; tags?: unknown; itemIds?: unknown; items?: Item[]
}

const asJson = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(Array.isArray(v) ? v : []))

/** outfitView → the HydratedOutfit shape SavedOutfitCard expects. */
export function toHydratedOutfit(o: OutfitViewPayload): HydratedOutfit {
  return {
    id: o.id, name: o.name, occasion: o.occasion ?? null, coverImageUri: o.coverImageUri ?? null,
    season: asJson(o.season), tags: asJson(o.tags), itemIds: asJson(o.itemIds),
    aiGenerated: 0, weatherContext: null, notes: null, timesWorn: 0, lastWornAt: null, createdAt: 0,
    items: o.items ?? [],
  }
}

// ─── View / open (#339) ────────────────────────────────────────────────────────
// Same as Suggest: an item thumbnail opens ItemDetail, an outfit's View opens
// OutfitDetail. Tool payloads are trimmed projections, so the full record is
// fetched on tap (and is scoped to the session user server-side).

interface Opener {
  openItem: (id: string) => void
  openOutfit: (outfit: HydratedOutfit | string) => void
}

function useDetails(): [Opener, ReactNode] {
  const [item, setItem] = useState<Item | null>(null)
  const [outfit, setOutfit] = useState<HydratedOutfit | null>(null)
  const opener: Opener = {
    openItem: id => { fetchItem(id).then(setItem).catch(() => {}) },
    openOutfit: o => {
      if (typeof o !== 'string') setOutfit(o)
      else fetchOutfit(o).then(setOutfit).catch(() => {})
    },
  }
  const modal = (
    <>
      {item && <ItemDetail item={item} onClose={() => setItem(null)} onChanged={() => setItem(null)} />}
      {outfit && <OutfitDetail outfit={outfit} onClose={() => setOutfit(null)} onChanged={() => setOutfit(null)} />}
    </>
  )
  return [opener, modal]
}

function ViewButton({ onClick, label = 'View' }: { onClick: () => void; label?: string }) {
  return <Button variant="secondary" onClick={onClick} className="self-start">{label}</Button>
}

function OutfitRow({ outfit, onView }: { outfit: OutfitViewPayload; onView: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 border-2 border-ink rounded-base pl-3 pr-1.5 py-1.5 bg-paper">
      <span className="font-bold truncate">{outfit.name}</span>
      <span className="flex items-center gap-2 shrink-0">
        {outfit.occasion && <span className="text-[12px] font-mono uppercase text-muted">{outfit.occasion}</span>}
        <button onClick={onView} className="border-2 border-ink rounded-base shadow-flat-xs px-2 py-1 text-[12px] font-bold font-mono uppercase hover:bg-hover">View</button>
      </span>
    </div>
  )
}

type SuggestionPayload = { name: string; occasion?: string | null; reasoning?: string | null; savedOutfit?: boolean; item_ids?: string[]; items?: Item[] }

/** Unsaved suggestion → the HydratedOutfit shape OutfitDetail takes (id '' = not saved), as SuggestTab does. */
function suggestionOutfit(s: SuggestionPayload): HydratedOutfit {
  return toHydratedOutfit({ id: '', name: s.name, occasion: s.occasion ?? null, itemIds: s.item_ids ?? [], items: s.items ?? [] })
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted">{children}</p>
}

type PhotoPayload = { id: string; imageUri: string; label?: string | null; isPrimary?: boolean }

function PhotoStrip({ photos }: { photos: PhotoPayload[] }) {
  return (
    <div data-testid="tool-photos" className="flex gap-2 overflow-x-auto">
      {photos.map(p => (
        <figure key={p.id} className="w-20 shrink-0 flex flex-col gap-1">
          <div className="aspect-[4/5] border-2 border-ink rounded-base overflow-hidden bg-surface-dim">
            <AuthImage src={`/${p.imageUri}`} alt={p.label ?? 'Your photo'} className="w-full h-full object-cover" lazy />
          </div>
          <figcaption className="text-[11px] font-mono uppercase text-muted truncate">
            {p.label ?? (p.isPrimary ? 'Primary' : 'Photo')}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function TryOnResult({ result }: { result: Record<string, unknown> }) {
  const navigate = useNavigate()
  const uri = typeof result.resultImageUri === 'string' ? result.resultImageUri : null
  if (!uri) return null
  // Item-scoped chips ({ label, itemLabel }); older results stored plain strings.
  const tips = Array.isArray(result.wearSuggestions)
    ? result.wearSuggestions.flatMap(t => {
        if (typeof t === 'string') return [t]
        const tip = t as { label?: unknown; itemLabel?: unknown } | null
        if (!tip || typeof tip.label !== 'string') return []
        return [typeof tip.itemLabel === 'string' && tip.itemLabel ? `${tip.itemLabel} · ${tip.label}` : tip.label]
      })
    : []
  return (
    <div data-testid="tool-tryon" className="flex flex-col gap-1.5 max-w-[16rem]">
      <div className="aspect-[4/5] border-2 border-ink rounded-base overflow-hidden bg-surface-dim">
        <AuthImage src={`/${uri}`} alt="Try-on result" className="w-full h-full object-contain" fillBackground />
      </div>
      {typeof result.outfitName === 'string' && <p className="font-bold truncate">{result.outfitName}</p>}
      {tips.length > 0 && <p className="text-[13px] text-muted">{tips[0]}</p>}
      <ViewButton label="Try On history" onClick={() => navigate('/tryon')} />
    </div>
  )
}

export function ToolResultView({ name, result }: { name: string; result: unknown }) {
  const [opener, modal] = useDetails()
  if (!result || typeof result !== 'object') return null
  return <>{renderResult(name, result as Record<string, unknown>, opener)}{modal}</>
}

function renderResult(name: string, r: Record<string, unknown>, { openItem, openOutfit }: Opener): ReactNode {

  switch (name) {
    case 'search_closet': {
      const items = (r.results as Item[] | undefined) ?? []
      if (!items.length) return <p className="text-[13px] text-muted">No matching items.</p>
      return (
        <div data-testid="tool-items" className="flex flex-col gap-1">
          <ClosetItemMini items={items} onItemClick={openItem} />
          {r.truncated === true && <p className="text-[12px] font-mono text-muted">Showing {items.length} of {String(r.total)}</p>}
        </div>
      )
    }
    case 'get_item':
      return (
        <div data-testid="tool-items" className="flex items-end gap-2">
          <ClosetItemMini items={[r as unknown as Item]} onItemClick={openItem} />
          <ViewButton label="Open" onClick={() => openItem(String(r.id))} />
        </div>
      )
    case 'get_outfit':
    case 'update_outfit': {
      const outfit = toHydratedOutfit(r as unknown as OutfitViewPayload)
      return (
        <div data-testid="tool-outfit" className="flex flex-col gap-1.5 max-w-[12rem]">
          <SavedOutfitCard outfit={outfit} onClick={() => openOutfit(outfit.id)} />
          <ViewButton onClick={() => openOutfit(outfit.id)} />
        </div>
      )
    }
    case 'list_outfits': {
      const outfits = (r.results as OutfitViewPayload[] | undefined) ?? []
      if (!outfits.length) return <p className="text-[13px] text-muted">No saved outfits yet.</p>
      return <div data-testid="tool-outfits" className="flex flex-col gap-1.5">{outfits.map(o => <OutfitRow key={o.id} outfit={o} onView={() => openOutfit(o.id)} />)}</div>
    }
    case 'get_weather': {
      const location = r.location as { name?: string } | undefined
      return <WeatherCard weather={r.weather as WeatherData} locationName={location?.name} />
    }
    case 'get_forecast': {
      const location = r.location as { name?: string } | undefined
      return <ForecastList days={(r.days as ForecastDay[] | undefined) ?? []} locationName={location?.name} />
    }
    case 'get_collection':
    case 'create_collection':
    case 'add_outfits_to_collection':
    case 'remove_outfits_from_collection':
    case 'update_collection':
      return <CollectionResult collection={r as unknown as CollectionViewPayload} />
    case 'search_shop':
    case 'list_liked_products':
      return <ShopResults result={r} />
    case 'suggest_outfit': {
      const suggestions = (r.suggestions as SuggestionPayload[] | undefined) ?? []
      if (!suggestions.length) return <p className="text-[13px] text-muted">{typeof r.reason === 'string' ? r.reason : 'No suggestions.'}</p>
      return (
        <div className="flex flex-col gap-2">
          {suggestions.map((s, i) => (
            <div key={i} className="border-2 border-ink rounded-base p-2 bg-paper flex flex-col gap-1.5">
              <p className="font-bold flex items-center gap-2">
                {s.name}
                {s.savedOutfit && <span className="text-[11px] font-mono uppercase border-2 border-ink rounded-base px-1">Saved</span>}
              </p>
              {s.reasoning && <p className="text-[13px] text-muted">{s.reasoning}</p>}
              {s.items?.length ? <ClosetItemMini items={s.items} onItemClick={openItem} /> : null}
              <ViewButton onClick={() => openOutfit(suggestionOutfit(s))} />
            </div>
          ))}
        </div>
      )
    }
    case 'create_outfit':
      return <OutfitRow outfit={r as unknown as OutfitViewPayload} onView={() => openOutfit(String(r.id))} />
    case 'find_related': {
      if (r.status === 'unavailable') return <Empty>Find related isn't available here.</Empty>
      if (r.status === 'capped') return <Empty>Daily Find related limit reached.</Empty>
      if (r.kind === 'item') {
        const items = (r.items as Item[] | undefined) ?? []
        if (!items.length) return <Empty>Nothing in your closet pairs with it yet.</Empty>
        return <div data-testid="tool-related-items"><ClosetItemMini items={items} onItemClick={openItem} /></div>
      }
      const outfits = (r.outfits as OutfitViewPayload[] | undefined) ?? []
      if (!outfits.length) return <Empty>No related saved outfits.</Empty>
      return (
        <div data-testid="tool-related-outfits" className="flex flex-col gap-1.5">
          {outfits.map(o => <OutfitRow key={o.id} outfit={o} onView={() => openOutfit(o.id)} />)}
        </div>
      )
    }
    case 'discover_closet': {
      const items = (r.items as Item[] | undefined) ?? []
      const outfits = (r.outfits as OutfitViewPayload[] | undefined) ?? []
      if (!items.length && !outfits.length) return <Empty>Nothing in your closet matched.</Empty>
      return (
        <div data-testid="tool-discover" className="flex flex-col gap-2">
          {items.length > 0 && <ClosetItemMini items={items} onItemClick={openItem} />}
          {outfits.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[12px] font-mono uppercase text-muted">Related outfits</p>
              {outfits.map(o => <OutfitRow key={o.id} outfit={o} onView={() => openOutfit(o.id)} />)}
            </div>
          )}
        </div>
      )
    }
    case 'list_my_photos': {
      const photos = (r.photos as PhotoPayload[] | undefined) ?? []
      if (!photos.length) return <Empty>No photos yet. Add one on the Try On page.</Empty>
      return <PhotoStrip photos={photos} />
    }
    case 'try_on':
      return <TryOnResult result={r} />
    default:
      return null
  }
}
