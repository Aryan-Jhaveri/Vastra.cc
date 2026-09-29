import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useItemCache } from '../context/ItemCacheContext'
import { ItemCard } from '../components/ItemCard'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import type { Item } from '../api/items'

interface ItemPickerSheetProps {
  existingItemIds: string[]
  onClose: () => void
  onAdd: (itemIds: string[], items: Item[]) => Promise<void>
}

export function ItemPickerSheet({ existingItemIds, onClose, onAdd }: ItemPickerSheetProps) {
  const { items, loading } = useItemCache()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingSet = new Set(existingItemIds)

  function toggle(id: string) {
    if (existingSet.has(id)) return
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function handleAdd() {
    if (selectedIds.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const selectedItems = items.filter(i => selectedIds.includes(i.id))
      await onAdd(selectedIds, selectedItems)
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 nav-anchor-right z-[60] flex justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink shrink-0">
          <button onClick={onClose} className="text-ink hover:text-muted flex items-center justify-center" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">Add Items</span>
          <div className="w-8" />
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : items.length === 0 ? (
            <p className="text-[13px] font-mono text-muted uppercase tracking-[0.06em] text-center py-12">No items in your closet</p>
          ) : (
            <div className="grid grid-cols-3 gap-[3px]">
              {items.map(item => (
                <div key={item.id} className={existingSet.has(item.id) ? 'opacity-30 pointer-events-none' : ''}>
                  <ItemCard
                    item={item}
                    selectable
                    selected={selectedIds.includes(item.id)}
                    onClick={() => toggle(item.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t-2 border-ink shrink-0">
          {error && <p className="text-[12px] font-mono text-error uppercase tracking-[0.06em] mb-2">{error}</p>}
          <Button className="w-full" disabled={selectedIds.length === 0} loading={saving} onClick={handleAdd}>
            Add {selectedIds.length > 0 ? `${selectedIds.length} item${selectedIds.length !== 1 ? 's' : ''}` : 'items'}
          </Button>
        </div>
      </div>
    </div>
  )
}
