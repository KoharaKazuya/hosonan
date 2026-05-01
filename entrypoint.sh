#!/usr/bin/env bash

set -euo pipefail

if (($# != 0)); then
  echo "error: this action does not accept arguments" >&2
  exit 2
fi

if [[ -z "${INPUT_OPENAI_API_KEY:-}" ]]; then
  echo "error: openai-api-key input is required." >&2
  exit 1
fi

workspace="${GITHUB_WORKSPACE:-/github/workspace}"
generator_root="${ARTICLE_GENERATOR_ROOT:-/opt/article-generator}"

export ARTICLE_REPO_ROOT="$workspace"
export ARTICLE_GENERATOR_ROOT="$generator_root"
export ARTICLE_TIMEZONE="${INPUT_TIMEZONE:-Asia/Tokyo}"
export OPENAI_API_KEY="$INPUT_OPENAI_API_KEY"

cd "$ARTICLE_REPO_ROOT"

"${ARTICLE_GENERATOR_ROOT}/scripts/run-generate-article.sh"
