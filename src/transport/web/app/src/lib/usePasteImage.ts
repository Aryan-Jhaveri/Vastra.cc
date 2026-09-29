import { useEffect } from 'react'
import { getImageFilesFromClipboard } from './clipboard'

export function usePasteImage(
  onFiles: (files: File[]) => void,
  active = true,
) {
  useEffect(() => {
    if (!active) return
    function handler(e: ClipboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const files = getImageFilesFromClipboard(e.clipboardData)
      if (files.length) {
        e.preventDefault()
        onFiles(files)
      }
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [onFiles, active])
}
