import { describe, expect, it } from 'vitest'
import { shouldHideFloatingDock } from './floating-dock-visibility'

describe('shouldHideFloatingDock', () => {
  it('hides the dock only on mobile while zen mode is active', () => {
    expect(shouldHideFloatingDock(true, true)).toBe(true)
    expect(shouldHideFloatingDock(true, false)).toBe(false)
    expect(shouldHideFloatingDock(false, true)).toBe(false)
  })
})
