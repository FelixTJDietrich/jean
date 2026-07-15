#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

upstream_remote="${JEAN_UPDATE_UPSTREAM_REMOTE:-origin}"
upstream_branch="${JEAN_UPDATE_UPSTREAM_BRANCH:-main}"
push_remote="${JEAN_UPDATE_PUSH_REMOTE:-fork}"
service_name="${JEAN_UPDATE_SERVICE:-jean.service}"
install_prefix="${JEAN_UPDATE_INSTALL_PREFIX:-/opt/jean/extracted/app/usr}"
app_data_dir="${JEAN_UPDATE_APP_DATA_DIR:-$HOME/.local/share/com.jean.desktop}"
http_port="${JEAN_UPDATE_HTTP_PORT:-3456}"
active_session_cap="${JEAN_UPDATE_ACTIVE_SESSION_CAP:-8}"
skip_merge="${JEAN_UPDATE_SKIP_MERGE:-0}"
skip_restart="${JEAN_UPDATE_SKIP_RESTART:-0}"
defer_restart="${JEAN_UPDATE_DEFER_RESTART:-1}"

if [[ "$skip_merge" != "1" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree is not clean. Commit or stash local changes before updating." >&2
    exit 1
  fi

  git fetch "$upstream_remote" --tags
  git merge "$upstream_remote/$upstream_branch"
fi

bun install --frozen-lockfile
bun run build
cargo build --manifest-path src-tauri/Cargo.toml --release --bin jean

ts="$(date +%Y%m%d-%H%M%S)"
bin_dir="$install_prefix/bin"
dist_dir="$install_prefix/lib/Jean/dist"
new_bin="$bin_dir/jean.new-$ts"
old_bin="$bin_dir/jean.$ts.bak"
new_dist="$install_prefix/lib/Jean/dist.new-$ts"
old_dist="$install_prefix/lib/Jean/dist.old-$ts"

install -m 0755 src-tauri/target/release/jean "$new_bin"
cp -a dist "$new_dist"
mv "$bin_dir/jean" "$old_bin"
mv "$new_bin" "$bin_dir/jean"
mv "$dist_dir" "$old_dist"
mv "$new_dist" "$dist_dir"

ui_state="$app_data_dir/ui-state.json"
if [[ -f "$ui_state" ]]; then
  UI_STATE_PATH="$ui_state" ACTIVE_SESSION_CAP="$active_session_cap" python3 - <<'PY'
import json, os, pathlib, shutil, datetime
path = pathlib.Path(os.environ['UI_STATE_PATH'])
cap = int(os.environ['ACTIVE_SESSION_CAP'])
data = json.loads(path.read_text())
active = data.get('active_session_ids') or {}
if len(active) > cap:
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = path.with_name(f'{path.name}.{ts}.bak')
    shutil.copy2(path, backup)
    data['active_session_ids'] = dict(list(active.items())[:cap])
    path.write_text(json.dumps(data, indent=2) + '\n')
    print(f'trimmed active_session_ids {len(active)} -> {cap}; backup={backup}')
else:
    print(f'active_session_ids count {len(active)} within cap {cap}')
PY
fi

if [[ -n "$push_remote" ]]; then
  current_branch="$(git branch --show-current)"
  git push "$push_remote" "HEAD:$current_branch"
fi

curl -fsS "http://127.0.0.1:$http_port/api/version"
echo

if [[ "$skip_restart" != "1" ]]; then
  if [[ "$defer_restart" == "1" ]]; then
    systemd-run --unit="jean-hosted-restart-$ts" --on-active=2 --collect /bin/systemctl restart "$service_name"
    echo "Restart scheduled via systemd for $service_name"
  else
    systemctl restart "$service_name"
    echo "Restarted $service_name"
  fi
fi

echo "Backups:"
echo "  binary: $old_bin"
echo "  dist:   $old_dist"
