export function getImageFilesFromClipboard(
  data: DataTransfer | null | undefined,
): File[] {
  const items = data?.items
  if (!items) return []
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.type.startsWith('image/')) continue
    const blob = item.getAsFile()
    if (blob) {
      const ext = blob.type.split('/')[1] || 'png'
      files.push(new File([blob], `pasted-${i}.${ext}`, { type: blob.type }))
    }
  }
  return files
}
