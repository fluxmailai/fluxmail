#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
compose_file="$repo_root/demo/mailbox/compose.yml"
messages_dir="$repo_root/demo/mailbox/messages"

action="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

version=""
command_args=()
if [[ "${1:-}" == "--" ]]; then
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ $# -lt 2 ]]; then
        echo "--version requires a value." >&2
        exit 2
      fi
      version="$2"
      shift 2
      ;;
    --)
      shift
      command_args+=("$@")
      break
      ;;
    *)
      command_args+=("$@")
      break
      ;;
  esac
done

demo_address="${FLUXMAIL_DEMO_ADDRESS:-demo@example.com}"
demo_name="${FLUXMAIL_DEMO_NAME:-Demo User}"
admin_name="${FLUXMAIL_DEMO_ADMIN_NAME:-Demo Admin}"
admin_email="${FLUXMAIL_DEMO_ADMIN_EMAIL:-admin@example.com}"
fluxmail_password="${FLUXMAIL_DEMO_PASSWORD:-Signal harbor maple 2026!}"
mailbox_password="${FLUXMAIL_DEMO_MAILBOX_PASSWORD:-fluxmail-demo}"
mailbox_host="${FLUXMAIL_DEMO_HOST:-127.0.0.1}"
imaps_port="${FLUXMAIL_DEMO_IMAPS_PORT:-3993}"
smtps_port="${FLUXMAIL_DEMO_SMTPS_PORT:-3465}"
smtp_port="${FLUXMAIL_DEMO_SMTP_PORT:-3025}"
web_port="${FLUXMAIL_DEMO_WEB_PORT:-8080}"
project_name="${FLUXMAIL_DEMO_PROJECT:-fluxmail-demo-mailbox}"
preload_dir="$repo_root/.context/demo-mailbox/preload"

if [[ ! "$demo_address" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]]; then
  echo "FLUXMAIL_DEMO_ADDRESS must be an email address." >&2
  exit 2
fi
if [[ ! "$demo_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]{0,63}$ ]]; then
  echo "FLUXMAIL_DEMO_NAME contains unsupported characters." >&2
  exit 2
fi
if [[ ! "$mailbox_password" =~ ^[A-Za-z0-9._+-]{1,64}$ ]]; then
  echo "FLUXMAIL_DEMO_MAILBOX_PASSWORD contains unsupported characters." >&2
  exit 2
fi
if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "FLUXMAIL_DEMO_PROJECT must contain lowercase letters, numbers, underscores, or hyphens." >&2
  exit 2
fi
if [[ -n "$version" && ! "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$ ]]; then
  echo "--version must be a valid npm version or tag." >&2
  exit 2
fi
for port in "$smtp_port" "$smtps_port" "$imaps_port" "$web_port"; do
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || ((port > 65535)); then
    echo "Demo ports must be integers from 1 through 65535." >&2
    exit 2
  fi
done

mailbox_user="${demo_address%@*}"
mailbox_domain="${demo_address#*@}"

if [[ -n "$version" ]]; then
  data_dir="$repo_root/.context/demo-fluxmail/npm-$version"
  fluxmail_launcher=(npx -y --package "fluxmail@$version" --)
  fluxmail_command=(fluxmail)
else
  data_dir="$repo_root/.context/demo-fluxmail/workspace"
  fluxmail_launcher=()
  fluxmail_command=(node "$repo_root/packages/server/dist/cli.js")
fi

export FLUXMAIL_DEMO_MAILBOX_USER="$mailbox_user"
export FLUXMAIL_DEMO_MAILBOX_DOMAIN="$mailbox_domain"
export FLUXMAIL_DEMO_MAILBOX_PASSWORD="$mailbox_password"
export FLUXMAIL_DEMO_PRELOAD_DIR="$preload_dir"
export FLUXMAIL_DEMO_SMTP_PORT="$smtp_port"
export FLUXMAIL_DEMO_IMAPS_PORT="$imaps_port"
export FLUXMAIL_DEMO_SMTPS_PORT="$smtps_port"
export FLUXMAIL_DEMO_WEB_PORT="$web_port"

compose() {
  docker compose --project-name "$project_name" --file "$compose_file" "$@"
}

run_fluxmail() {
  ${fluxmail_launcher[@]+"${fluxmail_launcher[@]}"} env \
    FLUXMAIL_DATA_DIR="$data_dir" \
    FLUXMAIL_PASSWORD="$fluxmail_password" \
    FLUXMAIL_TELEMETRY=0 \
    DEMO_MAILBOX_PASSWORD="$mailbox_password" \
    NODE_TLS_REJECT_UNAUTHORIZED=0 \
    NODE_NO_WARNINGS=1 \
    "${fluxmail_command[@]}" --no-update-notifier "$@"
}

render_messages() {
  local inbox_dir="$preload_dir/$demo_address/INBOX"
  local next_dir="$repo_root/.context/demo-mailbox/preload.next"

  rm -rf "$next_dir"
  mkdir -p "$next_dir/$demo_address/INBOX"
  for folder in Sent Drafts Trash Archive Spam; do
    mkdir -p "$next_dir/$demo_address/$folder"
  done
  for source in "$messages_dir"/*.eml; do
    sed \
      -e "s/{{DEMO_ADDRESS}}/$demo_address/g" \
      -e "s/{{DEMO_NAME}}/$demo_name/g" \
      "$source" >"$next_dir/$demo_address/INBOX/$(basename "$source")"
  done
  rm -rf "$preload_dir"
  mv "$next_dir" "$preload_dir"

  message_count="$(find "$inbox_dir" -maxdepth 1 -type f -name '*.eml' | wc -l | tr -d ' ')"
}

wait_for_mailbox() {
  for _attempt in {1..40}; do
    if curl --silent --output /dev/null "http://127.0.0.1:$web_port/"; then
      return 0
    fi
    sleep 0.25
  done
  echo "GreenMail did not become ready. Run 'docker compose --project-name $project_name --file $compose_file logs' for details." >&2
  return 1
}

reset_mailbox() {
  mkdir -p "$repo_root/.context/demo-mailbox"
  render_messages
  compose up --detach --force-recreate
  wait_for_mailbox
  echo "Synthetic mailbox reset with $message_count messages at $demo_address."
}

backup_data() {
  mkdir -p "$repo_root/.context/demo-backups"
  if [[ -d "$data_dir" ]]; then
    local backup_dir
    backup_dir="$(mktemp -d "$repo_root/.context/demo-backups/fluxmail.XXXXXX")"
    mv "$data_dir" "$backup_dir/data"
    echo "Previous demo data moved to $backup_dir/data"
  fi
}

verify_release() {
  if [[ -z "$version" ]]; then
    return
  fi
  local published_version
  published_version="$(npm view "fluxmail@$version" version 2>/dev/null || true)"
  if [[ -z "$published_version" ]]; then
    echo "fluxmail@$version is not available from npm." >&2
    exit 1
  fi
}

setup_demo() {
  if [[ ${#command_args[@]} -gt 0 ]]; then
    echo "setup does not accept Fluxmail command arguments." >&2
    exit 2
  fi

  verify_release
  reset_mailbox
  if [[ -z "$version" ]]; then
    (cd "$repo_root" && pnpm build)
  fi
  backup_data

  run_fluxmail setup --name "$admin_name" --email "$admin_email"
  run_fluxmail accounts add imap \
    --email "$demo_address" \
    --display-name "$demo_name" \
    --imap-host "$mailbox_host" \
    --imap-port "$imaps_port" \
    --imap-security tls \
    --imap-user "$mailbox_user" \
    --imap-password-env DEMO_MAILBOX_PASSWORD \
    --smtp-host "$mailbox_host" \
    --smtp-port "$smtps_port" \
    --smtp-security tls \
    --smtp-user "$mailbox_user" \
    --sent-folder Sent \
    --drafts-folder Drafts \
    --trash-folder Trash \
    --archive-folder Archive \
    --spam-folder Spam

  echo
  run_fluxmail accounts list
  echo
  if [[ -n "$version" ]]; then
    echo "Published fluxmail@$version demo environment is ready."
  else
    echo "Workspace demo environment is ready."
  fi
  echo "Run a command with: pnpm demo:run -- ${version:+--version $version }<command>"
}

case "$action" in
  setup)
    setup_demo
    ;;
  reset)
    if [[ ${#command_args[@]} -gt 0 || -n "$version" ]]; then
      echo "reset does not accept arguments." >&2
      exit 2
    fi
    reset_mailbox
    ;;
  stop)
    if [[ ${#command_args[@]} -gt 0 || -n "$version" ]]; then
      echo "stop does not accept arguments." >&2
      exit 2
    fi
    compose down --remove-orphans
    echo "Synthetic mailbox stopped. Its in-memory messages were discarded."
    ;;
  status)
    compose ps
    ;;
  run)
    if [[ ${#command_args[@]} -eq 0 ]]; then
      echo "run requires a Fluxmail command." >&2
      exit 2
    fi
    run_fluxmail "${command_args[@]}"
    ;;
  help|-h|--help)
    echo "Usage:"
    echo "  $0 setup [--version VERSION]"
    echo "  $0 reset"
    echo "  $0 stop"
    echo "  $0 status"
    echo "  $0 run [--version VERSION] -- <fluxmail command>"
    ;;
  *)
    echo "Unknown action: $action" >&2
    exit 2
    ;;
esac
