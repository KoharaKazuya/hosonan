#!/usr/bin/env bash

set -euo pipefail

if (($# != 0)); then
  echo "error: this command does not accept arguments" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_generator_root="$script_dir"

if [[ -n "${INPUT_OPENAI_API_KEY:-}" ]]; then
  export OPENAI_API_KEY="$INPUT_OPENAI_API_KEY"
fi

if [[ -n "${INPUT_TIMEZONE:-}" ]]; then
  export ARTICLE_TIMEZONE="$INPUT_TIMEZONE"
fi

article_repo_root="${ARTICLE_REPO_ROOT:-${GITHUB_WORKSPACE:-$(pwd)}}"
generator_root="${ARTICLE_GENERATOR_ROOT:-$default_generator_root}"
prompt_file="${ARTICLE_PROMPT_FILE:-${generator_root}/PROMPT.md}"
codex_bin="${CODEX_BIN:-codex}"

article_repo_root="$(cd "$article_repo_root" && pwd)"
generator_root="$(cd "$generator_root" && pwd)"

if [[ -n "${ARTICLE_TIMEZONE:-}" ]]; then
  export TZ="$ARTICLE_TIMEZONE"
fi

run_date="$(date +%F)"
date_dir="${article_repo_root}/articles/${run_date}"
draft_dir="${article_repo_root}/draft"
draft_index_file="${draft_dir}/index.md"
draft_thumbnail_file="${draft_dir}/thumbnail.webp"
article_title_max_chars=200
article_summary_max_chars=200

current_log_group=""

log_group_start() {
  local title="$1"

  log_group_end

  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::group::%s\n' "$title" >&2
  else
    printf '\n== %s ==\n' "$title" >&2
  fi

  current_log_group="$title"
}

log_group_end() {
  if [[ -z "$current_log_group" ]]; then
    return
  fi

  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::endgroup::\n' >&2
  fi

  current_log_group=""
}

log_step() {
  printf -- '-- %s\n' "$*" >&2
}

trap log_group_end EXIT

relative_path() {
  local path="$1"

  if [[ "$path" == "$article_repo_root"/* ]]; then
    printf '%s' "${path#"$article_repo_root"/}"
  else
    printf '%s' "$path"
  fi
}

front_matter_value() {
  local key="$1"
  local file="$2"

  awk -v key="$key" '
    NR == 1 && $0 == "---" {
      in_front_matter = 1
      next
    }
    in_front_matter && $0 == "---" {
      exit
    }
    in_front_matter && index($0, key ":") == 1 {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      quote = sprintf("%c", 39)
      if (substr(value, 1, 1) == quote && substr(value, length(value), 1) == quote) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$file"
}

string_length() {
  local value="$1"

  awk -v value="$value" 'BEGIN { print length(value) }'
}

validate_front_matter_text() {
  local key="$1"
  local value="$2"
  local max_chars="$3"

  if [[ -z "$value" ]]; then
    echo "error: generated article is missing ${key} metadata" >&2
    exit 1
  fi

  local length
  length="$(string_length "$value")"
  if ((length > max_chars)); then
    echo "error: generated article ${key} is too long: ${length} chars (max ${max_chars})" >&2
    exit 1
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

image_dimensions() {
  local image_file="$1"
  local width=""
  local height=""

  if command -v sips >/dev/null 2>&1; then
    width="$(sips -g pixelWidth "$image_file" 2>/dev/null | awk '/pixelWidth:/ { print $2; exit }')"
    height="$(sips -g pixelHeight "$image_file" 2>/dev/null | awk '/pixelHeight:/ { print $2; exit }')"
    if [[ -n "$width" && -n "$height" ]]; then
      printf '%s %s\n' "$width" "$height"
      return 0
    fi
  fi

  if command -v magick >/dev/null 2>&1; then
    magick identify -format '%w %h\n' "$image_file"
    return
  fi

  if command -v identify >/dev/null 2>&1; then
    identify -format '%w %h\n' "$image_file"
    return
  fi

  return 1
}

log_group_start "Prepare workspace"

if [[ ! -f "$prompt_file" ]]; then
  echo "error: prompt file is missing: $prompt_file" >&2
  exit 1
fi

if [[ ! -d "${article_repo_root}/config" ]]; then
  echo "error: config directory is missing: config/" >&2
  exit 1
fi

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

log_step "Prompt: $prompt_file"
log_step "Config directory: config/"
log_step "Draft directory: $(relative_path "$draft_dir")"
log_step "Output date directory: $(relative_path "$date_dir")"
log_step "Timezone: ${TZ:-system default}"
log_step "Web search: live"
log_step "Codex working directory: $(relative_path "$draft_dir")"
log_group_end

log_group_start "Run Codex CLI"
"$codex_bin" --search --dangerously-bypass-approvals-and-sandbox exec --cd "$draft_dir" - < "$prompt_file" >&2
log_group_end

log_group_start "Validate generated files"
log_step "Checking generated article file"

if [[ ! -f "$draft_index_file" ]]; then
  echo "error: generated draft is missing index.md" >&2
  exit 1
fi

log_step "Checking generated thumbnail file"

if [[ ! -f "$draft_thumbnail_file" ]]; then
  echo "error: generated draft is missing thumbnail.webp" >&2
  exit 1
fi

log_step "Checking thumbnail MIME type"
thumbnail_type="$(file --brief --mime-type "$draft_thumbnail_file")"
if [[ "$thumbnail_type" != "image/webp" ]]; then
  echo "error: generated thumbnail is not WebP: $thumbnail_type" >&2
  exit 1
fi

log_step "Checking thumbnail dimensions"
thumbnail_dimensions="$(image_dimensions "$draft_thumbnail_file" || true)"
if [[ -z "$thumbnail_dimensions" ]]; then
  echo "error: could not validate thumbnail dimensions; install sips or ImageMagick" >&2
  exit 1
fi

read -r thumbnail_width thumbnail_height <<< "$thumbnail_dimensions"
if [[ "$thumbnail_width" != "1200" || "$thumbnail_height" != "630" ]]; then
  echo "error: invalid thumbnail dimensions: ${thumbnail_width:-unknown}x${thumbnail_height:-unknown} (expected 1200x630)" >&2
  exit 1
fi
log_group_end

log_group_start "Read article metadata"
log_step "Reading title"
title="$(front_matter_value "title" "$draft_index_file")"
validate_front_matter_text "title" "$title" "$article_title_max_chars"

log_step "Reading summary"
summary="$(front_matter_value "summary" "$draft_index_file")"
validate_front_matter_text "summary" "$summary" "$article_summary_max_chars"

log_step "Reading slug"
slug="$(front_matter_value "slug" "$draft_index_file")"
if [[ ! "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  if [[ -z "$slug" ]]; then
    echo "error: generated article is missing slug metadata" >&2
  else
    echo "error: invalid slug in generated article: $slug" >&2
  fi
  exit 1
fi
log_group_end

log_group_start "Move article to output directory"
output_dir="$(available_output_dir "$slug")"
log_step "Moving draft to $(relative_path "$output_dir")"
mv "$draft_dir" "$output_dir"
output_directory="$(relative_path "$output_dir")"
log_group_end

log_group_start "Result"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'title=%s\n' "$title"
    printf 'directory=%s\n' "$output_directory"
  } >> "$GITHUB_OUTPUT"
fi

printf 'title: %s\n' "$title"
printf 'directory: %s\n' "$output_directory"

log_group_end
