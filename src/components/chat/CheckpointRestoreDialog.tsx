import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { triggerImmediateGitPoll } from '@/services/git-status'
import {
  analyzeAiCheckpointRestore,
  applyAiCheckpointRestoreProposal,
  checkpointQueryKeys,
  proposeAiCheckpointRestore,
  restoreAiCheckpoint,
  restoreAiCheckpointTurn,
} from '@/services/checkpoints'
import type {
  AiCheckpoint,
  CheckpointRestoreAnalysis,
  CheckpointRestoreProposal,
  RestoreFileProposal,
  RestorePathStatus,
} from '@/types/checkpoints'

function pathStatusLabel(status: RestorePathStatus): string {
  switch (status) {
    case 'clean':
      return 'Clean'
    case 'conflictedLaterActivity':
      return 'Later turn'
    case 'conflictedWorkingTree':
      return 'Edited after'
    case 'binaryOrUnreadable':
      return 'Binary'
    default:
      return status
  }
}

/** Shared risk copy — restore can be imperfect, especially AI merges. */
function RestoreRiskHint({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-left text-xs leading-snug text-amber-950 dark:text-amber-100',
        className
      )}
      role="note"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-amber-900 dark:text-amber-50">
          Restore can make mistakes
        </p>
        <p className="text-amber-900/85 dark:text-amber-100/85">
          Undoing AI edits may overwrite later work, miss shared-file changes, or
          (with AI assist) produce imperfect merges. Review carefully and prefer
          git commit / backup first when unsure.
        </p>
      </div>
    </div>
  )
}

/** Restore actions that mutate the worktree — each requires explicit approval. */
type PendingApproval =
  | 'cleanOnly'
  | 'allTurnFiles'
  | 'full'
  | 'applyAi'
  | null

export interface CheckpointRestoreDialogProps {
  open: boolean
  worktreeId: string
  checkpoint: AiCheckpoint | null
  onOpenChange: (open: boolean) => void
  /** Called after a successful restore (any mode). */
  onRestored?: () => void
}

/**
 * Shared restore flow: overlap analysis, clean-only, AI-assisted, force turn
 * files, and full worktree restore. Every mutating action requires an explicit
 * user Approve step before files are written.
 */
export function CheckpointRestoreDialog({
  open,
  worktreeId,
  checkpoint,
  onOpenChange,
  onRestored,
}: CheckpointRestoreDialogProps) {
  const queryClient = useQueryClient()
  const [restoreAnalysis, setRestoreAnalysis] =
    useState<CheckpointRestoreAnalysis | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [aiProposal, setAiProposal] =
    useState<CheckpointRestoreProposal | null>(null)
  const [selectedProposalPaths, setSelectedProposalPaths] = useState<
    Set<string>
  >(new Set())
  const [restoring, setRestoring] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>(null)

  const resetLocal = useCallback(() => {
    setRestoreAnalysis(null)
    setAiProposal(null)
    setSelectedProposalPaths(new Set())
    setPendingApproval(null)
    setAnalysisLoading(false)
    setProposing(false)
  }, [])

  useEffect(() => {
    if (!open || !checkpoint) {
      resetLocal()
      return
    }
    let cancelled = false
    setAnalysisLoading(true)
    setRestoreAnalysis(null)
    setAiProposal(null)
    setSelectedProposalPaths(new Set())
    setPendingApproval(null)
    void analyzeAiCheckpointRestore(worktreeId, checkpoint.id)
      .then(analysis => {
        if (!cancelled) setRestoreAnalysis(analysis)
      })
      .catch(e => {
        if (!cancelled) {
          toast.error(`Failed to analyze restore: ${e}`)
          onOpenChange(false)
        }
      })
      .finally(() => {
        if (!cancelled) setAnalysisLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, checkpoint, worktreeId, onOpenChange, resetLocal])

  const refreshAfterRestore = useCallback(async () => {
    triggerImmediateGitPoll()
    await queryClient.invalidateQueries({
      queryKey: checkpointQueryKeys.worktree(worktreeId),
    })
    onRestored?.()
  }, [queryClient, worktreeId, onRestored])

  const selectedAiCount = useMemo(() => {
    if (!aiProposal) return 0
    return aiProposal.files.filter(
      f => f.action !== 'skip' && selectedProposalPaths.has(f.path)
    ).length
  }, [aiProposal, selectedProposalPaths])

  const approvalCopy = useMemo(() => {
    switch (pendingApproval) {
      case 'cleanOnly':
        return {
          title: 'Approve restore?',
          body: `Restore ${restoreAnalysis?.cleanCount ?? 0} clean file(s) to the pre-turn snapshot. Conflicted files will be left unchanged.`,
          confirmLabel: 'Approve restore',
          destructive: false,
        }
      case 'allTurnFiles':
        return {
          title: 'Approve force restore?',
          body: `Restore all ${restoreAnalysis?.turnPaths.length ?? 0} file(s) this turn changed. Later edits on those paths (including other sessions) will be overwritten.`,
          confirmLabel: 'Approve force restore',
          destructive: true,
        }
      case 'full':
        return {
          title: 'Approve full worktree restore?',
          body: 'Reset the entire worktree to the state before this AI turn. All later uncommitted changes will be lost (including other sessions\' work on this worktree and files created after the checkpoint).',
          confirmLabel: 'Approve full restore',
          destructive: true,
        }
      case 'applyAi':
        return {
          title: 'Approve AI restore?',
          body: `Apply AI proposals for ${selectedAiCount} selected path(s)${
            aiProposal && aiProposal.cleanPaths.length > 0
              ? ` and restore ${aiProposal.cleanPaths.length} clean file(s)`
              : ''
          }. Review the proposal carefully before approving.`,
          confirmLabel: 'Approve AI restore',
          destructive: false,
        }
      default:
        return null
    }
  }, [pendingApproval, restoreAnalysis, selectedAiCount, aiProposal])

  const executeApprovedRestore = useCallback(async () => {
    if (!checkpoint || !pendingApproval) return
    setRestoring(true)
    try {
      if (pendingApproval === 'cleanOnly') {
        const result = await restoreAiCheckpointTurn(
          worktreeId,
          checkpoint.id,
          'cleanOnly'
        )
        const n = result.restoredPaths.length
        const skipped = result.skippedPaths.length
        toast.success(
          skipped > 0
            ? `Restored ${n} clean file(s); skipped ${skipped} conflicted`
            : `Restored ${n} file(s) from this turn`
        )
      } else if (pendingApproval === 'allTurnFiles') {
        const result = await restoreAiCheckpointTurn(
          worktreeId,
          checkpoint.id,
          'allTurnFiles'
        )
        toast.success(
          `Restored ${result.restoredPaths.length} turn file(s) from checkpoint`
        )
      } else if (pendingApproval === 'full') {
        await restoreAiCheckpoint(worktreeId, checkpoint.id)
        toast.success('Entire worktree restored to checkpoint')
      } else if (pendingApproval === 'applyAi' && aiProposal) {
        const files: RestoreFileProposal[] = aiProposal.files
          .filter(f => selectedProposalPaths.has(f.path) || f.action === 'skip')
          .map(f =>
            selectedProposalPaths.has(f.path)
              ? f
              : { ...f, action: 'skip' as const }
          )
        const result = await applyAiCheckpointRestoreProposal(
          worktreeId,
          checkpoint.id,
          files,
          aiProposal.cleanPaths
        )
        const applied = result.appliedPaths.length
        const errCount = result.errors.length
        if (errCount > 0) {
          toast.error(
            `Applied ${applied} path(s); ${errCount} error(s): ${result.errors[0]}`
          )
        } else {
          toast.success(
            `Applied restore to ${applied} path(s)${
              aiProposal.summary ? ` — ${aiProposal.summary}` : ''
            }`
          )
        }
      }
      await refreshAfterRestore()
      onOpenChange(false)
    } catch (e) {
      toast.error(`Restore failed: ${e}`)
    } finally {
      setRestoring(false)
    }
  }, [
    checkpoint,
    pendingApproval,
    worktreeId,
    aiProposal,
    selectedProposalPaths,
    refreshAfterRestore,
    onOpenChange,
  ])

  const handleProposeAiRestore = useCallback(async () => {
    if (!checkpoint) return
    setProposing(true)
    try {
      const proposal = await proposeAiCheckpointRestore(
        worktreeId,
        checkpoint.id
      )
      setAiProposal(proposal)
      setPendingApproval(null)
      const selectable = proposal.files
        .filter(f => f.action !== 'skip')
        .map(f => f.path)
      setSelectedProposalPaths(new Set(selectable))
      if (proposal.files.length === 0 && proposal.cleanPaths.length > 0) {
        toast.message('No conflicts — restore clean files instead')
      } else if (proposal.files.length === 0) {
        toast.message(proposal.summary || 'Nothing for AI to restore')
      }
    } catch (e) {
      toast.error(`AI restore proposal failed: ${e}`)
    } finally {
      setProposing(false)
    }
  }, [checkpoint, worktreeId])

  const toggleProposalPath = useCallback((path: string) => {
    setSelectedProposalPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const showApproval = pendingApproval != null && approvalCopy != null

  return (
    <AlertDialog
      open={open && !!checkpoint}
      onOpenChange={next => {
        if (!next && !restoring && !proposing) onOpenChange(false)
      }}
    >
      <AlertDialogContent
        className={cn(
          // Mobile: bottom sheet-style panel that stays on-screen and scrolls
          'flex w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0',
          'max-h-[min(92dvh,100%)]',
          'max-sm:top-auto max-sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:left-1/2 max-sm:translate-x-[-50%] max-sm:translate-y-0 max-sm:rounded-xl',
          // Desktop centered dialog
          'sm:max-w-lg sm:gap-0',
          // Override default padding from AlertDialogContent base
          'sm:p-0'
        )}
      >
        <AlertDialogHeader className="shrink-0 space-y-2 border-b border-border px-4 pb-3 pt-4 text-left sm:px-6 sm:pt-5">
          <AlertDialogTitle className="pr-2 text-base sm:text-lg">
            {showApproval
              ? approvalCopy.title
              : aiProposal
                ? 'Review AI restore proposal'
                : 'Restore this agent turn?'}
          </AlertDialogTitle>
          <RestoreRiskHint />
        </AlertDialogHeader>

        <AlertDialogDescription asChild>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 text-sm text-muted-foreground sm:px-6">
            {checkpoint?.userMessagePreview && (
              <p className="break-words font-medium text-foreground">
                “{checkpoint.userMessagePreview}”
              </p>
            )}

            {showApproval && (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground">
                {approvalCopy.body}
              </p>
            )}

            {showApproval && pendingApproval === 'applyAi' && (
              <p className="text-xs text-amber-800 dark:text-amber-200">
                AI-assisted merges are best-effort. Spot-check generated file
                contents before relying on them.
              </p>
            )}

            {analysisLoading && !showApproval && (
              <p className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking for overlapping edits…
              </p>
            )}

            {!analysisLoading &&
              restoreAnalysis &&
              !aiProposal &&
              !showApproval && (
                <>
                  <p>
                    Turn touched{' '}
                    <span className="font-medium text-foreground">
                      {restoreAnalysis.turnPaths.length}
                    </span>{' '}
                    file(s):{' '}
                    <span className="text-green-600 dark:text-green-400">
                      {restoreAnalysis.cleanCount} clean
                    </span>
                    {restoreAnalysis.conflictCount > 0 && (
                      <>
                        ,{' '}
                        <span className="text-amber-600 dark:text-amber-400">
                          {restoreAnalysis.conflictCount} conflicted
                        </span>
                      </>
                    )}
                    .
                  </p>
                  {restoreAnalysis.overlappingSessionIds.length > 0 && (
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                      Other session(s) also edited overlapping files in this
                      worktree. Prefer clean-only or AI-assisted restore instead
                      of full worktree restore.
                    </p>
                  )}
                  {restoreAnalysis.paths.length > 0 && (
                    <ul className="max-h-[min(12rem,30vh)] space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs sm:max-h-40">
                      {restoreAnalysis.paths.map(p => (
                        <li
                          key={p.path}
                          className="flex items-start justify-between gap-2"
                        >
                          <span className="min-w-0 flex-1 break-all font-mono">
                            {p.path}
                          </span>
                          <span
                            className={cn(
                              'shrink-0',
                              p.status === 'clean'
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-amber-600 dark:text-amber-400'
                            )}
                          >
                            {pathStatusLabel(p.status)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs">
                    Choose a restore mode, then{' '}
                    <strong className="text-foreground">Approve</strong> before
                    any files are changed.
                  </p>
                </>
              )}

            {aiProposal && !showApproval && (
              <>
                {aiProposal.summary && (
                  <p className="text-foreground">{aiProposal.summary}</p>
                )}
                {aiProposal.cleanPaths.length > 0 && (
                  <p className="text-xs">
                    Will also restore{' '}
                    <span className="font-medium text-foreground">
                      {aiProposal.cleanPaths.length}
                    </span>{' '}
                    clean file(s) deterministically.
                  </p>
                )}
                {aiProposal.files.length > 0 ? (
                  <ul className="max-h-[min(14rem,35vh)] space-y-2 overflow-y-auto rounded-md border border-border p-2 text-xs sm:max-h-48">
                    {aiProposal.files.map(f => (
                      <li
                        key={f.path}
                        className="flex items-start gap-2 border-b border-border/40 pb-2 last:border-0 last:pb-0"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0"
                          checked={selectedProposalPaths.has(f.path)}
                          disabled={f.action === 'skip'}
                          onChange={() => toggleProposalPath(f.path)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 break-all font-mono">
                              {f.path}
                            </span>
                            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] uppercase">
                              {f.action}
                            </span>
                          </div>
                          {f.reason && (
                            <p className="mt-0.5 text-muted-foreground">
                              {f.reason}
                            </p>
                          )}
                          {f.action === 'write' && f.content != null && (
                            <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted/50 p-1 font-mono text-[10px] leading-snug">
                              {f.content.slice(0, 800)}
                              {f.content.length > 800 ? '…' : ''}
                            </pre>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs">No AI file proposals.</p>
                )}
                <p className="text-xs">
                  Select paths, then request approval. Nothing is written until
                  you approve.
                </p>
              </>
            )}
          </div>
        </AlertDialogDescription>

        <AlertDialogFooter
          className={cn(
            'shrink-0 flex-col gap-2 border-t border-border bg-background px-4 py-3 sm:flex-col sm:space-x-0 sm:px-6 sm:py-4',
            'pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4'
          )}
        >
          {showApproval ? (
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <AlertDialogCancel
                disabled={restoring}
                className="m-0 w-full sm:w-auto"
                onClick={e => {
                  e.preventDefault()
                  setPendingApproval(null)
                }}
              >
                Back
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={e => {
                  e.preventDefault()
                  void executeApprovedRestore()
                }}
                disabled={restoring}
                className={cn(
                  'm-0 w-full sm:w-auto',
                  approvalCopy.destructive
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : undefined
                )}
              >
                {restoring ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Restoring…
                  </>
                ) : (
                  approvalCopy.confirmLabel
                )}
              </AlertDialogAction>
            </div>
          ) : aiProposal ? (
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <AlertDialogCancel
                disabled={restoring || proposing}
                className="m-0 w-full sm:w-auto"
                onClick={e => {
                  e.preventDefault()
                  setAiProposal(null)
                  setSelectedProposalPaths(new Set())
                  setPendingApproval(null)
                }}
              >
                Back
              </AlertDialogCancel>
              <Button
                size="sm"
                className="w-full sm:w-auto"
                disabled={
                  restoring ||
                  proposing ||
                  (selectedAiCount === 0 &&
                    aiProposal.cleanPaths.length === 0)
                }
                onClick={() => setPendingApproval('applyAi')}
              >
                Request approval…
              </Button>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-2">
              <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <AlertDialogCancel
                  disabled={restoring || proposing}
                  className="m-0 w-full sm:w-auto"
                >
                  Cancel
                </AlertDialogCancel>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full sm:w-auto"
                  disabled={
                    restoring ||
                    proposing ||
                    analysisLoading ||
                    !restoreAnalysis ||
                    restoreAnalysis.cleanCount === 0
                  }
                  onClick={() => setPendingApproval('cleanOnly')}
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />
                  Restore clean only
                  {restoreAnalysis ? ` (${restoreAnalysis.cleanCount})` : ''}
                </Button>
                <Button
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={
                    restoring ||
                    proposing ||
                    analysisLoading ||
                    !restoreAnalysis ||
                    restoreAnalysis.conflictCount === 0
                  }
                  onClick={() => void handleProposeAiRestore()}
                >
                  {proposing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-3.5 w-3.5" />
                  )}
                  AI-assisted…
                </Button>
              </div>
              <div className="flex w-full flex-col gap-2 border-t border-border pt-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={
                    restoring ||
                    proposing ||
                    analysisLoading ||
                    !restoreAnalysis ||
                    restoreAnalysis.turnPaths.length === 0
                  }
                  onClick={() => setPendingApproval('allTurnFiles')}
                >
                  Force restore all turn files
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-destructive hover:text-destructive sm:w-auto"
                  disabled={restoring || proposing || analysisLoading}
                  onClick={() => setPendingApproval('full')}
                >
                  Full worktree restore…
                </Button>
              </div>
            </div>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
