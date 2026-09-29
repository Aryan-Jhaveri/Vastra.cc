import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/api/client', () => ({ apiFetch: vi.fn(), apiFetchJSON: vi.fn() }))

import { apiFetch } from '../../src/api/client'
import { browserTimeZone, streamChat } from '../../src/api/chat'

const apiFetchMock = vi.mocked(apiFetch)

function emptyStream(): Response {
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } } as unknown as Response
}

const sentBody = () => JSON.parse(apiFetchMock.mock.calls.at(-1)![1]!.body as string) as Record<string, unknown>

afterEach(() => vi.restoreAllMocks())

describe('chat requests carry the browser time zone (#213: server runs in UTC)', () => {
  it('adds the IANA zone to every stream route body', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Asia/Tokyo' } as Intl.ResolvedDateTimeFormatOptions)
    apiFetchMock.mockResolvedValue(emptyStream())

    await streamChat('/api/chat/stream', { message: 'hi' }, () => {})
    expect(sentBody()).toEqual({ message: 'hi', timeZone: 'Asia/Tokyo' })

    await streamChat('/api/chat/confirm', { actionId: 'pa_1' }, () => {})
    expect(sentBody()).toEqual({ actionId: 'pa_1', timeZone: 'Asia/Tokyo' })
  })

  it('omits the zone when the browser cannot report one', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => { throw new Error('no Intl') })
    apiFetchMock.mockResolvedValue(emptyStream())
    expect(browserTimeZone()).toBeUndefined()

    await streamChat('/api/chat/stream', { message: 'hi' }, () => {})
    expect(sentBody()).toEqual({ message: 'hi' })
  })
})
