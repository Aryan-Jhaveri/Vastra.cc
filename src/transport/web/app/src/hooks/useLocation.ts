import { useState, useCallback } from 'react'
import { geocodeCity } from '../api/weather'

const LOCATION_KEY = 'closet-location'

interface LocationData {
  lat: number
  lon: number
  name: string
  countryCode?: string
}

function loadLocation(): LocationData | null {
  try {
    const raw = localStorage.getItem(LOCATION_KEY)
    return raw ? (JSON.parse(raw) as LocationData) : null
  } catch {
    return null
  }
}

function saveLocation(loc: LocationData): void {
  localStorage.setItem(LOCATION_KEY, JSON.stringify(loc))
}

export function useLocation() {
  const [location, setLocationState] = useState<LocationData | null>(loadLocation)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setLocation = useCallback((loc: LocationData) => {
    saveLocation(loc)
    setLocationState(loc)
  }, [])

  const clearLocation = useCallback(() => {
    localStorage.removeItem(LOCATION_KEY)
    setLocationState(null)
  }, [])

  const requestBrowserLocation = useCallback((): Promise<LocationData> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'))
        return
      }
      setLoading(true)
      setError(null)
      navigator.geolocation.getCurrentPosition(
        pos => {
          const loc: LocationData = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            name: 'Current location',
          }
          setLocation(loc)
          setLoading(false)
          resolve(loc)
        },
        err => {
          setLoading(false)
          setError(err.message)
          reject(err)
        },
      )
    })
  }, [setLocation])

  const geocode = useCallback(async (city: string): Promise<LocationData> => {
    setLoading(true)
    setError(null)
    try {
      const result = await geocodeCity(city)
      const loc: LocationData = { lat: result.lat, lon: result.lon, name: result.name, ...(result.countryCode ? { countryCode: result.countryCode } : {}) }
      setLocation(loc)
      return loc
    } catch (err) {
      setError(String(err))
      throw err
    } finally {
      setLoading(false)
    }
  }, [setLocation])

  return { location, loading, error, setLocation, clearLocation, requestBrowserLocation, geocode }
}
