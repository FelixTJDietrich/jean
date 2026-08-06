import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/components/chat/ChatWindow.tsx'),
  'utf8'
)

describe('ChatWindow zen composer', () => {
  it('places the action toolbar beside the textarea', () => {
    expect(source).toContain("'flex max-h-16 items-center overflow-hidden'")
    expect(source).toContain("zenMode && 'min-w-0 flex-1'")
    expect(source).toContain('{zenMode ? (')
    expect(source).toContain('<SendCancelButton')
  })
})
