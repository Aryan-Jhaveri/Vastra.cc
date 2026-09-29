import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { VastraLoader } from '../../src/components/ui/VastraLoader'

describe('VastraLoader', () => {
  it('renders the VASTRA text and three dots', () => {
    const { container } = render(<VastraLoader />)
    expect(container.textContent).toContain('Vastra')
    expect(container.querySelectorAll('.animate-bounce').length).toBe(3)
  })
})
