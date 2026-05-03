# workers/router

`workers/router` は `https://hosonan.koharakazuya.workers.dev` を単一の公開入口にするための Cloudflare Worker です。

これはカスタムドメイン取得と Cloudflare Workers `routes` 機能設定ができるまでの一時的なワークアラウンドです。将来的には router ではなく、カスタムドメインと `routes` 設定で `web` と `github-webhook` を公開 path ごとに割り当てる想定です。

## ルーティング

- `/api/github/webhook` と `/api/github/webhook/` は `GITHUB_WEBHOOK` service binding に委譲する。
- 未定義の `/api` namespace は `404 text/plain` を返す。
- `/api` 以外はすべて `WEB` service binding に委譲する。

## 公開 URL

- 記事 URL: `https://hosonan.koharakazuya.workers.dev/gh/<owner>/<repo>/<YYYY-MM-DD>/<slug>/`
- GitHub webhook URL: `https://hosonan.koharakazuya.workers.dev/api/github/webhook`

## 検証

```console
$ npm run build -w @hosonan/router
$ npm test -w @hosonan/router
```
