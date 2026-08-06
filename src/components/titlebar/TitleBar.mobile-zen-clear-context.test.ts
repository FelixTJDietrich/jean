import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TitleBar mobile zen clear context', () => {
  it('places an icon-only clear context action beside the zen action', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/titlebar/TitleBar.tsx'),
      'utf8'
    )

    expect(source).toMatch(
      /data-testid="toggle-zen-mode"[\s\S]*data-testid="clear-session-context"/
    )
    expect(source).toContain(
      "window.dispatchEvent(new CustomEvent('clear-session-context'))"
    )
    expect(source).toContain('aria-label="Clear context"')
  })
})
