# site/article-worker

`site/article-worker` は、GitHub App webhook で記事 Markdown の push を受け取り、HTML 断片へ変換して Cloudflare R2 に保存する Cloudflare Workers プロジェクトです。

記事生成を担当する `actions/codex/` とは独立しています。対象は、生成済みの `articles/YYYY-MM-DD/<slug>/index.md` だけです。

## フロー

1. GitHub App webhook が Worker に `push` event を送信する。
2. Worker は `x-hub-signature-256` を `WEBHOOK_SECRET` で検証する。
3. `commits[].added` / `commits[].modified` / `commits[].removed` から `articles/YYYY-MM-DD/<slug>/index.md` だけを抽出する。
4. 追加・変更された Markdown は、GitHub App JWT から installation access token を取得し、該当 commit SHA の Contents API で本文を読む。
5. front matter を本文から除外し、Markdown を wrapper なしの HTML 断片に変換する。
6. 変換した HTML を R2 に `text/html; charset=utf-8` で保存する。
7. 削除された Markdown は、対応する R2 object を削除する。

`push` 以外の event は無視します。

## R2 key

R2 object key は次の形式です。

```text
gh/<repository.owner.login>/<YYYY-MM-DD>/<slug>/index.html
```

例:

```text
gh/octocat/2026-05-02/example-article/index.html
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
- `WEBHOOK_SECRET`: GitHub webhook secret
- `ARTICLES_BUCKET`: R2 bucket binding

`wrangler.toml` には `ARTICLES_BUCKET` binding の雛形だけを置いています。実際の bucket 名は利用環境に合わせて設定してください。

## テスト

```console
$ npm install
$ npm run build --workspace @hosonan/article-worker
$ npm test --workspace @hosonan/article-worker
```

`npm run build` は TypeScript の型チェックを行います。`npm test` は Markdown 変換と webhook 分岐を検証します。

## 対象外

今回の Worker は記事本文の HTML 断片だけを生成します。次は対象外です。

- 記事一覧
- RSS
- 完全な HTML document
- CSS
- GitHub repo への HTML 書き戻し
