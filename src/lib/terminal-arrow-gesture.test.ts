import { afterEach, describe, expect, it } from 'vitest'
import {
  ARROW_KEY_SEQUENCES,
  arrowRepeatIntervalMs,
  isArrowGestureActive,
  resolveArrowDirection,
  resolveArrowSpeedGear,
  setArrowGestureActive,
} from './terminal-arrow-gesture'

describe('resolveArrowDirection', () => {
  it('returns null inside the deadzone', () => {
    expect(resolveArrowDirection(0, 0, 18)).toBeNull()
    expect(resolveArrowDirection(10, 5, 18)).toBeNull()
  })

  it('picks the dominant axis', () => {
    expect(resolveArrowDirection(0, -40, 18)).toBe('up')
    expect(resolveArrowDirection(0, 40, 18)).toBe('down')
    expect(resolveArrowDirection(-40, 0, 18)).toBe('left')
    expect(resolveArrowDirection(40, 0, 18)).toBe('right')
  })

  it('prefers horizontal when equal magnitude', () => {
    expect(resolveArrowDirection(30, 30, 18)).toBe('right')
    expect(resolveArrowDirection(-30, 30, 18)).toBe('left')
  })
})

describe('speed gears', () => {
  it('starts at gear 0 near the origin', () => {
    expect(resolveArrowSpeedGear(10)).toBe(0)
  })

  it('steps up with distance', () => {
    expect(resolveArrowSpeedGear(50)).toBe(1)
    expect(resolveArrowSpeedGear(120)).toBe(2)
  })

  it('shortens the repeat interval at higher gears', () => {
    const slow = arrowRepeatIntervalMs(10)
    const mid = arrowRepeatIntervalMs(50)
    const fast = arrowRepeatIntervalMs(120)
    expect(slow).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(fast)
  })
})

describe('ARROW_KEY_SEQUENCES', () => {
  it('uses standard CSI arrow sequences', () => {
    expect(ARROW_KEY_SEQUENCES.up).toBe('\x1b[A')
    expect(ARROW_KEY_SEQUENCES.down).toBe('\x1b[B')
    expect(ARROW_KEY_SEQUENCES.right).toBe('\x1b[C')
    expect(ARROW_KEY_SEQUENCES.left).toBe('\x1b[D')
  })
})

describe('active gesture registry', () => {
  afterEach(() => {
    setArrowGestureActive('term-1', false)
  })

  it('tracks active state for touch-scroll coordination', () => {
    expect(isArrowGestureActive('term-1')).toBe(false)
    setArrowGestureActive('term-1', true)
    expect(isArrowGestureActive('term-1')).toBe(true)
    setArrowGestureActive('term-1', false)
    expect(isArrowGestureActive('term-1')).toBe(false)
  })
})
