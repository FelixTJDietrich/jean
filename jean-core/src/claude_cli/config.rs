//! Configuration and path management for the embedded Claude CLI

use std::path::PathBuf;
use std::process::Command;

use tauri::AppHandle;

use super::accounts::{resolve_active_config_dir, ActiveConfigDir};
use crate::platform::{get_wsl_config, get_wsl_home_dir, silent_command};

/// Directory name for storing the Claude CLI binary
pub const CLI_DIR_NAME: &str = "claude-cli";

/// Name of the Claude CLI binary
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "claude.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "claude";

/// Name of the Claude CLI binary when Jean manages it inside a WSL distro
/// (always Linux, regardless of the host OS).
pub const CLI_BINARY_NAME_UNIX: &str = "claude";

/// Get the directory where Claude CLI is installed
///
/// Returns: `~/Library/Application Support/jean/claude-cli/`
pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CLI_DIR_NAME))
}

/// Get the full path to the Claude CLI binary
///
/// Returns: `~/Library/Application Support/jean/claude-cli/claude`
pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(CLI_BINARY_NAME))
}

/// Get the directory where Jean installs the Claude CLI inside a WSL distro.
/// Returns a Unix absolute path string like
/// `/home/<user>/.local/share/jean/claude-cli`.
pub fn get_wsl_cli_dir(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!("{home}/.local/share/jean/{CLI_DIR_NAME}"))
}

/// Get the full Unix path to the Jean-managed Claude CLI binary inside a
/// WSL distro.
pub fn get_wsl_cli_binary_path(distro: &str) -> Result<String, String> {
    Ok(format!(
        "{}/{CLI_BINARY_NAME_UNIX}",
        get_wsl_cli_dir(distro)?
    ))
}

/// Whether the Jean-managed Claude binary is present and executable.
pub fn jean_managed_installed(app: &AppHandle) -> bool {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(|path| crate::platform::wsl_file_executable(&wsl.distro, &path))
            .unwrap_or(false);
    }
    get_cli_binary_path(app)
        .map(|path| path.exists())
        .unwrap_or(false)
}

/// Find Claude on the system PATH (excluding the Jean-managed binary).
pub fn find_system_binary(app: &AppHandle) -> Option<PathBuf> {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(
            &wsl.distro,
            "claude",
            get_wsl_cli_binary_path(&wsl.distro).ok().as_deref(),
        )
        .map(PathBuf::from);
    }

    let jean_managed = get_cli_binary_path(app)
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());
    crate::platform::find_cli_in_host_path("claude", jean_managed.as_deref())
}

/// True when Jean-managed Claude is missing but a system PATH install exists.
/// Used to auto-select `claude_cli_source = "path"` so Homebrew installs work
/// without requiring a manual Settings toggle (issue #387).
pub fn should_auto_use_system(app: &AppHandle) -> bool {
    !jean_managed_installed(app) && find_system_binary(app).is_some()
}

fn jean_managed_path(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(CLI_BINARY_NAME_UNIX));
    }
    get_cli_binary_path(app).unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME))
}

/// Resolve Claude binary path based on the user's preference.
///
/// If `claude_cli_source` is `"path"`, look up `claude` in system PATH.
/// If `"jean"` (default) and the Jean-managed binary exists, use it.
/// Otherwise fall back to a system PATH install when present so Homebrew
/// (and similar) CLIs work without an explicit source switch.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let prefer_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    prefs.claude_cli_source == "path"
                } else {
                    false
                }
            } else {
                false
            }
        }
        Err(_) => false,
    };

    if prefer_path {
        if let Some(path) = find_system_binary(app) {
            return path;
        }
        log::warn!(
            "claude_cli_source is 'path' but could not find claude in PATH, falling back to Jean-managed binary"
        );
        return jean_managed_path(app);
    }

    if jean_managed_installed(app) {
        return jean_managed_path(app);
    }

    if let Some(path) = find_system_binary(app) {
        log::info!(
            "Jean-managed Claude CLI not installed; using system PATH binary at {}",
            path.display()
        );
        return path;
    }

    jean_managed_path(app)
}

/// Ensure the CLI directory exists, creating it if necessary
pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create CLI directory: {e}"))?;
    Ok(cli_dir)
}

/// **The single choke point for spawning the Claude CLI.**
///
/// Every non-UI Claude subprocess in Jean MUST go through this function —
/// direct `silent_command(&resolve_cli_binary(app))` is forbidden because it
/// silently bypasses the active-account `CLAUDE_CONFIG_DIR` injection.
///
/// Contract:
/// * Fails if the embedded binary is missing.
/// * Fails if an active Claude account is configured but its config dir is
///   unresolvable (missing on disk, stale id, unreadable prefs with an id
///   set). This is intentional: we refuse to silently fall back to the
///   shared `~/.claude/` and bill the wrong subscription.
/// * Applies `CLAUDE_CONFIG_DIR=<account-dir>` when an account is active;
///   leaves it unset when no account is selected (preserving pre-accounts
///   behavior).
///
/// The caller owns all other args/env/stdio/cwd. See callers in
/// `chat/naming.rs`, `chat/commands.rs`, `projects/commands.rs`, and
/// `chat/claude.rs` for usage examples.
pub fn spawn_claude_command(app: &AppHandle) -> Result<Command, String> {
    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err(format!(
            "Claude CLI not found at {}. Install it in Settings > Advanced.",
            cli_path.display()
        ));
    }

    let mut cmd = silent_command(&cli_path);

    // Scrub any ambient Anthropic / Claude auth state from the parent
    // process so the child CANNOT accidentally use the wrong subscription.
    // Concretely: an `ANTHROPIC_API_KEY` set in Jean's launching shell would
    // take precedence over the account's `.credentials.json` and bill the
    // API directly, defeating the whole profiles feature. We strip the
    // known auth-bearing env vars; downstream functionality (custom
    // profiles, region hints) is set explicitly by the caller.
    //
    // Docs: auth precedence at https://code.claude.com/docs/en/authentication
    for var in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ] {
        cmd.env_remove(var);
    }

    match resolve_active_config_dir(app)? {
        ActiveConfigDir::Default => {
            // No account: also clear any stale CLAUDE_CONFIG_DIR the shell
            // may have set so we predictably use ~/.claude/.
            cmd.env_remove("CLAUDE_CONFIG_DIR");
        }
        ActiveConfigDir::Account(dir) => {
            cmd.env("CLAUDE_CONFIG_DIR", &dir);
        }
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_jean_managed_location_shape() {
        let resolved = PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME);

        assert!(resolved.ends_with(CLI_BINARY_NAME));
        assert!(resolved.to_string_lossy().contains(CLI_DIR_NAME));
    }
}
