import { describe, it, expect, vi } from 'vitest'

describe('TryOn history toggle logic', () => {
  it('selects on first tap and clears on second tap', () => {
    const previewHistory = vi.fn()
    const clearHistoryPreview = vi.fn()
    const toggleHistorySelect = vi.fn()

    const handleClick = (id: string, selectedId: string | null, selectMode: boolean) => {
      if (selectMode) { toggleHistorySelect(id); return }
      if (selectedId === id) { clearHistoryPreview(); return }
      previewHistory(id)
    }

    handleClick('a', null, false)
    expect(previewHistory).toHaveBeenCalledWith('a')
    expect(clearHistoryPreview).not.toHaveBeenCalled()

    previewHistory.mockClear()
    handleClick('a', 'a', false)
    expect(clearHistoryPreview).toHaveBeenCalled()
    expect(previewHistory).not.toHaveBeenCalled()

    clearHistoryPreview.mockClear()
    handleClick('b', 'a', false)
    expect(previewHistory).toHaveBeenCalledWith('b')
    expect(clearHistoryPreview).not.toHaveBeenCalled()

    handleClick('a', 'a', true)
    expect(toggleHistorySelect).toHaveBeenCalledWith('a')
  })
})
