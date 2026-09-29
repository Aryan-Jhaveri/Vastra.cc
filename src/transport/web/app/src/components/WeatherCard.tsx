import { useState, useEffect } from 'react'
import type { WeatherData } from '../api/outfits'
import { Spinner } from './ui/Spinner'

interface WeatherCardProps {
  weather?: WeatherData | null
  loading?: boolean
  locationName?: string
}

function WeatherSkeleton() {
  return (
    <div
      className="border-2 border-ink p-3 rounded-base min-h-[120px] relative"
      data-testid="weather-card"
    >
      <div className="absolute top-3 right-3 border-2 border-ink px-1.5 py-0.5 rounded-base">
        <Spinner size={14} />
      </div>
      <div className="w-16 h-10 bg-ink/10 rounded" />
      <div className="mt-0.5 flex gap-2">
        <div className="w-28 h-4 bg-ink/10 rounded" />
        <div className="w-20 h-4 bg-ink/10 rounded" />
      </div>
      <div className="mt-2 flex gap-4">
        <div className="w-24 h-4 bg-ink/10 rounded" />
        <div className="w-24 h-4 bg-ink/10 rounded" />
      </div>
    </div>
  )
}

export function WeatherCard({ weather, loading, locationName }: WeatherCardProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (weather) {
      requestAnimationFrame(() => setVisible(true))
    }
  }, [weather])

  if (loading) {
    return <WeatherSkeleton />
  }

  if (!weather) {
    return (
      <div
        className="border-2 border-ink p-4 rounded-base min-h-[120px] flex items-center"
        data-testid="weather-card"
      >
        <p className="text-[14px] font-mono uppercase tracking-[0.1em] text-muted">Set a location to see weather.</p>
      </div>
    )
  }

  return (
    <div
      className={`border-2 border-ink p-3 rounded-base relative min-h-[120px] reveal-card ${visible ? 'reveal-card--visible' : ''}`}
      data-testid="weather-card"
    >
      <div className="absolute top-3 right-3 border-2 border-ink px-1.5 py-0.5 rounded-base">
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">{weather.condition}</span>
      </div>
      <div className="text-[40px] font-bold leading-none">{Math.round(weather.temperature)}°</div>
      <div className="text-[14px] font-mono text-muted mt-0.5 uppercase">
        <span>{locationName ?? 'Current location'}</span>
        {' — '}
        {weather.precipitation > 0 ? 'Rain expected' : 'No rain'}
      </div>
      <div className="mt-2 flex gap-4 text-[14px] font-mono text-muted uppercase tracking-[0.06em]">
        <span>Rain {weather.precipitation} mm</span>
        <span>Wind {weather.windSpeed} km/h</span>
      </div>
    </div>
  )
}
