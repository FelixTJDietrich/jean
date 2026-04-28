/**
 * ClaudeAccountLoginHint
 *
 * Shown right after an account is created (or on demand from the pill menu)
 * to tell the user the exact shell command they need to run to log into
 * their Claude subscription for this profile.
 *
 * We don't spawn `claude /login` ourselves — it opens a browser OAuth flow
 * and is cleaner to run interactively in the user's own terminal.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Info, Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { getClaudeAccountLoginCommand } from '@/services/claude-cli'

interface ClaudeAccountLoginHintProps {
  /** Account id to fetch the `CLAUDE_CONFIG_DIR=… claude /login` command for. */
  accountId: string | null
  /** Human-readable name shown in the dialog. */
  accountName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ClaudeAccountLoginHint({
  accountId,
  accountName,
  open,
  onOpenChange,
}: ClaudeAccountLoginHintProps) {
  const [command, setCommand] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Reset transient state when the dialog closes.
  useEffect(() => {
    if (!open) {
      setCommand(null)
      setLoadError(null)
      setIsLoading(false)
    }
  }, [open])

  // Fetch the login command whenever we open for a given account. Re-fetch
  // every time we open (rather than caching) so the command reflects the
  // current embedded binary path — Jean's auto-updater can replace the
  // binary beneath us and a cached command could become stale.
  useEffect(() => {
    if (!open || !accountId) return

    let cancelled = false
    setIsLoading(true)
    setLoadError(null)

    getClaudeAccountLoginCommand(accountId)
      .then(cmd => {
        if (cancelled) return
        setCommand(cmd)
      })
      .catch(error => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        logger.error('Failed to fetch Claude account login command', { error })
        setLoadError(message)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, accountId])

  const handleCopy = useCallback(async () => {
    if (!command) return
    try {
      await copyToClipboard(command)
      toast.success('Command copied to clipboard')
    } catch (error) {
      logger.error('Failed to copy login command', { error })
      toast.error('Failed to copy command', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [command])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Log in to
            {accountName ? (
              <> &ldquo;{accountName}&rdquo;</>
            ) : (
              <> your Claude account</>
            )}
          </DialogTitle>
          <DialogDescription>
            Run this in your terminal, then log in with the Claude subscription
            you want to use for this profile. Once done, come back here — Jean
            will detect the credentials automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="relative rounded-md border border-border bg-muted/40 px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed text-foreground break-all select-all">
            {isLoading && (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Preparing command…
              </span>
            )}
            {!isLoading && loadError && (
              <span className="text-destructive">{loadError}</span>
            )}
            {!isLoading && !loadError && command && (
              <code className="whitespace-pre-wrap">{command}</code>
            )}
          </div>

          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
            <span>
              The command opens your browser to complete Claude&apos;s OAuth
              sign-in. The resulting tokens land in this profile&apos;s
              config dir — session transcripts, settings, and installed
              plugins stay shared with{' '}
              <code className="font-mono">~/.claude/</code>.
            </span>
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
          <Button
            type="button"
            onClick={handleCopy}
            disabled={!command || isLoading}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy command
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ClaudeAccountLoginHint
