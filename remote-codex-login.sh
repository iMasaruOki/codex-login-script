#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  remote-codex-login.sh [--yes] [--force]

Options:
  -y, --yes    Skip the initial confirmation prompt.
  -f, --force  Start login even if already logged in.
  -h, --help   Show this help.

This script runs `codex login`, shows the ChatGPT browser URL on the remote
console, then forwards the final localhost callback URL back into the remote
Codex login server after you paste it.
EOF
}

print_err() {
  printf '%s\n' "$*" >&2
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    print_err "Required command not found: $cmd"
    exit 1
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local answer

  while true; do
    read -r -p "$prompt [y/N]: " answer
    case "${answer,,}" in
      y|yes)
        return 0
        ;;
      ""|n|no)
        return 1
        ;;
      *)
        printf 'Please answer y or n.\n'
        ;;
    esac
  done
}

show_status() {
  if codex login status 2>/dev/null; then
    return 0
  fi

  printf 'Not logged in.\n'
  return 1
}

cleanup() {
  if [[ -n "${LOGIN_PID:-}" ]] && kill -0 "$LOGIN_PID" >/dev/null 2>&1; then
    kill "$LOGIN_PID" >/dev/null 2>&1 || true
    wait "$LOGIN_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "${LOG_FILE:-}" && -f "${LOG_FILE:-}" ]]; then
    rm -f "$LOG_FILE"
  fi
}

extract_auth_url() {
  grep -Eo 'https://auth\.openai\.com/oauth/authorize[^[:space:]]+' "$1" | tail -n 1
}

extract_port() {
  grep -Eo 'http://localhost:[0-9]+' "$1" | tail -n 1 | sed -E 's#http://localhost:([0-9]+)#\1#'
}

normalize_callback_url() {
  local callback_url="$1"
  local port="$2"

  case "$callback_url" in
    "http://localhost:${port}/auth/callback"*)
      printf 'http://127.0.0.1:%s%s\n' "$port" "${callback_url#http://localhost:${port}}"
      ;;
    "http://127.0.0.1:${port}/auth/callback"*)
      printf '%s\n' "$callback_url"
      ;;
    "http://[::1]:${port}/auth/callback"*)
      printf 'http://127.0.0.1:%s%s\n' "$port" "${callback_url#http://\[::1\]:${port}}"
      ;;
    *)
      return 1
      ;;
  esac
}

wait_for_login_bootstrap() {
  local auth_url=""
  local port=""
  local attempts=0

  while [[ $attempts -lt 50 ]]; do
    if ! kill -0 "$LOGIN_PID" >/dev/null 2>&1; then
      print_err "codex login exited before printing the browser URL."
      if [[ -s "$LOG_FILE" ]]; then
        print_err ""
        print_err "Captured output:"
        cat "$LOG_FILE" >&2
      fi
      exit 1
    fi

    auth_url="$(extract_auth_url "$LOG_FILE" || true)"
    port="$(extract_port "$LOG_FILE" || true)"
    if [[ -n "$auth_url" && -n "$port" ]]; then
      AUTH_URL="$auth_url"
      LOGIN_PORT="$port"
      return 0
    fi

    sleep 0.2
    attempts=$((attempts + 1))
  done

  print_err "Timed out waiting for codex login to print the browser URL."
  if [[ -s "$LOG_FILE" ]]; then
    print_err ""
    print_err "Captured output:"
    cat "$LOG_FILE" >&2
  fi
  exit 1
}

main() {
  local assume_yes=0
  local force_login=0
  local status_output=""
  local callback_url=""
  local relay_url=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes)
        assume_yes=1
        ;;
      -f|--force)
        force_login=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        print_err "Unknown option: $1"
        usage >&2
        exit 1
        ;;
    esac
    shift
  done

  require_command codex
  require_command curl

  printf 'Codex remote login helper\n'
  printf '\n'
  printf 'This script uses regular `codex login` and relays the final localhost callback on the remote host.\n'
  printf '\n'
  printf 'Current login status:\n'
  if ! status_output="$(codex login status 2>&1)"; then
    status_output='Not logged in.'
  fi
  printf '%s\n' "$status_output"
  printf '\n'

  if [[ $assume_yes -eq 0 ]]; then
    if [[ $status_output == Logged\ in* && $force_login -eq 0 ]]; then
      if ! prompt_yes_no "Codex is already logged in. Start login again?"; then
        printf 'Cancelled.\n'
        exit 0
      fi
    else
      if ! prompt_yes_no "Start ChatGPT login now?"; then
        printf 'Cancelled.\n'
        exit 0
      fi
    fi
  fi

  LOG_FILE="$(mktemp)"
  trap cleanup EXIT

  printf '\n'
  printf 'Starting `codex login`...\n'
  printf '\n'

  ( printf '\n' | codex login ) >"$LOG_FILE" 2>&1 &
  LOGIN_PID=$!

  wait_for_login_bootstrap

  printf 'Open this URL in a browser on your local machine:\n'
  printf '%s\n' "$AUTH_URL"
  printf '\n'
  printf 'Finish account login, passkey or password entry, and workspace selection if prompted.\n'
  printf 'The browser will likely end on a failed page such as localhost:%s.\n' "$LOGIN_PORT"
  printf 'Copy the full URL from the browser address bar and paste it below.\n'
  printf '\n'

  while true; do
    read -r -p "Paste final callback URL: " callback_url
    if relay_url="$(normalize_callback_url "$callback_url" "$LOGIN_PORT")"; then
      break
    fi
    printf 'Expected a URL like http://localhost:%s/auth/callback?... Please try again.\n' "$LOGIN_PORT"
  done

  printf '\n'
  printf 'Relaying callback to the remote Codex login server...\n'
  curl --fail --silent --show-error "$relay_url" >/dev/null

  if ! wait "$LOGIN_PID"; then
    print_err "codex login failed."
    if [[ -s "$LOG_FILE" ]]; then
      print_err ""
      print_err "Captured output:"
      cat "$LOG_FILE" >&2
    fi
    exit 1
  fi

  LOGIN_PID=""

  printf 'Authentication completed.\n'
  printf '\n'
  printf 'Login status after authentication:\n'
  show_status
}

main "$@"
