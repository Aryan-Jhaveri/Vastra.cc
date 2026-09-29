import { useState, useEffect } from 'react'
import { fetchSettings, saveSettings } from '../api/settings'
import type { AppSettings, SettingsPatch } from '../api/settings'

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function update(patch: SettingsPatch) {
    const updated = await saveSettings(patch)
    setSettings(updated)
    return updated
  }

  return { settings, loading, update }
}
