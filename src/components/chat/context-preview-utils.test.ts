import { describe, expect, it } from 'vitest'
import { getLinkedPrContextPreviewExclusion } from './context-preview-utils'

describe('getLinkedPrContextPreviewExclusion', () => {
  it('hides the worktree linked PR context even when the worktree came from another context type', () => {
    expect(
      getLinkedPrContextPreviewExclusion({ pr_number: 9249, issue_number: 123 })
    ).toBe(9249)
    expect(
      getLinkedPrContextPreviewExclusion({
        pr_number: 9250,
        security_alert_number: 12,
      })
    ).toBe(9250)
    expect(
      getLinkedPrContextPreviewExclusion({
        pr_number: 9251,
        advisory_ghsa_id: 'GHSA-abcd-1234',
      })
    ).toBe(9251)
    expect(
      getLinkedPrContextPreviewExclusion({
        pr_number: 9252,
        linear_issue_identifier: 'ENG-123',
      })
    ).toBe(9252)
  })

  it('does not exclude PR contexts when there is no linked worktree PR', () => {
    expect(getLinkedPrContextPreviewExclusion({ issue_number: 123 })).toBeNull()
    expect(getLinkedPrContextPreviewExclusion(null)).toBeNull()
  })
})
