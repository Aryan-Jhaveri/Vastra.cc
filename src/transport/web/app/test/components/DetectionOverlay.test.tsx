import { render, screen, fireEvent, within } from '@testing-library/react'
import { DetectionOverlay, type Detection, clampView, clientToSourcePercent, type ViewState } from '../../src/components/DetectionOverlay'

function makeDet(id: string, overrides?: Partial<Detection>): Detection {
  return {
    id,
    label: id,
    category: 'tops',
    cropColor: '#d4e8d4',
    box: { x: 10, y: 10, w: 40, h: 50 },
    kept: true,
    alternatives: ['bottoms', 'shoes'],
    ...overrides,
  }
}

describe('DetectionOverlay', () => {
  it('renders all detections as cards', () => {
    const dets = [makeDet('a'), makeDet('b')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} />)
    const tops = screen.getAllByText('tops')
    expect(tops.length).toBe(2)
  })

  it('tapping a card sets activeId and shows resize handles on the matching box', () => {
    const dets = [makeDet('a'), makeDet('b', { box: { x: 50, y: 50, w: 40, h: 40 } })]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const cardB = screen.getByTestId('card-b')
    const imageButton = within(cardB).getByRole('button', { name: 'select' })
    fireEvent.click(imageButton)

    const handles = container.querySelectorAll('[data-badge]')
    const resizeHandles = Array.from(handles).filter(h =>
      h.className.includes('cursor-')
    )
    expect(resizeHandles.length).toBe(4)
  })

  it('tapping an inactive box on the photo activates it', () => {
    const dets = [makeDet('a'), makeDet('b', { box: { x: 50, y: 50, w: 40, h: 40 } })]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const initialHandles = container.querySelectorAll('[data-badge].cursor-nw-resize')
    expect(initialHandles.length).toBe(0)

    const boxes = container.querySelectorAll('[data-box]')
    fireEvent.click(boxes[1])

    const activeHandles = container.querySelectorAll('[data-badge]')
    const resizeHandles = Array.from(activeHandles).filter(h =>
      h.className.includes('cursor-')
    )
    expect(resizeHandles.length).toBe(4)
  })

  it('tapping active card again deselects it', () => {
    const dets = [makeDet('a')]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const imageButton = screen.getByRole('button', { name: 'select' })
    fireEvent.click(imageButton)

    expect(container.querySelectorAll('[data-badge]').length).toBeGreaterThan(0)

    fireEvent.click(imageButton)

    const handlesAfter = container.querySelectorAll('[data-badge]')
    const resizeAfter = Array.from(handlesAfter).filter(h =>
      h.className.includes('cursor-')
    )
    expect(resizeAfter.length).toBe(0)
  })

  it('active on-photo box has no buttons, only resize handles', () => {
    const dets = [makeDet('a')]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const imageButton = screen.getByRole('button', { name: 'select' })
    fireEvent.click(imageButton)

    const boxes = container.querySelectorAll('[data-box]')
    expect(boxes.length).toBe(1)

    const box = boxes[0] as HTMLElement
    const buttonsInBox = box.querySelectorAll('button')
    expect(buttonsInBox.length).toBe(0)

    const handles = box.querySelectorAll('[data-badge]')
    const resizeHandles = Array.from(handles).filter(h =>
      h.className.includes('cursor-')
    )
    expect(resizeHandles.length).toBe(4)

    const cardXButtons = screen.getAllByTitle('Remove')
    expect(cardXButtons.length).toBe(1)
  })

  it('deleting via card X removes the detection', () => {
    const onChange = vi.fn()
    const dets = [makeDet('a'), makeDet('b')]
    render(<DetectionOverlay detections={dets} onChange={onChange} />)

    const removeButtons = screen.getAllByTitle('Remove')
    fireEvent.click(removeButtons[0])

    expect(onChange).toHaveBeenCalledOnce()
    const newDets = onChange.mock.calls[0][0] as Detection[]
    expect(newDets.length).toBe(1)
    expect(newDets[0].id).toBe('b')
  })

  it('tap on photo background with addMode=false deselects activeId, does not call onTapAdd', () => {
    const onTapAdd = vi.fn()
    const dets = [makeDet('a')]
    const { container } = render(
      <DetectionOverlay detections={dets} onChange={() => {}} onTapAdd={onTapAdd} />
    )

    const imageButton = screen.getByRole('button', { name: 'select' })
    fireEvent.click(imageButton)

    const photoDiv = screen.getByTestId('bbox-photo')
    const img = photoDiv.querySelector('img')
    if (img) {
      fireEvent.click(img)
    }

    expect(onTapAdd).not.toHaveBeenCalled()
  })

  it('tap on photo background with addMode=true calls onTapAdd and exits add-mode', () => {
    const onTapAdd = vi.fn()
    const dets = [makeDet('a')]
    const { container } = render(
      <DetectionOverlay
        detections={dets}
        onChange={() => {}}
        onTapAdd={onTapAdd}
        sourcePhotoUri="test.jpg"
      />
    )

    const addTile = screen.getByTestId('add-tile')
    fireEvent.click(addTile)

    expect(screen.getByTestId('add-hint')).toBeInTheDocument()

    const photoDiv = screen.getByTestId('bbox-photo')
    fireEvent.click(photoDiv)

    expect(onTapAdd).toHaveBeenCalledOnce()

    expect(screen.queryByTestId('add-hint')).not.toBeInTheDocument()
  })

  it('toggleKept updates detection kept state', () => {
    const onChange = vi.fn()
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={onChange} />)

    const toggleButton = screen.getByText('✓')
    fireEvent.click(toggleButton)

    expect(onChange).toHaveBeenCalledOnce()
    const newDets = onChange.mock.calls[0][0] as Detection[]
    expect(newDets[0].kept).toBe(false)
  })

  it('kept toggle does not activate the card', () => {
    const dets = [makeDet('a')]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const toggleButton = screen.getByText('✓')
    fireEvent.click(toggleButton)

    const handles = container.querySelectorAll('[data-badge]')
    const resizeHandles = Array.from(handles).filter(h =>
      h.className.includes('cursor-')
    )
    expect(resizeHandles.length).toBe(0)
  })

  it('tapping card title button opens chip sheet', () => {
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const titleButton = screen.getByRole('button', { name: 'change category' })
    fireEvent.click(titleButton)

    expect(screen.getByText('looks more like')).toBeInTheDocument()
  })

  it('tapping card image area activates box, does NOT open chip sheet', () => {
    const dets = [makeDet('a')]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const imageButton = screen.getByRole('button', { name: 'select' })
    fireEvent.click(imageButton)

    const handles = container.querySelectorAll('[data-badge]')
    const resizeHandles = Array.from(handles).filter(h =>
      h.className.includes('cursor-')
    )
    expect(resizeHandles.length).toBe(4)

    expect(screen.queryByText('looks more like')).not.toBeInTheDocument()
  })

  it('card renders bbox-viewport-img with sourcePhotoUri', () => {
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" />)

    const img = screen.getByTestId('bbox-viewport-img')
    expect(img).toBeInTheDocument()
    expect(img.getAttribute('src')).toBe('test.jpg')
  })

  it('img has positive width and non-negative numeric left/top derivable from aspect ratio', () => {
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" aspectRatio="16/9" />)

    const img = screen.getByTestId('bbox-viewport-img')
    const width = parseFloat(img.style.width)
    const left = parseFloat(img.style.left)
    const top = parseFloat(img.style.top)

    expect(width).toBeGreaterThan(0)
    expect(Number.isFinite(width)).toBe(true)
    expect(Number.isFinite(left)).toBe(true)
    expect(Number.isFinite(top)).toBe(true)
  })

  it('zoom-in button increases scale', () => {
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" />)

    const zoomIn = screen.getByTestId('zoom-in')
    fireEvent.click(zoomIn)

    const wrapper = screen.getByTestId('bbox-photo').firstElementChild as HTMLElement
    expect(wrapper.style.transform).toContain('scale(1.5)')
  })

  it('zoom-out button decreases scale', () => {
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" />)

    const zoomIn = screen.getByTestId('zoom-in')
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)

    const zoomOut = screen.getByTestId('zoom-out')
    fireEvent.click(zoomOut)

    const wrapper = screen.getByTestId('bbox-photo').firstElementChild as HTMLElement
    expect(wrapper.style.transform).toContain('scale(1.5)')
  })

  it('fit button resets view to identity', () => {
    const dets = [makeDet('a')]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" />)

    const zoomIn = screen.getByTestId('zoom-in')
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)

    const fit = screen.getByTestId('zoom-fit')
    fireEvent.click(fit)

    const wrapper = screen.getByTestId('bbox-photo').firstElementChild as HTMLElement
    expect(wrapper.style.transform).toContain('scale(1)')
    expect(wrapper.style.transform).toContain('translate(0px,0px)')
  })

  it('view resets to identity when sourcePhotoUri changes', () => {
    const dets = [makeDet('a')]
    const { rerender } = render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" />)

    const zoomIn = screen.getByTestId('zoom-in')
    fireEvent.click(zoomIn)

    const before = (screen.getByTestId('bbox-photo').firstElementChild as HTMLElement).style.transform
    expect(before).toContain('scale(1.5)')

    rerender(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test2.jpg" />)

    const after = (screen.getByTestId('bbox-photo').firstElementChild as HTMLElement).style.transform
    expect(after).toContain('scale(1)')
    expect(after).toContain('translate(0px,0px)')
  })
})

describe('clampView', () => {
  it('clamps scale to [1, 6]', () => {
    expect(clampView({ scale: 0.5, tx: 0, ty: 0 }, 400, 600).scale).toBe(1)
    expect(clampView({ scale: 10, tx: 0, ty: 0 }, 400, 600).scale).toBe(6)
  })

  it('resets tx, ty to 0 when scale is 1', () => {
    const result = clampView({ scale: 1, tx: 50, ty: -30 }, 400, 600)
    expect(result).toEqual({ scale: 1, tx: 0, ty: 0 })
  })

  it('clamps tx within [-(scale-1)*cw, 0]', () => {
    const cw = 400
    const result = clampView({ scale: 3, tx: 200, ty: -2000 }, cw, 600)
    expect(result.tx).toBe(0)
    expect(result.ty).toBe(-(3 - 1) * 600)
  })
})

describe('clientToSourcePercent', () => {
  const rect = { left: 0, top: 0, width: 400, height: 600 }

  it('is a no-op at scale=1 tx=0 ty=0', () => {
    const view: ViewState = { scale: 1, tx: 0, ty: 0 }
    const result = clientToSourcePercent(200, 300, rect, view)
    expect(result.px).toBeCloseTo(50, 5)
    expect(result.py).toBeCloseTo(50, 5)
  })

  it('divides by scale when tx=ty=0 (center click at scale=2 resolves to 25%)', () => {
    const view: ViewState = { scale: 2, tx: 0, ty: 0 }
    const result = clientToSourcePercent(200, 300, rect, view)
    expect(result.px).toBeCloseTo(25, 5)
    expect(result.py).toBeCloseTo(25, 5)
  })

  it('subtracts translation and divides by scale (scale=2, tx=50, ty=20)', () => {
    const view: ViewState = { scale: 2, tx: 50, ty: 20 }
    const result = clientToSourcePercent(200, 300, rect, view)
    const xInner = (200 - rect.left - 50) / 2
    const yInner = (300 - rect.top - 20) / 2
    expect(result.px).toBeCloseTo((xInner / rect.width) * 100, 5)
    expect(result.py).toBeCloseTo((yInner / rect.height) * 100, 5)
  })
})

describe('bbox viewport padding', () => {
  it('renders a smaller scale for a small bbox than the unpadded equivalent', () => {
    const dets = [makeDet('a', { box: { x: 40, y: 40, w: 10, h: 10 } })]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" aspectRatio="1/1" />)

    const img = screen.getByTestId('bbox-viewport-img')
    const renderedWidth = parseFloat(img.style.width)
    const unpaddedS = 10000 / 10 // 1000
    // Padded: padW = 10 * 1.3 = 13, padS = 10000/13 ≈ 769
    expect(renderedWidth).toBeLessThan(unpaddedS)
    expect(renderedWidth).toBeGreaterThan(0)
  })

  // #121 — a wide, tight box must not fill the card's spare height with the
  // neighbouring photo: the image is clipped to the padded box.
  it('clips a wide box to its padded region instead of showing adjacent context', () => {
    const dets = [makeDet('a', { box: { x: 30, y: 45, w: 40, h: 5 } })]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" aspectRatio="1/1" />)
    const img = screen.getByTestId('bbox-viewport-img')
    // padded box: x 24–76, y 44.25–50.75 (15% of w/h on each side)
    const inset = img.style.clipPath.match(/inset\(([^)]+)\)/)![1].split(' ').map(parseFloat)
    const [top, right, bottom, left] = inset
    expect(top).toBeCloseTo(44.25, 5)
    expect(right).toBeCloseTo(24, 5)
    expect(bottom).toBeCloseTo(49.25, 5)
    expect(left).toBeCloseTo(24, 5)
    // Still contain: the whole padded width fits (the item is never cropped).
    expect(parseFloat(img.style.width)).toBeCloseTo(10000 / (40 * 1.3), 5)
  })

  it('never clips past the photo edge for a box touching the border', () => {
    const dets = [makeDet('a', { box: { x: 0, y: 0, w: 20, h: 20 } })]
    render(<DetectionOverlay detections={dets} onChange={() => {}} sourcePhotoUri="test.jpg" aspectRatio="1/1" />)
    const [top, , , left] = screen.getByTestId('bbox-viewport-img').style.clipPath.match(/inset\(([^)]+)\)/)![1].split(' ').map(parseFloat)
    expect(top).toBe(0)
    expect(left).toBe(0)
  })
})

describe('DetectionOverlay theming (#286)', () => {
  it('active box tint uses the theme accent, not the pastel cropColor', () => {
    const dets = [makeDet('a', { cropColor: '#d4e8d4' })]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    fireEvent.click(container.querySelectorAll('[data-box]')[0])

    const tint = container.querySelector('[data-box] > .opacity-20') as HTMLElement
    expect(tint).toBeTruthy()
    expect(tint.style.background).toBe('var(--color-accent)')
    expect(tint.style.background).not.toContain('#d4e8d4')
  })

  it('resize handles keep their size but are themed with accent borders', () => {
    const dets = [makeDet('a')]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    fireEvent.click(container.querySelectorAll('[data-box]')[0])

    const handle = container.querySelector('[data-badge].cursor-se-resize') as HTMLElement
    expect(handle).toBeTruthy()
    expect(handle.className).toContain('w-3 h-3')
    expect(handle.className).toContain('border-2')
    expect(handle.className).toContain('bg-paper')
    expect(handle.className).toContain('border-accent')
    expect(handle.className).not.toContain('border-ink')
  })

  it('box border thickness and geometry are unchanged (border-2, % offsets)', () => {
    const dets = [makeDet('a')]
    const { container } = render(<DetectionOverlay detections={dets} onChange={() => {}} />)

    const box = container.querySelector('[data-box]') as HTMLElement
    expect(box.style.left).toBe('10%')
    expect(box.style.top).toBe('10%')
    expect(box.style.width).toBe('40%')
    expect(box.style.height).toBe('50%')

    fireEvent.click(box)
    const borderDiv = box.querySelector('.border-2') as HTMLElement
    expect(borderDiv).toBeTruthy()
    expect(borderDiv.className).toContain('border-2')
  })

  it('zoom controls are theme buttons with press animation and 44px mobile targets', () => {
    render(<DetectionOverlay detections={[makeDet('a')]} onChange={() => {}} />)

    for (const testId of ['zoom-in', 'zoom-out', 'zoom-fit']) {
      const btn = screen.getByTestId(testId)
      expect(btn.className).toContain('border-2')
      expect(btn.className).toContain('border-ink')
      expect(btn.className).toContain('bg-paper')
      expect(btn.className).toContain('rounded-base')
      expect(btn.className).toContain('shadow-flat-xs')
      expect(btn.className).toContain('active:translate-x-[2px]')
      expect(btn.className).toContain('active:translate-y-[2px]')
      expect(btn.className).toContain('active:shadow-none')
      expect(btn.className).toContain('w-11 h-11')
      expect(btn.className).toContain('md:w-7 md:h-7')
    }
  })

  it('add-mode hint is a themed chip', () => {
    render(<DetectionOverlay detections={[makeDet('a')]} onChange={() => {}} />)

    fireEvent.click(screen.getByTestId('add-tile'))

    const hint = screen.getByTestId('add-hint')
    expect(hint.className).toContain('border-2')
    expect(hint.className).toContain('border-ink')
    expect(hint.className).toContain('bg-paper')
    expect(hint.className).toContain('rounded-base')
    expect(hint.className).toContain('shadow-flat-xs')
  })

  it('category chips and swatch derive from theme tokens, not pastel hexes', () => {
    const { container } = render(<DetectionOverlay detections={[makeDet('a')]} onChange={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'change category' }))
    expect(screen.getByText('looks more like')).toBeInTheDocument()

    const chip = screen.getByText('bottoms').closest('button') as HTMLElement
    expect(chip.style.background).toContain('var(--color-')
    expect(chip.style.background).not.toBe('#d4d4e8')

    const swatch = container.querySelector('div.w-12.h-12') as HTMLElement
    expect(swatch).toBeTruthy()
    expect(swatch.style.background).toContain('var(--color-')
    expect(swatch.style.background).not.toBe('#d4e8d4')
  })
})
