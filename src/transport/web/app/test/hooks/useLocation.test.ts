import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../../src/api/weather', () => ({
  geocodeCity: vi.fn(),
}))

import * as weatherApi from '../../src/api/weather'

const LOCATION_KEY = 'closet-location'

// Minimal localStorage mock
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((k: string) => store[k] ?? null),
  setItem: vi.fn((k: string, v: string) => { store[k] = v }),
  removeItem: vi.fn((k: string) => { delete store[k] }),
  clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]) }),
}
vi.stubGlobal('localStorage', localStorageMock)

describe('useLocation', () => {
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k])
    vi.clearAllMocks()
    localStorageMock.getItem.mockImplementation((k: string) => store[k] ?? null)
    localStorageMock.setItem.mockImplementation((k: string, v: string) => { store[k] = v })
    localStorageMock.removeItem.mockImplementation((k: string) => { delete store[k] })
  })

  it('returns null when no location stored', async () => {
    const { useLocation } = await import('../../src/hooks/useLocation')
    const { result } = renderHook(() => useLocation())
    expect(result.current.location).toBeNull()
  })

  it('reads location from localStorage on mount', async () => {
    const loc = { lat: 43.7, lon: -79.4, name: 'Toronto' }
    store[LOCATION_KEY] = JSON.stringify(loc)
    const { useLocation } = await import('../../src/hooks/useLocation')
    const { result } = renderHook(() => useLocation())
    expect(result.current.location).toEqual(loc)
  })

  it('setLocation persists to localStorage', async () => {
    const { useLocation } = await import('../../src/hooks/useLocation')
    const { result } = renderHook(() => useLocation())
    const loc = { lat: 51.5, lon: -0.12, name: 'London' }
    act(() => result.current.setLocation(loc))
    expect(result.current.location).toEqual(loc)
    expect(JSON.parse(store[LOCATION_KEY])).toEqual(loc)
  })

  it('clearLocation removes from localStorage', async () => {
    const loc = { lat: 43.7, lon: -79.4, name: 'Toronto' }
    store[LOCATION_KEY] = JSON.stringify(loc)
    const { useLocation } = await import('../../src/hooks/useLocation')
    const { result } = renderHook(() => useLocation())
    act(() => result.current.clearLocation())
    expect(result.current.location).toBeNull()
    expect(store[LOCATION_KEY]).toBeUndefined()
  })

  it('geocode calls API and stores result', async () => {
    vi.mocked(weatherApi.geocodeCity).mockResolvedValue({ lat: 48.8, lon: 2.35, name: 'Paris' })
    const { useLocation } = await import('../../src/hooks/useLocation')
    const { result } = renderHook(() => useLocation())
    await act(async () => {
      await result.current.geocode('Paris')
    })
    expect(result.current.location?.name).toBe('Paris')
    expect(weatherApi.geocodeCity).toHaveBeenCalledWith('Paris')
  })
})
