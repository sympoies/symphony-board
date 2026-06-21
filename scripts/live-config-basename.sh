#!/usr/bin/env bash
set -euo pipefail

env_file="${1:?usage: live-config-basename.sh <stack-env>}"

config_basename="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?SYMPHONY_CONFIG_BASENAME[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n1)"
if [[ -z "$config_basename" ]]; then
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?SYMPHONY_CONFIG_BASENAME[[:space:]]*=' "$env_file"; then
    echo "Invalid SYMPHONY_CONFIG_BASENAME for Live allowlist derivation." >&2
    exit 1
  fi
  config_basename="sources.pg.json"
fi
config_basename="${config_basename%\"}"
config_basename="${config_basename#\"}"
config_basename="${config_basename%\'}"
config_basename="${config_basename#\'}"

case "$config_basename" in
  ""|*/*|*..*)
    echo "Invalid SYMPHONY_CONFIG_BASENAME for Live allowlist derivation." >&2
    exit 1
    ;;
esac

printf '%s\n' "$config_basename"
