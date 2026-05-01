#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v cwebp >/dev/null 2>&1; then
  echo "skip: cwebp is required for runner tests" >&2
  exit 0
fi

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

create_fixture_repo() {
  local fixture="$1"

  mkdir -p "${fixture}/config" "${fixture}/articles"
  printf '# Test config\n' > "${fixture}/config/test.md"
}

create_git_fixture_repo() {
  local fixture="$1"

  create_fixture_repo "$fixture"
  git -C "$fixture" init -b main >/dev/null
  git -C "$fixture" config user.name "Test User"
  git -C "$fixture" config user.email "test@example.com"
  git -C "$fixture" add config/test.md
  git -C "$fixture" commit -m "test: initialize fixture" >/dev/null
}

create_mock_codex() {
  local bin_dir="$1"

  mkdir -p "$bin_dir"
  cat > "${bin_dir}/codex" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

cd_dir=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == "--cd" ]]; then
    cd_dir="$arg"
    break
  fi
  previous="$arg"
done

if [[ -z "$cd_dir" ]]; then
  echo "mock codex: --cd is required" >&2
  exit 1
fi

mkdir -p "$cd_dir"

if [[ "${MOCK_INDEX:-yes}" == "yes" ]]; then
  {
    printf -- '---\n'
    printf 'title: %s\n' "${MOCK_TITLE:-Mock Article}"
    if [[ "${MOCK_SLUG_PRESENT:-yes}" == "yes" ]]; then
      printf 'slug: %s\n' "${MOCK_SLUG:-mock-article}"
    fi
    printf 'createdAt: 2026-05-01T00:00:00+09:00\n'
    printf 'updatedAt: 2026-05-01T00:00:00+09:00\n'
    printf -- '---\n\n# Mock Article\n'
  } > "${cd_dir}/index.md"
fi

case "${MOCK_THUMBNAIL:-valid}" in
  valid)
    "${MAKE_WEBP}" "${cd_dir}/thumbnail.webp" 1200 630
    ;;
  missing)
    ;;
  text)
    printf 'not a webp\n' > "${cd_dir}/thumbnail.webp"
    ;;
  wrong-size)
    "${MAKE_WEBP}" "${cd_dir}/thumbnail.webp" 100 100
    ;;
esac
MOCK
  chmod +x "${bin_dir}/codex"
}

run_runner() {
  local fixture="$1"
  shift

  PATH="${test_root}/bin:${PATH}" \
  MAKE_WEBP="${test_root}/make-webp" \
  ARTICLE_REPO_ROOT="$fixture" \
  ARTICLE_GENERATOR_ROOT="$repo_root" \
  OPENAI_API_KEY=test-key \
  TZ=UTC \
  "$@" \
  "$repo_root/entrypoint.sh"
}

run_action_entrypoint() {
  local fixture="$1"
  shift

  PATH="${test_root}/bin:${PATH}" \
  MAKE_WEBP="${test_root}/make-webp" \
  GITHUB_WORKSPACE="$fixture" \
  ARTICLE_GENERATOR_ROOT="$repo_root" \
  INPUT_TIMEZONE=UTC \
  "$@" \
  "$repo_root/entrypoint.sh"
}

assert_success() {
  local name="$1"
  shift

  if "$@"; then
    printf 'ok: %s\n' "$name"
  else
    printf 'not ok: %s\n' "$name" >&2
    exit 1
  fi
}

assert_failure() {
  local name="$1"
  shift

  if "$@"; then
    printf 'not ok: %s\n' "$name" >&2
    exit 1
  else
    printf 'ok: %s\n' "$name"
  fi
}

cat > "${test_root}/make-webp" <<'MAKEWEBP'
#!/usr/bin/env bash
set -euo pipefail
output_file="$1"
width="$2"
height="$3"
ppm_file="${output_file}.ppm"
{
  printf 'P6\n%s %s\n255\n' "$width" "$height"
  dd if=/dev/zero bs=$((width * height * 3)) count=1 2>/dev/null
} > "$ppm_file"
cwebp -quiet "$ppm_file" -o "$output_file"
rm -f "$ppm_file"
MAKEWEBP
chmod +x "${test_root}/make-webp"

create_mock_codex "${test_root}/bin"

bash -n "${repo_root}/entrypoint.sh"
bash -n "${repo_root}/tests/run-generate-article.sh"
printf 'ok: shell scripts parse successfully\n'

ruby -e 'require "yaml"; ARGV.each { |path| YAML.load_file(path) }' \
  "${repo_root}/action.yml" \
  "${repo_root}/templates/user-repo/.github/workflows/generate-article.yml"
printf 'ok: YAML files parse successfully\n'

grep -q 'using: docker' "${repo_root}/action.yml"
grep -q 'image: Dockerfile' "${repo_root}/action.yml"
grep -q '^FROM node:24-bookworm-slim$' "${repo_root}/Dockerfile"
grep -q '^RUN npm install -g @openai/codex@latest$' "${repo_root}/Dockerfile"
! grep -q '^[[:space:]]*git \\' "${repo_root}/Dockerfile"
grep -q '^COPY PROMPT\.md /opt/article-generator/PROMPT\.md$' "${repo_root}/Dockerfile"
grep -q '^COPY entrypoint\.sh /opt/article-generator/entrypoint\.sh$' "${repo_root}/Dockerfile"
grep -q '^ENTRYPOINT \["/opt/article-generator/entrypoint\.sh"\]$' "${repo_root}/Dockerfile"
grep -q 'uses: <owner>/<action-repo>@v1' "${repo_root}/templates/user-repo/.github/workflows/generate-article.yml"
grep -q 'Commit generated article' "${repo_root}/templates/user-repo/.github/workflows/generate-article.yml"
printf 'ok: Docker action interface and image definition are configured\n'

fixture="${test_root}/valid"
create_fixture_repo "$fixture"
assert_success "moves a valid draft into the dated slug directory" run_runner "$fixture" env
test -f "${fixture}/articles/$(TZ=UTC date +%F)/mock-article/index.md"
test -f "${fixture}/articles/$(TZ=UTC date +%F)/mock-article/thumbnail.webp"

fixture="${test_root}/duplicate"
create_fixture_repo "$fixture"
mkdir -p "${fixture}/articles/$(TZ=UTC date +%F)/mock-article"
assert_success "adds a numeric suffix when the slug directory exists" run_runner "$fixture" env
test -d "${fixture}/articles/$(TZ=UTC date +%F)/mock-article-2"

fixture="${test_root}/invalid-slug"
create_fixture_repo "$fixture"
assert_failure "rejects an invalid slug" run_runner "$fixture" env MOCK_SLUG='Invalid Slug'

fixture="${test_root}/missing-thumbnail"
create_fixture_repo "$fixture"
assert_failure "rejects a missing thumbnail" run_runner "$fixture" env MOCK_THUMBNAIL=missing

fixture="${test_root}/wrong-mime"
create_fixture_repo "$fixture"
assert_failure "rejects a non-WebP thumbnail" run_runner "$fixture" env MOCK_THUMBNAIL=text

fixture="${test_root}/wrong-size"
create_fixture_repo "$fixture"
assert_failure "rejects a thumbnail with the wrong dimensions" run_runner "$fixture" env MOCK_THUMBNAIL=wrong-size

fixture="${test_root}/runner-missing-key"
create_fixture_repo "$fixture"
assert_failure "runner requires OPENAI_API_KEY" env \
  PATH="${test_root}/bin:${PATH}" \
  MAKE_WEBP="${test_root}/make-webp" \
  ARTICLE_REPO_ROOT="$fixture" \
  ARTICLE_GENERATOR_ROOT="$repo_root" \
  OPENAI_API_KEY= \
  TZ=UTC \
  "$repo_root/entrypoint.sh"

fixture="${test_root}/entrypoint-valid"
create_git_fixture_repo "$fixture"
before_head="$(git -C "$fixture" rev-parse HEAD)"
assert_success "action entrypoint runs the generator without committing article changes" run_action_entrypoint "$fixture" env INPUT_OPENAI_API_KEY=test-key
test -f "${fixture}/articles/$(TZ=UTC date +%F)/mock-article/index.md"
after_head="$(git -C "$fixture" rev-parse HEAD)"
test "$before_head" = "$after_head"
test -n "$(git -C "$fixture" status --porcelain -- articles)"

fixture="${test_root}/entrypoint-missing-key"
create_git_fixture_repo "$fixture"
assert_failure "action entrypoint requires an OpenAI API key" run_action_entrypoint "$fixture" env OPENAI_API_KEY=
