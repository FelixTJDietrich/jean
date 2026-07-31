/**
 * Termius-style long-press + drag arrow-key gesture helpers.
 * Long-press the terminal, drag in a direction → CSI arrow sequences.
 * Farther drag → faster repeat (3 speed gears).
 */

export type ArrowDirection = 'up' | 'down' | 'left' | 'right'

export const ARROW_KEY_SEQUENCES: Record<ArrowDirection, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
}

/** Hold duration before the gesture pad activates (ms). */
export const ARROW_GESTURE_LONG_PRESS_MS = 400

/** Finger movement before long-press fires cancels the gesture (user is scrolling). */
export const ARROW_GESTURE_CANCEL_MOVE_PX = 12

/** Deadzone around the origin before a direction registers. */
export const ARROW_GESTURE_DEADZONE_PX = 18

/** Distance thresholds for speed gears (px from origin). */
export const ARROW_GESTURE_GEAR_DISTANCES = [0, 48, 96] as const

/** Repeat intervals per gear (ms) — faster when farther from origin. */
export const ARROW_GESTURE_GEAR_INTERVALS_MS = [140, 75, 40] as const

const activeGestures = new Set<string>()

/** Touch-scroll and other handlers consult this to yield during arrow gestures. */
export function setArrowGestureActive(
  terminalId: string,
  active: boolean
): void {
  if (active) activeGestures.add(terminalId)
  else activeGestures.delete(terminalId)
}

export function isArrowGestureActive(terminalId: string): boolean {
  return activeGestures.has(terminalId)
}

/** Resolve dominant direction from delta, or null inside the deadzone. */
export function resolveArrowDirection(
  dx: number,
  dy: number,
  deadzonePx: number = ARROW_GESTURE_DEADZONE_PX
): ArrowDirection | null {
  const dist = Math.hypot(dx, dy)
  if (dist < deadzonePx) return null
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0 ? 'right' : 'left'
  }
  return dy > 0 ? 'down' : 'up'
}

/** Gear index 0..2 from distance to origin (0 = slowest / closest). */
export function resolveArrowSpeedGear(
  distancePx: number,
  gearDistances: readonly number[] = ARROW_GESTURE_GEAR_DISTANCES
): number {
  let gear = 0
  for (let i = 1; i < gearDistances.length; i++) {
    if (distancePx >= gearDistances[i]!) gear = i
  }
  return gear
}

export function arrowRepeatIntervalMs(
  distancePx: number,
  gearIntervals: readonly number[] = ARROW_GESTURE_GEAR_INTERVALS_MS
): number {
  const gear = resolveArrowSpeedGear(distancePx)
  return gearIntervals[gear] ?? gearIntervals[gearIntervals.length - 1]!
}
