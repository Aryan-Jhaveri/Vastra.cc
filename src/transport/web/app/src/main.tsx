import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { applyLocalThemePreference, installStatusBarColorSync } from './lib/theme'
import { initInstallPromptCapture } from './hooks/useInstallPrompt'

// Apply local theme tokens before React paints to avoid a palette flash.
applyLocalThemePreference()
// iOS status bar: re-write theme-color when the app returns to the foreground (#377).
installStatusBarColorSync()
initInstallPromptCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
