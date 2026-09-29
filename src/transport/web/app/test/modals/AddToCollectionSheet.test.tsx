import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { HydratedCollection } from '../../src/api/collections'

const mocks = vi.hoisted(() => ({ collections: [] as unknown[] }))

vi.mock('../../src/hooks/useCollections', () => ({
  useCollections: () => ({ collections: mocks.collections, loading: false, error: null, refetch: vi.fn() }),
}))
vi.mock('../../src/api/collections', () => ({
  addOutfitsToCollection: vi.fn(),
  createCollection: vi.fn(),
  fetchCollectionsForOutfit: vi.fn().mockResolvedValue([]),
}))

import { AddToCollectionSheet } from '../../src/modals/AddToCollectionSheet'

function col(id: string, name: string, outfitIds: string[], outfitCount?: number): HydratedCollection {
  return {
    id, name, description: null, coverImageUri: null, season: '[]', tags: '[]',
    createdAt: 0, updatedAt: 0,
    outfitCount: outfitCount as number,
    outfits: outfitIds.map(oid => ({ id: oid, items: [] })) as unknown as HydratedCollection['outfits'],
  }
}

describe('AddToCollectionSheet outfit count (#361)', () => {
  beforeEach(() => { mocks.collections = [] })

  it('shows the real count from hydrated outfits, not "0 outfits"', () => {
    // outfitCount deliberately absent, as the hydrated response used to be
    mocks.collections = [col('c1', 'Capsule', ['o1', 'o2'])]
    render(<AddToCollectionSheet onClose={() => {}} onAdded={() => {}} />)
    expect(screen.getByText('2 outfits')).toBeInTheDocument()
    expect(screen.queryByText('0 outfits')).not.toBeInTheDocument()
  })

  it('uses the singular for one outfit', () => {
    mocks.collections = [col('c1', 'Solo', ['o1'], 1)]
    render(<AddToCollectionSheet onClose={() => {}} onAdded={() => {}} />)
    expect(screen.getByText('1 outfit')).toBeInTheDocument()
  })

  it('shows 0 outfits for an empty collection', () => {
    mocks.collections = [col('c1', 'Empty', [], 0)]
    render(<AddToCollectionSheet onClose={() => {}} onAdded={() => {}} />)
    expect(screen.getByText('0 outfits')).toBeInTheDocument()
  })
})
