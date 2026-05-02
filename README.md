# AI Generated Articles

このリポジトリは、AI による記事生成と、生成した記事を Web サイトとしてまとめる部分を同じリポジトリで扱うための場所です。

現時点で実装済みなのは「記事生成」部分だけです。記事生成の実装は `actions/codex/` 以下にまとめています。今後、記事一覧や Web サイト生成の実装を追加する場合も、ルート直下へ個別の実装ファイルを増やさず、用途ごとのディレクトリに分けて配置します。

## 構成

```text
.
├── README.md
└── actions/
    └── codex/
        ├── README.md
        ├── action.yml
        ├── Dockerfile
        ├── entrypoint.sh
        ├── PROMPT.md
        ├── templates/user-repo/
        └── tests/
```

## 記事生成

`actions/codex` は、Codex CLI を使って最新ニュースを調査し、出典付きの Markdown 記事とサムネイルを 1 回の実行で 1 本生成する記事生成コンポーネントです。

使い方、手動実行、テスト方法は [actions/codex/README.md](actions/codex/README.md) を参照してください。

## Web サイト部分

記事を Web サイトとしてまとめる実装は未追加です。追加する場合は、記事生成部分とは分けて、例えば `site/` や `actions/site/` のような独立したディレクトリに配置します。

リポジトリルートの `README.md` は全体説明と各部分への導線に留め、実装ごとの詳細は各ディレクトリ配下のドキュメントへ分けます。
