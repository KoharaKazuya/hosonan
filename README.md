# AI Generated Articles

このリポジトリは、AI による記事生成と、生成した記事を Web サイトとしてまとめる部分を同じリポジトリで扱うための場所です。

記事生成の実装は `actions/codex/` 以下に、Web サイト向けの変換処理は `site/worker/` 以下にまとめています。今後、記事一覧や追加の Web サイト生成処理を実装する場合も、ルート直下へ個別の実装ファイルを増やさず、用途ごとのディレクトリに分けて配置します。

## 構成

```text
.
├── README.md
├── actions/
│   └── codex/
│       ├── README.md
│       ├── action.yml
│       ├── Dockerfile
│       ├── entrypoint.sh
│       ├── PROMPT.md
│       ├── templates/user-repo/
│       └── tests/
└── site/
    └── worker/
        ├── README.md
        ├── package.json
        ├── src/
        └── test/
```

## 記事生成

`actions/codex` は、Codex CLI を使って最新ニュースを調査し、出典付きの Markdown 記事とサムネイルを 1 回の実行で 1 本生成する記事生成コンポーネントです。

使い方、手動実行、テスト方法は [actions/codex/README.md](actions/codex/README.md) を参照してください。

## Web サイト部分

`site/worker` は、GitHub App webhook で `articles/YYYY-MM-DD/<slug>/index.md` の push を検知し、Markdown を HTML 断片へ変換して Cloudflare R2 に保存する Cloudflare Worker です。記事生成部分とは分けて管理しています。

詳細、必要な secret / binding、R2 key 仕様、Markdown 対応範囲、テスト方法は [site/worker/README.md](site/worker/README.md) を参照してください。

現時点の Web サイト部分は記事本文の HTML 断片生成だけを扱います。記事一覧、RSS、完全な HTML document、CSS、GitHub repo への HTML 書き戻しは対象外です。

リポジトリルートの `README.md` は全体説明と各部分への導線に留め、実装ごとの詳細は各ディレクトリ配下のドキュメントへ分けます。
