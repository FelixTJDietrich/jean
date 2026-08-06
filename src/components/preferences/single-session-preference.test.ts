import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPreferences } from '@/types/preferences'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('single session per worktree preference', () => {
  it('is disabled by default', () => {
    expect(defaultPreferences.single_session_per_worktree).toBe(false)
  })

  it('groups single-session and combined sync toggles under Experimental', () => {
    const experimental = readSource(
      'src/components/preferences/panes/ExperimentalPane.tsx'
    )
    const general = readSource('src/components/preferences/panes/GeneralPane.tsx')

    expect(experimental).toContain('Single session per worktree')
    expect(experimental).toContain('single_session_per_worktree: checked')
    expect(experimental).toContain('Combined git sync button')
    expect(experimental).toContain('git_sync_button: checked')
    expect(general).not.toContain('Single session per worktree')
    expect(general).not.toContain('Combined git sync button')
  })
})
