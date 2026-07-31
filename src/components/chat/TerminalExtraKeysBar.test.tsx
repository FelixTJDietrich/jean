import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { TerminalExtraKeysBar } from './TerminalExtraKeysBar'

const { writeTerminalInput, focusTerminal } = vi.hoisted(() => ({
  writeTerminalInput: vi.fn(),
  focusTerminal: vi.fn(),
}))

vi.mock('@/lib/terminal-instances', () => ({
  writeTerminalInput,
  focusTerminal,
}))

describe('TerminalExtraKeysBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders Termius-style special keys', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    expect(screen.getByTestId('terminal-extra-keys-bar')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send esc' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send tab' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Toggle ctrl' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send ^C' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send ^Z' })).toBeTruthy()
  })

  it('writes control sequences on one-shot key press', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Send ^C' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x03')
    expect(focusTerminal).toHaveBeenCalledWith('term-1')

    fireEvent.click(screen.getByRole('button', { name: 'Send esc' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x1b')

    fireEvent.click(screen.getByRole('button', { name: 'Send tab' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\t')
  })

  it('toggles sticky ctrl and applies it to the next keystroke', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    const ctrl = screen.getByRole('button', { name: 'Toggle ctrl' })
    fireEvent.click(ctrl)
    expect(ctrl).toHaveAttribute('aria-pressed', 'true')
    expect(writeTerminalInput).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'c' })
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x03')
    expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles sticky alt and prefixes the next keystroke with ESC', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle alt' }))
    fireEvent.keyDown(window, { key: 'b' })
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x1bb')
  })

  it('writes printable symbols from the bar', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Send /' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '/')

    fireEvent.click(screen.getByRole('button', { name: 'Send |' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '|')

    fireEvent.click(screen.getByRole('button', { name: 'Send ~' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '~')
  })
})
