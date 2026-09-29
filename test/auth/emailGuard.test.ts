import { describe, it, expect } from 'vitest'
import { validateEmail } from '../../src/auth/emailGuard.js'

describe('validateEmail', () => {
  it('rejects malformed emails', () => {
    expect(validateEmail('not-an-email')).toBe(false)
    expect(validateEmail('')).toBe(false)
    expect(validateEmail('@')).toBe(false)
    expect(validateEmail('a@')).toBe(false)
  })

  it('rejects disposable/temp-mail domains', () => {
    expect(validateEmail('x@minitts.net')).toBe(false)
    expect(validateEmail('x@mailinator.com')).toBe(false)
    expect(validateEmail('x@guerrillamail.com')).toBe(false)
    expect(validateEmail('x@10minutemail.com')).toBe(false)
  })

  it('rejects business/custom domains', () => {
    expect(validateEmail('x@some-business.com')).toBe(false)
    expect(validateEmail('x@mycompany.org')).toBe(false)
  })

  describe('Google', () => {
    it('accepts gmail.com and googlemail.com', () => {
      expect(validateEmail('a@gmail.com')).toBe(true)
      expect(validateEmail('a@googlemail.com')).toBe(true)
    })
  })

  describe('Yahoo', () => {
    it('accepts yahoo.com', () => {
      expect(validateEmail('a@yahoo.com')).toBe(true)
    })

    it('accepts ccTLD variants', () => {
      const domains = [
        'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.co.in', 'yahoo.co.id',
        'yahoo.co.kr', 'yahoo.co.nz', 'yahoo.co.th',
        'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.ie',
        'yahoo.no', 'yahoo.se', 'yahoo.dk', 'yahoo.nl', 'yahoo.be',
        'yahoo.gr', 'yahoo.ca', 'yahoo.cn',
        'yahoo.com.ar', 'yahoo.com.br', 'yahoo.com.mx', 'yahoo.com.au',
        'yahoo.com.sg', 'yahoo.com.hk', 'yahoo.com.tw', 'yahoo.com.ph',
        'yahoo.com.vn', 'yahoo.com.tr', 'yahoo.com.my', 'yahoo.com.pe',
        'yahoo.com.co',
        'yahoo.in', 'yahoo.fi', 'yahoo.pl',
      ]
      for (const d of domains) {
        expect(validateEmail(`a@${d}`), `expected ${d} to be valid`).toBe(true)
      }
    })

    it('accepts ymail.com and rocketmail.com', () => {
      expect(validateEmail('a@ymail.com')).toBe(true)
      expect(validateEmail('a@rocketmail.com')).toBe(true)
    })
  })

  describe('Microsoft (Outlook, Hotmail, Live)', () => {
    it('accepts outlook.com', () => {
      expect(validateEmail('a@outlook.com')).toBe(true)
    })

    it('accepts outlook ccTLD variants', () => {
      const domains = [
        'outlook.co.uk', 'outlook.co.id', 'outlook.co.kr',
        'outlook.co.nz', 'outlook.co.th',
        'outlook.com.ar', 'outlook.com.au', 'outlook.com.br',
        'outlook.com.gr', 'outlook.com.tr', 'outlook.com.vn',
        'outlook.de', 'outlook.fr', 'outlook.es', 'outlook.it',
        'outlook.dk', 'outlook.cz', 'outlook.jp', 'outlook.in',
        'outlook.ph', 'outlook.sa', 'outlook.ie', 'outlook.hu',
        'outlook.at', 'outlook.my', 'outlook.cl',
      ]
      for (const d of domains) {
        expect(validateEmail(`a@${d}`), `expected ${d} to be valid`).toBe(true)
      }
    })

    it('accepts hotmail.com', () => {
      expect(validateEmail('a@hotmail.com')).toBe(true)
    })

    it('accepts hotmail ccTLD variants', () => {
      const domains = [
        'hotmail.co.uk', 'hotmail.co.jp', 'hotmail.co.kr',
        'hotmail.co.nz', 'hotmail.co.th',
        'hotmail.com.ar', 'hotmail.com.br', 'hotmail.com.mx',
        'hotmail.com.au', 'hotmail.com.hk', 'hotmail.com.tw',
        'hotmail.com.tr', 'hotmail.com.vn', 'hotmail.com.pe',
        'hotmail.de', 'hotmail.fr', 'hotmail.es', 'hotmail.it',
        'hotmail.be', 'hotmail.ca', 'hotmail.no', 'hotmail.se',
        'hotmail.dk', 'hotmail.nl', 'hotmail.gr', 'hotmail.cl',
        'hotmail.ru', 'hotmail.hu', 'hotmail.ie',
        'hotmail.in',
      ]
      for (const d of domains) {
        expect(validateEmail(`a@${d}`), `expected ${d} to be valid`).toBe(true)
      }
    })

    it('accepts live.com', () => {
      expect(validateEmail('a@live.com')).toBe(true)
    })

    it('accepts live ccTLD variants', () => {
      const domains = [
        'live.co.uk', 'live.com.au', 'live.com.ar', 'live.com.mx',
        'live.com.pt', 'live.com.sg', 'live.com.my', 'live.ca',
        'live.de', 'live.fr', 'live.it', 'live.nl', 'live.no',
        'live.se', 'live.dk', 'live.be', 'live.at', 'live.cn',
        'live.jp', 'live.ru', 'live.hk', 'live.in', 'live.cl',
      ]
      for (const d of domains) {
        expect(validateEmail(`a@${d}`), `expected ${d} to be valid`).toBe(true)
      }
    })

    it('accepts msn.com and passport.com', () => {
      expect(validateEmail('a@msn.com')).toBe(true)
      expect(validateEmail('a@passport.com')).toBe(true)
    })
  })

  describe('Apple', () => {
    it('accepts icloud.com, me.com, mac.com', () => {
      expect(validateEmail('a@icloud.com')).toBe(true)
      expect(validateEmail('a@me.com')).toBe(true)
      expect(validateEmail('a@mac.com')).toBe(true)
    })
  })

  describe('AOL', () => {
    it('accepts aol.com', () => {
      expect(validateEmail('a@aol.com')).toBe(true)
    })

    it('accepts aol ccTLD variants', () => {
      const domains = [
        'aol.co.uk', 'aol.fr', 'aol.de', 'aol.it', 'aol.es',
        'aol.com.ar', 'aol.com.mx', 'aol.com.au', 'aol.com.br',
      ]
      for (const d of domains) {
        expect(validateEmail(`a@${d}`), `expected ${d} to be valid`).toBe(true)
      }
    })

    it('accepts compuserve.com', () => {
      expect(validateEmail('a@compuserve.com')).toBe(true)
    })
  })

  describe('env override (allowedDomains)', () => {
    it('overrides provider allowlist when provided', () => {
      expect(validateEmail('x@gmail.com', ['example.com'])).toBe(false)
      expect(validateEmail('x@example.com', ['example.com'])).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(validateEmail('x@Example.COM', ['example.com'])).toBe(true)
      expect(validateEmail('X@EXAMPLE.COM', ['example.com'])).toBe(true)
    })
  })
})
