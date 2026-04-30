#!/usr/bin/env bash

set -euo pipefail

if (($# != 0)); then
  echo "error: this command does not accept arguments" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prompt_file="${repo_root}/PROMPT.md"
user_profile_file="${repo_root}/config/user-profile.md"
run_date="$(date +%F)"
run_time="$(date +%H%M%S)"
output_dir="${repo_root}/articles/${run_date}"
temp_output_file="${output_dir}/.generating-${run_time}-$$.md"
trap 'rm -f "$temp_output_file"' EXIT

log() {
  printf '%s\n' "$*" >&2
}

relative_path() {
  local path="$1"

  if [[ "$path" == "$repo_root"/* ]]; then
    printf '%s' "${path#"$repo_root"/}"
  else
    printf '%s' "$path"
  fi
}

available_output_file() {
  local path="${output_dir}/$1.md"
  local index=2

  while [[ -e "$path" ]]; do
    path="${output_dir}/$1-${index}.md"
    index=$((index + 1))
  done

  printf '%s' "$path"
}

if [[ ! -f "$prompt_file" ]]; then
  echo "error: PROMPT.md was not found: $prompt_file" >&2
  exit 1
fi

if [[ ! -f "$user_profile_file" ]]; then
  echo "error: user profile was not found: $user_profile_file" >&2
  exit 1
fi

mkdir -p "$output_dir"
: > "$temp_output_file"

log "prompt: $(relative_path "$prompt_file")"
log "profile: $(relative_path "$user_profile_file")"
log "output directory: $(relative_path "$output_dir")"
log "web search: live"
log "running codex"

codex --search exec --cd "$repo_root" --output-last-message "$temp_output_file" - < "$prompt_file" > /dev/null

slug="$(awk -F: '/^slug:[[:space:]]*/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit }' "$temp_output_file")"
if [[ ! "$slug" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  if [[ -z "$slug" ]]; then
    echo "error: generated article is missing slug metadata" >&2
  else
    echo "error: invalid slug in generated article: $slug" >&2
  fi
  exit 1
fi

output_file="$(available_output_file "$slug")"
mv "$temp_output_file" "$output_file"
trap - EXIT

echo "generated: $(relative_path "$output_file")"
