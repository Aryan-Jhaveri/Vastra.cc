// #260 — manual image backup / restore (the nightly backup cron syncs images too).
//   make backup-images [FULL=1]                     upload changed (or all) images
//   make restore-images [APPLY=1] [USER_ID=id]      dry run, or write back missing files
// On Render: node --import tsx scripts/image-backup.ts sync|restore [--full] [--apply] [--user ID]
import { restoreMissingImages, syncImagesIncremental } from '../src/backups/images.js'

const [cmd, ...args] = process.argv.slice(2)
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }

if (cmd === 'sync') {
  const r = await syncImagesIncremental({ full: args.includes('--full') })
  console.log(`Uploaded ${r.uploaded}, unchanged ${r.skipped}, failed ${r.failed}${r.full ? ' (full sync)' : ''}`)
  process.exitCode = r.failed ? 1 : 0
} else if (cmd === 'restore') {
  const r = await restoreMissingImages({ apply: args.includes('--apply'), userId: value('--user') })
  if (args.includes('--apply')) console.log(`Restored ${r.restored}, already present ${r.present}, failed ${r.failed}`)
  else console.log(`Would restore ${r.wouldRestore} missing file(s); ${r.present} already present. Re-run with --apply (APPLY=1) to write them.`)
  process.exitCode = r.failed ? 1 : 0
} else {
  console.error('usage: image-backup.ts sync [--full] | restore [--apply] [--user ID]')
  process.exitCode = 2
}
