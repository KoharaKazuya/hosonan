#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: extract-article-titles.sh <articles-dir>" >&2
  exit 2
fi

articles_dir="${1%/}"
today="${HOSONAN_TODAY:-$(date +%F)}"

date_days_ago() {
  local base_date="$1"
  local days="$2"

  if date -j -v-"${days}"d -f '%F' "$base_date" +%F >/dev/null 2>&1; then
    date -j -v-"${days}"d -f '%F' "$base_date" +%F
  else
    date -d "${base_date} ${days} days ago" +%F
  fi
}

if [[ ! "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "error: HOSONAN_TODAY must be YYYY-MM-DD" >&2
  exit 2
fi

cutoff_date="$(date_days_ago "$today" 6)"

find "$articles_dir" -type f -name '*.md' -print0 |
  sort -z |
  while IFS= read -r -d '' article_file; do
    article_relative="${article_file#"$articles_dir"/}"
    article_date="${article_relative%%/*}"

    if [[ ! "$article_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      continue
    fi

    if [[ "$article_date" < "$cutoff_date" || "$article_date" > "$today" ]]; then
      continue
    fi

    metadata="$(
      awk '
        NR == 1 {
          if ($0 != "---") {
            exit
          }
          in_front_matter = 1
          next
        }

        in_front_matter && ($0 == "---" || $0 == "...") {
          exit
        }

        in_front_matter && /^(title|summary):[[:space:]]*/ {
          key = $0
          sub(/:.*/, "", key)
          value = $0
          sub(/^[^:]+:[[:space:]]*/, "", value)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
          if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
            value = substr(value, 2, length(value) - 2)
          }
          values[key] = value
        }

        END {
          if ("title" in values) {
            print values["title"] "\t" values["summary"]
          }
        }
      ' "$article_file"
    )"

    if [[ -n "$metadata" ]]; then
      printf '%s\t%s\t%s\n' "$article_date" "$article_file" "$metadata"
    fi
  done |
  sort -t '	' -k1,1r -k2,2 |
  cut -f2-
