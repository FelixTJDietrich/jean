import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  focusTerminal,
  writeTerminalInput,
} from '@/lib/terminal-instances'
import {
  ARROW_GESTURE_CANCEL_MOVE_PX,
  ARROW_GESTURE_DEADZONE_PX,
  ARROW_GESTURE_LONG_PRESS_MS,
  ARROW_KEY_SEQUENCES,
  arrowRepeatIntervalMs,
  resolveArrowDirection,
  setArrowGestureActive,
  type ArrowDirection,
} from '@/lib/terminal-arrow-gesture'

interface TerminalArrowGestureProps {
  terminalId: string
  /** Element that receives the long-press + drag gesture (terminal surface). */
  surfaceRef: RefObject<HTMLElement | null>
  enabled?: boolean
}

/** Pad size in CSS px — keep in sync with the rendered box. */
export const ARROW_GESTURE_PAD_SIZE = 88

/**
 * Termius-style motion pad: long-press the terminal, drag up/down/left/right
 * to send arrow keys (history / cursor). Hold further for faster repeat.
 *
 * Render this as a flex sibling *above* the terminal surface so the pad sits
 * in its own chrome row and never covers emulator text.
 */
export function TerminalArrowGesture({
  terminalId,
  surfaceRef,
  enabled = true,
}: TerminalArrowGestureProps) {
  const [active, setActive] = useState(false)
  const [direction, setDirection] = useState<ArrowDirection | null>(null)
  const activeRef = useRef(false)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const directionRef = useRef<ArrowDirection | null>(null)
  const distanceRef = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const surface = surfaceRef.current
    if (!surface) return

    const clearLongPressTimer = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }

    const clearRepeatTimer = () => {
      if (repeatTimerRef.current) {
        clearTimeout(repeatTimerRef.current)
        repeatTimerRef.current = null
      }
    }

    const sendArrow = (dir: ArrowDirection) => {
      writeTerminalInput(terminalId, ARROW_KEY_SEQUENCES[dir])
    }

    /** Start (or restart) auto-repeat. Interval is re-read each tick for gears. */
    const scheduleRepeat = () => {
      clearRepeatTimer()
      const tick = () => {
        const dir = directionRef.current
        if (!activeRef.current || !dir) return
        sendArrow(dir)
        const interval = arrowRepeatIntervalMs(distanceRef.current)
        repeatTimerRef.current = setTimeout(tick, interval)
      }
      const interval = arrowRepeatIntervalMs(distanceRef.current)
      repeatTimerRef.current = setTimeout(tick, interval)
    }

    const activate = (x: number, y: number) => {
      activeRef.current = true
      setArrowGestureActive(terminalId, true)
      // Drag origin stays at the finger so direction tracks movement from press.
      originRef.current = { x, y }
      directionRef.current = null
      distanceRef.current = 0
      setDirection(null)
      setActive(true)
      focusTerminal(terminalId)
    }

    const deactivate = () => {
      clearLongPressTimer()
      clearRepeatTimer()
      activeRef.current = false
      setArrowGestureActive(terminalId, false)
      originRef.current = null
      directionRef.current = null
      distanceRef.current = 0
      setDirection(null)
      setActive(false)
    }

    const updateDirection = (clientX: number, clientY: number) => {
      const origin = originRef.current
      if (!origin || !activeRef.current) return

      const dx = clientX - origin.x
      const dy = clientY - origin.y
      const distance = Math.hypot(dx, dy)
      distanceRef.current = distance

      const next = resolveArrowDirection(dx, dy, ARROW_GESTURE_DEADZONE_PX)
      const prev = directionRef.current

      if (next !== prev) {
        directionRef.current = next
        setDirection(next)
        if (next) {
          sendArrow(next)
          scheduleRepeat()
        } else {
          clearRepeatTimer()
        }
      }
      // Same direction: distanceRef already updated; next tick picks new gear.
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        deactivate()
        return
      }
      // Don't steal touches that start on the extra-keys bar.
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-testid="terminal-extra-keys-bar"]')
      ) {
        return
      }

      const touch = event.touches[0]!
      clearLongPressTimer()
      originRef.current = { x: touch.clientX, y: touch.clientY }

      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        const origin = originRef.current
        if (!origin) return
        activate(origin.x, origin.y)
        // Soft haptic when available (iOS Safari / some Android).
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate(10)
          } catch {
            // ignore
          }
        }
      }, ARROW_GESTURE_LONG_PRESS_MS)
    }

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        deactivate()
        return
      }
      const touch = event.touches[0]!

      if (activeRef.current) {
        event.preventDefault()
        updateDirection(touch.clientX, touch.clientY)
        return
      }

      // Cancel pending long-press if the user is clearly scrolling.
      const origin = originRef.current
      if (origin && longPressTimerRef.current) {
        const moved = Math.hypot(
          touch.clientX - origin.x,
          touch.clientY - origin.y
        )
        if (moved > ARROW_GESTURE_CANCEL_MOVE_PX) {
          clearLongPressTimer()
          originRef.current = null
        }
      }
    }

    const onTouchEnd = () => {
      deactivate()
    }

    surface.addEventListener('touchstart', onTouchStart, { passive: true })
    surface.addEventListener('touchmove', onTouchMove, { passive: false })
    surface.addEventListener('touchend', onTouchEnd, { passive: true })
    surface.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      deactivate()
      surface.removeEventListener('touchstart', onTouchStart)
      surface.removeEventListener('touchmove', onTouchMove)
      surface.removeEventListener('touchend', onTouchEnd)
      surface.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [enabled, surfaceRef, terminalId])

  // Keep mounted while inactive so touch listeners stay registered; only the
  // chrome row is omitted so the pad never overlays terminal text.
  if (!active) return null

  return (
    <div
      data-testid="terminal-arrow-gesture-pad"
      role="presentation"
      aria-hidden
      className="pointer-events-none flex shrink-0 justify-end px-2 pt-1.5 pb-0.5"
    >
      <div
        className={cn(
          'grid grid-cols-3 grid-rows-3 rounded-2xl',
          'border border-border/80 bg-background/90 shadow-lg backdrop-blur-md'
        )}
        style={{
          width: ARROW_GESTURE_PAD_SIZE,
          height: ARROW_GESTURE_PAD_SIZE,
        }}
      >
        <PadCell />
        <PadCell active={direction === 'up'} icon={<ArrowUp />} />
        <PadCell />
        <PadCell active={direction === 'left'} icon={<ArrowLeft />} />
        <PadCell center />
        <PadCell active={direction === 'right'} icon={<ArrowRight />} />
        <PadCell />
        <PadCell active={direction === 'down'} icon={<ArrowDown />} />
        <PadCell />
      </div>
    </div>
  )
}

function PadCell({
  active,
  icon,
  center,
}: {
  active?: boolean
  icon?: ReactNode
  center?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center',
        center && 'rounded-full',
        active && 'text-primary',
        !active && icon && 'text-muted-foreground/80',
        active && 'scale-110'
      )}
    >
      {icon ? (
        <span
          className={cn(
            'flex size-7 items-center justify-center rounded-md transition-transform',
            active && 'bg-primary/20'
          )}
        >
          <span className="[&>svg]:size-4">{icon}</span>
        </span>
      ) : center ? (
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      ) : null}
    </div>
  )
}
