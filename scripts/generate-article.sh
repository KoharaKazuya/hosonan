#!/usr/bin/env bash

set -euo pipefail

if (($# != 0)); then
  echo "error: this command does not accept arguments" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prompt_file="${repo_root}/PROMPT.md"
run_date="$(date +%F)"
date_dir="${repo_root}/articles/${run_date}"
draft_dir="${repo_root}/draft"
draft_index_file="${draft_dir}/index.md"

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

available_output_dir() {
  local path="${date_dir}/$1"
  local index=2

  while [[ -e "$path" ]]; do
    path="${date_dir}/$1-${index}"
    index=$((index + 1))
  done

  printf '%s' "$path"
}

if [[ -e "$draft_dir" ]]; then
  if [[ ! -d "$draft_dir" ]]; then
    echo "error: draft exists but is not a directory: $(relative_path "$draft_dir")" >&2
    exit 1
  fi

  if [[ -n "$(find "$draft_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "error: draft directory is not empty: $(relative_path "$draft_dir")" >&2
    exit 1
  fi
else
  mkdir -p "$draft_dir"
fi

mkdir -p "$date_dir"

log "prompt: $(relative_path "$prompt_file")"
log "config directory: config/"
log "draft directory: $(relative_path "$draft_dir")"
log "output date directory: $(relative_path "$date_dir")"
log "web search: live"
log "sandbox: workspace-write ($(relative_path "$draft_dir") only)"
log "running codex"

codex --search --sandbox workspace-write --ask-for-approval never exec --cd "$draft_dir" - < "$prompt_file" > /dev/null

if [[ ! -f "$draft_index_file" ]]; then
  echo "error: generated draft is missing index.md" >&2
  exit 1
fi

slug="$(awk -F: '/^slug:[[:space:]]*/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit }' "$draft_index_file")"
if [[ ! "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  if [[ -z "$slug" ]]; then
    echo "error: generated article is missing slug metadata" >&2
  else
    echo "error: invalid slug in generated article: $slug" >&2
  fi
  exit 1
fi

output_dir="$(available_output_dir "$slug")"
mv "$draft_dir" "$output_dir"

echo "generated: $(relative_path "$output_dir")"
