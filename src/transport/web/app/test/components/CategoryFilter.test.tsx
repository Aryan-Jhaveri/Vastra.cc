import { render, screen, fireEvent } from '@testing-library/react'
import { CategoryFilter } from '../../src/components/CategoryFilter'

const categories = ['tops', 'bottoms', 'shoes']

describe('CategoryFilter', () => {
  it('renders All chip plus each category', () => {
    render(<CategoryFilter categories={categories} value={[]} onChange={() => {}} />)
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('tops')).toBeInTheDocument()
    expect(screen.getByText('bottoms')).toBeInTheDocument()
    expect(screen.getByText('shoes')).toBeInTheDocument()
  })

  it('highlights the active category', () => {
    render(<CategoryFilter categories={categories} value={['tops']} onChange={() => {}} />)
    const topsBtn = screen.getByText('tops')
    expect(topsBtn.className).toContain('bg-accent')
  })

  it('calls onChange with empty array when All clicked', () => {
    const onChange = vi.fn()
    render(<CategoryFilter categories={categories} value={['tops']} onChange={onChange} />)
    fireEvent.click(screen.getByText('All'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('calls onChange with category array when chip clicked', () => {
    const onChange = vi.fn()
    render(<CategoryFilter categories={categories} value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByText('shoes'))
    expect(onChange).toHaveBeenCalledWith(['shoes'])
  })

  it('renders no chips when categories empty', () => {
    render(<CategoryFilter categories={[]} value={[]} onChange={() => {}} />)
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.queryByText('tops')).not.toBeInTheDocument()
  })
})
