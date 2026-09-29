import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useInView } from '../../src/hooks/useInView'

describe('useInView fallback', () => {
  it('returns inView=true when IntersectionObserver is missing', () => {
    let result: { inView: boolean } | null = null
    function TestComp() {
      const hook = useInView({ rootMargin: '200px' })
      result = hook
      return <div ref={hook.ref} data-testid="el" />
    }
    render(<TestComp />)
    expect(result?.inView).toBe(true)
  })

  it('returns ref object', () => {
    let result: { ref: { current: HTMLDivElement | null } } | null = null
    function TestComp() {
      const hook = useInView()
      result = hook
      return <div ref={hook.ref} data-testid="el" />
    }
    render(<TestComp />)
    expect(result?.ref).toBeDefined()
    expect(result?.ref.current).toBeInstanceOf(HTMLDivElement)
  })
})
