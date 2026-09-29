import { describe, it, expect } from 'vitest'
import { safeNextUrl } from '../../src/lib/safeNextUrl'

describe('safeNextUrl', () => {
  it('accepts same-origin paths with query and hash', () => {
    const u = safeNextUrl('/?share=abc&kind=inbox&claim=tok#x')
    expect(u?.pathname).toBe('/')
    expect(u?.searchParams.get('share')).toBe('abc')
    expect(u?.hash).toBe('#x')
  })

  it.each([
    null,
    '',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '\\/evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    'javascript:alert(1)',
  ])('rejects %j', (next) => {
    expect(safeNextUrl(next)).toBeNull()
  })
})
