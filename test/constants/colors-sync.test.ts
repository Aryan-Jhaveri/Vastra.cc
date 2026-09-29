import { describe, it, expect } from 'vitest'
import { COLORS as BACKEND } from '../../src/constants/colors.js'
import { COLORS as FRONTEND } from '../../src/transport/web/app/src/constants/colors.js'

describe('color constants stay in sync across backend/frontend copies', () => {
  it('COLORS tuples match exactly', () => {
    expect([...FRONTEND]).toEqual([...BACKEND])
  })
})