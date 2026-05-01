# AI Generated Articles

Codex CLI をベースに、最新のインターネットニュースを収集し、出典を確認しながらテキストベースの記事を自動生成する GitHub Actions 用の Docker container action です。1 回の実行で、1 本の記事を生成します。

このリポジトリでは、ニュース収集、要点整理、記事生成、記事内での根拠提示、サムネイル検証、記事配置までを一連の action として扱います。生成された記事は、利用側リポジトリの `articles/` 以下に保存され、別システムで Web サイトとして表示される前提です。

## 目的

- 最新ニュースを複数ソースから収集する
- 収集した情報を要約し、重複や矛盾を整理する
- 既存の記事を参照し、近いタイミングで繰り返し実行しても重複記事を避ける
- Codex CLI を使って、記事ごとの構成案と本文を生成する
- 記事ごとに、Footnote 記法でサイト名とリンク化したページタイトルを示す
- Web サイトへの変換に渡しやすい記事ファイルを出力する

## 想定する使い方

### GitHub Actions

利用側リポジトリには `config/`、`articles/`、最小 workflow だけを置きます。`PROMPT.md` と生成・検証ロジックはこの Action リポジトリで管理します。

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
      - uses: <owner>/<action-repo>@v1
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

利用側リポジトリには `OPENAI_API_KEY` secret を設定してください。action 内では必須の `openai-api-key` input として受け取り、`OPENAI_API_KEY` として Codex CLI に渡します。この Docker container action は `articles/` 以下にファイルを出力するところまでを担当します。生成された差分の commit / push は、利用側 workflow の後続 step で行ってください。

利用側がこの Action リポジトリを指定する箇所は `uses: <owner>/<action-repo>@v1` の 1 箇所だけです。GitHub Actions はこのリポジトリの `Dockerfile` を build し、`node:24-bookworm-slim` ベースの container 内で Codex CLI と entrypoint を実行します。

Action image は `node:24-bookworm-slim` をベースにし、Codex CLI と記事生成に必要な最小限の実用パッケージだけを追加します。`codex-universal` は多言語開発環境向けの参照 image としては有用ですが、この Action では記事生成に使わないランタイムやビルドツールまで含める必要がないため採用しません。

## アーキテクチャ案

```text
ユーザー入力
  |
  v
既存記事の確認
  |
  v
記事候補の選定
  |
  v
ニュース収集
  |
  v
出典評価・重複排除
  |
  v
既存記事との重複確認
  |
  v
記事構成生成
  |
  v
本文生成
  |
  v
記事内への根拠整理
  |
  v
自動品質チェック
  |
  v
記事出力
```

## ディレクトリ構成案

```text
.
├── README.md
├── action.yml                      # Docker container action 定義
├── Dockerfile                      # GitHub Actions が build する action image
├── entrypoint.sh                   # container action の entrypoint
├── PROMPT.md                       # Action repo 管理の生成プロンプト
├── templates/user-repo/            # 利用側 repo に置く最小ファイル例
└── tests/
    └── run-generate-article.sh
```

## Codex CLI の前提

Action image 内に Codex CLI をインストールし、GitHub Actions では必須の `openai-api-key` input を `OPENAI_API_KEY` として渡して実行します。entrypoint を直接実行する場合は `OPENAI_API_KEY` を必須チェックせず、認証は Codex CLI の実行環境に委ねます。

記事生成に必要なシステム上の制約は、この Action リポジトリのルート直下の 1 ファイルで管理します。

- `PROMPT.md`: 記事生成ワークフロー、情報源の優先順位、採用基準、検証ルール

ユーザーが変更する好み、関心、記事フォーマットは、利用側リポジトリの `config/` 以下に置きます。`config/` 以下には任意の名前でファイルを置けます。

- 例: ユーザーの好み、関心、避けたい内容を記述したファイル
- 例: 記事の文体、構成、見出し、出典表示の好みを記述したファイル

実行時は Action リポジトリの `PROMPT.md` と、利用側リポジトリの `config/` 以下の設定をあわせて参照します。記事フォーマット、読者像、関心、避けたい内容などは、用途に合わせて `config/` 以下の任意のファイルに記述します。v1 では `PROMPT.md` の差し替えインターフェイスは提供しません。

記事生成は、Docker container action の entrypoint を引数なしで実行します。このリポジトリでは、それ以外の生成方法は想定しません。

entrypoint は次の処理を 1 回のコマンドで行います。

- 空の `draft/` ディレクトリの作成
- Action リポジトリの `PROMPT.md` の Codex CLI への標準入力渡し
- Codex CLI の作業ディレクトリを `draft/` に限定し、`draft/` 以下だけを書き込み可能にする sandbox 設定
- Codex CLI による `draft/index.md` と `draft/thumbnail.webp` の生成
- `draft/thumbnail.webp` が WebP かつ 1200x630px であることの検証
- `draft/index.md` の front matter から `slug` を検証
- `articles/YYYY-MM-DD/` ディレクトリの作成
- 生成された記事のトピックに基づく `articles/YYYY-MM-DD/<topic-slug>/` への `draft/` のリネーム

entrypoint は `PROMPT.md` をそのまま Codex CLI に渡します。Codex CLI は `draft/` を作業ディレクトリとして起動され、`PROMPT.md` の指示に従って `../config/` 以下の設定ファイルと既存の `../articles/**/*.md`、`../articles/**/index.md` を参照します。1 回の実行で 1 本の記事を生成します。

出力先は `articles/YYYY-MM-DD/<topic-slug>/index.md` と `articles/YYYY-MM-DD/<topic-slug>/thumbnail.webp` です。サムネイル画像は 1200x630px の WebP 画像として生成します。記事にその他の添付ファイルがある場合は、同じ記事ディレクトリ内に配置されます。日付ごとにディレクトリを分けますが、1 日 1 本の前提は置きません。近いタイミングで繰り返し実行する前提のため、生成時は既存記事と重複しないトピックや新しい進展を選びます。同名ディレクトリがすでにある場合は、既存ディレクトリを上書きせず、末尾に連番を付けます。トピック、出力先、モデルなどはコマンド実行時に指定せず、必要な方針は `PROMPT.md` と `config/` 以下に記述します。

生成開始時に `draft/` が空でない場合、スクリプトは既存内容を上書きせずに停止します。失敗した生成物を確認するか削除してから再実行してください。

日付ディレクトリは action の `timezone` input で決まります。

## GitHub Action の処理

`action.yml` は次の処理を行います。

- `Dockerfile` を使って `node:24-bookworm-slim` ベースの action image を build する
- image 内に Codex CLI と、`bash`、`bubblewrap`、`ca-certificates`、`file`、`git`、`imagemagick`、`ripgrep`、`tzdata`、`webp` を用意する
- 必須の `openai-api-key` input を `OPENAI_API_KEY` として Codex CLI に渡す
- `/opt/article-generator` にある `PROMPT.md` と entrypoint で、`/github/workspace` の `config/` と `articles/` を参照し、`draft/` を生成・検証して `articles/YYYY-MM-DD/<slug>/` に配置する
- commit / push は行わず、利用側 workflow の後続 step に委ねる

追加パッケージの役割は次の通りです。

- `bubblewrap`: Codex CLI の Linux sandbox 用
- `git`: Codex CLI によるリポジトリ判定と状態確認用
- `ripgrep`: `config/` と既存 `articles/` の高速探索用
- `tzdata`: `timezone` input による日付生成の安定化用
- `webp`: `thumbnail.webp` の生成・変換に使う `cwebp` などの提供用

`jq`、`curl`、`wget`、`build-essential`、多言語ランタイム類は、現在の entrypoint と生成フローでは必須ではないため image には追加しません。

## テスト

entrypoint は mock Codex で検証できます。

```console
$ tests/run-generate-article.sh
```

このテストは、Docker action 定義、Dockerfile の主要設定、workflow テンプレート、正常生成、slug 衝突時の連番、slug 不正、サムネイル不足、MIME 不一致、サイズ不一致、Codex CLI への認証委譲と非 commit 動作を確認します。

## 記事生成時の方針

- 事実と推測を分けて書く
- 出典のない断定を避ける
- 可能な限り一次情報、公式発表、当事者の発言を優先する
- 複数メディアで裏取りできない情報は本文に採用しない
- 引用は必要最小限にし、本文は独自の要約として作成する
- 日付、固有名詞、数値、リンク、本文中の出典参照は自動チェックの対象にする
- 既存記事と同じニュース、同じ発表、同じ論点の焼き直しを避ける

## 自動品質チェック

記事を Web サイト表示に渡す前に、記事ごとに少なくとも次の項目を自動チェックします。

- リンク切れがない
- 既存記事と重複した記事になっていない
- 日付と時刻が正しい
- 固有名詞の表記が正しい
- 数値や引用が出典と一致している
- 見出しが本文の内容を誇張していない
- 著作権上問題のある長い引用が含まれていない
- 記事内の出典参照が記事内の脚注定義に対応している
- 読者が記事だけで出典ページをたどれる

## 今後の実装候補

- ニュース収集プロンプトのテンプレート化
- 重複記事の検出精度向上
- ファクトチェック用の自動検証コマンド
- GitHub Actions による定期実行
- Web サイト変換前チェック結果の自動生成

## 注意事項

このツールはテキストベースの記事作成を完全自動化することを目的とします。記事生成の途中に人間のチェックは挟みません。Web サイトへの変換、配信、公開管理はこのリポジトリのスコープ外です。特に速報性の高いニュース、金融、医療、法律、災害、安全保障に関する内容は、自動チェックで公式情報と複数の信頼できる出典を優先して扱います。
