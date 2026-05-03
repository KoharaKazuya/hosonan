# workers/article-renderer

`workers/article-renderer` は、`workers/github-webhook` の Durable Object が enqueue した repo 単位 Queue message を処理し、GitHub repository の記事 Markdown と Cloudflare R2 を収束させる Cloudflare Workers プロジェクトです。

## フロー

1. `hosonan-article-render` Queue から repo 単位 message を受け取る。
2. repo Durable Object から lease を取得する。lease が有効な同期中なら Queue message を短い delay で retry する。
3. GitHub App JWT から installation access token を取得する。
4. 前回同期 commit と target commit を compare できる場合は差分 path だけを処理する。
5. compare 不能、初回同期、差分過大の場合は target commit の tree を全量スキャンする。
6. 追加・変更された記事 Markdown を HTML 断片に変換して R2 に保存し、消えた記事の R2 object を削除する。
7. 成功時だけ Durable Object に完了通知し、`lastSyncedCommit` と `lastArticleIndex` を進める。

同期中に例外が発生した場合は Durable Object に失敗を通知し、`lastSyncedCommit` は進めません。既存 R2 object は可能な限り維持され、Queue retry で再同期します。

## Queue

- Queue 名: `hosonan-article-render`
- Consumer Worker: `hosonan-article-renderer`
- message 型: `@hosonan/shared` の `RepoSyncQueueMessage`

## R2 key

R2 object key は次の形式です。

```text
gh/<repository.owner.login>/<repository.name>/<YYYY-MM-DD>/<slug>/index.html
```

例:

```text
gh/octocat/blog/2026-05-02/example-article/index.html
```

## Markdown 対応範囲

Markdown 変換は `unified` / `remark` / `rehype` 系のパイプラインで行います。CommonMark 相当を基準にし、次を有効にしています。

- table
- task list
- strikethrough
- autolink
- footnotes
- fenced code block の syntax highlight 用 class
- heading `id`

heading `id` は GitHub 風に見出し文字列から生成し、同じ見出しが複数ある場合は `-1`, `-2` のように連番で衝突を避けます。

raw HTML は HTML としては許可しません。Markdown 内に HTML node が含まれる場合も変換は失敗させず、出力できる Markdown 部分を HTML 断片として保存します。

## Sanitizer と URL policy

変換後 HTML には必ず sanitizer を適用し、記事本文に必要なタグと属性だけを許可します。

URL は次の policy です。

- `href`: `https:` と `mailto:` のみ許可
- `src`: `https:` のみ許可
- `javascript:`, `data:`, `http:`, protocol-relative URL、相対 URL は除去

## Secrets / bindings

Worker には次が必要です。

- `GITHUB_APP_ID`: GitHub App ID
- `GITHUB_PRIVATE_KEY`: GitHub App private key
- `ARTICLES_BUCKET`: R2 bucket binding
- `REPO_SYNC_STATE`: `workers/github-webhook` の repo 同期状態 Durable Object
- Queue consumer: `hosonan-article-render`

`wrangler.jsonc` には `ARTICLES_BUCKET` binding の雛形だけを置いています。実際の bucket 名は利用環境に合わせて設定してください。

## テスト

```console
$ npm install
$ npm run build --workspace @hosonan/article-renderer
$ npm test --workspace @hosonan/article-renderer
```

`npm run build` は Wrangler binding 型と TypeScript の型チェックを行います。`npm test` は repo 単位 Queue message 処理、lease 中の retry、差分同期、全量スキャン fallback、R2 書き込み・削除、Markdown 変換を検証します。

## 対象外

今回の Worker は記事本文の HTML 断片だけを生成します。次は対象外です。

- 記事一覧
- RSS
- 完全な HTML document
- CSS
- GitHub repo への HTML 書き戻し
