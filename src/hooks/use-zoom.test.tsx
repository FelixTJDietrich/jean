import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPreferences: { zoom_level?: number } | undefined
let mockIsNativeApp = false
const mockSetZoom = vi.fn()

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mockPreferences }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => mockIsNativeApp,
}))

vi.mock('@/lib/platform', () => ({
  isMacOS: true,
  getServerPlatform: vi.fn(() => 'mac'),
  isServerWindows: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: mockSetZoom }),
}))

import { useZoom } from './use-zoom'

describe('useZoom', () => {
  beforeEach(() => {
    mockPreferences = { zoom_level: 125 }
    mockIsNativeApp = false
    mockSetZoom.mockReset()
    document.documentElement.style.zoom = ''
    document.documentElement.style.fontSize = ''
    document.documentElement.style.removeProperty('--app-zoom')
  })

  afterEach(() => {
    document.documentElement.style.zoom = ''
    document.documentElement.style.fontSize = ''
    document.documentElement.style.removeProperty('--app-zoom')
  })

  it('applies layout-safe zoom in headless web clients', async () => {
    document.documentElement.style.zoom = '1.5'

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe(
        '1.25'
      )
    })
    expect(document.documentElement.style.fontSize).toBe('20px')
    expect(document.documentElement.style.zoom).toBe('')
    expect(mockSetZoom).not.toHaveBeenCalled()
  })

  it('uses native webview zoom in the desktop app', async () => {
    mockIsNativeApp = true

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1.25)
    })
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe(
      ''
    )
    expect(document.documentElement.style.fontSize).toBe('')
  })
})
