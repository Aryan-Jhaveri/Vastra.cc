import { describe, it, expect } from 'vitest'
import { limitConcurrency } from '../../src/lib/limitConcurrency'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('limitConcurrency', () => {
  it('never runs more than max tasks at once and starts queued tasks in order', async () => {
    const limit = limitConcurrency(2)
    const gates = Array.from({ length: 5 }, () => deferred())
    const started: number[] = []
    let active = 0
    let peak = 0
    const runs = gates.map((g, i) => limit(async () => {
      started.push(i)
      active++
      peak = Math.max(peak, active)
      await g.promise
      active--
      return i
    }))

    await tick()
    expect(started).toEqual([0, 1])
    gates[1].resolve()
    await tick()
    expect(started).toEqual([0, 1, 2])
    gates[0].resolve(); gates[2].resolve(); gates[3].resolve(); gates[4].resolve()
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4])
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
  })

  it('a rejected or synchronously throwing task frees its slot and propagates', async () => {
    const limit = limitConcurrency(1)
    const failed = limit(() => Promise.reject(new Error('boom')))
    const threw = limit(() => { throw new Error('sync') })
    const ok = limit(async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(threw).rejects.toThrow('sync')
    await expect(ok).resolves.toBe('ok')
  })

  it('rejects a non-positive or fractional cap', () => {
    expect(() => limitConcurrency(0)).toThrow()
    expect(() => limitConcurrency(1.5)).toThrow()
  })
})
