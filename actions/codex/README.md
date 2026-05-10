# actions/codex

`actions/codex` は、Codex CLI を使って最新ニュースを調査し、出典付きの Markdown 記事とサムネイルを 1 回の実行で 1 本生成する GitHub Action です。

生成された記事は、利用側リポジトリの `articles/YYYY-MM-DD/<topic-slug>/` 以下に保存されます。この Action は記事ファイルの生成と検証までを担当し、生成後の commit / push は利用側 workflow の後続 step に委ねます。

## 利用例

利用側リポジトリには `config/`、`articles/`、最小 workflow だけを置きます。`PROMPT.md` と生成・検証ロジックはこのリポジトリの `actions/codex/` で管理します。

```yaml
name: Generate article

on:
  workflow_dispatch:
  schedule:
    - cron: "0 22 * * *"

permissions:
  contents: write

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: KoharaKazuya/hosonan/actions/codex@v1
        with:
          timezone: Asia/Tokyo
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
      - name: Commit generated article
        run: |
          set -euo pipefail
          if [[ -z "$(git status --porcelain -- articles)" ]]; then
            echo "No generated article changes to commit."
            exit 0
          fi

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add articles
          git commit -m "feat: 新しい記事を生成する

          Codex CLI によって生成された記事本文とサムネイルを articles/ 以下に追加します。
          生成日時のタイムゾーンには action input の timezone を使用します。"
          git push
```

利用側リポジトリには `OPENAI_API_KEY` secret を設定してください。Action 内では必須の `openai-api-key` input として受け取り、`OPENAI_API_KEY` として Codex CLI に渡します。

利用側がこの Action を指定する箇所は `uses: KoharaKazuya/hosonan/actions/codex@v1` です。GitHub Actions は `actions/codex/Dockerfile` を build し、`node:24-bookworm-slim` ベースの container 内で Codex CLI と entrypoint を実行します。

利用側 workflow の雛形は `templates/user-repo/.github/workflows/generate-article.yml` にあります。

## 手動実行

手元で動作確認する場合は、このリポジトリのルートで Action image を build します。

```console
$ docker build -t local/hosonan-codex:dev actions/codex
```

次に、記事を生成したいリポジトリへ移動し、build 済みの image を起動します。

```console
$ docker run --rm -it -v "$PWD:/github/workspace" -w /github/workspace --entrypoint=/bin/bash local/hosonan-codex:dev
```

起動した container 内で Codex CLI にログインします。手動実行では `OPENAI_API_KEY` を必須にせず、Codex CLI の認証状態に委ねます。

```console
$ codex login --device-auth
```

ログイン後、container 内で entrypoint を実行します。

```console
$ /opt/hosonan/entrypoint.sh
```

正常に完了すると、mount した記事リポジトリの `articles/` 以下に記事ディレクトリが生成されます。

## 記事生成の流れ

`entrypoint.sh` は次の処理を 1 回のコマンドで行います。

- 空の `draft/` ディレクトリの作成
- `PROMPT.md` の Codex CLI への標準入力渡し
- Codex CLI の作業ディレクトリを `draft/` に指定
- Docker container action 自体を隔離境界として扱い、Codex CLI 側の承認と sandbox をバイパス
- `draft/index.md` と `draft/thumbnail.webp` の生成
- `thumbnail.webp` が WebP かつ 1200x630px であることの検証
- `index.md` の front matter から `title`、`summary`、`slug` を検証
- `articles/YYYY-MM-DD/<topic-slug>/` への生成物配置

出力先は `articles/YYYY-MM-DD/<topic-slug>/index.md` と `articles/YYYY-MM-DD/<topic-slug>/thumbnail.webp` です。同名ディレクトリがすでにある場合は、既存ディレクトリを上書きせず、末尾に連番を付けます。生成開始時に `draft/` が空でない場合、スクリプトは既存内容を上書きせずに停止します。

日付ディレクトリは Action の `timezone` input で決まります。

## Codex CLI の前提

Action image 内に Codex CLI をインストールし、GitHub Actions では必須の `openai-api-key` input を `OPENAI_API_KEY` として渡して実行します。entrypoint を直接実行する場合は `OPENAI_API_KEY` を必須チェックせず、認証は Codex CLI の実行環境に委ねます。

記事生成に必要なシステム上の制約は `PROMPT.md` で管理します。ユーザーが変更する好み、関心、記事フォーマットは、利用側リポジトリの `config/` 以下に任意のファイルとして置きます。

## Action image

`action.yml` は `Dockerfile` を使って Docker container action を定義します。image は `node:24-bookworm-slim` をベースにし、Codex CLI と記事生成に必要な最小限の実用パッケージだけを追加します。

追加パッケージの主な役割は次の通りです。

- `git`: Codex CLI によるリポジトリ判定と状態確認用
- `ripgrep`: `config/` と既存 `articles/` の高速探索用
- `tzdata`: `timezone` input による日付生成の安定化用
- `webp`: `thumbnail.webp` の生成・変換に使う `cwebp` などの提供用

`jq`、`curl`、`wget`、`build-essential`、多言語ランタイム類は、現在の entrypoint と生成フローでは必須ではないため image には追加しません。

## テスト

entrypoint は mock Codex で検証できます。

```console
$ actions/codex/tests/run-generate-article.sh
```

このテストは、Docker action 定義、Dockerfile の主要設定、workflow テンプレート、正常生成、slug 衝突時の連番、slug 不正、サムネイル不足、MIME 不一致、サイズ不一致、Codex CLI への認証委譲と非 commit 動作を確認します。
