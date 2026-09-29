import { describe, it, expect } from 'vitest'
import { VALID_THEME_IDS as BACKEND_IDS } from '../../src/constants/themes.js'
import { VALID_THEME_IDS as FRONTEND_IDS } from '../../src/transport/web/app/src/constants/themes.js'

describe('theme constants stay in sync across backend/frontend copies', () => {
  it('VALID_THEME_IDS tuples match exactly', () => {
    expect([...FRONTEND_IDS]).toEqual([...BACKEND_IDS])
  })
})
