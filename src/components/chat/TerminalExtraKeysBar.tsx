import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  focusTerminal,
  writeTerminalInput,
} from '@/lib/terminal-instances'
import {
  applyCtrlModifier,
  resolveStickyKeyData,
  TERMINAL_EXTRA_KEYS,
  type TerminalExtraKeyAction,
} from '@/lib/terminal-extra-keys'

interface TerminalExtraKeysBarProps {
  terminalId: string
  className?: string
  /** When true, omit home-indicator safe-area padding (keyboard already lifts us). */
  keyboardOpen?: boolean
}

/**
 * Termius-style special-keys strip for web access and mobile soft keyboards.
 * One-shot keys inject control sequences; Ctrl/Alt are sticky for the next char.
 */
export function TerminalExtraKeysBar({
  terminalId,
  className,
  keyboardOpen = false,
}: TerminalExtraKeysBarProps) {
  const [stickyCtrl, setStickyCtrl] = useState(false)
  const [stickyAlt, setStickyAlt] = useState(false)

  const sendData = useCallback(
    (data: string) => {
      writeTerminalInput(terminalId, data)
      focusTerminal(terminalId)
    },
    [terminalId]
  )

  const clearSticky = useCallback(() => {
    setStickyCtrl(false)
    setStickyAlt(false)
  }, [])

  // When sticky Ctrl/Alt is active, capture the next keystroke and transform it.
  useEffect(() => {
    if (!stickyCtrl && !stickyAlt) return

    const onKeyDown = (event: KeyboardEvent) => {
      // Only intercept when focus is still in this terminal (or nothing stole it).
      const terminalRoot = document.querySelector(
        `[data-terminal-id="${terminalId}"]`
      )
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        terminalRoot &&
        !terminalRoot.contains(active) &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return
      }

      const data = resolveStickyKeyData(event, stickyCtrl, stickyAlt)
      if (data === null) return

      event.preventDefault()
      event.stopPropagation()
      sendData(data)
      clearSticky()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [stickyCtrl, stickyAlt, terminalId, sendData, clearSticky])

  // Reset sticky modifiers when switching terminals.
  useEffect(() => {
    setStickyCtrl(false)
    setStickyAlt(false)
  }, [terminalId])

  const handleKey = useCallback(
    (action: TerminalExtraKeyAction) => {
      if (action.type === 'toggle') {
        if (action.modifier === 'ctrl') {
          setStickyCtrl(prev => !prev)
          setStickyAlt(false)
        } else {
          setStickyAlt(prev => !prev)
          setStickyCtrl(false)
        }
        focusTerminal(terminalId)
        return
      }

      // One-shot data key. If sticky Ctrl/Alt is on and this is a single
      // printable char, apply the modifier; control chords (^C etc.) send as-is.
      let data = action.data
      if (stickyCtrl && data.length === 1) {
        const ctrlData = applyCtrlModifier(data)
        if (ctrlData !== null) data = ctrlData
      } else if (stickyAlt && data.length === 1) {
        data = `\x1b${data}`
      }

      sendData(data)
      clearSticky()
    },
    [terminalId, stickyCtrl, stickyAlt, sendData, clearSticky]
  )

  return (
    <div
      data-testid="terminal-extra-keys-bar"
      className={cn(
        'shrink-0 border-t border-border/60 bg-background/95 backdrop-blur-sm',
        // Home-indicator inset only when the soft keyboard is closed; when open
        // the parent applies visual-viewport padding so we already sit above it.
        !keyboardOpen && 'pb-[env(safe-area-inset-bottom,0px)]',
        className
      )}
      // Keep terminal focused: prevent bar buttons from taking keyboard focus.
      // Use pointerdown so touch + mouse both avoid focus steal.
      onPointerDown={e => e.preventDefault()}
    >
      <div
        role="toolbar"
        aria-label="Terminal special keys"
        className="flex gap-1.5 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TERMINAL_EXTRA_KEYS.map(action => {
          const isActive =
            action.type === 'toggle' &&
            ((action.modifier === 'ctrl' && stickyCtrl) ||
              (action.modifier === 'alt' && stickyAlt))

          return (
            <button
              key={action.label}
              type="button"
              aria-label={
                action.type === 'toggle'
                  ? `Toggle ${action.label}`
                  : `Send ${action.label}`
              }
              aria-pressed={action.type === 'toggle' ? isActive : undefined}
              className={cn(
                'inline-flex h-8 min-w-[2.25rem] shrink-0 items-center justify-center rounded-full px-2.5',
                'text-xs font-medium tabular-nums tracking-wide',
                'border border-border/70 bg-muted/40 text-muted-foreground',
                'active:scale-95 transition-colors touch-manipulation select-none',
                'hover:bg-muted hover:text-foreground',
                isActive &&
                  'border-primary/60 bg-primary/20 text-primary hover:bg-primary/25'
              )}
              onClick={() => handleKey(action)}
            >
              {action.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
