import { isNativeApp } from '@/lib/environment'

const MOBILE_WEB_MAX_WIDTH = 768

function userAgentMatchesMobileWeb(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iP(ad|hone|od)|Android/i.test(navigator.userAgent)
}

function viewportMatchesMobileWeb(): boolean {
  if (typeof window === 'undefined') return false
  if (window.innerWidth > 0 && window.innerWidth < MOBILE_WEB_MAX_WIDTH) {
    return true
  }
  return window.matchMedia?.(`(max-width: ${MOBILE_WEB_MAX_WIDTH - 1}px)`)
    .matches
}

export function isMobileWebSafeMode(): boolean {
  if (isNativeApp()) return false
  if (typeof window === 'undefined') return false
  return userAgentMatchesMobileWeb() || viewportMatchesMobileWeb()
}
