import { apiFetchJSON } from './client'
import type { WeatherData } from './outfits'

export interface GeoResult {
  lat: number
  lon: number
  name: string
  countryCode?: string
}

export async function fetchWeather(lat: number, lon: number): Promise<WeatherData> {
  return apiFetchJSON(`/api/weather?lat=${lat}&lon=${lon}`)
}

export async function geocodeCity(city: string): Promise<GeoResult> {
  return apiFetchJSON(`/api/weather/geocode?city=${encodeURIComponent(city)}`)
}
