# router-worker

`site/router-worker` は `https://hosonan.koharakazuya.workers.dev` を単一の公開入口にするための Cloudflare Worker です。

これはカスタムドメイン取得と Cloudflare Workers `routes` 機能設定ができるまでの一時的なワークアラウンドです。将来的には router worker ではなく、カスタムドメインと `routes` 設定で `site-worker` と `article-worker` を公開 path ごとに割り当てる想定です。

## ルーティング

- `/api/github/webhook` と `/api/github/webhook/` は `ARTICLE_WORKER` service binding に委譲する。
- 未定義の `/api` namespace は `404 text/plain` を返す。
- `/api` 以外はすべて `SITE_WORKER` service binding に委譲する。

## 公開 URL

- 記事 URL: `https://hosonan.koharakazuya.workers.dev/gh/<owner>/<YYYY-MM-DD>/<slug>/`
- GitHub webhook URL: `https://hosonan.koharakazuya.workers.dev/api/github/webhook`

## 検証

```console
$ npm run build -w @hosonan/router-worker
$ npm test -w @hosonan/router-worker
```
