//! Named Claude subscription profiles ("accounts").
//!
//! Each account owns an isolated `CLAUDE_CONFIG_DIR` under
//! `<app_data>/claude-accounts/<id>/`. The directory contains:
//!
//! * `.credentials.json` — a **real file** written by `claude /login` when
//!   run against this account's config dir. Each account has independent
//!   OAuth tokens here.
//! * symlinks back into `~/.claude/` for everything that should be shared
//!   across accounts (`projects/`, `todos/`, `plugins/`, `skills/`,
//!   `commands/`, `agents/`, `settings.json`, `settings.local.json`,
//!   `history.jsonl`). This keeps transcripts in one place so that
//!   `--resume <session-id>` works after switching accounts mid-session.
//!
//! When no account is active, Jean spawns `claude` with no
//! `CLAUDE_CONFIG_DIR`, preserving the pre-profile behavior exactly.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{load_preferences_sync, AppPreferences, ClaudeAccount};

/// Serializes all preferences mutations so that concurrent account CRUD
/// cannot lost-update each other (two `create_claude_account` calls racing
/// would otherwise both read empty prefs and clobber each other on write,
/// orphaning one account dir). This is coarser than strictly necessary but
/// prefs writes are rare.
fn prefs_mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Subdirectory under `app_data_dir()` that holds per-account config dirs.
pub const ACCOUNTS_DIR_NAME: &str = "claude-accounts";

/// Items under `~/.claude/` that should be shared across accounts
/// (transcripts, user skills, global settings, installed plugins, etc.).
/// `.credentials.json` is *intentionally* not in this list — that's the
/// whole point of having separate accounts.
const SHARED_CLAUDE_ITEMS: &[&str] = &[
    "projects",
    "todos",
    "plugins",
    "skills",
    "commands",
    "agents",
    "plans",
    "shell-snapshots",
    "history.jsonl",
    "settings.json",
    "settings.local.json",
    "CLAUDE.md",
];

// =============================================================================
// Path helpers
// =============================================================================

pub fn get_accounts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(app_data_dir.join(ACCOUNTS_DIR_NAME))
}

pub fn get_account_config_dir(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    validate_account_id(account_id)?;
    Ok(get_accounts_dir(app)?.join(account_id))
}

/// Result of resolving which `CLAUDE_CONFIG_DIR` to use for a Claude spawn.
#[derive(Debug, Clone)]
pub enum ActiveConfigDir {
    /// No account is selected; use the plain `~/.claude/` dir.
    Default,
    /// An account is selected and its config dir is ready.
    Account(PathBuf),
}

/// Resolve which `CLAUDE_CONFIG_DIR` should be used right now.
///
/// Returns `Err` when an account is *configured* but its dir is missing or
/// the account is unknown. We refuse to fall back to `~/.claude/` in that
/// case: silently using the shared dir would bill the wrong subscription.
/// Callers should surface the error to the user instead of spawning Claude.
///
/// When preferences themselves cannot be read (fresh install, corrupted
/// file), we treat it as "no account selected" — the app should boot even
/// if prefs are unrecoverable.
pub fn resolve_active_config_dir(app: &AppHandle) -> Result<ActiveConfigDir, String> {
    let prefs = match load_preferences_sync(app) {
        Ok(p) => Some(p),
        Err(e) => {
            log::warn!("Could not read preferences while resolving Claude account ({e}); defaulting to ~/.claude/");
            None
        }
    };
    let accounts_dir = get_accounts_dir(app)?;
    resolve_from_prefs(prefs.as_ref(), &accounts_dir)
}

/// Pure core of `resolve_active_config_dir`: given preferences and the
/// accounts directory, compute which `CLAUDE_CONFIG_DIR` to use.
/// Split out so the decision logic can be unit-tested without needing a
/// real Tauri `AppHandle`.
///
/// `None` prefs → treated as "no account selected" (default).
fn resolve_from_prefs(
    prefs: Option<&AppPreferences>,
    accounts_dir: &Path,
) -> Result<ActiveConfigDir, String> {
    let Some(prefs) = prefs else {
        return Ok(ActiveConfigDir::Default);
    };
    let Some(active_id) = prefs.active_claude_account_id.as_ref() else {
        return Ok(ActiveConfigDir::Default);
    };
    if !prefs
        .claude_accounts
        .iter()
        .any(|a| &a.id == active_id)
    {
        return Err(format!(
            "Active Claude account '{active_id}' no longer exists. \
             Switch profile or create the account again."
        ));
    }
    validate_account_id(active_id)?;
    let dir = accounts_dir.join(active_id);
    if !dir.is_dir() {
        return Err(format!(
            "Claude account config dir is missing at {}. \
             Delete this account and re-create it, or restore the directory.",
            dir.display()
        ));
    }
    Ok(ActiveConfigDir::Account(dir))
}

/// Best-effort accessor for the active config dir that treats *any* problem
/// (missing dir, stale id, unreadable prefs) as "no account" and returns
/// `None`. Use this ONLY for display/read-only code paths where silently
/// falling back to the shared `~/.claude/` is acceptable. For anything that
/// spawns Claude or reads credentials, call `resolve_active_config_dir`.
pub fn get_active_account_config_dir(app: &AppHandle) -> Option<PathBuf> {
    match resolve_active_config_dir(app) {
        Ok(ActiveConfigDir::Account(dir)) => Some(dir),
        _ => None,
    }
}

// =============================================================================
// Validation
// =============================================================================

/// Account IDs are UUIDs generated by us on create. Strictly validate so
/// a tampered `preferences.json` cannot feed `get_account_config_dir` an
/// all-dash or otherwise degenerate string that still passes a loose
/// "hex + dashes" filter. We require exact UUID shape (RFC 4122 textual
/// representation).
fn validate_account_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| format!("Invalid account id: {id:?}"))
}

/// Validates and canonicalizes a user-supplied account name.
/// Public within the module so command-layer validation can funnel through
/// the same rules as on-disk scaffolding, preventing "validated twice with
/// different rules" drift.
pub(super) fn validate_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Account name cannot be empty".to_string());
    }
    if trimmed.chars().count() > 40 {
        return Err("Account name too long (max 40 characters)".to_string());
    }
    Ok(trimmed.to_string())
}

/// Validates and canonicalizes a hex color like `#3b82f6` or `abc`.
pub(super) fn validate_color(color: &str) -> Result<String, String> {
    // Accept "#rgb" / "#rrggbb" (case-insensitive).
    let s = color.trim();
    let hex = s.strip_prefix('#').unwrap_or(s);
    let ok = (hex.len() == 3 || hex.len() == 6)
        && hex.chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        return Err(format!("Invalid color '{color}'; expected hex like #3b82f6"));
    }
    let hex_lower = hex.to_lowercase();
    Ok(format!("#{hex_lower}"))
}

// =============================================================================
// Directory scaffolding
// =============================================================================

/// Create an account's config directory and populate it with symlinks to
/// shared `~/.claude/` items. Idempotent per item — existing symlinks are
/// left alone; existing real files/dirs cause an explicit error so we don't
/// silently shadow user data.
fn scaffold_account_dir(account_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(account_dir)
        .map_err(|e| format!("Failed to create {}: {e}", account_dir.display()))?;

    // 0700 on unix so credentials live under a private parent.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(account_dir)
            .map_err(|e| format!("Failed to stat account dir: {e}"))?
            .permissions();
        perms.set_mode(0o700);
        let _ = std::fs::set_permissions(account_dir, perms);
    }

    let Some(home) = dirs::home_dir() else {
        return Err("No home directory found; cannot set up Claude account".to_string());
    };
    let claude_home = home.join(".claude");

    for item in SHARED_CLAUDE_ITEMS {
        let source = claude_home.join(item);
        if !source.exists() {
            // Nothing to share yet; skip silently. If the user later creates
            // the item (e.g. first time running `claude`), we can re-scaffold.
            continue;
        }
        let target = account_dir.join(item);
        if let Err(e) = create_symlink_if_missing(&source, &target) {
            // Non-fatal: log and keep going so one unshareable item doesn't
            // break account creation entirely.
            log::warn!(
                "Could not symlink {} -> {}: {e}",
                target.display(),
                source.display()
            );
        }
    }
    Ok(())
}

fn create_symlink_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    // If target already exists as a symlink, assume it's ours; leave it.
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            return Ok(());
        }
        return Err(format!(
            "{} already exists and is not a symlink; refusing to overwrite",
            target.display()
        ));
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)
            .map_err(|e| format!("symlink failed: {e}"))
    }
    #[cfg(windows)]
    {
        let result = if source.is_dir() {
            std::os::windows::fs::symlink_dir(source, target)
        } else {
            std::os::windows::fs::symlink_file(source, target)
        };
        result.map_err(|e| {
            format!(
                "symlink failed: {e}. On Windows, enable Developer Mode \
                 or run as administrator to create symlinks."
            )
        })
    }
}

// =============================================================================
// Mutations (called from Tauri commands)
// =============================================================================

pub fn create_account_on_disk(
    app: &AppHandle,
    name: &str,
    color: &str,
) -> Result<ClaudeAccount, String> {
    let name = validate_name(name)?;
    let color = validate_color(color)?;

    let id = Uuid::new_v4().to_string();
    let dir = get_account_config_dir(app, &id)?;
    scaffold_account_dir(&dir)?;

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(ClaudeAccount {
        id,
        name,
        color,
        created_at,
    })
}

/// Delete the account's config directory.
///
/// Uses `remove_dir_all`, which on both Unix and Windows removes symlink
/// *entries* as-is rather than following them — so the shared
/// `~/.claude/projects/` etc. symlinked inside the account dir are safe.
/// `.credentials.json` is a real file and *is* deleted.
///
/// Path traversal via the account id is prevented by `validate_account_id`
/// (UUID-shape enforcement). The top-level dir itself is `symlink_metadata`-
/// checked below: if someone planted a symlink named `<uuid>` pointing at,
/// say, `$HOME`, `remove_dir_all` on its entries would happily nuke the
/// target even though the symlink entry itself is what we mean to delete.
/// Refusing to operate on a symlinked top closes that hole.
pub fn delete_account_on_disk(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let dir = get_account_config_dir(app, account_id)?;
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to delete {} because it is a symlink (not the real account dir).",
                    dir.display()
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(e) => {
            return Err(format!(
                "Failed to stat account dir {}: {e}",
                dir.display()
            ));
        }
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Failed to delete account dir {}: {e}", dir.display()))?;
    Ok(())
}

/// Construct a shell-safe `claude /login` command for the given account.
/// Returned as a string suitable for "copy to clipboard" + paste into a
/// terminal. We intentionally don't spawn this ourselves — `/login` opens
/// a browser OAuth flow and is cleaner in the user's own shell.
///
/// The returned string is platform-specific:
/// * Unix: `CLAUDE_CONFIG_DIR='...' '...' /login` (POSIX single-quoted).
/// * Windows: PowerShell form `$env:CLAUDE_CONFIG_DIR='...'; & '...' /login`.
///
/// We emit PowerShell on Windows because Terminal.app/PowerShell 7 is the
/// modern default and bash-style quoting (`'`) works on neither cmd.exe
/// nor PowerShell without translation.
pub fn build_login_command(
    app: &AppHandle,
    account_id: &str,
    claude_binary: &Path,
) -> Result<String, String> {
    let dir = get_account_config_dir(app, account_id)?;
    let dir_str = dir.to_string_lossy();
    let bin_str = claude_binary.to_string_lossy();

    #[cfg(unix)]
    {
        // Use the shared POSIX shell_escape helper so quoting rules cannot
        // drift between this helper and other shell-building code.
        use crate::platform::shell_escape;
        Ok(format!(
            "CLAUDE_CONFIG_DIR={} {} /login",
            shell_escape(&dir_str),
            shell_escape(&bin_str),
        ))
    }
    #[cfg(windows)]
    {
        Ok(format!(
            "$env:CLAUDE_CONFIG_DIR={}; & {} /login",
            powershell_single_quote(&dir_str),
            powershell_single_quote(&bin_str),
        ))
    }
}

/// PowerShell single-quoted-string literal escaping.
///
/// Inside a single-quoted PowerShell string, the ONLY metacharacter is the
/// single quote itself, which is escaped by doubling it (`''`). No
/// expansion happens — `$var`, backticks, and `;` are all literal.
/// <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules>
#[cfg(windows)]
fn powershell_single_quote(s: &str) -> String {
    let escaped = s.replace('\'', "''");
    format!("'{escaped}'")
}

/// Snapshot of an account's on-disk state used to build UI summaries.
///
/// We only expose fields the UI actually renders; add new ones as new UI
/// states are introduced. Keeping this narrow avoids "staleness forever"
/// bugs where the struct carries fields nothing reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct AccountHealth {
    /// `.credentials.json` exists inside the config dir (user has run
    /// `claude /login` at least once for this account).
    pub has_credentials: bool,
}

/// Stat the account's config dir to report its on-disk health. Never
/// errors — a broken or invalid account resolves to `AccountHealth::default()`
/// so the UI can render a "needs login / missing" state.
pub fn inspect_account(app: &AppHandle, account_id: &str) -> AccountHealth {
    let Ok(dir) = get_account_config_dir(app, account_id) else {
        return AccountHealth::default();
    };
    AccountHealth {
        has_credentials: dir.join(".credentials.json").is_file(),
    }
}

// =============================================================================
// Mutations through preferences (private helpers called by commands)
// =============================================================================

/// Convenience: mutate preferences and save atomically. Serializes across
/// all concurrent callers (see `prefs_mutation_lock`) and re-reads from
/// disk inside the critical section so callers cannot lose each other's
/// writes.
pub fn mutate_preferences<F>(app: &AppHandle, mutator: F) -> Result<AppPreferences, String>
where
    F: FnOnce(&mut AppPreferences) -> Result<(), String>,
{
    let _guard = prefs_mutation_lock()
        .lock()
        .map_err(|e| format!("Preferences mutation lock poisoned: {e}"))?;

    let mut prefs = load_preferences_sync(app)?;
    mutator(&mut prefs)?;

    // Strip transient CLI-profile fields the same way `save_preferences`
    // does — those live in sibling files on disk, not in preferences.json.
    // Without this, a round-trip through this helper would persist stale
    // in-memory contents and break the "file is source of truth" invariant.
    for profile in &mut prefs.custom_cli_profiles {
        profile.settings_json.clear();
        profile.file_path.clear();
    }

    let prefs_path = crate::get_preferences_path(app)?;
    let json = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {e}"))?;

    // Write to a unique tmp file in the same directory as the final file
    // (required for a rename to be atomic on the same filesystem), fsync,
    // then rename. Non-atomic writes can leave preferences.json half-
    // written on crash and orphan the account list.
    use std::io::Write as _;
    let tmp_suffix = Uuid::new_v4();
    let tmp = prefs_path.with_extension(format!("{tmp_suffix}.tmp"));
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create preferences tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write preferences tmp: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("Failed to fsync preferences tmp: {e}"))?;
    }
    std::fs::rename(&tmp, &prefs_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize preferences: {e}")
    })?;
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_account_ids() {
        // Canonical UUIDs pass.
        assert!(validate_account_id(&Uuid::new_v4().to_string()).is_ok());
        // Degenerate strings that a loose hex+dash filter would accept
        // must be rejected so prefs tampering can't build weird paths.
        assert!(validate_account_id("").is_err());
        assert!(validate_account_id("-").is_err());
        assert!(validate_account_id("---").is_err());
        assert!(validate_account_id("deadbeef").is_err()); // too short
        assert!(validate_account_id("../etc/passwd").is_err());
        assert!(validate_account_id("foo bar").is_err());
    }

    #[test]
    fn validates_color() {
        assert_eq!(validate_color("#3b82f6").unwrap(), "#3b82f6");
        assert_eq!(validate_color("#ABC").unwrap(), "#abc");
        assert_eq!(validate_color("3b82f6").unwrap(), "#3b82f6");
        assert!(validate_color("blue").is_err());
        assert!(validate_color("#ggg").is_err());
    }

    #[test]
    fn validates_name() {
        assert_eq!(validate_name("Personal").unwrap(), "Personal");
        assert_eq!(validate_name("  Work  ").unwrap(), "Work");
        assert!(validate_name("").is_err());
        assert!(validate_name(&"x".repeat(41)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn powershell_quoting_escapes_single_quotes() {
        assert_eq!(powershell_single_quote("simple"), "'simple'");
        assert_eq!(powershell_single_quote("C:\\Users\\a b"), "'C:\\Users\\a b'");
        // PowerShell doubles single quotes inside single-quoted strings.
        assert_eq!(powershell_single_quote("it's"), "'it''s'");
        // Dollar signs and backticks are literal inside single quotes.
        assert_eq!(powershell_single_quote("$env:X"), "'$env:X'");
    }

    /// Build a default-ish `AppPreferences` for resolver tests. We pull
    /// defaults via `AppPreferences::default()` rather than listing every
    /// field here so the test doesn't break on every unrelated prefs
    /// addition.
    fn test_prefs(
        accounts: Vec<ClaudeAccount>,
        active: Option<String>,
    ) -> AppPreferences {
        let mut prefs = AppPreferences::default();
        prefs.claude_accounts = accounts;
        prefs.active_claude_account_id = active;
        prefs
    }

    fn test_account(id: &str) -> ClaudeAccount {
        ClaudeAccount {
            id: id.to_string(),
            name: format!("acct-{id}"),
            color: "#3b82f6".to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn resolve_from_prefs_no_prefs_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let result = resolve_from_prefs(None, tmp.path()).unwrap();
        assert!(matches!(result, ActiveConfigDir::Default));
    }

    #[test]
    fn resolve_from_prefs_no_active_id_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let prefs = test_prefs(vec![], None);
        let result = resolve_from_prefs(Some(&prefs), tmp.path()).unwrap();
        assert!(matches!(result, ActiveConfigDir::Default));
    }

    #[test]
    fn resolve_from_prefs_stale_active_id_errors() {
        // The active id points at an account that has since been deleted.
        // The CORE invariant: we must NOT silently fall back to the shared
        // ~/.claude/ — that would bill the wrong subscription.
        let tmp = tempfile::tempdir().unwrap();
        let ghost_id = Uuid::new_v4().to_string();
        let prefs = test_prefs(vec![], Some(ghost_id.clone()));
        let err = resolve_from_prefs(Some(&prefs), tmp.path()).unwrap_err();
        assert!(
            err.contains(&ghost_id) || err.contains("no longer exists"),
            "expected stale-id error, got: {err}"
        );
    }

    #[test]
    fn resolve_from_prefs_active_dir_missing_errors() {
        // Active account exists in prefs but its config dir has been
        // deleted. Same invariant: refuse to fall back.
        let tmp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let prefs = test_prefs(vec![test_account(&id)], Some(id));
        let err = resolve_from_prefs(Some(&prefs), tmp.path()).unwrap_err();
        assert!(err.contains("missing"), "expected 'missing' error, got: {err}");
    }

    #[test]
    fn resolve_from_prefs_active_dir_present_returns_account() {
        let tmp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        // Create the per-account dir so the resolver finds it.
        std::fs::create_dir_all(tmp.path().join(&id)).unwrap();
        let prefs = test_prefs(vec![test_account(&id)], Some(id.clone()));
        match resolve_from_prefs(Some(&prefs), tmp.path()).unwrap() {
            ActiveConfigDir::Account(dir) => {
                assert!(dir.ends_with(&id));
            }
            ActiveConfigDir::Default => panic!("expected Account, got Default"),
        }
    }

    #[test]
    fn shared_items_never_leaks_credentials() {
        // The whole feature's premise: per-account .credentials.json must
        // NOT be symlinked from ~/.claude/. If this slips in accidentally
        // (e.g. via a well-intentioned "share more!" refactor), two
        // accounts would immediately start clobbering each other's tokens.
        for item in SHARED_CLAUDE_ITEMS {
            assert_ne!(
                *item, ".credentials.json",
                "SHARED_CLAUDE_ITEMS must never include credentials"
            );
            assert!(
                !item.contains("credential"),
                "SHARED_CLAUDE_ITEMS entry {item:?} looks credential-shaped; reject"
            );
        }
    }
}
