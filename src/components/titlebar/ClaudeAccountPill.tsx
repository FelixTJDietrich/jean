/**
 * ClaudeAccountPill
 *
 * Top-right titlebar affordance for switching between named Claude subscription
 * profiles ("Personal" / "Work" / …). Used when one subscription hits a rate
 * limit mid-session so the user can keep going on another without signing out.
 *
 * Behavior:
 *  - Zero accounts → renders a compact "Add Claude account" CTA instead of a pill.
 *  - ≥1 account  → renders a pill (dot + name) that opens a dropdown listing
 *    all accounts with a check on the active one, plus a "Use default" option
 *    to clear the selection, "+ New account", and "Manage accounts…".
 *  - No active account → pill reads "Default" with a muted dot.
 *  - Active account missing credentials → amber warning dot with a tooltip
 *    telling the user to run `claude /login`. Switching still works; the pill
 *    is purely display/switching, it never blocks other UI.
 *  - Mobile (narrow) → pill collapses to just the dot; dropdown still works.
 *
 * All state flows through TanStack Query hooks (no Zustand subscription here).
 */

import { useCallback, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Plus,
  Settings2,
  UserCircle2,
} from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/store/ui-store'
import {
  useClaudeAccounts,
  useSetActiveClaudeAccount,
} from '@/services/claude-cli'

import { AddClaudeAccountDialog } from './AddClaudeAccountDialog'
import { ClaudeAccountLoginHint } from './ClaudeAccountLoginHint'

const WARNING_COLOR = '#f59e0b' // amber-500

export function ClaudeAccountPill() {
  const isMobile = useIsMobile()
  const { data, isLoading } = useClaudeAccounts()
  const setActive = useSetActiveClaudeAccount()

  const [addOpen, setAddOpen] = useState(false)
  // We carry the name AS WELL as the id so the login-hint dialog can show
  // the freshly-typed name immediately, before the TanStack Query cache
  // has re-fetched the account list (the invalidate is asynchronous).
  const [loginHint, setLoginHint] = useState<{
    id: string
    name: string
  } | null>(null)

  const accounts = data?.accounts ?? []
  const activeAccountId = data?.activeAccountId ?? null
  const activeAccount = useMemo(
    () => accounts.find(a => a.id === activeAccountId) ?? null,
    [accounts, activeAccountId]
  )

  // Open Preferences at the closest-matching pane. There isn't a dedicated
  // "claude accounts" pane yet, so surface users at "providers" where other
  // backend/provider settings live.
  const openManageAccounts = useCallback(() => {
    useUIStore.getState().openPreferencesPane('providers')
  }, [])

  const handleSwitch = useCallback(
    (nextId: string | null) => {
      if (nextId === activeAccountId) return
      setActive.mutate(nextId)
    },
    [activeAccountId, setActive]
  )

  const handleCreate = useCallback(() => {
    setAddOpen(true)
  }, [])

  const handleCreated = useCallback(
    (newAccountId: string, newAccountName: string) => {
      // Chain straight into the "here's your login command" step.
      setLoginHint({ id: newAccountId, name: newAccountName })
    },
    []
  )

  const handleLoginHintOpenChange = useCallback((open: boolean) => {
    if (!open) setLoginHint(null)
  }, [])

  // Memoize so React reference-compares equal across renders when only
  // unrelated state changes, preventing unnecessary button re-renders.
  // MUST be declared before any conditional `return` below — React
  // requires the same hook count on every render of this component, so
  // moving this past the early returns triggers React error #310
  // ("Rendered more hooks than during the previous render") on the
  // transition from the loading-skeleton path to the rendered-pill path.
  const pillStyle = useMemo(
    () =>
      activeAccount
        ? { boxShadow: `inset 0 0 0 1px ${activeAccount.color}40` }
        : undefined,
    [activeAccount]
  )

  // -----------------------------------------------------------------------
  // Render: still loading or no accounts yet → compact CTA.
  // -----------------------------------------------------------------------
  if (isLoading) {
    // Reserve approximate pill width so the titlebar doesn't reflow when
    // accounts data arrives (avoids CLS on first paint). The width matches
    // the shortest resolved state (the default "Default" pill) — wider
    // states cause at most a 30-40px nudge right rather than a full
    // cluster shift.
    return (
      <div className="mr-1 h-6 w-20 rounded-full border border-border/30" aria-hidden />
    )
  }

  if (accounts.length === 0) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCreate}
              className={cn(
                'mr-1 flex h-6 items-center gap-1 rounded-md px-2',
                'text-[0.625rem] font-medium text-foreground/60',
                'hover:text-foreground hover:bg-accent transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              aria-label="Add Claude account"
            >
              <UserCircle2 className="h-3 w-3" />
              {!isMobile && <span>Add Claude account</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Create a named Claude subscription profile
          </TooltipContent>
        </Tooltip>

        <AddClaudeAccountDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onCreated={handleCreated}
        />
        <ClaudeAccountLoginHint
          accountId={loginHint?.id ?? null}
          accountName={loginHint?.name}
          open={loginHint !== null}
          onOpenChange={handleLoginHintOpenChange}
        />
      </>
    )
  }

  // -----------------------------------------------------------------------
  // Render: at least one account → pill + dropdown.
  // -----------------------------------------------------------------------
  const missingCredentials = activeAccount != null && !activeAccount.hasCredentials
  const pillLabel = activeAccount ? activeAccount.name : 'Default'
  const pillDotColor = activeAccount?.color ?? null

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={
                  activeAccount
                    ? `Claude account: ${activeAccount.name}`
                    : 'Claude account: default'
                }
                className={cn(
                  'mr-1 flex h-6 items-center gap-1.5 rounded-full',
                  'border border-border/70 bg-background/60',
                  'px-2 text-[0.625rem] font-medium text-foreground/80',
                  'hover:bg-accent hover:text-foreground transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
                // Subtle colored ring from the account's own color so the
                // user can recognize their profile at a glance.
                style={pillStyle}
              >
                <AccountDot
                  color={missingCredentials ? WARNING_COLOR : pillDotColor}
                  warning={missingCredentials}
                />
                {!isMobile && (
                  <span className="max-w-[8rem] truncate">{pillLabel}</span>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">
                {activeAccount ? activeAccount.name : 'Default (~/.claude/)'}
              </span>
              <span className="text-muted-foreground">
                {activeAccount
                  ? activeAccount.hasCredentials
                    ? 'Signed in'
                    : 'Not logged in — run `claude /login`'
                  : 'Using the shared ~/.claude/ directory'}
              </span>
            </div>
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" className="min-w-[14rem]">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Claude account
          </DropdownMenuLabel>

          <AccountMenuRow
            label="Default (~/.claude/)"
            description="Shared Claude config"
            active={activeAccountId === null}
            onSelect={() => handleSwitch(null)}
          />

          {accounts.map(account => (
            <AccountMenuRow
              key={account.id}
              label={account.name}
              description={
                account.hasCredentials ? 'Signed in' : 'Not logged in'
              }
              dotColor={account.color}
              active={account.id === activeAccountId}
              warn={!account.hasCredentials}
              onSelect={() => handleSwitch(account.id)}
            />
          ))}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={handleCreate}>
            <Plus className="h-4 w-4" />
            <span>New account</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openManageAccounts}>
            <Settings2 className="h-4 w-4" />
            <span>Manage accounts…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AddClaudeAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={handleCreated}
      />
      <ClaudeAccountLoginHint
        accountId={loginHint?.id ?? null}
        accountName={loginHint?.name}
        open={loginHint !== null}
        onOpenChange={handleLoginHintOpenChange}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Internal bits
// ---------------------------------------------------------------------------

interface AccountDotProps {
  /** Hex color for the dot; `null` renders a muted neutral dot. */
  color: string | null
  warning?: boolean
}

/**
 * Small colored circle used both in the pill and as a left-accessory on
 * dropdown rows. Renders a ring so light-colored dots still have enough
 * contrast on both light and dark backgrounds.
 */
function AccountDot({ color, warning }: AccountDotProps) {
  if (warning) {
    return (
      <AlertTriangle
        className="h-3 w-3"
        style={{ color: WARNING_COLOR }}
        aria-hidden
      />
    )
  }

  if (color === null) {
    return (
      <span
        className="h-2 w-2 rounded-full bg-muted-foreground/40 ring-1 ring-border"
        aria-hidden
      />
    )
  }

  return (
    <span
      className="h-2 w-2 rounded-full ring-1 ring-border"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

interface AccountMenuRowProps {
  label: string
  description?: string
  /** Per-account hex color; omit for the "default" row. */
  dotColor?: string
  active: boolean
  warn?: boolean
  onSelect: () => void
}

function AccountMenuRow({
  label,
  description,
  dotColor,
  active,
  warn,
  onSelect,
}: AccountMenuRowProps) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="flex items-center gap-2 pr-2"
    >
      <AccountDot color={dotColor ?? null} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{label}</span>
        {description && (
          <span
            className={cn(
              'truncate text-[0.625rem]',
              warn ? 'text-amber-500' : 'text-muted-foreground'
            )}
          >
            {description}
          </span>
        )}
      </div>
      {active && (
        <Check
          className="ml-auto h-3.5 w-3.5 text-foreground"
          aria-hidden
        />
      )}
    </DropdownMenuItem>
  )
}

export default ClaudeAccountPill
