# Claude account profiles

Jean supports multiple named Claude subscription profiles ("Personal" /
"Work" / …) on a single machine. Each profile owns an isolated
`CLAUDE_CONFIG_DIR` so that OAuth credentials for two subscriptions never
collide, while transcripts and shared state stay in one place so
`claude --resume <session-id>` keeps working after switching accounts
mid-session.

## Why this design

**The constraint.** `claude /login` writes `.credentials.json` into
`$CLAUDE_CONFIG_DIR` (defaults to `~/.claude/`). Two subscriptions on the
same machine would otherwise overwrite each other's tokens.

**The alternatives we rejected.**

- `CLAUDE_CODE_OAUTH_TOKEN` env var alone. Experimentally verified (v2.1.119):
  the CLI silently falls back to disk `.credentials.json` on `401`, so a
  misconfigured env var can bill the wrong subscription. Not safe as the
  *only* mechanism.
- Per-account `$HOME`. Overrides too much (git config, ssh, shell rc) and
  breaks subprocess interactions outside the Claude CLI.
- Swapping `.credentials.json` in place before every spawn. Racy with
  concurrent spawns and with the CLI's own token refresh.

**The choice.** Per-account `<app_data>/claude-accounts/<uuid>/` as the
`CLAUDE_CONFIG_DIR`, with symlinks back into `~/.claude/` for shared
state. `.credentials.json` is the only per-account real file.

## Disk layout

```
<app_data_dir>/claude-accounts/
  <uuid-1>/
    .credentials.json       ← real file, written by `claude /login`
    projects     → ~/.claude/projects        (shared)
    settings.json → ~/.claude/settings.json  (shared)
    plugins      → ~/.claude/plugins         (shared)
    skills       → ~/.claude/skills          (shared)
    …everything in SHARED_CLAUDE_ITEMS
  <uuid-2>/
    …
```

The shared items list lives in
[`src-tauri/src/claude_cli/accounts.rs`](../../src-tauri/src/claude_cli/accounts.rs)
as `SHARED_CLAUDE_ITEMS`. The critical invariant is: **`.credentials.json`
is the only thing that must NOT be shared** — everything else is fair game.

On macOS, the Keychain service `Claude Code-credentials` is bypassed when
an account is active; see `keychain_allowed()` in
`src-tauri/src/claude_cli/commands.rs`.

## The single choke point for Claude spawns

Every non-UI Claude subprocess spawned by Jean MUST go through
`crate::claude_cli::spawn_claude_command(app)` in
`src-tauri/src/claude_cli/config.rs`. This helper:

1. Resolves the embedded CLI binary (errors if missing).
2. Calls `resolve_active_config_dir(app)`, which returns:
   - `Ok(ActiveConfigDir::Default)` → no env var set (use `~/.claude/`).
   - `Ok(ActiveConfigDir::Account(dir))` → injects `CLAUDE_CONFIG_DIR=dir`.
   - `Err(msg)` → active account is configured but its dir is missing or
     the id is stale. **Spawning is refused**; callers propagate the error
     to the user. Silently falling back to `~/.claude/` would bill the
     wrong subscription.
3. Returns a `std::process::Command` via `silent_command()` so the caller
   can add args/stdio/cwd.

Direct `silent_command(&resolve_cli_binary(app))` for Claude is forbidden
— it bypasses the account env-var injection. One-shot spawns (naming,
summarization, commit-message generation, PR content, code review,
release notes, MCP health) all use the helper; see the callers in
`src-tauri/src/chat/naming.rs`, `src-tauri/src/chat/commands.rs`, and
`src-tauri/src/projects/commands.rs`.

For the long-running detached chat spawn, env var injection happens
inside `build_claude_args()` via the same `resolve_active_config_dir()`
call.

## Preferences schema

Two fields on `AppPreferences`:

```rust
pub claude_accounts: Vec<ClaudeAccount>,
pub active_claude_account_id: Option<String>,
```

`ClaudeAccount` itself is persisted as snake_case (Pattern A in
`CLAUDE.md`). The runtime `ClaudeAccountSummary` returned by
`list_claude_accounts` adds `has_credentials` + `config_dir` and is
wire-serialized camelCase (Pattern B).

## Atomicity and concurrency

**Preferences writes** go through `accounts::mutate_preferences()`. It:

- Serializes every mutation through a process-wide `Mutex<()>` so two
  concurrent `create_claude_account` calls cannot lost-update each other.
- Re-reads prefs from disk inside the critical section so the mutator
  sees the latest state.
- Writes to a unique tmp file in the same directory, `fsync`s, then
  renames atomically.
- Mirrors the `settings_json` stripping that `save_preferences` does so
  the "file is source of truth" invariant holds.

**Credential writes** (`persist_claude_credentials`) use the same
tmp-file + fsync + rename pattern, with `0600` perms on Unix. A partial
write here forces the user to re-run `claude /login`, so durability
matters.

**Delete guard**: `delete_claude_account` refuses while any Claude session
is running (via `crate::chat::registry::get_running_sessions()`). The
check is inside the mutation-lock critical section to close the TOCTOU
against a concurrent `set_active_claude_account`.

## Security invariants

- `validate_account_id` restricts account IDs to `[0-9a-f-]{1,64}` (UUID
  shape) before any path join, preventing traversal via account id.
- `validate_name` / `validate_color` canonicalize user input before disk
  scaffolding; both commands (create, rename) funnel through the same
  helpers.
- `build_login_command` emits POSIX-shell-escaped output on Unix and
  PowerShell-escaped output on Windows. Callers use it strictly as a
  copy-to-clipboard hint — Jean never `exec`s this string itself.
- On macOS, when an account is active, the Keychain path is bypassed to
  prevent Keychain-vs-per-account-file confusion (the Keychain entry is
  per-user, not per-profile).

## Extending to other backends

When this pattern is extended to Codex / OpenCode / gh / Linear (see
issue #165), lift the common shape into a shared `provider_accounts`
module and parametrize on a small trait:

```rust
trait ProviderAccountBackend {
    fn config_dir_env_var(&self) -> &'static str;        // e.g. "CLAUDE_CONFIG_DIR"
    fn credentials_filename(&self) -> &'static str;      // e.g. ".credentials.json"
    fn shared_items(&self) -> &'static [&'static str];   // "projects", "settings.json", …
    fn login_command_template(&self, …) -> String;       // for the hint dialog
    fn keychain_service(&self) -> Option<&'static str>;  // None on Linux/Windows
}
```

Preferences should then nest under a single `providers:
HashMap<ProviderId, ProviderAccountsBlock>` field rather than adding flat
`codex_accounts` / `opencode_accounts` siblings.

## Testing

Unit tests in `src-tauri/src/claude_cli/accounts.rs` cover validators and
the Windows PowerShell quoter. Integration coverage for
`resolve_active_config_dir`'s refuse-silent-fallback invariant is the
single most important behavior to exercise when adding related features
— it's the invariant that prevents billing the wrong subscription.
