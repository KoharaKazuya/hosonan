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

repo_dir="$(cd "${cd_dir}/.." && pwd)"
count_file="${repo_dir}/.mock-codex-count"
call_count=1
if [[ -f "$count_file" ]]; then
  call_count="$(($(cat "$count_file") + 1))"
fi
printf '%s\n' "$call_count" > "$count_file"

value_for_call() {
  local base_name="$1"
  local default_value="$2"
  local call_name="${base_name}_${call_count}"
  printf '%s' "${!call_name:-${!base_name:-$default_value}}"
}

mock_index="$(value_for_call MOCK_INDEX yes)"
mock_title="$(value_for_call MOCK_TITLE "Mock Article")"
mock_summary_present="$(value_for_call MOCK_SUMMARY_PRESENT yes)"
mock_summary="$(value_for_call MOCK_SUMMARY "Mock article summary")"
mock_slug_present="$(value_for_call MOCK_SLUG_PRESENT yes)"
mock_slug="$(value_for_call MOCK_SLUG mock-article)"
mock_thumbnail="$(value_for_call MOCK_THUMBNAIL valid)"

if [[ -n "${MOCK_EXPECT_CODEX_API_KEY:-}" && "${CODEX_API_KEY:-}" != "$MOCK_EXPECT_CODEX_API_KEY" ]]; then
  echo "mock codex: CODEX_API_KEY was not propagated" >&2
  exit 1
fi

if [[ "$mock_index" == "yes" ]]; then
  {
    printf -- '---\n'
    printf 'title: %s\n' "$mock_title"
    if [[ "$mock_summary_present" == "yes" ]]; then
      printf 'summary: %s\n' "$mock_summary"
    fi
    if [[ "$mock_slug_present" == "yes" ]]; then
      printf 'slug: %s\n' "$mock_slug"
    fi
    printf 'createdAt: 2026-05-01T00:00:00+09:00\n'
    printf 'updatedAt: 2026-05-01T00:00:00+09:00\n'
    printf -- '---\n\n# Mock Article\n'
  } > "${cd_dir}/index.md"
fi

case "$mock_thumbnail" in
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
bash -n "${repo_root}/extract-article-titles.sh"
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
! grep -q '^[[:space:]]*bubblewrap \\$' "${repo_root}/Dockerfile"
grep -q -- '--dangerously-bypass-approvals-and-sandbox' "${repo_root}/entrypoint.sh"
! grep -q -- '--sandbox' "${repo_root}/entrypoint.sh"
grep -q '^[[:space:]]*git \\$' "${repo_root}/Dockerfile"
grep -q '^[[:space:]]*ripgrep \\$' "${repo_root}/Dockerfile"
grep -q '^[[:space:]]*tzdata \\$' "${repo_root}/Dockerfile"
grep -q '^[[:space:]]*webp \\$' "${repo_root}/Dockerfile"
! grep -q '^[[:space:]]*jq \\$' "${repo_root}/Dockerfile"
! grep -q '^[[:space:]]*curl \\$' "${repo_root}/Dockerfile"
! grep -q '^[[:space:]]*wget \\$' "${repo_root}/Dockerfile"
! grep -q '^[[:space:]]*build-essential \\$' "${repo_root}/Dockerfile"
grep -q '^COPY PROMPT\.md /opt/hosonan/PROMPT\.md$' "${repo_root}/Dockerfile"
grep -q '^COPY entrypoint\.sh /opt/hosonan/entrypoint\.sh$' "${repo_root}/Dockerfile"
grep -q '^COPY extract-article-titles\.sh /opt/hosonan/extract-article-titles\.sh$' "${repo_root}/Dockerfile"
grep -q '^RUN chmod +x /opt/hosonan/extract-article-titles\.sh$' "${repo_root}/Dockerfile"
grep -q '^ENTRYPOINT \["/opt/hosonan/entrypoint\.sh"\]$' "${repo_root}/Dockerfile"
grep -q 'uses: KoharaKazuya/hosonan/actions/codex@v1' "${repo_root}/templates/user-repo/.github/workflows/generate-article.yml"
grep -q 'article-count: "1"' "${repo_root}/templates/user-repo/.github/workflows/generate-article.yml"
grep -q 'Commit generated article' "${repo_root}/templates/user-repo/.github/workflows/generate-article.yml"
grep -q 'article-count:' "${repo_root}/action.yml"
printf 'ok: Docker action interface and image definition are configured\n'

titles_fixture="${test_root}/titles"
mkdir -p \
  "${titles_fixture}/articles/2026-04-28/old" \
  "${titles_fixture}/articles/2026-04-29/boundary" \
  "${titles_fixture}/articles/2026-05-01/missing" \
  "${titles_fixture}/articles/2026-05-03/quoted" \
  "${titles_fixture}/articles/2026-05-04/single" \
  "${titles_fixture}/articles/2026-05-05/zebra" \
  "${titles_fixture}/articles/2026-05-06/future" \
  "${titles_fixture}/articles/misc/no-date"
printf -- '---\ntitle: Old News\n---\n\n# Body\n' > "${titles_fixture}/articles/2026-04-28/old/index.md"
printf -- '---\ntitle: Boundary News\n---\n\n# Body\n' > "${titles_fixture}/articles/2026-04-29/boundary/index.md"
printf -- '---\ntitle: Zebra News\nsummary: Zebra summary\n---\n\n# Body\n' > "${titles_fixture}/articles/2026-05-05/zebra/index.md"
printf -- '---\ntitle: "Quoted News"\nsummary: "Quoted summary"\n---\n\n# Body\n' > "${titles_fixture}/articles/2026-05-03/quoted/quoted.md"
printf -- '---\ntitle: '\''Single Quoted News'\''\nsummary: '\''Single quoted summary'\''\n---\n\n# Body\n' > "${titles_fixture}/articles/2026-05-04/single/single.md"
printf -- '---\nslug: missing-title\n---\n\n# Missing title\n' > "${titles_fixture}/articles/2026-05-01/missing/missing.md"
printf -- '# No front matter\n\ntitle: Body Title\n' > "${titles_fixture}/articles/2026-05-01/missing/body-title.md"
printf -- '---\nslug: front-matter-only\n---\n\ntitle: Body Title\n# Heading Title\n' > "${titles_fixture}/articles/2026-05-01/missing/front-matter-without-title.md"
printf -- '---\ntitle: Future News\n---\n\n# Body\n' > "${titles_fixture}/articles/2026-05-06/future/index.md"
printf -- '---\ntitle: No Date News\n---\n\n# Body\n' > "${titles_fixture}/articles/misc/no-date/index.md"
actual_titles="${titles_fixture}/actual-titles.txt"
expected_titles="${titles_fixture}/expected-titles.txt"
HOSONAN_TODAY=2026-05-05 "${repo_root}/extract-article-titles.sh" "${titles_fixture}/articles" > "$actual_titles"
{
  printf '%s\t%s\t%s\n' "${titles_fixture}/articles/2026-05-05/zebra/index.md" 'Zebra News' 'Zebra summary'
  printf '%s\t%s\t%s\n' "${titles_fixture}/articles/2026-05-04/single/single.md" 'Single Quoted News' 'Single quoted summary'
  printf '%s\t%s\t%s\n' "${titles_fixture}/articles/2026-05-03/quoted/quoted.md" 'Quoted News' 'Quoted summary'
  printf '%s\t%s\t%s\n' "${titles_fixture}/articles/2026-04-29/boundary/index.md" 'Boundary News' ''
} > "$expected_titles"
diff -u "$expected_titles" "$actual_titles"
printf 'ok: article metadata is extracted from recent date directories in latest order\n'

fixture="${test_root}/valid"
create_fixture_repo "$fixture"
assert_success "moves a valid draft into the dated slug directory" run_runner "$fixture" env
test -f "${fixture}/articles/$(TZ=UTC date +%F)/mock-article/index.md"
test -f "${fixture}/articles/$(TZ=UTC date +%F)/mock-article/thumbnail.webp"
test "$(cat "${fixture}/.mock-codex-count")" = "1"

fixture="${test_root}/default-count"
create_fixture_repo "$fixture"
assert_success "generates one article when article-count is unset" run_runner "$fixture" env
test "$(find "${fixture}/articles/$(TZ=UTC date +%F)" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = "1"
test "$(cat "${fixture}/.mock-codex-count")" = "1"

fixture="${test_root}/empty-count"
create_fixture_repo "$fixture"
assert_success "treats an empty article-count as one article" run_runner "$fixture" env 'INPUT_ARTICLE-COUNT='
test "$(cat "${fixture}/.mock-codex-count")" = "1"

fixture="${test_root}/multiple"
create_fixture_repo "$fixture"
assert_success "generates three articles when article-count is 3" run_runner "$fixture" env 'INPUT_ARTICLE-COUNT=3' MOCK_SLUG=multi-article
test -f "${fixture}/articles/$(TZ=UTC date +%F)/multi-article/index.md"
test -f "${fixture}/articles/$(TZ=UTC date +%F)/multi-article-2/index.md"
test -f "${fixture}/articles/$(TZ=UTC date +%F)/multi-article-3/index.md"
test "$(cat "${fixture}/.mock-codex-count")" = "3"

fixture="${test_root}/outputs"
create_fixture_repo "$fixture"
github_output="${fixture}/github-output.txt"
assert_success "writes single and multi-value GitHub outputs" run_runner "$fixture" env GITHUB_OUTPUT="$github_output" 'INPUT_ARTICLE-COUNT=2' MOCK_SLUG=output-article MOCK_TITLE_1="First Article" MOCK_TITLE_2="Second Article"
grep -q '^title=First Article$' "$github_output"
grep -q "^directory=articles/$(TZ=UTC date +%F)/output-article$" "$github_output"
grep -q '^titles<<__HOSONAN_TITLES__$' "$github_output"
grep -q '^First Article$' "$github_output"
grep -q '^Second Article$' "$github_output"
grep -q '^directories<<__HOSONAN_DIRECTORIES__$' "$github_output"
grep -q "^articles/$(TZ=UTC date +%F)/output-article-2$" "$github_output"

fixture="${test_root}/duplicate"
create_fixture_repo "$fixture"
mkdir -p "${fixture}/articles/$(TZ=UTC date +%F)/mock-article"
assert_success "adds a numeric suffix when the slug directory exists" run_runner "$fixture" env
test -d "${fixture}/articles/$(TZ=UTC date +%F)/mock-article-2"

fixture="${test_root}/second-invalid"
create_fixture_repo "$fixture"
assert_failure "fails when a later generated article is invalid" run_runner "$fixture" env 'INPUT_ARTICLE-COUNT=2' MOCK_SLUG_1=first-article MOCK_SLUG_2='Invalid Slug'
test -f "${fixture}/articles/$(TZ=UTC date +%F)/first-article/index.md"
test "$(cat "${fixture}/.mock-codex-count")" = "2"

for invalid_count in 0 11 1.5 abc " 1" "1 " "1 2"; do
  fixture="${test_root}/invalid-count-${invalid_count//[^a-zA-Z0-9]/_}"
  create_fixture_repo "$fixture"
  assert_failure "rejects invalid article-count: ${invalid_count}" run_runner "$fixture" env "INPUT_ARTICLE-COUNT=$invalid_count"
  test ! -e "${fixture}/.mock-codex-count"
done

fixture="${test_root}/invalid-slug"
create_fixture_repo "$fixture"
assert_failure "rejects an invalid slug" run_runner "$fixture" env MOCK_SLUG='Invalid Slug'

fixture="${test_root}/missing-summary"
create_fixture_repo "$fixture"
assert_failure "rejects a missing summary" run_runner "$fixture" env MOCK_SUMMARY_PRESENT=no

fixture="${test_root}/long-summary"
create_fixture_repo "$fixture"
assert_failure "rejects an overlong summary" run_runner "$fixture" env MOCK_SUMMARY="$(printf 's%.0s' {1..201})"

fixture="${test_root}/missing-thumbnail"
create_fixture_repo "$fixture"
assert_failure "rejects a missing thumbnail" run_runner "$fixture" env MOCK_THUMBNAIL=missing

fixture="${test_root}/wrong-mime"
create_fixture_repo "$fixture"
assert_failure "rejects a non-WebP thumbnail" run_runner "$fixture" env MOCK_THUMBNAIL=text

fixture="${test_root}/wrong-size"
create_fixture_repo "$fixture"
assert_failure "rejects a thumbnail with the wrong dimensions" run_runner "$fixture" env MOCK_THUMBNAIL=wrong-size

fixture="${test_root}/runner-without-key"
create_fixture_repo "$fixture"
assert_success "runner lets Codex CLI handle authentication without OPENAI_API_KEY" run_runner "$fixture" env OPENAI_API_KEY=

fixture="${test_root}/entrypoint-valid"
create_git_fixture_repo "$fixture"
before_head="$(git -C "$fixture" rev-parse HEAD)"
assert_success "action entrypoint runs the generator without committing article changes" run_action_entrypoint "$fixture" env
test -f "${fixture}/articles/$(TZ=UTC date +%F)/mock-article/index.md"
after_head="$(git -C "$fixture" rev-parse HEAD)"
test "$before_head" = "$after_head"
test -n "$(git -C "$fixture" status --porcelain -- articles)"

fixture="${test_root}/entrypoint-with-input-key"
create_git_fixture_repo "$fixture"
assert_success "action entrypoint propagates the API key input for codex exec" run_action_entrypoint "$fixture" env 'INPUT_OPENAI-API-KEY=test-key' MOCK_EXPECT_CODEX_API_KEY=test-key
