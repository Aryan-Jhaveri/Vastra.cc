import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WeatherCard } from '../../src/components/WeatherCard'
import type { WeatherData } from '../../src/api/outfits'

const mockWeather: WeatherData = {
  temperature: 22,
  weatherCode: 0,
  condition: 'Clear sky',
  precipitation: 0,
  windSpeed: 15,
  icon: '☀️',
}

describe('WeatherCard', () => {
  it('shows loading skeleton with stable min-height', () => {
    render(<WeatherCard loading />)
    const card = screen.getByTestId('weather-card')
    expect(card.className).toContain('min-h-[120px]')
  })

  it('shows placeholder with stable min-height', () => {
    render(<WeatherCard />)
    const card = screen.getByTestId('weather-card')
    expect(card.className).toContain('min-h-[120px]')
    expect(screen.getByText(/Set a location/i)).toBeInTheDocument()
  })

  it('renders temperature and condition with reveal-card animation class', () => {
    render(<WeatherCard weather={mockWeather} locationName="Toronto" />)
    const card = screen.getByTestId('weather-card')
    expect(card.className).toContain('min-h-[120px]')
    expect(card.className).toContain('reveal-card')
    expect(screen.getByText(/22°/)).toBeInTheDocument()
    expect(screen.getByText('Clear sky')).toBeInTheDocument()
    expect(screen.getByText('Toronto')).toBeInTheDocument()
  })

  it('transitions from loading to loaded without layout shift', () => {
    const { rerender } = render(<WeatherCard loading />)
    const loadingCard = screen.getByTestId('weather-card')
    expect(loadingCard.className).toContain('min-h-[120px]')

    rerender(<WeatherCard weather={mockWeather} />)
    const loadedCard = screen.getByTestId('weather-card')
    expect(loadedCard.className).toContain('min-h-[120px]')
    expect(loadedCard.className).toContain('reveal-card')
  })

  it('renders precipitation and wind', () => {
    render(<WeatherCard weather={mockWeather} />)
    expect(screen.getByText(/0 mm/)).toBeInTheDocument()
    expect(screen.getByText(/15 km\/h/)).toBeInTheDocument()
  })
})
