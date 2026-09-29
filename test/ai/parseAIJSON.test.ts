import { describe, expect, it } from 'vitest'
import { firstJSONValue, parseAIJSON } from '../../src/ai/parse.js'

// Prod 2026-09-28: bulk detect failed with "Unexpected non-whitespace
// character after JSON" when the model added content after the JSON; the old
// greedy fallback grabbed first-"{"-to-last-"}" and failed. The fallback now
// takes the first complete JSON value.

describe('parseAIJSON', () => {
  it('plain and fenced JSON', () => {
    expect(parseAIJSON('{"a":1}')).toEqual({ a: 1 })
    expect(parseAIJSON('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
  })

  it('JSON followed by a second object or prose (the prod failure)', () => {
    const detections = '{"items":[{"label":"shirt","box_2d":[1,2,3,4]}]}'
    expect(parseAIJSON(`${detections}\n{"note":"extra"}`)).toEqual({ items: [{ label: 'shirt', box_2d: [1, 2, 3, 4] }] })
    expect(parseAIJSON(`${detections}\nHope this helps! {see above}`)).toEqual({ items: [{ label: 'shirt', box_2d: [1, 2, 3, 4] }] })
    expect(parseAIJSON(`Here you go:\n[{"label":"shoe"}]\n[{"label":"dupe"}]`)).toEqual([{ label: 'shoe' }])
  })

  it('braces and quotes inside strings do not end the value early', () => {
    expect(parseAIJSON('{"text":"a } ] \\" {","n":2} trailing')).toEqual({ text: 'a } ] " {', n: 2 })
  })

  it('still throws on nothing usable', () => {
    expect(() => parseAIJSON('no json here')).toThrow(/Failed to parse AI JSON response/)
    expect(() => parseAIJSON('{"a": [1, 2}')).toThrow()
    expect(() => parseAIJSON('')).toThrow(/Empty AI response/)
  })

  it('firstJSONValue returns null for unbalanced input', () => {
    expect(firstJSONValue('{"a":1')).toBeNull()
    expect(firstJSONValue('text')).toBeNull()
  })
})
