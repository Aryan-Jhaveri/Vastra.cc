import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { PageResetProvider, usePageReset } from '../../src/context/PageResetContext'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

function wrapper({ children }: { children: ReactNode }) {
  return <PageResetProvider>{children}</PageResetProvider>
}

describe('PageResetContext', () => {
  it('provides default reset keys of 0 for each page', () => {
    let captured: number | undefined
    function Read() {
      const { resetKeys } = usePageReset()
      captured = resetKeys.tryon
      return null
    }
    render(<Read />, { wrapper })
    expect(captured).toBe(0)
  })

  it('triggerReset increments the counter for a given page', () => {
    const results: number[] = []
    function Trigger() {
      const { resetKeys, triggerReset } = usePageReset()
      results.push(resetKeys.tryon)
      if (results.length === 1) triggerReset('tryon')
      return <span data-testid="key">{resetKeys.tryon}</span>
    }
    render(<Trigger />, { wrapper })
    // After triggerReset, the component re-renders and we get the new value
    expect(results).toEqual([0, 1])
  })

  it('triggerReset does not affect other pages', () => {
    function Read() {
      const { resetKeys, triggerReset } = usePageReset()
      useEffect(() => { triggerReset('closet') }, [triggerReset])
      return (
        <span data-testid="others">
          {resetKeys.tryon}-{resetKeys.outfits}-{resetKeys.settings}
        </span>
      )
    }
    const { getByTestId } = render(<Read />, { wrapper })
    expect(getByTestId('others').textContent).toBe('0-0-0')
  })

  it('multiple resets accumulate', () => {
    let capturedKey = 0
    function Multi() {
      const { resetKeys, triggerReset } = usePageReset()
      capturedKey = resetKeys.tryon
      useEffect(() => {
        triggerReset('tryon')
        triggerReset('tryon')
        triggerReset('tryon')
      }, [triggerReset])
      return null
    }
    render(<Multi />, { wrapper })
    expect(capturedKey).toBe(3)
  })
})
