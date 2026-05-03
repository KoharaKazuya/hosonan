# hosonan

このリポジトリは、AI による記事生成と、生成した記事を Web サイトとしてまとめる部分を同じリポジトリで扱うための場所です。

記事生成の実装は `actions/codex/` 以下に、Web サイト向けの Workers は npm workspaces として `site/` 以下にまとめています。今後、記事一覧や追加の Web サイト生成処理を実装する場合も、ルート直下へ個別の実装ファイルを増やさず、用途ごとの package に分けて配置します。

## 構成

```text
.
├── README.md
├── package.json
├── docs/
│   └── github-backend-blog-system.md
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
    ├── article-worker/
    │   ├── README.md
    │   ├── package.json
    │   ├── src/
    │   └── test/
    ├── shared/
    │   ├── package.json
    │   ├── src/
    │   └── test/
    └── site-worker/
        ├── README.md
        ├── package.json
        ├── src/
        └── test/
```

## 記事生成

`actions/codex` は、Codex CLI を使って最新ニュースを調査し、出典付きの Markdown 記事とサムネイルを 1 回の実行で 1 本生成する記事生成コンポーネントです。

使い方、手動実行、テスト方法は [actions/codex/README.md](actions/codex/README.md) を参照してください。

## Web サイト部分

`site/article-worker` は、GitHub App webhook で `articles/YYYY-MM-DD/<slug>/index.md` の push を検知し、Markdown を HTML 断片へ変換して Cloudflare R2 に保存する Cloudflare Worker です。

`site/site-worker` は、R2 に保存された HTML 断片を `/gh/<owner>/<YYYY-MM-DD>/<slug>/` の Web ページとして配信する Cloudflare Worker です。

`site/shared` は、記事 path、R2 key、配信用 URL 正規化、HTML escape など、両 Worker で使う純粋関数を提供します。

現時点の Web サイト部分は、単一 repo 形状の `articles/YYYY-MM-DD/<slug>/index.md` を記事本文として変換・配信する最小実装です。

実装済みの範囲は次のとおりです。

- GitHub webhook の `push` event を受信し、署名を検証する。
- GitHub App installation access token を使って対象 Markdown を GitHub Contents API から取得する。
- front matter を除いた Markdown を HTML 断片へ変換し、Cloudflare R2 に保存する。
- 削除された記事に対応する R2 object を削除する。
- R2 に保存された HTML 断片を最小限の HTML document に組み込み、Cache API を使って配信する。

現状では、multi-tenant registry、Queue による非同期同期、Durable Objects による repo 単位 coalescing、D1、asset proxy、記事一覧、RSS、画像配信、GitHub repo への HTML 書き戻しは実装していません。Markdown 画像も asset proxy URL へ変換されず、現在の sanitizer では出力 HTML に残りません。

詳細、必要な secret / binding、R2 key 仕様、Markdown 対応範囲、テスト方法は [site/article-worker/README.md](site/article-worker/README.md) を参照してください。

GitHub repository を記事の source of truth として Cloudflare 上で公開する最終的な想定は [docs/github-backend-blog-system.md](docs/github-backend-blog-system.md) にまとめています。

全 workspace の検証は root から実行できます。

```console
$ npm install
$ npm run build --workspaces
$ npm test --workspaces
```

リポジトリルートの `README.md` は全体説明と各部分への導線に留め、実装ごとの詳細は各ディレクトリ配下のドキュメントへ分けます。
