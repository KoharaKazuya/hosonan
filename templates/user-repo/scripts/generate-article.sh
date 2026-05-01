#!/usr/bin/env bash

set -euo pipefail

if (($# != 0)); then
  echo "error: this command does not accept arguments" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
generator_root="${ARTICLE_GENERATOR_ROOT:-}"

if [[ -z "$generator_root" ]]; then
  echo "error: ARTICLE_GENERATOR_ROOT must point to the cloned article generator repository" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "error: Codex CLI is not installed or is not on PATH" >&2
  exit 1
fi

if ! codex login status >/dev/null 2>&1; then
  echo "error: Codex CLI is not logged in" >&2
  echo "Run 'codex login' and then retry scripts/generate-article.sh." >&2
  exit 1
fi

ARTICLE_REPO_ROOT="$repo_root" \
ARTICLE_GENERATOR_ROOT="$generator_root" \
"${generator_root}/scripts/run-generate-article.sh"
