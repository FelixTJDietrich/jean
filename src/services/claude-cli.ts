/**
 * Claude CLI management service
 *
 * Provides TanStack Query hooks for checking, installing, and managing
 * the embedded Claude CLI binary.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke, useWsConnectionStatus } from '@/lib/transport'
import { listen } from '@/lib/transport'
import { toast } from 'sonner'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type {
  ClaudeCliStatus,
  ClaudeAuthStatus,
  ReleaseInfo,
  InstallProgress,
  ClaudeUsageSnapshot,
  ClaudeAccountSummary,
  ClaudeAccountsState,
} from '@/types/claude-cli'

import { hasBackendTransport } from '@/lib/environment'

const isTauri = hasBackendTransport
const USAGE_REFRESH_MS = 1000 * 60 * 5

// Query keys for Claude CLI.
// NOTE: every key nests under `['claude-cli', ...]` so a coarse
// `invalidateQueries(['claude-cli'])` reliably refreshes everything
// claude-related. The websocket cache-invalidate listener in
// `src/hooks/useMainWindowEventListeners.ts` must stay in sync with this.
export const claudeCliQueryKeys = {
  all: ['claude-cli'] as const,
  status: () => [...claudeCliQueryKeys.all, 'status'] as const,
  auth: () => [...claudeCliQueryKeys.all, 'auth'] as const,
  usage: () => [...claudeCliQueryKeys.all, 'usage'] as const,
  versions: () => [...claudeCliQueryKeys.all, 'versions'] as const,
  accounts: () => [...claudeCliQueryKeys.all, 'accounts'] as const,
}

/**
 * Hook to detect Claude CLI in system PATH
 */
export function useClaudePathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...claudeCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      package_manager: string | null
    }> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
      try {
        const result = await invoke<{
          found: boolean
          path: string | null
          version: string | null
          package_manager: string | null
        }>('detect_claude_in_path')
        console.debug('[ONBOARDING:SVC] claude path detection:', result)
        return result
      } catch (err) {
        console.debug('[ONBOARDING:SVC] claude path detection failed:', err)
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30, // 30 min cache
    gcTime: 1000 * 60 * 60,
  })
}

function getUsageStaleTime(snapshot?: ClaudeUsageSnapshot): number {
  if (!snapshot?.fetchedAt) return 0
  const expiresAtMs = snapshot.fetchedAt * 1000 + USAGE_REFRESH_MS
  return Math.max(0, expiresAtMs - Date.now())
}

function getUsageRefetchInterval(snapshot?: ClaudeUsageSnapshot): number {
  if (!snapshot?.fetchedAt) return USAGE_REFRESH_MS
  const expiresAtMs = snapshot.fetchedAt * 1000 + USAGE_REFRESH_MS
  return Math.max(1_000, expiresAtMs - Date.now())
}

/**
 * Hook to check if Claude CLI is installed and get its status
 */
export function useClaudeCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: claudeCliQueryKeys.status(),
    queryFn: async (): Promise<ClaudeCliStatus> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning mock CLI status')
        return {
          installed: false,
          version: null,
          path: null,
          supports_auth_command: false,
        }
      }

      try {
        console.debug('[ONBOARDING:SVC] claude: checking installed status...')
        const status = await invoke<ClaudeCliStatus>(
          'check_claude_cli_installed'
        )
        console.debug('[ONBOARDING:SVC] claude: status =', status)
        return status
      } catch (error) {
        logger.error('Failed to check Claude CLI status', { error })
        return {
          installed: false,
          version: null,
          path: null,
          supports_auth_command: false,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to check if Claude CLI is authenticated
 */
export function useClaudeCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: claudeCliQueryKeys.auth(),
    queryFn: async (): Promise<ClaudeAuthStatus> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning mock auth status')
        return { authenticated: false, error: 'Not in Tauri context' }
      }

      try {
        console.debug('[ONBOARDING:SVC] claude: checking auth status...')
        const status = await invoke<ClaudeAuthStatus>('check_claude_cli_auth')
        console.debug('[ONBOARDING:SVC] claude: auth =', status)
        return status
      } catch (error) {
        logger.error('Failed to check Claude CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Hook to fetch current Claude usage.
 */
export function useClaudeUsage(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: claudeCliQueryKeys.usage(),
    queryFn: async (): Promise<ClaudeUsageSnapshot> => {
      if (!isTauri()) {
        throw new Error('Claude usage is only available in Tauri context')
      }
      return invoke<ClaudeUsageSnapshot>('get_claude_usage')
    },
    enabled: options?.enabled ?? true,
    staleTime: query => getUsageStaleTime(query.state.data),
    gcTime: 1000 * 60 * 10,
    refetchInterval: query => getUsageRefetchInterval(query.state.data),
  })
}

/**
 * Hook to fetch available Claude CLI versions from GitHub
 */
export function useAvailableCliVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: claudeCliQueryKeys.versions(),
    queryFn: async (): Promise<ReleaseInfo[]> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning empty versions list')
        return []
      }

      try {
        logger.debug('Fetching available Claude CLI versions')
        // Transform snake_case from Rust to camelCase
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_cli_versions')

        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch CLI versions', { error })
        throw error
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes to avoid rate limiting
    gcTime: 1000 * 60 * 30, // 30 minutes
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to install Claude CLI
 */
export function useInstallClaudeCli() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (version?: string) => {
      logger.info('Installing Claude CLI', { version })
      await invoke('install_claude_cli', { version: version ?? null })
    },
    // Disable retry - installation should not be retried automatically
    retry: false,
    onSuccess: () => {
      // Invalidate status to refetch
      queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.status() })
      logger.info('Claude CLI installed successfully')
      toast.success('Claude CLI installed successfully')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to install Claude CLI', { error })
      toast.error('Failed to install Claude CLI', { description: message })
    },
  })
}

/**
 * Hook to listen for installation progress events
 * Returns [progress, resetProgress] tuple to allow resetting state before new install
 */
export function useInstallProgress(): [InstallProgress | null, () => void] {
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const wsConnected = useWsConnectionStatus()

  const resetProgress = useCallback(() => {
    setProgress(null)
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let unlistenFn: (() => void) | null = null
    const listenerId = Math.random().toString(36).substring(7)

    const setupListener = async () => {
      try {
        logger.info('[useInstallProgress] Setting up listener', { listenerId })
        unlistenFn = await listen<InstallProgress>(
          'claude-cli:install-progress',
          event => {
            logger.info('[useInstallProgress] Received progress event', {
              listenerId,
              stage: event.payload.stage,
              message: event.payload.message,
              percent: event.payload.percent,
            })
            setProgress(event.payload)
          }
        )
      } catch (error) {
        logger.error('[useInstallProgress] Failed to setup listener', {
          listenerId,
          error,
        })
      }
    }

    setupListener()

    return () => {
      logger.info('[useInstallProgress] Cleaning up listener', { listenerId })
      if (unlistenFn) {
        unlistenFn()
      }
    }
  }, [wsConnected])

  return [progress, resetProgress]
}

/**
 * Combined hook for CLI setup flow
 */
function checkManualVersion(version: string) {
  return invoke<boolean>('check_claude_cli_version_exists', { version })
}

export function useClaudeCliSetup() {
  const status = useClaudeCliStatus()
  const versions = useAvailableCliVersions()
  const installMutation = useInstallClaudeCli()
  const [progress, resetProgress] = useInstallProgress()

  const needsSetup = !status.isLoading && !status.data?.installed

  // Wrapper to support install with options (e.g., onSuccess callback)
  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    logger.info('[useClaudeCliSetup] install() called', {
      version,
      isPending: installMutation.isPending,
    })

    // Reset progress before starting new installation to prevent stale state
    resetProgress()

    logger.info('[useClaudeCliSetup] Calling installMutation.mutate()', {
      version,
    })
    installMutation.mutate(version, {
      onSuccess: () => {
        logger.info('[useClaudeCliSetup] mutate onSuccess callback')
        options?.onSuccess?.()
      },
      onError: error => {
        logger.error('[useClaudeCliSetup] mutate onError callback', { error })
        options?.onError?.(error)
      },
    })
  }


  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data ?? [],
    isVersionsLoading: versions.isFetching,
    isVersionsError: versions.isError,
    refetchVersions: versions.refetch,
    needsSetup,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress,
    install,
    checkManualVersion,
    refetchStatus: status.refetch,
  }
}

// =============================================================================
// Claude account profiles (personal / work / etc.)
// =============================================================================

const EMPTY_ACCOUNTS_STATE: ClaudeAccountsState = {
  accounts: [],
  activeAccountId: null,
}

/**
 * Fetch the list of named Claude accounts + which one is active.
 *
 * In non-Tauri (web browser) contexts the backend isn't reachable; return
 * an empty list so UI renders as "no accounts" and doesn't crash.
 */
export function useClaudeAccounts(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: claudeCliQueryKeys.accounts(),
    queryFn: async (): Promise<ClaudeAccountsState> => {
      if (!isTauri()) return EMPTY_ACCOUNTS_STATE
      try {
        return await invoke<ClaudeAccountsState>('list_claude_accounts')
      } catch (error) {
        logger.error('Failed to list Claude accounts', { error })
        return EMPTY_ACCOUNTS_STATE
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
  })
}

/**
 * Which queries depend on the active Claude account. `auth` and `usage` are
 * per-account, so switching invalidates them too; rename/delete/create do
 * not need to touch them.
 */
function invalidateSwitchDependents(
  queryClient: ReturnType<typeof useQueryClient>
) {
  queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.accounts() })
  queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.auth() })
  queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.usage() })
}

function invalidateAccountList(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.accounts() })
}

/**
 * Create a new named Claude subscription profile.
 *
 * The backend scaffolds `<app_data>/claude-accounts/<uuid>/` with symlinks
 * back into `~/.claude/` and appends to `preferences.claude_accounts`.
 * The account starts *without* credentials — the caller is expected to
 * chain into the login-hint dialog that surfaces the `claude /login`
 * shell command.
 *
 * Invalidates: `['claude-cli', 'accounts']`.
 * Errors: surfaced via `toast.error`.
 */
export function useCreateClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; color: string }) => {
      return invoke<ClaudeAccountSummary>('create_claude_account', input)
    },
    retry: false,
    onSuccess: account => {
      invalidateAccountList(queryClient)
      toast.success(`Created "${account.name}"`)
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to create account', { description: message })
    },
  })
}

/**
 * Delete a named Claude account: removes it from preferences AND deletes
 * the on-disk `<app_data>/claude-accounts/<id>/` directory (including the
 * per-account `.credentials.json`; shared `~/.claude/` symlinks are
 * removed as entries without following them).
 *
 * Refused server-side while any Claude session is running — running
 * subprocesses may still hold the dir via `CLAUDE_CONFIG_DIR`.
 *
 * Invalidates: `['claude-cli', 'accounts'/'auth'/'usage']` (delete may
 * un-set the active account, which affects auth + usage).
 */
export function useDeleteClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await invoke('delete_claude_account', { id })
    },
    retry: false,
    onSuccess: () => {
      // Delete can un-set the active account server-side, so auth/usage
      // also need to refetch (mirror of the "switch" invalidation set).
      invalidateSwitchDependents(queryClient)
      toast.success('Account removed')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to remove account', { description: message })
    },
  })
}

/**
 * Switch the active Claude account. Passing `null` clears the selection
 * and falls back to the plain `~/.claude/` directory.
 *
 * This mutation does NOT optimistically update the cache. Two rapid
 * clicks on different accounts would each snapshot "previous" into their
 * own context, and an error on the second would restore to the stale
 * first-click snapshot rather than the true pre-mutation state. The
 * backend call is a single file write, so the round-trip latency is
 * small enough that a direct invalidate-on-settle is simpler and correct.
 */
export function useSetActiveClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string | null) => {
      await invoke('set_active_claude_account', { id })
    },
    retry: false,
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to switch account', { description: message })
    },
    onSettled: () => {
      invalidateSwitchDependents(queryClient)
    },
  })
}

/**
 * Rename and/or re-color a Claude account. Name must be unique
 * (case-insensitive) across active accounts; omitting `color` leaves it
 * unchanged.
 *
 * Invalidates: `['claude-cli', 'accounts']`.
 */
export function useRenameClaudeAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      name: string
      color?: string
    }) => {
      return invoke<ClaudeAccountSummary>('rename_claude_account', input)
    },
    retry: false,
    onSuccess: () => {
      invalidateAccountList(queryClient)
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to update account', { description: message })
    },
  })
}

/**
 * Returns the shell command the user should paste into their terminal to
 * log in as this account (`CLAUDE_CONFIG_DIR=/... claude /login`). We don't
 * spawn it ourselves because `/login` opens a browser OAuth flow and is
 * cleaner to run interactively.
 */
export async function getClaudeAccountLoginCommand(id: string): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      'Account login is only available when Jean is running as a desktop app.'
    )
  }
  return invoke<string>('get_claude_account_login_command', { id })
}
