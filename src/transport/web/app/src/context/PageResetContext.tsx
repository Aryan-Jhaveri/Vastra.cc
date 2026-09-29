import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface PageResetAPI {
  resetKeys: Readonly<Record<string, number>>
  triggerReset: (page: string) => void
}

const PageResetContext = createContext<PageResetAPI>({
  resetKeys: {},
  triggerReset: () => {},
})

export function PageResetProvider({ children }: { children: ReactNode }) {
  const [resetKeys, setResetKeys] = useState<Record<string, number>>({
    home: 0,
    tryon: 0,
    closet: 0,
    outfits: 0,
    settings: 0,
  })

  const triggerReset = useCallback((page: string) => {
    setResetKeys(prev => ({ ...prev, [page]: prev[page] + 1 }))
  }, [])

  return (
    <PageResetContext.Provider value={{ resetKeys, triggerReset }}>
      {children}
    </PageResetContext.Provider>
  )
}

export function usePageReset() {
  return useContext(PageResetContext)
}
