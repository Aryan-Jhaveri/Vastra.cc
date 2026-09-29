import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'

vi.mock('../../../src/api/client', () => ({
  apiFetch: vi.fn(async () => new Response(new Blob(['x']))),
  apiFetchJSON: vi.fn(),
  getImageSrc: (uri: string) => `/${uri}`,
}))

import { ToolResultView, toolDoneLabel, toolLabel } from '../../../src/components/chat/ToolResultView'

const item = (id: string) => ({ id, imageUri: `images/items/${id}.jpg`, category: 'tops' })
const outfit = (id: string, name: string) => ({ id, name, occasion: 'casual', items: [item(`${id}_i`)] })

function renderResult(name: string, result: unknown) {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="/home" element={<ToolResultView name={name} result={result} />} />
        <Route path="/tryon" element={<p>Try On page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ToolResultView — related / discover / photos / try-on', () => {
  it('labels the new tools', () => {
    expect(toolLabel('try_on')).toBe('Try on')
    expect(toolDoneLabel('find_related')).toBe('Found related pieces')
    expect(toolDoneLabel('discover_closet')).toBe('Discovered in your closet')
    expect(toolDoneLabel('list_my_photos')).toBe('Checked your photos')
  })

  it('find_related on an item renders the related items grid', () => {
    renderResult('find_related', { kind: 'item', status: 'success', items: [item('a'), item('b')] })
    expect(screen.getByTestId('tool-related-items')).toBeInTheDocument()
  })

  it('find_related on an outfit renders outfit rows', () => {
    renderResult('find_related', { kind: 'outfit', status: 'success', outfits: [outfit('o1', 'Office'), outfit('o2', 'Weekend')] })
    const rows = screen.getByTestId('tool-related-outfits')
    expect(rows).toHaveTextContent('Office')
    expect(rows).toHaveTextContent('Weekend')
  })

  it('find_related explains unavailable and capped results', () => {
    const { unmount } = renderResult('find_related', { kind: 'item', status: 'unavailable' })
    expect(screen.getByText(/isn't available/)).toBeInTheDocument()
    unmount()
    renderResult('find_related', { kind: 'item', status: 'capped' })
    expect(screen.getByText(/limit reached/)).toBeInTheDocument()
  })

  it('discover_closet renders items and related outfits, or an empty note', () => {
    const { unmount } = renderResult('discover_closet', { query: 'yellow', items: [item('y')], outfits: [outfit('o', 'Sunny')] })
    expect(screen.getByTestId('tool-discover')).toHaveTextContent('Related outfits')
    expect(screen.getByTestId('tool-discover')).toHaveTextContent('Sunny')
    unmount()
    renderResult('discover_closet', { query: 'x', items: [], outfits: [] })
    expect(screen.getByText('Nothing in your closet matched.')).toBeInTheDocument()
  })

  it('list_my_photos shows the photos, or how to add one', () => {
    const { unmount } = renderResult('list_my_photos', { photos: [{ id: 'p1', imageUri: 'images/user/p1.jpg', label: 'Mirror', isPrimary: true }] })
    expect(screen.getByTestId('tool-photos')).toHaveTextContent('Mirror')
    unmount()
    renderResult('list_my_photos', { photos: [], message: 'none' })
    expect(screen.getByText(/Add one on the Try On page/)).toBeInTheDocument()
  })

  it('try_on shows the result image and links to Try On history', () => {
    renderResult('try_on', { tryonId: 't1', resultImageUri: 'images/users/u/tryon/t1.jpg', wearSuggestions: [{ label: 'Tucked', instruction: 'Tuck the tee in', itemId: 'i1', itemLabel: 't-shirt' }], historyAt: '/tryon' })
    const card = screen.getByTestId('tool-tryon')
    expect(card).toHaveTextContent('t-shirt · Tucked')
    fireEvent.click(screen.getByRole('button', { name: 'Try On history' }))
    expect(screen.getByText('Try On page')).toBeInTheDocument()
  })

  it('try_on still shows a plain-string tip from older results', () => {
    renderResult('try_on', { tryonId: 't1', resultImageUri: 'images/users/u/tryon/t1.jpg', wearSuggestions: ['Tuck it in'], historyAt: '/tryon' })
    expect(screen.getByTestId('tool-tryon')).toHaveTextContent('Tuck it in')
  })
})
