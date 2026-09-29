import { useState, useMemo, useEffect, useRef } from 'react'
import { useLocation as useRouterLocation, useNavigate } from 'react-router'
import { MapPin } from 'lucide-react'
import { useLocation } from '../hooks/useLocation'
import { fetchWeather } from '../api/outfits'
import type { WeatherData } from '../api/outfits'
import { getMe } from '../api/auth'
import { WeatherCard } from '../components/WeatherCard'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/Button'
import { TabStrip, type HomeTab } from '../components/home/TabStrip'
import { SuggestTab } from '../components/home/SuggestTab'
import { RemindersTab } from '../components/home/RemindersTab'
import { DiscoverTab } from '../components/home/DiscoverTab'
import { AskTab } from '../components/home/AskTab'
import { useChatEnabled } from '../hooks/useChatEnabled'
import { TabFade } from '../components/TabFade'
import { usePageReset } from '../context/PageResetContext'

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning.'
  if (h < 17) return 'Good afternoon.'
  return 'Good evening.'
}

export function Home() {
  const routerLocation = useRouterLocation()
  const navigate = useNavigate()
  const { location, loading: locLoading, geocode, requestBrowserLocation } = useLocation()
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [cityInput, setCityInput] = useState('')
  const [userName, setUserName] = useState<string | null>(null)

  const { resetKeys } = usePageReset()
  const homeResetKey = resetKeys.home
  const initialHomeResetKey = useRef(homeResetKey)
  useEffect(() => {
    if (homeResetKey === initialHomeResetKey.current) return
    navigate({ hash: 'suggest' }, { replace: true })
  }, [homeResetKey, navigate])

  useEffect(() => {
    getMe().then(res => setUserName(res.name)).catch(() => {})
  }, [])

  const chatEnabled = useChatEnabled()

  const activeTab = useMemo<HomeTab>(() => {
    const hash = routerLocation.hash.replace('#', '')
    if (hash === 'reminders' || hash === 'discover') return hash
    if (hash === 'ask' && chatEnabled) return 'ask'
    return 'suggest'
  }, [routerLocation.hash, chatEnabled])

  function setTab(tab: HomeTab) {
    navigate({ hash: tab }, { replace: true })
  }

  // Auto-switch to Discover tab if there's a pending share
  useEffect(() => {
    const pendingShare = localStorage.getItem('closet-pending-share')
    if (pendingShare && activeTab !== 'discover') {
      navigate({ hash: 'discover' }, { replace: true })
    }
  }, [activeTab, navigate])

  // Fetch weather when location becomes available (lightweight, no LLM)
  useEffect(() => {
    if (!location) return
    setWeatherLoading(true)
    fetchWeather(location.lat, location.lon)
      .then(setWeather)
      .catch(() => {})
      .finally(() => setWeatherLoading(false))
  }, [location?.lat, location?.lon]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGeocode(e: React.FormEvent) {
    e.preventDefault()
    if (!cityInput.trim()) return
    try { await geocode(cityInput.trim()) }
    catch { /* error shown in WeatherCard */ }
  }

  async function handleGPS() {
    try { await requestBrowserLocation() }
    catch { /* user denied */ }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title={getGreeting()}
        subtitle={userName ? <span className="text-muted normal-case">{userName}</span> : undefined}
        hideEmptySubtitle={!userName}
      />

      {/* Weather — always visible above tabs */}
      <WeatherCard
        weather={weather}
        loading={weatherLoading}
        locationName={location?.name}
      />

      {/* City input */}
      <form onSubmit={handleGeocode} className="flex gap-2">
        <input
          value={cityInput}
          onChange={e => setCityInput(e.target.value)}
          placeholder="Enter city…"
          className="flex-1 border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
        />
        <Button type="submit" variant="secondary" loading={locLoading}>Go</Button>
        <button
          type="button"
          onClick={handleGPS}
          title="Use my location"
          aria-label="Use my location"
          className="border-2 border-ink px-3 py-2 hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] flex items-center justify-center rounded-base"
        >
          <MapPin className="w-4 h-4" />
        </button>
      </form>

      {/* Tab strip */}
      <TabStrip active={activeTab} onChange={setTab} showAsk={chatEnabled} />

      {/* Tab body */}
      {activeTab === 'suggest' && (
        <TabFade>
          <SuggestTab key={homeResetKey} location={location} />
        </TabFade>
      )}
      {activeTab === 'reminders' && (
        <TabFade>
          <RemindersTab />
        </TabFade>
      )}
      {activeTab === 'discover' && (
        <TabFade>
          <DiscoverTab location={location} />
        </TabFade>
      )}
      {activeTab === 'ask' && (
        <TabFade>
          <AskTab />
        </TabFade>
      )}
    </div>
  )
}
