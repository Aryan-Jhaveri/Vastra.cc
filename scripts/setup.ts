// `make setup` (#315 Phase 2): configure a self-hosted Vastra from a checkout.
// Runs with the repo's own lockfile-pinned deps — nothing is fetched from a
// package registry. The flow lives in src/setup/run.ts.
//
//   make setup                       interactive, writes ./.env
//   make setup ENV_FILE=/path/.env   write somewhere else
//   make setup TARGET=render         skip the first question

import { createInterface, type Interface } from 'readline'
import { resolve } from 'path'
import { existsSync } from 'fs'
import webpush from 'web-push'
import { runSetup, type Choice, type SetupIO } from '../src/setup/run.js'
import type { Target } from '../src/setup/envFile.js'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const envPath = resolve(flag('--out') ?? '.env')
const targetArg = flag('--target')
if (targetArg && !['docker', 'node', 'render'].includes(targetArg)) {
  console.error('--target must be docker, node or render')
  process.exit(2)
}

let muted = false
const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
// Secrets: keep the prompt, swallow the typed characters.
const rlOut = rl as unknown as { _writeToOutput: (s: string) => void }
const write = rlOut._writeToOutput.bind(rl)
rlOut._writeToOutput = s => { if (!muted || s.includes('\n')) write(muted ? '\n' : s) }

// A line queue rather than rl.question: piped input (scripts, CI) arrives all
// at once, and lines read while no prompt is waiting would otherwise be lost.
const lines: string[] = []
const waiting: Array<(line: string | null) => void> = []
let closed = false
rl.on('line', line => { const w = waiting.shift(); if (w) w(line); else lines.push(line) })
rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(null) })

async function question(q: string): Promise<string> {
  process.stdout.write(q)
  const line = lines.length ? lines.shift()! : closed ? null : await new Promise<string | null>(res => waiting.push(res))
  if (line === null) { console.error('\nInput ended before setup finished; nothing written.'); process.exit(1) }
  if (!process.stdin.isTTY) process.stdout.write('\n')
  return line.trim()
}

const io: SetupIO = {
  async choose<T extends string>(q: string, options: Choice<T>[], fallback: T): Promise<T> {
    console.log(`\n${q}`)
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.value === fallback ? '  (default)' : ''}`))
    for (;;) {
      const a = await question('> ')
      if (!a) return fallback
      const n = Number(a)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
      const hit = options.find(o => o.value === a)
      if (hit) return hit.value
      console.log(`Pick 1–${options.length}.`)
    }
  },
  async ask(q, fallback) {
    for (;;) {
      const a = await question(`${q}${fallback ? ` [${fallback}]` : ''}: `)
      if (a || fallback !== undefined) return a || fallback!
    }
  },
  async secret(q) {
    muted = true
    try { return await question(`${q}: `) } finally { muted = false }
  },
  async confirm(q, fallback) {
    const a = (await question(`${q} [${fallback ? 'Y/n' : 'y/N'}] `)).toLowerCase()
    return a ? a.startsWith('y') : fallback
  },
  print(line = '') { console.log(line) },
}

try {
  const inContainer = existsSync('/.dockerenv') || process.env.VASTRA_IN_CONTAINER === '1'
  const result = await runSetup(io, { envPath, target: targetArg as Target | undefined, inContainer }, {
    generateVapid: () => webpush.generateVAPIDKeys(),
  })
  process.exitCode = result && (result.written || result.pasted) ? 0 : 1
} finally {
  rl.close()
}
