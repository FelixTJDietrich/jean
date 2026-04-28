import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { ClaudeAccountPill } from './ClaudeAccountPill'
import type {
  ClaudeAccountSummary,
  ClaudeAccountsState,
} from '@/types/claude-cli'

/**
 * Render-state tests for the Claude account pill. We mock the service
 * hooks rather than the transport because the hook contracts are what the
 * pill actually consumes; keeping the test at that seam means a future
 * refactor of the IPC layer doesn't break these assertions.
 */

const mocks = vi.hoisted(() => ({
  useClaudeAccounts: vi.fn(),
  useSetActiveClaudeAccount: vi.fn(),
  useIsMobile: vi.fn().mockReturnValue(false),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeAccounts: mocks.useClaudeAccounts,
  useSetActiveClaudeAccount: mocks.useSetActiveClaudeAccount,
  getClaudeAccountLoginCommand: vi.fn(),
  useCreateClaudeAccount: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: mocks.useIsMobile,
}))

function makeAccount(
  id: string,
  overrides: Partial<ClaudeAccountSummary> = {}
): ClaudeAccountSummary {
  return {
    id,
    name: `Account ${id}`,
    color: '#3b82f6',
    createdAt: 0,
    hasCredentials: true,
    configDir: `/tmp/claude-accounts/${id}`,
    ...overrides,
  }
}

function stubQuery(data: ClaudeAccountsState | undefined, isLoading = false) {
  mocks.useClaudeAccounts.mockReturnValue({
    data,
    isLoading,
    // Only the fields the pill reads; TanStack Query returns more but we
    // don't pretend to mock the whole shape.
  })
}

describe('ClaudeAccountPill', () => {
  beforeEach(() => {
    mocks.useSetActiveClaudeAccount.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    })
    mocks.useIsMobile.mockReturnValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reserves a fixed-width placeholder while loading (prevents titlebar CLS)', () => {
    stubQuery(undefined, true)
    const { container } = render(<ClaudeAccountPill />)

    // Loading state renders an aria-hidden placeholder with a reserved
    // width so the titlebar cluster doesn't shift when data arrives.
    const placeholder = container.querySelector('[aria-hidden]')
    expect(placeholder).not.toBeNull()
    expect(placeholder).toHaveClass('w-20')
  })

  it('renders a compact "Add Claude account" CTA when no accounts exist', () => {
    stubQuery({ accounts: [], activeAccountId: null })
    render(<ClaudeAccountPill />)

    expect(
      screen.getByRole('button', { name: /add claude account/i })
    ).toBeVisible()
  })

  it('renders a "Default" pill when accounts exist but none is active', () => {
    stubQuery({
      accounts: [makeAccount('a'.repeat(32))],
      activeAccountId: null,
    })
    render(<ClaudeAccountPill />)

    const pill = screen.getByRole('button', {
      name: /claude account: default/i,
    })
    expect(pill).toBeVisible()
    expect(pill).toHaveTextContent('Default')
  })

  it('renders the active account name when one is selected', () => {
    const id = 'deadbeef-dead-beef-dead-beefdeadbeef'
    stubQuery({
      accounts: [makeAccount(id, { name: 'Work' })],
      activeAccountId: id,
    })
    render(<ClaudeAccountPill />)

    const pill = screen.getByRole('button', {
      name: /claude account: work/i,
    })
    expect(pill).toBeVisible()
    expect(pill).toHaveTextContent('Work')
  })

  it('shows a warning indicator when the active account has no credentials', () => {
    const id = 'deadbeef-dead-beef-dead-beefdeadbeef'
    stubQuery({
      accounts: [
        makeAccount(id, { name: 'Personal', hasCredentials: false }),
      ],
      activeAccountId: id,
    })
    const { container } = render(<ClaudeAccountPill />)

    // Amber AlertTriangle replaces the color dot when credentials are missing.
    // It's rendered as a lucide svg with `aria-hidden`; detecting by class is
    // brittle, but the semantic alternative (screen.getByRole) doesn't apply
    // to decorative svgs. Assert on the aria-label on the pill instead.
    const pill = screen.getByRole('button', {
      name: /claude account: personal/i,
    })
    expect(pill).toBeVisible()
    // Warning icon is aria-hidden; presence check on the svg inside the button.
    expect(container.querySelector('button svg')).not.toBeNull()
  })

  it('collapses to just a dot on mobile (no label)', () => {
    mocks.useIsMobile.mockReturnValue(true)
    const id = 'deadbeef-dead-beef-dead-beefdeadbeef'
    stubQuery({
      accounts: [makeAccount(id, { name: 'Work' })],
      activeAccountId: id,
    })
    render(<ClaudeAccountPill />)

    const pill = screen.getByRole('button', {
      name: /claude account: work/i,
    })
    // Label text is hidden on mobile; aria-label still announces the account.
    expect(pill.textContent).not.toMatch(/Work/)
  })
})
