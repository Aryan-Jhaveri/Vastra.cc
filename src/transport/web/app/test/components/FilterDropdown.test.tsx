import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { FilterDropdown } from '../../src/components/ui/FilterDropdown'

describe('FilterDropdown', () => {
  it('renders exactly one All option in the dropdown list', () => {
    render(
      <FilterDropdown
        label="Season"
        options={['fall', 'spring', 'summer', 'winter']}
        value=""
        onChange={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('combobox'))
    // Radix renders options in a portal; the listbox contains all items
    const listbox = screen.getByRole('listbox')
    const allOptions = within(listbox).getAllByText('All')
    expect(allOptions).toHaveLength(1)
    expect(within(listbox).getByText('fall')).toBeInTheDocument()
    expect(within(listbox).getByText('spring')).toBeInTheDocument()
    expect(within(listbox).getByText('summer')).toBeInTheDocument()
    expect(within(listbox).getByText('winter')).toBeInTheDocument()
  })
})
