#!/usr/bin/env bash

set -euo pipefail

PROGRAM_NAME="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage:
  remote-codex-login.sh [--yes] [--force]

Options:
  -y, --yes    Skip the initial confirmation prompt.
  -f, --force  Start login even if already logged in.
  -h, --help   Show this help.

This script runs `codex login --device-auth` so you can complete
ChatGPT sign-in from a remote or headless console session.
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

main() {
  local assume_yes=0
  local force_login=0
  local status_output=""

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

  printf 'Codex remote login helper\n'
  printf '\n'
  printf 'This script starts ChatGPT device authentication for Codex.\n'
  printf 'Open the displayed URL on your local machine, sign in, and complete workspace selection if prompted.\n'
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
      if ! prompt_yes_no "Start ChatGPT device login now?"; then
        printf 'Cancelled.\n'
        exit 0
      fi
    fi
  fi

  printf '\n'
  printf 'Starting `codex login --device-auth`...\n'
  printf '\n'

  codex login --device-auth

  printf '\n'
  printf 'Login status after authentication:\n'
  show_status
}

main "$@"
