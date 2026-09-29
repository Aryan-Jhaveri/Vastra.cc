import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from '../../src/db/client.js'
import { deleteUserImageDirectory, getUserImagesDir } from '../../src/storage/images.js'

function seedUserImages(userId: string): string {
  const dir = join(getUserImagesDir(userId), 'items')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.jpg'), 'fake')
  writeFileSync(join(dir, 'b.jpg'), 'fake')
  return join(DATA_DIR, 'users', userId)
}

describe('deleteUserImageDirectory', () => {
  beforeEach(() => {
    // start clean for these specific fixture users
    for (const id of ['del-A', 'del-B']) {
      rmSync(join(DATA_DIR, 'users', id), { recursive: true, force: true })
    }
  })

  it('removes only the target user dir, leaving siblings intact', async () => {
    const dirA = seedUserImages('del-A')
    const dirB = seedUserImages('del-B')
    expect(existsSync(dirA)).toBe(true)
    expect(existsSync(dirB)).toBe(true)

    await deleteUserImageDirectory('del-A')

    expect(existsSync(dirA)).toBe(false)          // target gone
    expect(existsSync(dirB)).toBe(true)           // sibling untouched
    expect(existsSync(join(dirB, 'images/items/a.jpg'))).toBe(true)
  })

  it('is a no-op when the user dir does not exist', async () => {
    await expect(deleteUserImageDirectory('never-existed')).resolves.toBeUndefined()
  })

  it('refuses unsafe userIds (traversal / separators) and never escapes users root', async () => {
    const usersRoot = join(DATA_DIR, 'users')
    mkdirSync(usersRoot, { recursive: true })
    for (const bad of ['..', '../evil', 'a/b', 'a\\b', '']) {
      await expect(deleteUserImageDirectory(bad)).rejects.toThrow()
    }
    // the users root itself must still be present
    expect(existsSync(usersRoot)).toBe(true)
  })
})
