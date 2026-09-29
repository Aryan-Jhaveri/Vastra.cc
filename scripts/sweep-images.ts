// #362 — find (and optionally delete) image files no DB row references.
//   make sweep-images                 dry run: report only
//   make sweep-images APPLY=1         delete
//   make sweep-images DAYS=7 USER_ID=id  shorter grace, one user
// On Render: node --import tsx scripts/sweep-images.ts [--apply] [--days N] [--user ID]
import { formatSweepReport, sweepOrphanImages, DEFAULT_GRACE_DAYS } from '../src/storage/imageSweep.js'

const args = process.argv.slice(2)
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const days = Number(value('--days') ?? DEFAULT_GRACE_DAYS)
if (!Number.isFinite(days) || days < 1) { console.error('--days must be at least 1'); process.exit(2) }

const report = await sweepOrphanImages({ apply: args.includes('--apply'), graceDays: days, userId: value('--user') })
console.log(formatSweepReport(report))
if (!report.applied && report.orphans) console.log('Dry run. Re-run with --apply (make sweep-images APPLY=1) to delete.')
