//! Tauri commands for Claude CLI management

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;

use super::accounts;
use super::config::{
    ensure_cli_dir, get_cli_binary_path, get_cli_dir, get_wsl_cli_binary_path, get_wsl_cli_dir,
    resolve_cli_binary,
};
use crate::http_server::EmitExt;
use crate::platform::silent_command;
use crate::ClaudeAccount;

/// Extract semver version number from a version string
/// Handles formats like: "1.0.28", "v1.0.28", "Claude CLI 1.0.28"
fn extract_version_number(version_str: &str) -> String {
    // Try to find a semver-like pattern (digits.digits.digits)
    for word in version_str.split_whitespace() {
        let trimmed = word.trim_start_matches('v');
        // Check if it looks like a version number (starts with digit, contains dots)
        if trimmed
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && trimmed.contains('.')
        {
            return trimmed.to_string();
        }
    }
    // Fallback: return original string
    version_str.to_string()
}

/// Base URL for Claude CLI binary distribution
const CLAUDE_DIST_BUCKET: &str =
    "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const CLAUDE_CREDENTIALS_FILE: &str = ".claude/.credentials.json";
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_REFRESH_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_SCOPES: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers";
const CLAUDE_USAGE_CACHE_TTL_SECS: u64 = 5 * 60;
static CLAUDE_USAGE_FETCH_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn claude_usage_fetch_lock() -> &'static AsyncMutex<()> {
    CLAUDE_USAGE_FETCH_LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Status of the Claude CLI installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCliStatus {
    /// Whether Claude CLI is installed
    pub installed: bool,
    /// Installed version (if any)
    pub version: Option<String>,
    /// Path to the CLI binary (if installed)
    pub path: Option<String>,
    /// Whether the CLI supports the `auth` subcommand (older CLIs lack it)
    #[serde(default)]
    pub supports_auth_command: bool,
}

/// Information about a Claude CLI release from GitHub
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseInfo {
    /// Version string (e.g., "1.0.0")
    pub version: String,
    /// Git tag name (e.g., "v1.0.0")
    pub tag_name: String,
    /// Publication date in ISO format
    pub published_at: String,
    /// Whether this is a prerelease
    pub prerelease: bool,
}

/// Progress event for CLI installation
#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    /// Current stage of installation
    pub stage: String,
    /// Progress message
    pub message: String,
    /// Percentage complete (0-100)
    pub percent: u8,
}

/// Check if Claude CLI is installed and get its status
#[tauri::command]
pub async fn check_claude_cli_installed(app: AppHandle) -> Result<ClaudeCliStatus, String> {
    log::trace!("Checking Claude CLI installation status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_cli_binary(&app);

    // In WSL mode, `binary_path` is either an absolute Unix path (Jean-managed
    // install inside the distro) or a bare tool name ("claude" for system
    // PATH). Neither form satisfies `.exists()` on the Windows filesystem —
    // verify inside WSL. Absolute paths use `test -x` (Jean install location
    // is not on $PATH); bare names use `which`.
    if wsl.enabled {
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            log::trace!("Claude CLI not found inside WSL distro {}", wsl.distro);
            return Ok(ClaudeCliStatus {
                installed: false,
                version: None,
                path: None,
                supports_auth_command: false,
            });
        }
        let raw_ver = crate::platform::wsl_tool_version(&wsl.distro, &tool);
        let version = raw_ver.map(|v| extract_version_number(&v));
        let supports_auth_command = version
            .as_ref()
            .map(|v| {
                v.split('.')
                    .next()
                    .and_then(|major| major.parse::<u32>().ok())
                    .unwrap_or(0)
                    >= 1
            })
            .unwrap_or(false);
        return Ok(ClaudeCliStatus {
            installed: true,
            version,
            path: Some(tool),
            supports_auth_command,
        });
    }

    if !binary_path.exists() {
        log::trace!("Claude CLI not found at {:?}", binary_path);
        return Ok(ClaudeCliStatus {
            installed: false,
            version: None,
            path: None,
            supports_auth_command: false,
        });
    }

    // Try to get the version by running claude --version
    // Use the binary directly - shell wrapper causes PowerShell parsing issues on Windows
    let version = match silent_command(&binary_path).arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                log::trace!("Claude CLI raw version output: {}", version_str);
                // claude --version returns just the version number like "1.0.28"
                // but handle any prefix like "v1.0.28" or "Claude CLI 1.0.28"
                let version = extract_version_number(&version_str);
                log::trace!("Claude CLI parsed version: {}", version);
                Some(version)
            } else {
                log::warn!("Failed to get Claude CLI version");
                None
            }
        }
        Err(e) => {
            log::warn!("Failed to execute Claude CLI: {}", e);
            None
        }
    };

    // Infer auth support from version instead of spawning another process.
    // The `auth` subcommand was added in Claude CLI ~1.0.16; all 1.x+ versions have it.
    let supports_auth_command = version
        .as_ref()
        .map(|v| {
            v.split('.')
                .next()
                .and_then(|major| major.parse::<u32>().ok())
                .unwrap_or(0)
                >= 1
        })
        .unwrap_or(false);
    log::trace!(
        "Claude CLI supports auth command: {supports_auth_command} (inferred from version)"
    );

    Ok(ClaudeCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
        supports_auth_command,
    })
}

/// npm package metadata for version listing
#[derive(Debug, Deserialize)]
struct NpmPackageInfo {
    versions: std::collections::HashMap<String, serde_json::Value>,
    time: std::collections::HashMap<String, String>,
    #[serde(rename = "dist-tags")]
    dist_tags: std::collections::HashMap<String, String>,
}

/// Platform-specific release information from manifest
#[derive(Debug, Deserialize)]
struct PlatformInfo {
    checksum: String,
}

/// Release manifest containing checksums for all platforms
#[derive(Debug, Deserialize)]
struct Manifest {
    platforms: std::collections::HashMap<String, PlatformInfo>,
}

/// Parse version string into comparable parts
fn parse_version(version: &str) -> Vec<u32> {
    version.split('.').filter_map(|s| s.parse().ok()).collect()
}

/// Get available Claude CLI versions from npm registry
#[tauri::command]
pub async fn get_available_cli_versions() -> Result<Vec<ReleaseInfo>, String> {
    log::trace!("Fetching available Claude CLI versions from npm registry");

    let client = reqwest::Client::new();
    let response = client
        .get("https://registry.npmjs.org/@anthropic-ai/claude-code")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch versions: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "npm registry returned status: {}",
            response.status()
        ));
    }

    let package_info: NpmPackageInfo = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse npm response: {e}"))?;

    // Get the latest stable version from dist-tags
    // Versions > latest (e.g., "next" tag) don't have manifests in the bucket
    let latest_version = package_info
        .dist_tags
        .get("latest")
        .ok_or("No 'latest' tag found in npm dist-tags")?;
    let latest_parts = parse_version(latest_version);

    // Filter versions to only include those <= latest (excludes prereleases like "next")
    let mut versions: Vec<ReleaseInfo> = package_info
        .versions
        .keys()
        .filter(|version| {
            // Exclude prerelease versions (e.g., 1.0.0-beta)
            if version.contains('-') {
                return false;
            }
            // Exclude versions > latest
            let parts = parse_version(version);
            parts <= latest_parts
        })
        .map(|version| {
            let published_at = package_info.time.get(version).cloned().unwrap_or_default();
            ReleaseInfo {
                version: version.clone(),
                tag_name: format!("v{version}"),
                published_at,
                prerelease: false,
            }
        })
        .collect();

    // Sort by version descending (newest first)
    versions.sort_by(|a, b| {
        let a_parts = parse_version(&a.version);
        let b_parts = parse_version(&b.version);
        b_parts.cmp(&a_parts)
    });

    // Take only the 5 most recent versions
    versions.truncate(5);

    log::trace!("Found {} Claude CLI versions", versions.len());
    Ok(versions)
}

/// Fetch the latest version string from the distribution bucket
async fn fetch_latest_version() -> Result<String, String> {
    let url = format!("{CLAUDE_DIST_BUCKET}/latest");
    log::trace!("Fetching latest version from {url}");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch stable version: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch stable version: HTTP {}",
            response.status()
        ));
    }

    let version = response
        .text()
        .await
        .map_err(|e| format!("Failed to read latest version: {e}"))?
        .trim()
        .to_string();

    log::trace!("Latest version: {version}");
    Ok(version)
}

/// Get the platform string for the current system
fn get_platform() -> Result<&'static str, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok("darwin-arm64");
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok("darwin-x64");
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok("linux-x64");
    }

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok("linux-arm64");
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok("win32-x64");
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

/// Fetch the release manifest containing checksums for all platforms
async fn fetch_manifest(version: &str) -> Result<Manifest, String> {
    let url = format!("{CLAUDE_DIST_BUCKET}/{version}/manifest.json");
    log::trace!("Fetching manifest from {url}");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch manifest: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch manifest: HTTP {}",
            response.status()
        ));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse manifest: {e}"))
}

/// Verify SHA256 checksum of downloaded data
fn verify_checksum(data: &[u8], expected: &str) -> Result<(), String> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let computed = format!("{:x}", hasher.finalize());

    if computed != expected.to_lowercase() {
        return Err(format!(
            "Checksum mismatch: expected {expected}, got {computed}"
        ));
    }
    Ok(())
}

/// Install Claude CLI by downloading the binary directly from Anthropic's distribution bucket
#[tauri::command]
pub async fn install_claude_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing Claude CLI, version: {:?}", version);

    // Check if any Claude processes are running - cannot replace binary while in use
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot install Claude CLI while {} Claude {} running. Please stop all active sessions first.",
            count,
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let wsl = crate::platform::get_wsl_config();

    emit_progress(&app, "starting", "Preparing installation...", 0);

    // Determine version (use provided or fetch stable)
    let version = match version {
        Some(v) => v,
        None => fetch_latest_version().await?,
    };

    // Detect platform. In WSL mode the target is the distro's architecture,
    // not the Windows host's.
    let platform: &str = if wsl.enabled {
        crate::platform::wsl_detect_arch(&wsl.distro).ok_or_else(|| {
            "Unsupported WSL architecture (expected x86_64 or aarch64)".to_string()
        })?
    } else {
        get_platform()?
    };
    log::trace!("Installing version {version} for platform {platform}");

    // Fetch manifest and get expected checksum
    emit_progress(
        &app,
        "fetching_manifest",
        "Fetching release manifest...",
        10,
    );
    let manifest = fetch_manifest(&version).await?;
    let expected_checksum = manifest
        .platforms
        .get(platform)
        .ok_or_else(|| format!("No checksum found for platform {platform}"))?
        .checksum
        .clone();
    log::trace!("Expected checksum for {platform}: {expected_checksum}");

    // Build download URL. Target binary name comes from the platform string,
    // NOT the host OS — a Windows host installing into WSL downloads the
    // Linux `claude`, not `claude.exe`.
    let binary_name = if platform.starts_with("win32") {
        "claude.exe"
    } else {
        "claude"
    };
    let download_url = format!("{CLAUDE_DIST_BUCKET}/{version}/{platform}/{binary_name}");
    log::trace!("Downloading from: {download_url}");

    // Emit progress: downloading
    emit_progress(&app, "downloading", "Downloading Claude CLI...", 25);

    // Download the binary
    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Claude CLI: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download Claude CLI: HTTP {}",
            response.status()
        ));
    }

    let binary_content = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read binary content: {e}"))?;

    log::trace!("Downloaded {} bytes", binary_content.len());

    // Verify checksum before writing to disk
    emit_progress(&app, "verifying_checksum", "Verifying checksum...", 55);
    verify_checksum(&binary_content, &expected_checksum)?;
    log::trace!("Checksum verified successfully");

    if wsl.enabled {
        // WSL branch: stream the bytes into the distro at
        // $HOME/.local/share/jean/claude-cli/claude and make it executable.
        let unix_path = get_wsl_cli_binary_path(&wsl.distro)?;
        emit_progress(&app, "installing", "Installing Claude CLI into WSL...", 65);
        log::trace!("Writing Claude CLI to WSL at {unix_path}");
        crate::platform::wsl_write_bytes(&wsl.distro, &unix_path, &binary_content)
            .map_err(|e| format!("Failed to write binary into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(&wsl.distro, &unix_path)?;
        emit_progress(&app, "complete", "Installation complete!", 100);
        log::trace!("Claude CLI installed successfully at WSL:{unix_path}");
        return Ok(());
    }

    // Native branch: write to %AppData%/jean/claude-cli/claude(.exe).
    let _cli_dir = ensure_cli_dir(&app)?;
    let binary_path = get_cli_binary_path(&app)?;

    emit_progress(&app, "installing", "Installing Claude CLI...", 65);

    // Uses platform::write_binary_file which writes to a temp file then atomically renames.
    // This handles Windows file-locking (OS error 32) and macOS code-signing inode taint
    // (SIGKILL) when the existing binary is in use by another process.
    log::trace!("Creating binary file at {:?}", binary_path);
    crate::platform::write_binary_file(&binary_path, &binary_content)
        .map_err(|e| format!("Failed to create binary file: {e}"))?;
    log::trace!("Binary file written successfully");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        log::trace!(
            "Setting executable permissions (0o755) on {:?}",
            binary_path
        );
        let mut perms = std::fs::metadata(&binary_path)
            .map_err(|e| format!("Failed to get binary metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&binary_path, perms)
            .map_err(|e| format!("Failed to set binary permissions: {e}"))?;
        log::trace!("Executable permissions set successfully");
    }

    #[cfg(target_os = "macos")]
    {
        log::trace!("Removing quarantine attribute from {:?}", binary_path);
        let _ = silent_command("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&binary_path)
            .output();
        // Ignore errors - attribute might not exist
    }

    emit_progress(&app, "complete", "Installation complete!", 100);

    log::trace!("Claude CLI installed successfully at {:?}", binary_path);
    Ok(())
}

/// Uninstall the Jean-managed Claude CLI by deleting its directory.
///
/// Refuses to run while any Claude sessions are active. Idempotent: returns
/// `Ok(())` if the directory does not exist.
#[tauri::command]
pub async fn uninstall_claude_cli(app: AppHandle) -> Result<(), String> {
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot uninstall Claude CLI while {} Claude {} running. Please stop all active sessions first.",
            count,
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        let cli_dir = get_wsl_cli_dir(&wsl.distro)?;
        crate::platform::wsl_remove_path(&wsl.distro, &cli_dir)
            .map_err(|e| format!("Failed to remove Claude CLI directory inside WSL: {e}"))?;
        log::info!(
            "Removed Jean-managed Claude CLI inside WSL distro {} at {}",
            wsl.distro,
            cli_dir
        );
        return Ok(());
    }

    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove Claude CLI directory: {e}"))?;
        log::info!("Removed Jean-managed Claude CLI at {:?}", cli_dir);
    }
    Ok(())
}

/// Result of checking Claude CLI authentication status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeAuthStatus {
    /// Whether the CLI is authenticated (can execute queries)
    pub authenticated: bool,
    /// Error message if authentication check failed
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageWindowSnapshot {
    pub used_percent: f64,
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageSnapshot {
    pub plan_type: Option<String>,
    pub session: Option<ClaudeUsageWindowSnapshot>,
    pub weekly: Option<ClaudeUsageWindowSnapshot>,
    pub sonnet_weekly: Option<ClaudeUsageWindowSnapshot>,
    pub extra_usage_spent: Option<f64>,
    pub extra_usage_limit: Option<f64>,
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeUsageCacheEntry {
    cached_at: u64,
    snapshot: ClaudeUsageSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ClaudeOauthCredentials {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    expires_at: Option<u64>,
    #[serde(default)]
    subscription_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ClaudeCredentialsFile {
    #[serde(rename = "claudeAiOauth", default)]
    claude_ai_oauth: Option<ClaudeOauthCredentials>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
enum ClaudeCredentialSource {
    File(PathBuf),
    WslFile {
        distro: String,
        path: String,
    },
    #[cfg(target_os = "macos")]
    Keychain,
}

#[derive(Debug, Deserialize)]
struct ClaudeRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsageWindow {
    #[serde(default, deserialize_with = "de_opt_f64")]
    utilization: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    resets_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ClaudeExtraUsage {
    #[serde(default)]
    is_enabled: Option<bool>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    used_credits: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_f64")]
    monthly_limit: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsageApiResponse {
    #[serde(default)]
    five_hour: Option<ClaudeUsageWindow>,
    #[serde(default)]
    seven_day: Option<ClaudeUsageWindow>,
    #[serde(default)]
    seven_day_sonnet: Option<ClaudeUsageWindow>,
    #[serde(default)]
    extra_usage: Option<ClaudeExtraUsage>,
}

fn de_opt_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };
    Ok(match value {
        Value::Number(num) => num.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    })
}

fn de_opt_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };
    Ok(match value {
        Value::Number(num) => num.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    })
}

fn build_usage_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create usage HTTP client: {e}"))
}

#[cfg(target_os = "macos")]
fn decode_hex_utf8(hex: &str) -> Option<String> {
    if hex.is_empty() || hex.len() % 2 != 0 {
        return None;
    }
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for idx in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[idx..idx + 2], 16).ok()?;
        bytes.push(byte);
    }
    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "macos")]
fn parse_credentials_json(raw: &str) -> Option<ClaudeCredentialsFile> {
    if let Ok(creds) = serde_json::from_str::<ClaudeCredentialsFile>(raw) {
        return Some(creds);
    }
    let trimmed = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let decoded = decode_hex_utf8(trimmed)?;
    serde_json::from_str::<ClaudeCredentialsFile>(&decoded).ok()
}

/// Resolve the credentials file path for the currently-active Claude account,
/// falling back to `~/.claude/.credentials.json` when no account is active.
///
/// This is the single choke point that controls whose credentials Jean reads
/// and refreshes. Any new code path that touches `.credentials.json` **must**
/// go through here (or `load_claude_credentials`).
fn get_claude_credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = accounts::get_active_account_config_dir(app) {
        return Ok(dir.join(".credentials.json"));
    }
    let home = dirs::home_dir().ok_or_else(|| "No home directory found".to_string())?;
    Ok(home.join(CLAUDE_CREDENTIALS_FILE))
}

fn wsl_claude_credentials_path(home: &str) -> String {
    format!("{}/{}", home.trim_end_matches('/'), CLAUDE_CREDENTIALS_FILE)
}

fn credentials_have_access_token(credentials: &ClaudeCredentialsFile) -> bool {
    credentials
        .claude_ai_oauth
        .as_ref()
        .and_then(|o| o.access_token.as_ref())
        .is_some()
}

fn parse_claude_credentials(raw: &str) -> Result<ClaudeCredentialsFile, String> {
    serde_json::from_str::<ClaudeCredentialsFile>(raw)
        .map_err(|e| format!("Failed to parse Claude credentials JSON: {e}"))
}

fn read_wsl_claude_credentials(distro: &str, path: &str) -> Result<ClaudeCredentialsFile, String> {
    let output = crate::platform::wsl_aware_command("cat", None)
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to read Claude credentials inside WSL: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "Claude credentials not found inside WSL distro {distro}. Run `claude` inside WSL to authenticate."
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    parse_claude_credentials(&raw)
}

/// On macOS, the Keychain entry "Claude Code-credentials" is a *system-wide*
/// (single-user-singleton) credential store. It has no notion of profiles.
/// When the user has an active Claude account, we skip Keychain entirely so
/// we never accidentally read the wrong account's token or write one
/// account's refreshed token into the other's slot.
#[cfg(target_os = "macos")]
fn keychain_allowed(app: &AppHandle) -> bool {
    accounts::get_active_account_config_dir(app).is_none()
}

#[cfg(target_os = "macos")]
fn load_credentials_from_keychain() -> Option<ClaudeCredentialsFile> {
    let output = silent_command("security")
        .args(["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let payload = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_credentials_json(&payload)
}

fn load_claude_credentials(
    app: &AppHandle,
) -> Result<(ClaudeCredentialSource, ClaudeCredentialsFile), String> {
    // WSL takes priority: when Jean is configured to use a WSL distro for
    // Claude, the active-account `CLAUDE_CONFIG_DIR` (which lives on the
    // Windows host filesystem) doesn't apply — read credentials from inside
    // the distro instead.
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        let home = crate::platform::get_wsl_home_dir(&wsl.distro)?;
        let cred_path = wsl_claude_credentials_path(&home);
        let parsed = read_wsl_claude_credentials(&wsl.distro, &cred_path)?;
        if credentials_have_access_token(&parsed) {
            return Ok((
                ClaudeCredentialSource::WslFile {
                    distro: wsl.distro,
                    path: cred_path,
                },
                parsed,
            ));
        }
        return Err(format!(
            "Claude credentials not found inside WSL distro {}. Run `claude` inside WSL to authenticate.",
            wsl.distro
        ));
    }

    let cred_path = get_claude_credentials_path(app)?;
    if cred_path.exists() {
        let raw = std::fs::read_to_string(&cred_path)
            .map_err(|e| format!("Failed to read Claude credentials file: {e}"))?;
        let parsed = parse_claude_credentials(&raw)?;
        if credentials_have_access_token(&parsed) {
            return Ok((ClaudeCredentialSource::File(cred_path), parsed));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if keychain_allowed(app) {
            if let Some(parsed) = load_credentials_from_keychain() {
                if credentials_have_access_token(&parsed) {
                    return Ok((ClaudeCredentialSource::Keychain, parsed));
                }
            }
        }
    }

    Err("Claude credentials not found. Run `claude` to authenticate.".to_string())
}

fn persist_claude_credentials(
    source: &ClaudeCredentialSource,
    full_data: &ClaudeCredentialsFile,
) -> Result<(), String> {
    // Keep this minified. Claude can break on keychain values with embedded newlines.
    let payload = serde_json::to_string(full_data)
        .map_err(|e| format!("Failed to serialize Claude credentials: {e}"))?;

    match source {
        ClaudeCredentialSource::File(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create Claude credentials directory {}: {e}",
                        parent.display()
                    )
                })?;
            }
            // Atomic write: a concurrent reader (claude CLI subprocess, another
            // auth check, etc.) must never observe a truncated or half-written
            // credentials file. Write to a unique tmp path, fsync it, then
            // rename on top. The fsync is load-bearing for OAuth tokens — a
            // power loss after a non-fsynced rename can leave an empty file,
            // forcing the user to re-run `claude /login`.
            use std::io::Write as _;
            let tmp_suffix = uuid::Uuid::new_v4();
            let tmp = path.with_extension(format!("tmp.{tmp_suffix}"));
            {
                let mut f = std::fs::File::create(&tmp).map_err(|e| {
                    format!("Failed to create Claude credentials tmp: {e}")
                })?;
                f.write_all(payload.as_bytes())
                    .map_err(|e| format!("Failed to write Claude credentials tmp: {e}"))?;
                f.sync_all()
                    .map_err(|e| format!("Failed to fsync Claude credentials tmp: {e}"))?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &tmp,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            std::fs::rename(&tmp, path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("Failed to finalize Claude credentials file: {e}")
            })
        }
        ClaudeCredentialSource::WslFile { distro, path } => {
            crate::platform::wsl_write_bytes(distro, path, payload.as_bytes())
                .map_err(|e| format!("Failed to write Claude credentials inside WSL: {e}"))
        }
        #[cfg(target_os = "macos")]
        ClaudeCredentialSource::Keychain => {
            let output = silent_command("security")
                .args([
                    "add-generic-password",
                    "-U",
                    "-s",
                    CLAUDE_KEYCHAIN_SERVICE,
                    "-a",
                    "claude",
                    "-w",
                    &payload,
                ])
                .output()
                .map_err(|e| format!("Failed to update Claude credentials keychain: {e}"))?;
            if output.status.success() {
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(if stderr.is_empty() {
                    "Failed to update Claude credentials keychain.".to_string()
                } else {
                    format!("Failed to update Claude credentials keychain: {stderr}")
                })
            }
        }
    }
}

fn token_needs_refresh(oauth: &ClaudeOauthCredentials, now_ms: u64) -> bool {
    let Some(expires_at) = oauth.expires_at else {
        return true;
    };
    let refresh_buffer_ms = 5 * 60 * 1000;
    now_ms.saturating_add(refresh_buffer_ms) >= expires_at
}

fn get_usage_cache_dir() -> Option<PathBuf> {
    let base = dirs::cache_dir().or_else(|| dirs::home_dir().map(|h| h.join(".cache")))?;
    Some(base.join("jean").join("usage-cache"))
}

fn get_claude_usage_cache_path(cache_key: &str) -> Option<PathBuf> {
    // Validate: only let through chars we already produce ourselves (uuid
    // hex, dashes, or the literal "default") so we cannot be tricked into
    // escaping the cache dir if an attacker ever controls active_account_id.
    let safe = cache_key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe {
        return None;
    }
    let filename = if cache_key == "default" {
        "claude.json".to_string()
    } else {
        format!("claude-{cache_key}.json")
    };
    Some(get_usage_cache_dir()?.join(filename))
}

fn load_cached_claude_usage(cache_key: &str, now_secs: u64) -> Option<ClaudeUsageSnapshot> {
    let path = get_claude_usage_cache_path(cache_key)?;
    let content = std::fs::read_to_string(path).ok()?;
    let entry: ClaudeUsageCacheEntry = serde_json::from_str(&content).ok()?;
    if now_secs.saturating_sub(entry.cached_at) <= CLAUDE_USAGE_CACHE_TTL_SECS {
        return Some(entry.snapshot);
    }
    None
}

fn save_cached_claude_usage(cache_key: &str, snapshot: &ClaudeUsageSnapshot, now_secs: u64) {
    let Some(path) = get_claude_usage_cache_path(cache_key) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let entry = ClaudeUsageCacheEntry {
        cached_at: now_secs,
        snapshot: snapshot.clone(),
    };
    if let Ok(serialized) = serde_json::to_string_pretty(&entry) {
        let _ = std::fs::write(path, serialized);
    }
}

async fn refresh_claude_access_token(
    client: &reqwest::Client,
    source: &ClaudeCredentialSource,
    full_data: &mut ClaudeCredentialsFile,
) -> Result<Option<String>, String> {
    log::trace!("Claude token refresh: starting");
    let oauth = full_data.claude_ai_oauth.clone().ok_or_else(|| {
        "Claude OAuth credentials missing. Run `claude` to authenticate.".to_string()
    })?;
    let refresh_token = oauth
        .refresh_token
        .clone()
        .ok_or_else(|| "Claude refresh token missing. Run `claude` to authenticate.".to_string())?;

    let response = client
        .post(CLAUDE_REFRESH_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLAUDE_OAUTH_CLIENT_ID,
            "scope": CLAUDE_OAUTH_SCOPES
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to refresh Claude token: {e}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::BAD_REQUEST
    {
        let body = response.json::<Value>().await.unwrap_or(Value::Null);
        let error_code = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("token_expired");
        if error_code == "invalid_grant" {
            log::trace!("Claude token refresh: invalid_grant");
            return Err("Claude session expired. Run `claude` to log in again.".to_string());
        }
        log::trace!("Claude token refresh: unauthorized response");
        return Err("Claude token expired. Run `claude` to log in again.".to_string());
    }

    if !response.status().is_success() {
        log::trace!(
            "Claude token refresh: non-success status {}, proceeding with existing token",
            response.status()
        );
        return Ok(None);
    }

    let refreshed = response
        .json::<ClaudeRefreshResponse>()
        .await
        .map_err(|e| format!("Failed to parse Claude refresh response JSON: {e}"))?;

    let mut next_oauth = oauth;
    next_oauth.access_token = Some(refreshed.access_token.clone());
    if let Some(refresh_token) = refreshed.refresh_token {
        next_oauth.refresh_token = Some(refresh_token);
    }
    if let Some(expires_in) = refreshed.expires_in {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        next_oauth.expires_at = Some(now_ms.saturating_add(expires_in.saturating_mul(1000)));
    }

    full_data.claude_ai_oauth = Some(next_oauth.clone());
    if let Err(e) = persist_claude_credentials(source, full_data) {
        log::warn!("Claude token refresh succeeded but failed to persist credentials: {e}");
    }

    log::trace!("Claude token refresh: success");
    Ok(next_oauth.access_token)
}

/// Check if Claude CLI is authenticated by running `claude auth status`.
///
/// Goes through `spawn_claude_command` so the check is scoped to the active
/// account's `CLAUDE_CONFIG_DIR`. If an account is configured but its dir
/// is missing, we report "not authenticated" with the resolver's error
/// message — rather than silently checking the shared `~/.claude/` and
/// falsely reporting the user as signed in.
#[tauri::command]
pub async fn check_claude_cli_auth(app: AppHandle) -> Result<ClaudeAuthStatus, String> {
    log::trace!("Checking Claude CLI authentication status");

    let wsl = crate::platform::get_wsl_config();

    // WSL mode: WSL distro doesn't support per-account profiles, so route
    // straight through `wsl_aware_command`. Native mode: go through
    // `spawn_claude_command` so the active account's CLAUDE_CONFIG_DIR is
    // injected and a misconfigured account refuses to silently fall back.
    let output = if wsl.enabled {
        let binary_path = resolve_cli_binary(&app);
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            return Ok(ClaudeAuthStatus {
                authenticated: false,
                error: Some("Claude CLI not installed inside WSL".to_string()),
            });
        }
        log::trace!("Running auth check (WSL): {:?}", binary_path);
        crate::platform::wsl_aware_command(&tool, None)
            .args(["auth", "status"])
            .output()
            .map_err(|e| format!("Failed to execute Claude CLI: {e}"))?
    } else {
        let mut cmd = match super::config::spawn_claude_command(&app) {
            Ok(c) => c,
            Err(msg) => {
                return Ok(ClaudeAuthStatus {
                    authenticated: false,
                    error: Some(msg),
                });
            }
        };
        cmd.args(["auth", "status"])
            .output()
            .map_err(|e| format!("Failed to execute Claude CLI: {e}"))?
    };

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::trace!("Claude CLI auth check output: {stdout}");
        // Parse JSON response: {"loggedIn": true, ...}
        let logged_in = serde_json::from_str::<serde_json::Value>(&stdout)
            .ok()
            .and_then(|v| v.get("loggedIn")?.as_bool())
            .unwrap_or(false);
        Ok(ClaudeAuthStatus {
            authenticated: logged_in,
            error: if logged_in { None } else { Some(stdout) },
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("Claude CLI auth check failed: {stderr}");
        Ok(ClaudeAuthStatus {
            authenticated: false,
            error: Some(stderr),
        })
    }
}

/// Get current Claude usage for authenticated users.
#[tauri::command]
pub async fn get_claude_usage(app: AppHandle) -> Result<ClaudeUsageSnapshot, String> {
    get_claude_usage_with_source(&app, "ui").await
}

pub(crate) async fn get_claude_usage_with_source(
    app: &AppHandle,
    request_source: &'static str,
) -> Result<ClaudeUsageSnapshot, String> {
    // Serialize usage fetches so token refresh cannot run concurrently from UI + background.
    let _usage_lock = claude_usage_fetch_lock().lock().await;
    log::trace!("Claude usage fetch start (source={request_source})");

    // Usage cache is keyed per account so switching accounts doesn't serve
    // the previous account's cached numbers. We read the active id from
    // preferences directly rather than deriving from the filesystem — that
    // avoids a corner case where the dir briefly vanishes and we'd cache
    // under "default" alongside the real no-account value.
    let cache_key = crate::load_preferences_sync(app)
        .ok()
        .and_then(|p| p.active_claude_account_id)
        .unwrap_or_else(|| "default".to_string());

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(cached) = load_cached_claude_usage(&cache_key, now_secs) {
        log::trace!("Claude usage fetch hit cache (source={request_source})");
        return Ok(cached);
    }

    let (source, mut credentials) = load_claude_credentials(app)?;
    let usage_client = build_usage_client()?;

    let oauth = credentials.claude_ai_oauth.clone().ok_or_else(|| {
        "Claude OAuth credentials missing. Run `claude` to authenticate.".to_string()
    })?;

    let mut access_token = oauth
        .access_token
        .clone()
        .ok_or_else(|| "Claude access token missing. Run `claude` to authenticate.".to_string())?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if token_needs_refresh(&oauth, now_ms) {
        log::trace!("Claude usage fetch requires token refresh (source={request_source})");
        if let Some(refreshed_token) =
            refresh_claude_access_token(&usage_client, &source, &mut credentials).await?
        {
            access_token = refreshed_token;
        }
    }

    let mut response = usage_client
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(access_token.trim())
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Claude usage: {e}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        log::trace!(
            "Claude usage fetch received 401, retrying after refresh (source={request_source})"
        );
        if let Some(refreshed_token) =
            refresh_claude_access_token(&usage_client, &source, &mut credentials).await?
        {
            response = usage_client
                .get(CLAUDE_USAGE_URL)
                .bearer_auth(refreshed_token.trim())
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header("anthropic-beta", "oauth-2025-04-20")
                .send()
                .await
                .map_err(|e| format!("Failed to fetch Claude usage: {e}"))?;
        }
    }

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err("Claude token expired. Run `claude` to log in again.".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Claude usage request failed (HTTP {}).",
            response.status()
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Claude usage response body: {e}"))?;
    let usage = serde_json::from_str::<ClaudeUsageApiResponse>(&body).map_err(|e| {
        let snippet = body.chars().take(200).collect::<String>();
        format!("Failed to parse Claude usage response JSON: {e}. Body starts with: {snippet}")
    })?;

    let fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let map_window = |window: Option<ClaudeUsageWindow>| -> Option<ClaudeUsageWindowSnapshot> {
        let w = window?;
        Some(ClaudeUsageWindowSnapshot {
            used_percent: w.utilization?,
            resets_at: w.resets_at,
        })
    };

    let (extra_usage_spent, extra_usage_limit) = usage
        .extra_usage
        .and_then(|e| {
            if e.is_enabled.unwrap_or(false) {
                Some((e.used_credits, e.monthly_limit))
            } else {
                None
            }
        })
        .unwrap_or((None, None));

    let snapshot = ClaudeUsageSnapshot {
        plan_type: credentials
            .claude_ai_oauth
            .as_ref()
            .and_then(|o| o.subscription_type.clone()),
        session: map_window(usage.five_hour),
        weekly: map_window(usage.seven_day),
        sonnet_weekly: map_window(usage.seven_day_sonnet),
        extra_usage_spent,
        extra_usage_limit,
        fetched_at,
    };

    save_cached_claude_usage(&cache_key, &snapshot, fetched_at);
    log::trace!("Claude usage fetch success (source={request_source})");
    Ok(snapshot)
}

/// Result of detecting Claude CLI in system PATH
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudePathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

/// Detect Claude CLI in system PATH (excluding Jean-managed binary)
#[tauri::command]
pub async fn detect_claude_in_path(app: AppHandle) -> Result<ClaudePathDetection, String> {
    log::trace!("Detecting Claude CLI in system PATH");

    let jean_managed_path = get_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());
    let wsl = crate::platform::get_wsl_config();
    let jean_managed_wsl = if wsl.enabled {
        get_wsl_cli_binary_path(&wsl.distro).ok()
    } else {
        None
    };

    let detection = crate::platform::detect_cli_in_path(
        "claude",
        jean_managed_path.as_deref(),
        jean_managed_wsl.as_deref(),
    );

    if !detection.found {
        log::trace!("Claude CLI not found in PATH");
        return Ok(ClaudePathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    let version = detection.version.map(|v| extract_version_number(&v));

    log::trace!(
        "Found Claude CLI in PATH: {:?} (version: {:?}, pkg_mgr: {:?})",
        detection.path,
        version,
        detection.package_manager
    );

    Ok(ClaudePathDetection {
        found: true,
        path: detection.path,
        version,
        package_manager: detection.package_manager,
    })
}

/// Helper function to emit installation progress events
fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let progress = InstallProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        percent,
    };

    if let Err(e) = app.emit_all("claude-cli:install-progress", &progress) {
        log::warn!("Failed to emit install progress: {}", e);
    }
}

// =============================================================================
// Claude account management (commands)
// =============================================================================

/// Per-account summary returned to the frontend. Adds the runtime-computed
/// `has_credentials` flag so the UI can distinguish "account exists but
/// needs `/login`" from "account ready to use".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountSummary {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: u64,
    pub has_credentials: bool,
    pub config_dir: String,
}

impl ClaudeAccountSummary {
    fn from_account(app: &AppHandle, acct: &ClaudeAccount) -> Self {
        let dir = accounts::get_account_config_dir(app, &acct.id)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let health = accounts::inspect_account(app, &acct.id);
        Self {
            id: acct.id.clone(),
            name: acct.name.clone(),
            color: acct.color.clone(),
            created_at: acct.created_at,
            has_credentials: health.has_credentials,
            config_dir: dir,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountsState {
    pub accounts: Vec<ClaudeAccountSummary>,
    pub active_account_id: Option<String>,
}

#[tauri::command]
pub async fn list_claude_accounts(app: AppHandle) -> Result<ClaudeAccountsState, String> {
    let prefs = crate::load_preferences_sync(&app)?;
    let mut accounts_out: Vec<ClaudeAccountSummary> = prefs
        .claude_accounts
        .iter()
        .map(|a| ClaudeAccountSummary::from_account(&app, a))
        .collect();
    // Oldest first — stable ordering that survives renames.
    accounts_out.sort_by_key(|a| a.created_at);

    Ok(ClaudeAccountsState {
        accounts: accounts_out,
        active_account_id: prefs.active_claude_account_id.clone(),
    })
}

#[tauri::command]
pub async fn create_claude_account(
    app: AppHandle,
    name: String,
    color: String,
) -> Result<ClaudeAccountSummary, String> {
    // Canonicalize AND validate input via the same helpers the on-disk
    // scaffolding uses, so a whitespace-only name or malformed color fails
    // BEFORE we create any filesystem artifacts to roll back.
    let canonical_name = accounts::validate_name(&name)?;
    let canonical_color = accounts::validate_color(&color)?;

    // Fast-fail uniqueness check outside the mutation lock so we don't scaffold
    // a dir just to discover the name is taken. The authoritative re-check
    // inside the critical section below closes the race.
    {
        let existing = crate::load_preferences_sync(&app)?;
        if existing
            .claude_accounts
            .iter()
            .any(|a| a.name.eq_ignore_ascii_case(&canonical_name))
        {
            return Err(format!(
                "An account named '{canonical_name}' already exists"
            ));
        }
    }

    let created = accounts::create_account_on_disk(&app, &canonical_name, &canonical_color)?;
    let created_clone = created.clone();
    if let Err(e) = accounts::mutate_preferences(&app, |prefs| {
        // Authoritative uniqueness check inside the critical section.
        if prefs
            .claude_accounts
            .iter()
            .any(|a| a.name.eq_ignore_ascii_case(&created.name))
        {
            return Err(format!(
                "An account named '{}' already exists",
                created.name
            ));
        }
        prefs.claude_accounts.push(created.clone());
        Ok(())
    }) {
        // Roll back the on-disk dir if the prefs mutation fails so we don't
        // leak orphaned account directories on uniqueness collisions or
        // prefs-write errors.
        let _ = accounts::delete_account_on_disk(&app, &created_clone.id);
        return Err(e);
    }

    Ok(ClaudeAccountSummary::from_account(&app, &created_clone))
}

#[tauri::command]
pub async fn delete_claude_account(app: AppHandle, id: String) -> Result<(), String> {
    // If any Claude session is currently running, ripping any account dir
    // out from under it corrupts in-flight token refreshes and kills the
    // subprocess. The subprocess may have been spawned with this account's
    // CLAUDE_CONFIG_DIR even if the user has since switched, so we check
    // unconditionally regardless of whether the account is currently active.
    // This mirrors `install_claude_cli`'s same safety guard.
    //
    // The check runs INSIDE `mutate_preferences` so it cannot race with a
    // concurrent set_active_claude_account.
    accounts::mutate_preferences(&app, |prefs| {
        if !prefs.claude_accounts.iter().any(|a| a.id == id) {
            return Err("Account not found".to_string());
        }
        let running = crate::chat::registry::get_running_sessions();
        if !running.is_empty() {
            return Err(format!(
                "Cannot delete a Claude account while {} session(s) are still running. \
                 Stop them and try again.",
                running.len()
            ));
        }
        prefs.claude_accounts.retain(|a| a.id != id);
        if prefs.active_claude_account_id.as_deref() == Some(&id) {
            prefs.active_claude_account_id = None;
        }
        Ok(())
    })?;

    // Only remove the dir after preferences have been updated — if the dir
    // removal fails, the account is already out of prefs so it won't be
    // re-referenced. The leftover dir is an ignorable nuisance at worst.
    if let Err(e) = accounts::delete_account_on_disk(&app, &id) {
        log::warn!("Deleted account '{id}' from prefs but failed to remove dir: {e}");
    }

    Ok(())
}

#[tauri::command]
pub async fn set_active_claude_account(
    app: AppHandle,
    id: Option<String>,
) -> Result<(), String> {
    accounts::mutate_preferences(&app, |prefs| {
        if let Some(ref target_id) = id {
            if !prefs.claude_accounts.iter().any(|a| &a.id == target_id) {
                return Err("Account not found".to_string());
            }
        }
        prefs.active_claude_account_id = id.clone();
        Ok(())
    })?;

    Ok(())
}

#[tauri::command]
pub async fn rename_claude_account(
    app: AppHandle,
    id: String,
    name: String,
    color: Option<String>,
) -> Result<ClaudeAccountSummary, String> {
    // Canonicalize inputs outside the lock; validators are cheap and
    // share implementation with create_claude_account so the two commands
    // cannot drift.
    let canonical_name = accounts::validate_name(&name)?;
    let canonical_color = color
        .as_deref()
        .map(accounts::validate_color)
        .transpose()?;

    // Capture the updated account inside the critical section so the
    // returned summary always reflects *this* write, even if another
    // rename races in after we release the mutation lock.
    let mut updated_account: Option<ClaudeAccount> = None;
    accounts::mutate_preferences(&app, |prefs| {
        if prefs
            .claude_accounts
            .iter()
            .any(|a| a.id != id && a.name.eq_ignore_ascii_case(&canonical_name))
        {
            return Err(format!(
                "An account named '{canonical_name}' already exists"
            ));
        }
        let account = prefs
            .claude_accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| "Account not found".to_string())?;
        account.name = canonical_name.clone();
        if let Some(c) = &canonical_color {
            account.color = c.clone();
        }
        updated_account = Some(account.clone());
        Ok(())
    })?;

    let updated = updated_account.ok_or_else(|| "Account not found".to_string())?;
    Ok(ClaudeAccountSummary::from_account(&app, &updated))
}

/// Returns the shell command the user should run to log in to a given
/// account (with `CLAUDE_CONFIG_DIR` preset). We intentionally do NOT spawn
/// this ourselves: `claude /login` opens a browser OAuth flow and is best
/// handled in the user's preferred terminal.
#[tauri::command]
pub async fn get_claude_account_login_command(
    app: AppHandle,
    id: String,
) -> Result<String, String> {
    let prefs = crate::load_preferences_sync(&app)?;
    if !prefs.claude_accounts.iter().any(|a| a.id == id) {
        return Err("Account not found".to_string());
    }
    let binary = resolve_cli_binary(&app);
    accounts::build_login_command(&app, &id, &binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_credentials_path_uses_wsl_home() {
        assert_eq!(
            wsl_claude_credentials_path("/home/alice"),
            "/home/alice/.claude/.credentials.json"
        );
        assert_eq!(
            wsl_claude_credentials_path("/home/alice/"),
            "/home/alice/.claude/.credentials.json"
        );
    }

    #[test]
    fn credentials_have_access_token_only_when_oauth_token_exists() {
        let mut credentials = ClaudeCredentialsFile::default();
        assert!(!credentials_have_access_token(&credentials));

        credentials.claude_ai_oauth = Some(ClaudeOauthCredentials {
            access_token: Some("token".to_string()),
            ..Default::default()
        });
        assert!(credentials_have_access_token(&credentials));
    }
}
