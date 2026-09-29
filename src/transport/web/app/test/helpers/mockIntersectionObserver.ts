import { vi } from 'vitest'

// jsdom ships no IntersectionObserver. Vitest ≥3 rejects `new` on arrow-function
// vi.fn implementations, so the constructor below is a plain function expression
// returning the observer instance — constructible on every vitest version.
// Callers trigger visibility by invoking a captured callback directly.
export type MockIOEntry = { isIntersecting: boolean }
export type MockIOCallback = (entries: MockIOEntry[]) => void

export interface MockIOInstance {
  observe: ReturnType<typeof vi.fn>
  unobserve: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

export interface MockIOHandle {
  callbacks: MockIOCallback[]
  instances: MockIOInstance[]
  lastCallback: MockIOCallback
}

export function installMockIntersectionObserver(): MockIOHandle {
  const callbacks: MockIOCallback[] = []
  const instances: MockIOInstance[] = []

  const MockIntersectionObserver = vi.fn(function (callback: MockIOCallback): MockIOInstance {
    callbacks.push(callback)
    const instance: MockIOInstance = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }
    instances.push(instance)
    return instance
  })

  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

  return {
    callbacks,
    instances,
    get lastCallback() {
      return callbacks[callbacks.length - 1]!
    },
  }
}
