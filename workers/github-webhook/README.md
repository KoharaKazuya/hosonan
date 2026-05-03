# workers/github-webhook

`workers/github-webhook` は、`/api/github/webhook` で GitHub App webhook を受け取り、対象 repo / branch の更新を repo 単位 Durable Object に集約する Cloudflare Workers プロジェクトです。

記事生成を担当する `actions/codex/`、記事本文を変換する `workers/article-renderer/` とは独立しています。この Worker は記事 path を抽出せず、repo の同期状態管理と debounce を担当します。

## フロー

1. GitHub App webhook が Worker に `push` event を送信する。
2. Worker は `x-hub-signature-256` を `WEBHOOK_SECRET` で検証する。
3. 対象 branch 以外の `push`、branch 削除、`after` がない payload は無視する。
4. `repository.id` をキーに Durable Object を取得し、owner、repo、installation、target branch、`after` commit を通知する。
5. Durable Object は最後に受け取った target commit を保持し、60 秒 debounce の Alarm を設定する。
6. Alarm 発火時に未同期 target があれば repo 単位の Queue message を `ARTICLE_RENDER_QUEUE` に enqueue する。

`push` 以外の event、installation や target commit がない payload は無視します。

## Durable Object

Durable Object は repo ごとの同期状態の正です。主に次を保持します。

- `targetCommit`
- `lastSyncedCommit`
- `lastArticleIndex`
- `inFlightLease`
- `lastError`
- `retryAt`

Queue consumer は同期開始時に `claimSync()` 相当の RPC を行い、10 分 lease を取得できた場合だけ GitHub / R2 同期を実行します。lease が有効な間は二重同期を避け、期限切れ lease は次回 claim で再取得できます。

## Secrets / bindings

Worker には次が必要です。

- `WEBHOOK_SECRET`: GitHub webhook secret
- `ARTICLE_RENDER_QUEUE`: `hosonan-article-render` Queue producer binding
- `REPO_SYNC_STATE`: repo 同期状態 Durable Object

GitHub App private key、GitHub App ID、R2 bucket はこの Worker では使いません。

## テスト

```console
$ npm install
$ npm run build --workspace @hosonan/github-webhook
$ npm test --workspace @hosonan/github-webhook
```

`npm run build` は Wrangler binding 型と TypeScript の型チェックを行います。`npm test` は署名検証、event 分岐、Durable Object 通知、debounce、lease 管理を検証します。
