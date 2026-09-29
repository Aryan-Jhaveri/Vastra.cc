import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { InlineField } from '../../src/components/ui/InlineField'

describe('InlineField', () => {
  it('renders label and value in display mode', () => {
    render(<InlineField label="Brand" value="Nike" onSave={vi.fn()} />)
    expect(screen.getByText('Brand')).toBeInTheDocument()
    expect(screen.getByText('Nike')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('shows — when value is null or empty', () => {
    render(<InlineField label="Brand" value={null} onSave={vi.fn()} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('switches to input mode on click', () => {
    render(<InlineField label="Brand" value="Nike" onSave={vi.fn()} />)
    fireEvent.click(screen.getByText('Nike'))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Nike')
  })

  it('pre-fills input with current value', () => {
    render(<InlineField label="Color" value="navy" onSave={vi.fn()} />)
    fireEvent.click(screen.getByText('navy'))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('navy')
  })

  it('calls onSave and reverts to display on blur', async () => {
    const onSave = vi.fn()
    render(<InlineField label="Brand" value="Nike" onSave={onSave} />)
    fireEvent.click(screen.getByText('Nike'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Adidas' } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledWith('Adidas')
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  })

  it('calls onSave on Enter key', async () => {
    const onSave = vi.fn()
    render(<InlineField label="Brand" value="Nike" onSave={onSave} />)
    fireEvent.click(screen.getByText('Nike'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Puma' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith('Puma')
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  })

  it('calls onSave on Save button click', async () => {
    const onSave = vi.fn()
    render(<InlineField label="Brand" value="Nike" onSave={onSave} />)
    fireEvent.click(screen.getByText('Nike'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Reebok' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith('Reebok')
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  })

  it('renders textarea when multiline=true', () => {
    render(<InlineField label="Notes" value="Some notes" onSave={vi.fn()} multiline />)
    fireEvent.click(screen.getByText('Some notes'))
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA')
  })

  it('applies custom valueClassName', () => {
    render(<InlineField label="Name" value="My Outfit" onSave={vi.fn()} valueClassName="font-bold text-base" />)
    const span = screen.getByText('My Outfit')
    expect(span.className).toContain('font-bold')
    expect(span.className).toContain('text-base')
  })
})

describe('InlineField alwaysOpen (#372: Notes)', () => {
  it('shows the input with no pencil; Save appears on the row only after a change, then saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<InlineField label="Notes" value="old" onSave={onSave} multiline alwaysOpen />)
    const box = screen.getByRole('textbox')
    expect(box).toHaveValue('old')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    fireEvent.blur(box)
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.change(box, { target: { value: 'new notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('new notes'))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
