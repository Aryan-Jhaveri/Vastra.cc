import { describe, it, expect, afterAll } from 'vitest'
import { rmSync, mkdirSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { DiskBackend } from '../../src/storage/images.js'
import { DATA_DIR } from '../../src/db/client.js'

const TEST_PREFIX = 'test-backend-' + Date.now()
const backend = new DiskBackend()

function testKey(name: string): string {
  return `${TEST_PREFIX}/${name}`
}

afterAll(async () => {
  await backend.deletePrefix(TEST_PREFIX)
})

describe('DiskBackend', () => {
  it('putObject and getObject round-trip', async () => {
    const key = testKey('roundtrip.jpg')
    const buffer = Buffer.from('test image data')
    await backend.putObject(key, buffer, 'image/jpeg')
    const retrieved = await backend.getObject(key)
    expect(retrieved.toString()).toBe('test image data')
  })

  it('headObject returns metadata for existing key', async () => {
    const key = testKey('head.jpg')
    const buffer = Buffer.from('test data for head')
    await backend.putObject(key, buffer, 'image/jpeg')
    const head = await backend.headObject(key)
    expect(head).not.toBeNull()
    expect(head!.size).toBe(buffer.length)
    expect(head!.contentType).toBe('image/jpeg')
  })

  it('headObject returns null for missing key', async () => {
    const head = await backend.headObject(testKey('nonexistent.jpg'))
    expect(head).toBeNull()
  })

  it('deleteObject removes the file', async () => {
    const key = testKey('delete.jpg')
    await backend.putObject(key, Buffer.from('delete me'), 'image/jpeg')
    expect(await backend.headObject(key)).not.toBeNull()
    await backend.deleteObject(key)
    expect(await backend.headObject(key)).toBeNull()
  })

  it('deletePrefix recursively deletes and returns count', async () => {
    const prefix = testKey('prefix-delete')
    await backend.putObject(`${prefix}/a.jpg`, Buffer.from('a'), 'image/jpeg')
    await backend.putObject(`${prefix}/b.jpg`, Buffer.from('b'), 'image/jpeg')
    await backend.putObject(`${prefix}/sub/c.jpg`, Buffer.from('c'), 'image/jpeg')
    const count = await backend.deletePrefix(prefix)
    expect(count).toBe(3)
    expect(await backend.headObject(`${prefix}/a.jpg`)).toBeNull()
    expect(await backend.headObject(`${prefix}/sub/c.jpg`)).toBeNull()
  })

  it('listPrefix returns all keys under prefix', async () => {
    const prefix = testKey('list-prefix')
    await backend.putObject(`${prefix}/x.jpg`, Buffer.from('x'), 'image/jpeg')
    await backend.putObject(`${prefix}/y.jpg`, Buffer.from('y'), 'image/jpeg')
    await backend.putObject(`${prefix}/nested/z.jpg`, Buffer.from('z'), 'image/jpeg')
    const keys = await backend.listPrefix(prefix)
    expect(keys).toHaveLength(3)
    expect(keys).toContain(`${prefix}/x.jpg`)
    expect(keys).toContain(`${prefix}/y.jpg`)
    expect(keys).toContain(`${prefix}/nested/z.jpg`)
  })

  it('streamObject returns a readable stream', async () => {
    const key = testKey('stream.jpg')
    const buffer = Buffer.from('stream test data')
    await backend.putObject(key, buffer, 'image/jpeg')
    const stream = await backend.streamObject(key)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    const result = Buffer.concat(chunks).toString()
    expect(result).toBe('stream test data')
  })
})
