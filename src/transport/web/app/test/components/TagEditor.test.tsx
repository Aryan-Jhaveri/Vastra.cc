import { render, screen, fireEvent } from '@testing-library/react'
import { TagEditor } from '../../src/components/ui/TagEditor'

describe('TagEditor', () => {
  it('renders existing tags as chips', () => {
    render(<TagEditor tags={['vintage', 'minimalist']} onChange={vi.fn()} />)
    expect(screen.getByText('vintage')).toBeInTheDocument()
    expect(screen.getByText('minimalist')).toBeInTheDocument()
  })

  it('adds tag on Enter key', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'casual' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['casual'])
  })

  it('adds tag on comma key', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'summer' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(onChange).toHaveBeenCalledWith(['summer'])
  })

  it('adds tag on blur when input has value', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'formal' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(['formal'])
  })

  it('removes tag on × click', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={['vintage', 'casual']} onChange={onChange} />)
    const removeButtons = screen.getAllByRole('button')
    fireEvent.click(removeButtons[0])
    expect(onChange).toHaveBeenCalledWith(['casual'])
  })

  it('deduplicates — does not add tag already present', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={['vintage']} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'vintage' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('normalises tag to lowercase before adding', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Casual' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['casual'])
  })

  it('does not add empty or whitespace-only tags', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={[]} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears input after adding a tag', () => {
    render(<TagEditor tags={[]} onChange={vi.fn()} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'cozy' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('')
  })
})

describe('TagEditor — removal (#371)', () => {
  it('each × is labelled and keeps focus in the input, so a half-typed tag is not added over the removal', () => {
    const onChange = vi.fn()
    render(<TagEditor tags={['vintage', 'casual']} onChange={onChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'half' } })
    const remove = screen.getByRole('button', { name: 'Remove vintage' })
    // mouseDown is prevented, so the input never blurs.
    expect(fireEvent.mouseDown(remove)).toBe(false)
    fireEvent.click(remove)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(['casual'])
  })
})
