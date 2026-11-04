#!/usr/bin/env bash
set -euo pipefail

# Prepares a git worktree for a Claude Code session, like the Conductor setup
# in .conductor/settings.toml. It gives the worktree its own data directory
# and demo mailbox so parallel sessions don't share ~/.fluxmail or GreenMail.
# The main checkout and Conductor workspaces are left alone.
#
#   bash scripts/worktree-setup.sh             set up this worktree by hand
#   bash scripts/worktree-setup.sh --env DIR   print the settings for DIR
#
# Claude Code hooks run it with their JSON input on stdin. Session hooks add a
# line to the session's environment file that runs --env for the current
# directory before each command, so the settings follow EnterWorktree and cd.

# Gives each worktree its own slot from 1 to 400 and records it in the shared
# git directory, so two worktrees never get the same ports. A slot is reused
# only after its worktree's directory is gone.
worktree_slot() {
  local worktree=$1 registry lock slot='' taken=' ' live='' start i
  local entry_slot entry_path
  registry="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)/claude-worktree-slots"
  slot=$(awk -F '\t' -v path="$worktree" '$2 == path { print $1; exit }' "$registry" 2>/dev/null || true)
  if [[ -n "$slot" ]]; then
    printf '%s\n' "$slot"
    return
  fi

  lock="$registry.lock"
  for ((i = 0; i < 100; i++)); do
    mkdir "$lock" 2>/dev/null && break
    sleep 0.05
  done
  if ((i == 100)); then
    echo "worktree-setup: $lock has been held for 5 seconds. If no other worktree setup is running, delete it and try again." >&2
    return 1
  fi
  if [[ -f "$registry" ]]; then
    while IFS=$'\t' read -r entry_slot entry_path; do
      [[ -d "$entry_path" ]] || continue
      [[ "$entry_path" != "$worktree" ]] || slot=$entry_slot
      live+="$entry_slot"$'\t'"$entry_path"$'\n'
      taken+="$entry_slot "
    done < "$registry"
  fi
  if [[ -z "$slot" ]]; then
    start=$(($(printf '%s' "$worktree" | cksum | cut -d ' ' -f 1) % 400))
    for ((i = 0; i < 400; i++)); do
      slot=$(((start + i) % 400 + 1))
      [[ "$taken" == *" $slot "* ]] || break
    done
    live+="$slot"$'\t'"$worktree"$'\n'
  fi
  printf '%s' "$live" > "$registry.$$" && mv "$registry.$$" "$registry"
  rmdir "$lock"
  printf '%s\n' "$slot"
}

# Settings for one worktree.
worktree_environment() {
  local slot path_hash
  slot=$(worktree_slot "$1")
  path_hash=$(printf '%s' "$1" | cksum | cut -d ' ' -f 1)
  printf '%s\n' \
    "FLUXMAIL_DATA_DIR=$1/.context/fluxmail-data" \
    "FLUXMAIL_DEMO_PROJECT=fluxmail-demo-mailbox-$path_hash" \
    "FLUXMAIL_DEMO_SMTP_PORT=$((43000 + slot))" \
    "FLUXMAIL_DEMO_SMTPS_PORT=$((43500 + slot))" \
    "FLUXMAIL_DEMO_IMAPS_PORT=$((44000 + slot))" \
    "FLUXMAIL_DEMO_WEB_PORT=$((44500 + slot))"
}
purpose='data and demo mailbox'

setup() {
  cd "$1" && pnpm install --prefer-offline
}

# Prints the worktree that contains $1, or fails for a main checkout, a
# Conductor workspace or a directory outside git.
linked_worktree() {
  [[ -z "${CONDUCTOR_WORKSPACE_PATH:-}${CONDUCTOR_PORT:-}" ]] || return 1
  local worktree git_dir common_dir
  worktree=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  git_dir=$(git -C "$worktree" rev-parse --path-format=absolute --git-dir)
  common_dir=$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)
  [[ "$git_dir" != "$common_dir" ]] || return 1
  printf '%s\n' "$worktree"
}

exports() {
  local assignment
  while IFS= read -r assignment; do
    printf 'export %q\n' "$assignment"
  done < <(worktree_environment "$1")
}

if [[ "${1:-}" == --env ]]; then
  worktree=$(linked_worktree "${2:-$PWD}") || exit 0
  exports "$worktree"
  exit 0
fi

input=''
[[ -t 0 ]] || input=$(cat)
field() {
  printf '%s' "$input" | node -e '
    let text = "";
    process.stdin.on("data", chunk => (text += chunk));
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(text)[process.argv[1]];
        if (typeof value === "string") process.stdout.write(value);
      } catch {}
    });
  ' "$1"
}
event=$(field hook_event_name)
source=$(field source)
directory=$(field cwd)
[[ -n "$directory" ]] || directory=$PWD

# Claude Code clears the environment file on each CwdChanged event.
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")
  printf '[ ! -f %q ] || eval "$(bash %q --env "$PWD")"\n' "$script" "$script" >> "$CLAUDE_ENV_FILE"
fi
case "$event:$source" in
  SessionStart:startup | PostToolUse:* | :) ;;
  *) exit 0 ;;
esac

worktree=$(linked_worktree "$directory") || exit 0
mkdir -p "$worktree/.context"
log="$worktree/.context/worktree-setup.log"
root=$(dirname "$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)")
if (setup "$worktree" "$root") > "$log" 2>&1; then
  status='Set up this worktree.'
else
  status="Worktree setup failed. Read $log, fix the cause, then run bash scripts/worktree-setup.sh."
fi

if [[ -z "$event" ]]; then
  echo "$status Its $purpose use these settings:"
  exports "$worktree"
  exit 0
fi
settings=$(worktree_environment "$worktree" | paste -sd ' ' -)
node -e '
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: process.argv[1],
      additionalContext: process.argv[2],
    },
  }));
' "$event" "$status Its $purpose use $settings, which Bash commands in this worktree get automatically."
