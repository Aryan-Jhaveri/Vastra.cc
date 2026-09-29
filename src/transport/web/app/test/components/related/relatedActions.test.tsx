import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// #332 — the select actions in each detail card's Related section.
const mocks = vi.hoisted(() => ({
  saveModal: vi.fn(),
  sheet: vi.fn(),
}))
vi.mock('../../../src/api/related', () => ({ findRelated: vi.fn(), fetchSavedRelated: vi.fn().mockResolvedValue(null) }))
vi.mock('../../../src/api/outfits', () => ({ fetchOutfit: vi.fn() }))
vi.mock('../../../src/api/collections', () => ({ addOutfitsToCollection: vi.fn() }))
vi.mock('../../../src/components/ItemCard', () => ({
  ItemCard: (p: { item: { id: string }; onClick: () => void; selected?: boolean }) =>
    <button data-selected={String(Boolean(p.selected))} onClick={p.onClick}>item:{p.item.id}</button>,
}))
vi.mock('../../../src/components/SavedOutfitCard', () => ({
  SavedOutfitCard: (p: { outfit: { id: string }; onClick?: () => void }) => <button onClick={p.onClick}>outfit:{p.outfit.id}</button>,
}))
vi.mock('../../../src/modals/OutfitSaveModal', () => ({
  OutfitSaveModal: (p: { items: Array<{ id: string }>; onSaved: (o: { id: string }) => void }) => {
    mocks.saveModal(p.items.map(i => i.id))
    return <button onClick={() => p.onSaved({ id: 'new-outfit' })}>save-modal</button>
  },
}))
vi.mock('../../../src/modals/AddToCollectionSheet', () => ({
  AddToCollectionSheet: (p: { outfitIds: string[] }) => { mocks.sheet(p.outfitIds); return <div>sheet</div> },
}))

import { findRelated } from '../../../src/api/related'
import { fetchOutfit } from '../../../src/api/outfits'
import { addOutfitsToCollection } from '../../../src/api/collections'
import { ItemRelated } from '../../../src/components/related/ItemRelated'
import { OutfitRelated } from '../../../src/components/related/OutfitRelated'
import { CollectionRelated } from '../../../src/components/related/CollectionRelated'

const anchor = { id: 'anchor-item' } as never

async function findAndSelect(searchLabel: string, pick: string[]) {
  fireEvent.click(screen.getByRole('button', { name: searchLabel }))
  fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
  for (const name of pick) fireEvent.click(screen.getByText(name))
}

beforeEach(() => {
  vi.mocked(findRelated).mockReset()
  mocks.saveModal.mockReset()
  mocks.sheet.mockReset()
})

describe('ItemRelated', () => {
  it('Outfit is disabled until one item is selected, then saves [anchor, ...selected]', async () => {
    vi.mocked(findRelated).mockResolvedValue({ kind: 'result', result: { kind: 'item', status: 'success', foundAt: Date.now(), scores: {}, items: [{ id: 'pants' }, { id: 'shoes' }] as never } })
    vi.mocked(fetchOutfit).mockResolvedValue({ id: 'new-outfit' } as never)
    render(<ItemRelated anchor={anchor} onOpenItem={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Find related items' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    expect(screen.getByRole('button', { name: 'Outfit' })).toBeDisabled()

    fireEvent.click(screen.getByText('item:shoes'))
    fireEvent.click(screen.getByRole('button', { name: 'Outfit' }))
    expect(mocks.saveModal).toHaveBeenLastCalledWith(['anchor-item', 'shoes'])

    // Saved → the new outfit shows with + Collection → the sheet gets its id.
    fireEvent.click(screen.getByText('save-modal'))
    expect(await screen.findByTestId('related-created-outfit')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ Collection' }))
    expect(mocks.sheet).toHaveBeenLastCalledWith(['new-outfit'])
  })
})

describe('OutfitRelated', () => {
  it('+ Collection opens the sheet with exactly the selected outfits', async () => {
    vi.mocked(findRelated).mockResolvedValue({ kind: 'result', result: { kind: 'outfit', status: 'success', foundAt: Date.now(), scores: {}, outfits: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] as never } })
    render(<OutfitRelated anchorId="anchor-outfit" onOpenOutfit={vi.fn()} />)
    await findAndSelect('Find related outfits', ['outfit:o1', 'outfit:o3'])
    fireEvent.click(screen.getByRole('button', { name: '+ Collection' }))
    expect(mocks.sheet).toHaveBeenLastCalledWith(['o1', 'o3'])
  })
})

describe('CollectionRelated', () => {
  it('Add N adds the selection in one call, refreshes the modal and drops them from Related', async () => {
    vi.mocked(findRelated).mockResolvedValue({ kind: 'result', result: { kind: 'collection', status: 'success', foundAt: Date.now(), scores: {}, outfits: [{ id: 'o1' }, { id: 'o2' }] as never } })
    vi.mocked(addOutfitsToCollection).mockResolvedValue(undefined)
    const onAdded = vi.fn()
    render(<CollectionRelated collectionId="col1" onOpenOutfit={vi.fn()} onAdded={onAdded} />)
    await findAndSelect('Find outfits for this collection', ['outfit:o2'])
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledOnce())
    expect(addOutfitsToCollection).toHaveBeenCalledExactlyOnceWith('col1', ['o2'])
    expect(screen.queryByText('outfit:o2')).toBeNull()
    expect(screen.getByText('outfit:o1')).toBeInTheDocument()
    // No per-card Add buttons: adding only happens through Select → Add N.
    expect(screen.queryAllByRole('button', { name: /^\+ Add$/ })).toHaveLength(0)
  })
})
