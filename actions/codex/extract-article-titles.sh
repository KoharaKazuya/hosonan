#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: extract-article-titles.sh <articles-dir>" >&2
  exit 2
fi

articles_dir="$1"

find "$articles_dir" -type f -name '*.md' -print0 |
  sort -z |
  while IFS= read -r -d '' article_file; do
    title="$(
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

        in_front_matter && /^title:[[:space:]]*/ {
          value = $0
          sub(/^title:[[:space:]]*/, "", value)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
          if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
            value = substr(value, 2, length(value) - 2)
          }
          print value
          exit
        }
      ' "$article_file"
    )"

    if [[ -n "$title" ]]; then
      printf '%s\t%s\n' "$article_file" "$title"
    fi
  done
