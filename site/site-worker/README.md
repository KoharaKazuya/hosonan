# site/site-worker

`site/site-worker` は、Cloudflare R2 に保存された記事本文 HTML 断片を、最小限の HTML document に組み込んで配信する Cloudflare Workers プロジェクトです。

## URL

次の URL を記事ページとして扱います。

```text
/gh/<owner>/<YYYY-MM-DD>/<slug>/
/gh/<owner>/<YYYY-MM-DD>/<slug>/index.html
```

どちらも同じ R2 key と cache key に正規化します。

```text
gh/<owner>/<YYYY-MM-DD>/<slug>/index.html
```

## レスポンス

R2 object が存在する場合は、保存済みの HTML 断片を `<main class="article">` に挿入した HTML document を返します。R2 にない記事や不正な URL は `404 text/plain` を返します。

対応する HTTP method は `GET` と `HEAD` だけです。それ以外は `405` と `Allow: GET, HEAD` を返します。

## Cache API

完成した HTML document は、正規化後 URL を key にして Cache API に保存します。レスポンスには次の header を付与します。

```text
Cache-Control: public, max-age=300
Content-Type: text/html; charset=utf-8
```

## Bindings

Worker には次が必要です。

- `ARTICLES_BUCKET`: R2 bucket binding

## テスト

root から全 workspace を検証できます。

```console
$ npm install
$ npm run build --workspaces
$ npm test --workspaces
```

この package だけを検証する場合は次を使います。

```console
$ npm run build --workspace @hosonan/site-worker
$ npm test --workspace @hosonan/site-worker
```
