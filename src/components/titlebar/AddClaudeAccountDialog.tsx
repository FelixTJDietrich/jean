/**
 * AddClaudeAccountDialog
 *
 * Creates a new named Claude subscription profile (e.g. "Personal" / "Work").
 * After a successful create, the caller is notified via `onCreated(id)` so it
 * can chain into the login-command hint (the account has no credentials yet
 * until the user runs `claude /login` in their terminal).
 */

import { useCallback, useEffect, useState } from 'react'
import { Check } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useCreateClaudeAccount } from '@/services/claude-cli'
import type { ClaudeAccountSummary } from '@/types/claude-cli'

/**
 * A tasteful, theme-neutral palette. Values are concrete hex so they persist
 * consistently and render the same across light/dark mode (we only ever use
 * them as a small indicator dot).
 */
const COLOR_PALETTE = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#06b6d4', // cyan-500
  '#3b82f6', // blue-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
] as const

// Blue is neutral; red is the app's destructive token and would be
// semantically misleading for a freshly-created profile.
const DEFAULT_COLOR = '#3b82f6'
const NAME_MAX_LENGTH = 40

interface AddClaudeAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called with the new account's id and display name after a successful
   * create. Name is passed through so the caller can show it immediately
   * without waiting for the TanStack Query cache to refetch.
   */
  onCreated?: (accountId: string, accountName: string) => void
}

export function AddClaudeAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: AddClaudeAccountDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(DEFAULT_COLOR)
  const [pendingCreated, setPendingCreated] =
    useState<ClaudeAccountSummary | null>(null)
  const createAccount = useCreateClaudeAccount()

  // Reset form when the dialog closes so reopening starts fresh.
  useEffect(() => {
    if (!open) {
      setName('')
      setColor(DEFAULT_COLOR)
    }
  }, [open])

  // Handoff to `onCreated` runs in an effect keyed on `!open` so the
  // callback fires AFTER React has committed the dialog's closed state and
  // Radix has begun (and ideally finished) its exit animation. This is
  // what avoids two Radix focus traps overlapping when the parent
  // immediately opens a second dialog.
  useEffect(() => {
    if (!open && pendingCreated) {
      const account = pendingCreated
      setPendingCreated(null)
      onCreated?.(account.id, account.name)
    }
  }, [open, pendingCreated, onCreated])

  const trimmedName = name.trim()
  const isValid =
    trimmedName.length > 0 && trimmedName.length <= NAME_MAX_LENGTH
  const isSubmitting = createAccount.isPending

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!isValid || isSubmitting) return

      createAccount.mutate(
        { name: trimmedName, color },
        {
          onSuccess: account => {
            // Just stash the created account and close. The parent watches
            // for `!open && pendingCreated` via useEffect and opens the
            // login-hint dialog only after this dialog has fully unmounted
            // — which is what we need to avoid two overlapping Radix
            // focus traps fighting during the exit animation.
            setPendingCreated(account)
            onOpenChange(false)
          },
        }
      )
    },
    [
      createAccount,
      trimmedName,
      color,
      isValid,
      isSubmitting,
      onOpenChange,
      onCreated,
    ]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Claude account</DialogTitle>
          <DialogDescription>
            Create a separate profile so you can switch Claude subscriptions
            without signing out. You&apos;ll log in with{' '}
            <code className="font-mono text-xs">claude /login</code> next.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="claude-account-name"
              className="text-sm font-medium text-foreground"
            >
              Name
            </label>
            <Input
              id="claude-account-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Personal, Work, Client X…"
              maxLength={NAME_MAX_LENGTH}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={isSubmitting}
              aria-invalid={name.length > 0 && !isValid}
            />
            <p className="text-xs text-muted-foreground">
              {trimmedName.length}/{NAME_MAX_LENGTH}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Color</span>
            <div
              role="radiogroup"
              aria-label="Account color"
              className="flex flex-wrap gap-2"
            >
              {COLOR_PALETTE.map(swatch => {
                const selected = swatch === color
                return (
                  <button
                    key={swatch}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`Pick color ${swatch}`}
                    disabled={isSubmitting}
                    onClick={() => setColor(swatch)}
                    className={cn(
                      'relative flex h-7 w-7 items-center justify-center rounded-full',
                      'ring-offset-background transition-all',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      selected
                        ? 'ring-2 ring-foreground/80 ring-offset-2'
                        : 'ring-1 ring-border hover:ring-foreground/40'
                    )}
                    style={{ backgroundColor: swatch }}
                  >
                    {selected && (
                      <Check
                        className="h-3.5 w-3.5 text-white drop-shadow-sm"
                        aria-hidden
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default AddClaudeAccountDialog
