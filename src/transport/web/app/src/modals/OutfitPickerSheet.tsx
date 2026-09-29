import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useSavedOutfits } from '../hooks/useSavedOutfits'
import { addOutfitsToCollection } from '../api/collections'
import { OutfitPicker } from '../components/OutfitPicker'
import { Button } from '../components/ui/Button'

interface OutfitPickerSheetProps {
  collectionId: string
  /** Outfit IDs already in this collection — shown greyed out, not selectable */
  existingOutfitIds: string[]
  onClose: () => void
  onAdded: () => void
}

export function OutfitPickerSheet({ collectionId, existingOutfitIds, onClose, onAdded }: OutfitPickerSheetProps) {
  const { outfits, loading } = useSavedOutfits()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingSet = new Set(existingOutfitIds)

  function toggleOutfit(id: string) {
    if (existingSet.has(id)) return
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function handleAdd() {
    if (selectedIds.length === 0) return
    setSaving(true)
    setError(null)
    try {
      await addOutfitsToCollection(collectionId, selectedIds)
      onAdded()
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 nav-anchor-right z-[60] flex justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink shrink-0">
          <button onClick={onClose} className="text-ink hover:text-muted flex items-center justify-center" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">Add Outfits</span>
          <div className="w-8" />
        </div>

        <OutfitPicker
          outfits={outfits}
          loading={loading}
          selectedIds={selectedIds}
          onToggle={toggleOutfit}
          existingOutfitIds={existingOutfitIds}
        />

        {/* Footer */}
        <div className="px-4 py-3 border-t-2 border-ink shrink-0">
          {error && (
            <p className="text-[12px] font-mono text-error uppercase tracking-[0.06em] mb-2">{error}</p>
          )}
          <Button
            className="w-full"
            disabled={selectedIds.length === 0}
            loading={saving}
            onClick={handleAdd}
          >
            Add {selectedIds.length > 0 ? `${selectedIds.length} outfit${selectedIds.length !== 1 ? 's' : ''}` : 'outfits'}
          </Button>
        </div>
      </div>
    </div>
  )
}
