import '@testing-library/jest-dom'

// jsdom in this env ships a working `sessionStorage` but a non-functional
// `localStorage`. The app now reads `localStorage` first for the "remember me"
// token (see src/api/client.ts), so provide an in-memory Storage when the real
// one is missing its methods. Guarded so a working storage / per-file stub wins.
function installMemoryStorage(name: 'localStorage' | 'sessionStorage'): void {
  const existing = (globalThis as Record<string, unknown>)[name] as Storage | undefined
  if (existing && typeof existing.getItem === 'function') return
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() { return store.size },
    clear: () => { store.clear() },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, name, { value: storage, writable: true, configurable: true })
}
installMemoryStorage('localStorage')
installMemoryStorage('sessionStorage')

// jsdom stubs needed by Radix UI components
window.HTMLElement.prototype.hasPointerCapture = () => false
window.HTMLElement.prototype.setPointerCapture = () => {}
window.HTMLElement.prototype.releasePointerCapture = () => {}
window.HTMLElement.prototype.scrollIntoView = () => {}

// Stub Web Animations API (not available in jsdom)
window.HTMLElement.prototype.animate = function (): any {
  return { cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, ready: Promise.resolve(), finished: Promise.resolve() }
}

window.matchMedia = window.matchMedia || ((_query: string) => ({
  matches: false,
  media: _query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}) as MediaQueryList)
