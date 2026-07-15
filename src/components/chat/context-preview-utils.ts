interface WorktreeContextPreviewFields {
  pr_number?: number | null
  issue_number?: number | null
  security_alert_number?: number | null
  advisory_ghsa_id?: string | null
  linear_issue_identifier?: string | null
}

export function getLinkedPrContextPreviewExclusion(
  worktree: WorktreeContextPreviewFields | null | undefined
): number | null {
  return worktree?.pr_number ?? null
}
