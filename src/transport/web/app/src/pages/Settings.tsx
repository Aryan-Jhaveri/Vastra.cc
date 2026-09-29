import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { useLocation } from '../hooks/useLocation'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/Button'
import { apiFetch, clearSessionState } from '../api/client'
import { useSettings } from '../hooks/useSettings'
import { useShopEnabled } from '../hooks/useShopEnabled'
import type { ShopGender } from '../api/settings'
import { formatSizesSummary } from '../constants/sizes'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { HostedBillingSection, HostedLegalLinks } from '../hosted'
import { ChevronRight, ChevronDown, Moon, Sun, Download, Share2, Heart } from 'lucide-react'
import {
  THEMES,
  applyThemePreference,
  loadSavedCustomPalettes,
  loadSavedCustomPaletteSlot,
  loadSavedTheme,
  type CustomThemePalette,
  type CustomThemePalettes,
  type CustomPaletteSlot,
  type ThemeModeColors,
} from '../lib/theme'
import { Sheet } from '../components/ui/Sheet'
import { useInstallPrompt } from '../hooks/useInstallPrompt'
import { usePageReset } from '../context/PageResetContext'
import { InlineField } from '../components/ui/InlineField'
import { deleteAccount } from '../api/account'
import { getMe, patchMe } from '../api/auth'
import { getAuthStatus } from '../api/tokens'
import { ConnectionsSection } from '../components/settings/ConnectionsSection'
import { ManageLinksSection } from '../components/settings/ManageLinks'

const EMPTY_CUSTOM_PALETTE: CustomThemePalette = {
  light: { primary: '#0a0a0a', secondary: '#ffffff', tertiary: '#bfbfbf' },
  dark: { primary: '#f5f5f5', secondary: '#0a0a0a', tertiary: '#444444' },
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function Settings({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate()
  const shopEnabled = useShopEnabled()

  const [isDark, setIsDark] = useState(() => localStorage.getItem('theme') === 'dark')
  const [themeId, setThemeId] = useState(() => loadSavedTheme())
  const [customPalettes, setCustomPalettes] = useState<CustomThemePalettes>(() => loadSavedCustomPalettes())
  const [customPaletteSlot, setCustomPaletteSlot] = useState<CustomPaletteSlot | null>(() => loadSavedCustomPaletteSlot())
  const [editingCustomSlot, setEditingCustomSlot] = useState<CustomPaletteSlot | null>(null)
  const [draftCustomPalette, setDraftCustomPalette] = useState<CustomThemePalette | null>(null)

  const isDarkRef = useRef(isDark)
  isDarkRef.current = isDark
  const themeIdRef = useRef(themeId)
  themeIdRef.current = themeId

  const { settings, loading: settingsLoading, update: updateSettings } = useSettings()

  // Apply account theme when loaded (syncs across devices)
  useEffect(() => {
    if (settingsLoading) return
    if (!settings.themeId && !settings.colorScheme && !settings.customPalettes && !settings.customPaletteSlot) return
    const id = settings.themeId && THEMES.some(t => t.id === settings.themeId)
      ? settings.themeId!
      : themeIdRef.current
    const dark = settings.colorScheme === 'dark'
      ? true
      : settings.colorScheme === 'light'
        ? false
        : isDarkRef.current
    setThemeId(id)
    setIsDark(dark)
    setCustomPalettes(settings.customPalettes ?? {})
    setCustomPaletteSlot(settings.customPaletteSlot ?? null)
    applyThemePreference(id, dark, settings.customPalettes ?? {}, settings.customPaletteSlot ?? null)
  }, [settingsLoading, settings.themeId, settings.colorScheme, settings.customPalettes, settings.customPaletteSlot])

  async function persistThemePrefs(
    id: string,
    dark: boolean,
    slot: CustomPaletteSlot | null = customPaletteSlot,
    palettes: CustomThemePalettes = customPalettes,
  ) {
    applyThemePreference(id, dark, palettes, slot)
    setThemeId(id)
    setIsDark(dark)
    setCustomPalettes(palettes)
    setCustomPaletteSlot(slot)
    try {
      await updateSettings({
        themeId: id,
        colorScheme: dark ? 'dark' : 'light',
        customPalettes: palettes,
        customPaletteSlot: slot,
      })
    } catch { /* local prefs still applied */ }
  }

  function openCustomPalette(slot: CustomPaletteSlot) {
    const saved = customPalettes[slot]
    setDraftCustomPalette(saved ? { light: { ...saved.light }, dark: { ...saved.dark } } : {
      light: { ...EMPTY_CUSTOM_PALETTE.light },
      dark: { ...EMPTY_CUSTOM_PALETTE.dark },
    })
    setEditingCustomSlot(slot)
  }

  function closeCustomPalette() {
    setEditingCustomSlot(null)
    setDraftCustomPalette(null)
  }

  function handleDraftPaletteChange(mode: 'light' | 'dark', role: keyof ThemeModeColors, value: string) {
    setDraftCustomPalette(current => current ? {
      ...current,
      [mode]: { ...current[mode], [role]: value },
    } : current)
  }

  function saveCustomPalette() {
    if (editingCustomSlot === null || draftCustomPalette === null) return
    const next = { ...customPalettes, [editingCustomSlot]: draftCustomPalette }
    void persistThemePrefs(themeId, isDark, editingCustomSlot, next)
    closeCustomPalette()
  }

  function resetCustomPalette() {
    if (editingCustomSlot === null) return
    const next = { ...customPalettes }
    delete next[editingCustomSlot]
    const nextSlot = customPaletteSlot === editingCustomSlot ? null : customPaletteSlot
    void persistThemePrefs(themeId, isDark, nextSlot, next)
    closeCustomPalette()
  }

  function toggleDarkMode() {
    void persistThemePrefs(themeId, !isDark)
  }

  function handleThemeChange(id: string) {
    void persistThemePrefs(id, isDark, null)
  }

  const { location, geocode, clearLocation } = useLocation()
  const [cityInput, setCityInput] = useState(location?.name ?? '')
  const [geoLoading, setGeoLoading] = useState(false)
  const [savingServerLocation, setSavingServerLocation] = useState(false)
  const [serverLocationError, setServerLocationError] = useState<string | null>(null)
  const serverLocation = settings.serverLocation?.enabled ? settings.serverLocation : null

  // Explicit consent only: the browser location is never uploaded on its own.
  async function handleSaveServerLocation() {
    if (!location) return
    setSavingServerLocation(true)
    setServerLocationError(null)
    try {
      await updateSettings({ serverLocation: { enabled: true, ...location } })
    } catch {
      setServerLocationError('Could not save location. Try again.')
    } finally {
      setSavingServerLocation(false)
    }
  }

  async function handleRemoveServerLocation() {
    setSavingServerLocation(true)
    setServerLocationError(null)
    try {
      await updateSettings({ serverLocation: { enabled: false } })
    } catch {
      setServerLocationError('Could not remove location. Try again.')
    } finally {
      setSavingServerLocation(false)
    }
  }
  const { state: pushState, subscribe: subscribePush, unsubscribe: unsubscribePush, sendTest: sendTestPush } = usePushNotifications()
  const { canInstall, isInstalled, install } = useInstallPrompt()
  const [installLoading, setInstallLoading] = useState(false)
  const [userName, setUserNameState] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string>('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [tokensEnabled, setTokensEnabled] = useState(false)

  const [pushMsg, setPushMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pushTesting, setPushTesting] = useState(false)

  useEffect(() => {
    getMe().then(res => {
      setUserNameState(res.name)
      setUserEmail(res.email)
      setIsAdmin(res.isAdmin === true)
    }).catch(() => {})
    getAuthStatus().then(res => setTokensEnabled(Boolean(res.tokensEnabled))).catch(() => {})
  }, [])

  async function handleEnablePush() {
    setPushMsg(null)
    const res = await subscribePush()
    if (!res.ok && res.error) setPushMsg({ kind: 'err', text: res.error })
  }

  async function handleTestPush() {
    setPushTesting(true)
    setPushMsg(null)
    const res = await sendTestPush()
    setPushTesting(false)
    if (res.ok) {
      setPushMsg({
        kind: 'ok',
        text: res.sent > 0
          ? `Sent ✓ (${res.sent} device${res.sent > 1 ? 's' : ''})`
          : 'No registered devices to notify',
      })
    } else {
      setPushMsg({ kind: 'err', text: `Failed: ${res.error ?? 'unknown error'}` })
    }
    setTimeout(() => setPushMsg(null), 5000)
  }

  // Password change — hidden until user taps "Change Password"
  const [showPwForm, setShowPwForm] = useState(false)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)

  // Delete account confirmation
  const [deleteExpanded, setDeleteExpanded] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const { resetKeys } = usePageReset()
  const settingsResetKey = resetKeys.settings
  const initialResetKey = useRef(settingsResetKey)
  const resetAllState = useCallback(() => {
    setShowPwForm(false)
    setPwCurrent('')
    setPwNew('')
    setPwConfirm('')
    setPwError(null)
    setPwSuccess(false)
    setDeleteExpanded(false)
    setShowDeleteConfirm(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])
  useEffect(() => {
    if (settingsResetKey === initialResetKey.current) return
    resetAllState()
  }, [settingsResetKey, resetAllState])

  async function handleUpdateCity(e: React.FormEvent) {
    e.preventDefault()
    if (!cityInput.trim()) return
    setGeoLoading(true)
    try {
      await geocode(cityInput.trim())
    } finally {
      setGeoLoading(false)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwError(null)
    setPwSuccess(false)
    if (pwNew !== pwConfirm) { setPwError('New passwords do not match'); return }
    setPwLoading(true)
    try {
      const res = await apiFetch('/api/settings/password', {
        method: 'POST',
        body: JSON.stringify({ current: pwCurrent, newPassword: pwNew }),
      })
      const body = await res.json() as { error?: string }
      if (!res.ok) { setPwError(body.error ?? 'Failed to update password'); return }
      // The server rotated the __system__ password and set a fresh httpOnly
      // cookie; nothing is stored client-side (#295).
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
      setPwSuccess(true)
      setShowPwForm(false)
    } catch {
      setPwError('Something went wrong')
    } finally {
      setPwLoading(false)
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
    clearSessionState()
    clearLocation()
    window.location.assign('https://www.vastra.cc')
  }

  async function handleDeleteAccount() {
    setDeleteLoading(true)
    try {
      await deleteAccount()
      localStorage.clear()
      window.location.assign('/login')
    } catch {
      setDeleteLoading(false)
    }
  }

  return (
    <div className="flex flex-col p-4 pb-20">
      <PageHeader title="Settings." hideEmptySubtitle={true} />
      <div className="mb-6" />

      {/* Profile section */}
      <div className="mb-6">
        <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-0 mb-0 pb-1 border-b border-outline-variant">Profile</p>
        <div className="border-b border-outline-variant py-3">
          <p className="text-sm font-mono text-muted mb-3">{userEmail}</p>
          <InlineField
            label="Name"
            value={userName}
            onSave={async (next) => {
              if (!next.trim()) return
              await patchMe({ name: next.trim() })
              setUserNameState(next.trim())
            }}
            maxLength={128}
            placeholder="Your name"
          />
        </div>
      </div>

      {/* Location section */}
      <div className="mb-2"></div>
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-0 mb-0 pb-1 border-b border-outline-variant">Location</p>
      {location && (
        <div className="border-b border-outline-variant py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{location.name}</p>
            <p className="text-[14px] font-mono text-muted mt-0.5">{location.lat.toFixed(4)}, {location.lon.toFixed(4)}</p>
          </div>
          <button
            onClick={clearLocation}
            className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors rounded-base"
          >
            Clear
          </button>
        </div>
      )}
      <div className="border-b border-outline-variant py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Saved for scheduled features</p>
            <p className="text-[14px] font-mono text-muted mt-0.5">
              {serverLocation
                ? `${serverLocation.name} — ${serverLocation.lat.toFixed(4)}, ${serverLocation.lon.toFixed(4)}`
                : 'Not saved. Reminders run without weather context.'}
            </p>
          </div>
          {serverLocation ? (
            <Button variant="secondary" onClick={handleRemoveServerLocation} loading={savingServerLocation}>Remove</Button>
          ) : (
            <Button
              variant="secondary"
              onClick={handleSaveServerLocation}
              loading={savingServerLocation}
              disabled={!location}
            >
              Save
            </Button>
          )}
        </div>
        {serverLocationError && (
          <p className="text-[13px] font-mono text-error mt-2">{serverLocationError}</p>
        )}
      </div>
      <form onSubmit={handleUpdateCity} className="py-3 flex gap-2">
        <input
          value={cityInput}
          onChange={e => setCityInput(e.target.value)}
          placeholder="Update city…"
          className="flex-1 border-2 border-ink px-3 py-2 text-sm font-mono outline-none bg-paper text-ink focus:bg-surface-dim"
        />
        <Button type="submit" variant="secondary" loading={geoLoading}>Update</Button>
      </form>

      {/* Style & shopping (#329) — Sizes always; the shop rows only when the
          shop row is enabled (#324). */}
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">
        Style &amp; shopping <span className="ml-1 text-[11px] border border-ink px-1 text-ink">New</span>
      </p>
      <button
        onClick={() => navigate('/settings/sizes')}
        className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium">Sizes</p>
          <p className="text-[14px] font-mono text-muted mt-0.5 truncate">
            {formatSizesSummary(settings.userSizes) || 'Add your sizes'}
          </p>
        </div>
        <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
      </button>
      {shopEnabled && (
        <>
          <button
            onClick={() => navigate('/settings/liked')}
            className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium flex items-center gap-2">
                <Heart className="w-4 h-4 text-muted" strokeWidth={2} />
                Liked items
              </p>
              <p className="text-[14px] font-mono text-muted mt-0.5 truncate">Saved from shop results</p>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          </button>
          <ShopForRow
            // #335: null while loading, so no option is highlighted until the
            // saved value arrives (a default here flickers to the real one).
            value={settingsLoading ? null : settings.shopGender ?? 'any'}
            disabled={settingsLoading}
            onChange={async (shopGender) => { await updateSettings({ shopGender }) }}
          />
        </>
      )}

      {/* Push Notifications */}
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">Push Notifications</p>
      <div className="border-b border-outline-variant py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Outfit reminders</p>
            <p className="text-[14px] font-mono text-muted mt-0.5">
              {pushState === 'unsupported' ? 'Not supported in this browser' :
               pushState === 'denied' ? 'Blocked — allow in browser settings' :
               pushState === 'subscribed' ? 'Enabled — notified when jobs run' :
               'Get notified when scheduled jobs fire'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pushState === 'subscribed' && (
              <button
                onClick={handleTestPush}
                disabled={pushTesting}
                className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] px-3 py-1.5 border-2 border-ink text-ink hover:bg-surface-dim transition-colors disabled:opacity-40"
              >
                {pushTesting ? '…' : 'Send test'}
              </button>
            )}
            {pushState !== 'unsupported' && pushState !== 'denied' && (
              <button
                onClick={pushState === 'subscribed' ? unsubscribePush : handleEnablePush}
                disabled={pushState === 'loading'}
                className={`text-[14px] font-bold font-mono uppercase tracking-[0.08em] px-3 py-1.5 border-2 transition-colors disabled:opacity-40
                  ${pushState === 'subscribed'
                    ? 'border-ink text-ink hover:bg-surface-dim'
                    : 'border-ink bg-accent text-accent-on hover:opacity-90'}`}
              >
                {pushState === 'loading' ? '…' : pushState === 'subscribed' ? 'Turn off' : 'Enable'}
              </button>
            )}
          </div>
        </div>
        {pushMsg && (
          <p className={`text-[14px] font-mono mt-2 ${pushMsg.kind === 'ok' ? 'text-muted' : 'text-red-600'}`}>
            {pushMsg.text}
          </p>
        )}
        {pushState === 'denied' && (
          <p className="text-[14px] font-mono text-muted mt-2">
            iOS: Settings → Notifications → Vastra to re-enable.
          </p>
        )}
      </div>

      {/* Security section */}
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">Security</p>

      {/* Change password — collapsed by default */}
      {!showPwForm ? (
        <button
          onClick={() => setShowPwForm(true)}
          className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
        >
          <p className="text-sm font-medium">Change Password</p>
          <ChevronRight className="w-3.5 h-3.5 text-muted" />
        </button>
      ) : (
        <form onSubmit={handleChangePassword} className="py-3 flex flex-col gap-3 border-b border-outline-variant">
          {pwError && (
            <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[14px] font-mono uppercase tracking-[0.06em] rounded-base">{pwError}</div>
          )}
          {pwSuccess && (
            <div className="border-2 border-ink bg-accent text-accent-on px-3 py-2 text-[14px] font-mono uppercase tracking-[0.06em] rounded-base">Password updated</div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted">Current Password</label>
            <input type="password" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)} required
              className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none bg-paper text-ink focus:bg-surface-dim" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted">New Password</label>
            <input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} required minLength={8}
              className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none bg-paper text-ink focus:bg-surface-dim" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted">Confirm New Password</label>
            <input type="password" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} required minLength={8}
              className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none bg-paper text-ink focus:bg-surface-dim" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" loading={pwLoading}>Save</Button>
            <button
              type="button"
              onClick={() => { setShowPwForm(false); setPwCurrent(''); setPwNew(''); setPwConfirm(''); setPwError(null) }}
              className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors rounded-base"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Connections — personal API tokens (#321). Hidden in HOSTED_MODE. */}
      {tokensEnabled && <ConnectionsSection />}

      {/* Manage Links */}
      <ManageLinksSection />

      {/* Billing + legal pages are vastra.cc's own (#358): absent from self-host builds. */}
      <HostedBillingSection />
      <HostedLegalLinks />

      {/* Install App */}
      {canInstall && (
        <>
          <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">App</p>
          <div className="border-b border-outline-variant py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Install App</p>
              <p className="text-[14px] font-mono text-muted mt-0.5">Add to home screen for quick access</p>
            </div>
            <button
              onClick={async () => {
                setInstallLoading(true)
                await install()
                setInstallLoading(false)
              }}
              disabled={installLoading}
              className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-accent hover:text-accent-on transition-colors disabled:opacity-40 flex items-center gap-1.5 rounded-base"
            >
              <Download className="w-3 h-3" />
              {installLoading ? '…' : 'Install'}
            </button>
          </div>
        </>
      )}
      {!isInstalled && !canInstall && isIOS() && (
        <>
          <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">App</p>
          <div className="border-b border-outline-variant py-3">
            <p className="text-sm font-medium">Install App</p>
            <p className="text-[14px] font-mono text-muted mt-0.5">
              Tap <Share2 className="w-3 h-3 inline-block" /> <strong>Share</strong> then <strong>Add to Home Screen</strong>
            </p>
          </div>
        </>
      )}
      {isInstalled && (
        <>
          <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">App</p>
          <div className="border-b border-outline-variant py-3">
            <p className="text-sm font-medium text-muted">Installed</p>
            <p className="text-[14px] font-mono text-muted mt-0.5">This app is on your home screen</p>
          </div>
        </>
      )}

      {/* Appearance section */}
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">Appearance</p>
      <div className="border-b border-outline-variant py-3 flex items-center justify-between">
        <p className="text-sm font-medium">Dark Mode</p>
        <button
          onClick={toggleDarkMode}
          className="border-2 border-ink px-5 py-2.5 hover:bg-surface-dim transition-colors rounded-full flex items-center gap-2"
          title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em]">{isDark ? 'Light' : 'Dark'}</span>
        </button>
      </div>
      <div className="py-3 flex flex-col gap-3">
        <p className="text-sm font-medium">Theme</p>
        <p className="text-[13px] font-mono text-muted">Swipe past the four basic themes to reach your custom slots.</p>
        <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-2">
          {THEMES.map(theme => {
            const isActive = customPaletteSlot === null && themeId === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => handleThemeChange(theme.id)}
                aria-pressed={isActive}
                className={`relative flex w-[154px] min-w-[154px] snap-start flex-col border-2 p-3 text-left transition-all ${isActive ? 'border-ink' : 'border-outline-variant hover:border-muted'}`}
                style={{ background: theme.light['--color-paper'] }}
              >
                <div className="flex flex-col gap-1 mb-2">
                  {(['Light', 'Dark'] as const).map((mode, index) => {
                    const colors = index === 0 ? theme.light : theme.dark
                    return (
                      <div key={mode} className="flex items-center gap-1" aria-label={`${mode} palette swatches`}>
                        {(['--color-primary', '--color-secondary', '--color-tertiary'] as const).map(token => (
                          <span key={token} className="h-4 w-4 border border-black/10" style={{ background: colors[token] }} />
                        ))}
                      </div>
                    )
                  })}
                </div>
                <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em]" style={{ color: theme.light['--color-ink'] }}>
                  {theme.label}
                </span>
                {theme.description && (
                  <span className="text-[14px] font-mono" style={{ color: theme.light['--color-muted'] }}>
                    {theme.description}
                  </span>
                )}
              </button>
            )
          })}
          {([1, 2, 3, 4] as const).map(slot => {
            const palette = customPalettes[slot]
            const isActive = customPaletteSlot === slot
            return (
              <button
                key={`custom-${slot}`}
                type="button"
                onClick={() => openCustomPalette(slot)}
                aria-label={palette ? `Edit Custom ${slot} palette` : `Create Custom ${slot} palette`}
                aria-pressed={isActive}
                className={`flex w-[154px] min-w-[154px] snap-start flex-col border-2 p-3 text-left transition-all ${isActive ? 'border-ink' : 'border-dashed border-outline-variant hover:border-muted'}`}
              >
                <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em]">Custom {slot}</span>
                {palette ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {(['Light', 'Dark'] as const).map((mode, index) => {
                      const colors = index === 0 ? palette.light : palette.dark
                      return (
                        <div key={mode} className="flex items-center gap-1" aria-label={`${mode} custom palette swatches`}>
                          {[colors.primary, colors.secondary, colors.tertiary].map((color, colorIndex) => (
                            <span key={colorIndex} className="h-4 w-4 border border-black/10" style={{ background: color }} />
                          ))}
                        </div>
                      )
                    })}
                    <span className="mt-1 text-[12px] font-mono text-muted">Tap to edit</span>
                  </div>
                ) : (
                  <span className="mt-3 flex h-16 flex-col items-center justify-center border border-dashed border-outline-variant text-muted">
                    <span className="text-xl leading-none">+</span>
                    <span className="text-[11px] font-mono uppercase tracking-[0.08em]">Empty</span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Instance (#315) — admin only: the config make setup wrote, read-only. */}
      {isAdmin && (
        <>
          <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">Instance</p>
          <button
            onClick={() => navigate('/settings/instance')}
            className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">Configuration</p>
              <p className="text-[14px] font-mono text-muted mt-0.5 truncate">AI providers, sign-ups, email and push</p>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          </button>
        </>
      )}

      {/* About section */}
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">About</p>
      <button
        onClick={() => navigate('/settings/guide')}
        className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
      >
        <p className="text-sm font-medium">Guide</p>
        <ChevronRight className="w-3.5 h-3.5 text-muted" />
      </button>
      <button
        onClick={() => navigate('/about')}
        className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
      >
        <p className="text-sm font-medium">Meet the team</p>
        <ChevronRight className="w-3.5 h-3.5 text-muted" />
      </button>
      <div className="py-3 flex items-center justify-between border-b border-outline-variant">
        <p className="text-sm font-medium">Vastra</p>
        <p className="text-[14px] font-mono text-muted" data-testid="app-version">v{__APP_VERSION__}</p>
      </div>

      {/* Delete */}
      {userEmail !== 'self@local.closet' && (
        <div className="mt-6">
          <button
            onClick={() => { setDeleteExpanded(e => !e); setShowDeleteConfirm(false) }}
            className="w-full border-b border-outline-variant py-3 flex items-center justify-between text-left hover:bg-surface-dim transition-colors"
          >
            <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-red-600">Delete</p>
            {deleteExpanded
              ? <ChevronDown className="w-3.5 h-3.5 text-red-400" />
              : <ChevronRight className="w-3.5 h-3.5 text-red-400" />}
          </button>
          {deleteExpanded && (
            <div className="py-3 flex flex-col gap-3">
              {!showDeleteConfirm ? (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="border-2 border-red-500 text-red-600 py-3 px-4 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-red-50 transition-colors rounded-base"
                >
                  Delete Account
                </button>
              ) : (
                <>
                  <p className="text-[14px] font-mono text-muted leading-relaxed">
                    This will permanently delete your account, items, outfits, and images. This cannot be undone.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      className="border-2 border-ink px-4 py-2 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors rounded-base"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDeleteAccount}
                      disabled={deleteLoading}
                      className="border-2 border-red-500 bg-red-500 text-white px-4 py-2 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-red-600 transition-colors disabled:opacity-40 rounded-base"
                    >
                      {deleteLoading ? 'Deleting…' : 'Yes, delete my account'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Log out — at the end of the page */}
      <div className="mt-6">
        <button
          onClick={handleLogout}
          className="border-2 border-ink px-4 py-3 w-full text-sm font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors rounded-base flex items-center justify-center gap-2"
        >
          Log Out
        </button>
      </div>

      <Sheet
        open={editingCustomSlot !== null}
        onClose={closeCustomPalette}
        title={editingCustomSlot === null ? undefined : `Custom ${editingCustomSlot} palette`}
        peekHeight="64vh"
        actions={(
          <div className="flex items-center gap-2 p-3">
            <button
              type="button"
              onClick={resetCustomPalette}
              disabled={editingCustomSlot === null}
              className="border-2 border-ink px-3 py-2.5 text-[12px] font-bold font-mono uppercase tracking-[0.06em] hover:bg-surface-dim disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={closeCustomPalette}
              className="border-2 border-ink px-3 py-2.5 text-[12px] font-bold font-mono uppercase tracking-[0.06em] hover:bg-surface-dim"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveCustomPalette}
              disabled={editingCustomSlot === null || draftCustomPalette === null}
              className="ml-auto border-2 border-ink bg-accent px-5 py-2.5 text-[12px] font-bold font-mono uppercase tracking-[0.08em] text-accent-on hover:bg-active disabled:opacity-40"
            >
              Save
            </button>
          </div>
        )}
      >
        <div className="p-4">
          <p className="text-[13px] font-mono text-muted mb-3">
            Primary sets accents. Secondary sets the background colors. Tertiary sets line and border colors.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['light', 'dark'] as const).map(mode => (
              <div key={mode} className="border-2 border-outline-variant p-3">
                <h3 className="mb-3 text-[13px] font-bold font-mono uppercase tracking-[0.08em]">{mode} mode</h3>
                <div className="flex flex-col gap-3">
                  {(['primary', 'secondary', 'tertiary'] as const).map(role => (
                    <label key={role} className="flex items-center justify-between gap-3 border-b border-outline-variant pb-2 last:border-b-0 last:pb-0">
                      <span>
                        <span className="block text-[12px] font-bold font-mono uppercase tracking-[0.05em]">{role}</span>
                        <span className="block text-[11px] font-mono text-muted">
                          {role === 'primary' ? 'Accents' : role === 'secondary' ? 'Backgrounds' : 'Lines + borders'}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-[11px] font-mono text-muted">{draftCustomPalette?.[mode][role].toUpperCase()}</span>
                        <input
                          type="color"
                          aria-label={`Custom ${editingCustomSlot ?? ''} ${mode} ${role}`}
                          value={draftCustomPalette?.[mode][role] ?? EMPTY_CUSTOM_PALETTE[mode][role]}
                          onChange={event => handleDraftPaletteChange(mode, role, event.target.value)}
                          className="h-9 w-11 cursor-pointer border-0 bg-transparent p-0"
                        />
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] font-mono text-muted">Reset clears this slot and returns it to the empty state.</p>
        </div>
      </Sheet>
    </div>
  )
}

const SHOP_FOR_OPTIONS: { value: ShopGender; label: string }[] = [
  { value: 'female', label: 'Women' },
  { value: 'male', label: 'Men' },
  { value: 'any', label: 'Everyone' },
]

/** Style & shopping → "Shop for": filters the Related shop row by Shopify's
 *  Target gender (always with Unisex). Everyone sends no filter. */
function ShopForRow({ value, disabled, onChange }: {
  value: ShopGender | null
  disabled: boolean
  onChange: (value: ShopGender) => Promise<void>
}) {
  const [saving, setSaving] = useState<ShopGender | null>(null)
  const [error, setError] = useState(false)
  const current = saving ?? value

  async function pick(next: ShopGender) {
    if (value === null || next === value || saving) return
    setSaving(next)
    setError(false)
    try {
      await onChange(next)
    } catch {
      setError(true)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="border-b border-outline-variant py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Shop for</p>
        <p className="text-[13px] font-mono text-muted">
          {error ? "Couldn't save. Try again." : 'Filters shop suggestions'}
        </p>
      </div>
      <div role="radiogroup" aria-label="Shop for" className="flex shrink-0 border-2 border-ink rounded-base overflow-hidden">
        {SHOP_FOR_OPTIONS.map((opt, i) => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={current === opt.value}
            disabled={disabled || !!saving}
            onClick={() => void pick(opt.value)}
            className={`px-2.5 h-9 text-[13px] font-bold font-mono uppercase tracking-[0.04em] transition-colors ${
              i > 0 ? 'border-l-2 border-ink' : ''
            } ${current === opt.value ? 'bg-accent text-accent-on' : 'bg-paper hover:bg-surface-dim'}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
