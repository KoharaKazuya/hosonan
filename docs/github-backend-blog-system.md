# GitHub バックエンド型ブログシステム設計

このドキュメントは、GitHub repository を記事の編集・保管場所とし、Cloudflare Workers / R2 / D1 / Queues / Durable Objects で公開用のブログを構築する最終的な想定アーキテクチャを整理するものです。

## 目的

- GitHub を記事原稿の source of truth として扱う。
- 記事配信時に GitHub API へ read-through せず、公開用成果物は Cloudflare 側に保存して配信する。
- GitHub App は read-only 権限を前提にし、Personal Access Token や repository への HTML 書き戻しに依存しない。
- webhook の瞬間的な集中や GitHub API rate limit を吸収できる同期基盤を持つ。
- 画像などの asset も公開用 cache key を安定させ、GitHub 側 URL や query string の揺れを配信面に持ち込まない。

## 目標構成

### GitHub App

GitHub App は対象 repository の contents read 権限と metadata read 権限を持ちます。`push`、`installation`、`installation_repositories` などの event を受け取り、installation と repository の状態を Cloudflare 側の registry に反映します。

署名検証には webhook secret を使います。Contents API や tarball 取得には GitHub App installation access token を使い、ユーザー単位の PAT は使いません。

### Cloudflare Workers

Workers は大きく次の責務に分けます。

- Webhook 受信 Worker: GitHub webhook の署名を検証し、delivery id の重複排除を行い、同期 request を Queue へ投入する。
- Sync Worker: Queue から repository 単位の同期 request を受け取り、対象 commit の Markdown と metadata を読み、公開用成果物を生成する。
- Site Worker: R2 と metadata store から公開用 HTML document を返す。記事本文取得のために GitHub API を呼ばない。
- Asset Worker: Markdown 内の画像 URL を公開用 asset URL へ変換し、GitHub raw asset を R2 に cache して配信する。

### D1

D1 は registry と同期状態の管理に使います。想定する主なテーブルは次のとおりです。

- `users`: 利用者または owner の識別情報。
- `installations`: GitHub App installation id、account、権限状態。
- `sites`: 公開 site と GitHub repository、branch、記事 root、公開 host の対応。
- `sync_states`: repository / site 単位の最新同期 commit、同期中 status、error、次回再試行時刻。
- `articles`: 記事 slug、date、title、公開状態、compiled metadata、対応する R2 key。
- `assets`: 元 URL、正規化済み asset key、content hash、cache 状態。
- `webhook_deliveries`: GitHub delivery id の処理履歴と重複排除用 TTL。

### Cloudflare Queues と Durable Objects

Webhook Worker は同期処理を直接実行せず、Queue に軽量な request を投入します。

Queue consumer は repository または site 単位で Durable Object に処理を集約します。Durable Object は同じ repository への連続 push を coalescing し、常に最新 commit へ向けた同期を 1 本にまとめます。これにより webhook ごとのフル同期や同時実行による race を避けます。

### R2

R2 は公開用成果物の保存先です。

- 記事 HTML 断片または完成済み HTML。
- compiled metadata の snapshot。
- asset proxy 用の画像や添付ファイル。
- active snapshot。配信側が最新の整合した成果物セットだけを読むための manifest。

配信時は R2 と D1、または active snapshot だけを読み、GitHub API は呼びません。

## 記事入力形式

記事 Markdown は repository 内の `content/posts/*.md` のような site ごとの設定可能な path に置く想定です。front matter から title、published date、slug、description、tags、draft 状態、cover image などを読み取ります。

```text
content/posts/*.md
```

## 同期フロー

目標設計の同期フローは次のとおりです。

1. GitHub App webhook を受信する。
2. 署名と delivery id を検証し、重複 delivery を破棄する。
3. installation、repository、site の状態を registry で確認する。
4. repository / site 単位の同期 request を Queue に投入する。
5. Durable Object が同一 repository の request を coalescing する。
6. Sync Worker が対象 commit の変更差分を Contents API で取得する。
7. 大量変更や差分取得失敗時は tarball fallback で repository snapshot を取得する。
8. Markdown を HTML と compiled metadata に変換する。
9. Markdown 内 asset を asset proxy URL に置換し、必要な asset を R2 に保存する。
10. R2 に成果物を保存し、D1 の記事状態と active snapshot を更新する。

記事削除時は、即時に配信不能にするため D1 の状態を inactive または deleted に更新します。R2 object の削除は後続の cleanup job で行ってもよく、配信可否は metadata と active snapshot を正とします。

## 配信フロー

Site Worker は公開 URL を正規化し、metadata と R2 の成果物から HTML document を返します。document は Cache API または Cloudflare cache に保存できます。

配信時の原則は次のとおりです。

- GitHub API へ本文を読みに行かない。
- URL を canonical path に正規化し、query string を cache key に含めない。
- active snapshot を使い、同期途中の不完全な成果物を配信しない。
- draft、deleted、権限消失した site は明示的に非公開にする。

## Asset proxy

Markdown 内の画像や添付ファイルは、GitHub raw URL をそのまま HTML に残さず、Cloudflare 側の asset URL へ変換します。

asset key は元 repository、commit または content hash、path をもとに安定生成します。`?raw=1` や署名付き URL などの query string に依存した key にしないことで、cache key の増殖を避けます。

Asset Worker は R2 にある asset を返し、未保存の場合だけ controlled fetch で GitHub から取得します。取得失敗時は retry と placeholder の方針を分け、記事本文の配信と asset cache の失敗を分離します。

## 実装順序

1. Queue と repository 単位 coalescing を導入する。

   Webhook Worker が同期処理を直接実行する構造をやめ、Queue へ同期 request を投入します。Durable Object または同等の排他制御で同一 repository の連続 push をまとめ、最新 commit への同期に集約します。

2. site registry を追加する。

   D1 に `installations`、`sites`、`sync_states` を追加し、GitHub repository と公開 site の対応を明示します。これにより multi-tenant 化、installation 権限消失、repository 削除への対応が可能になります。

3. compiled metadata と active snapshot を保存する。

   front matter を捨てるだけでなく、title、date、slug、draft、tags などを compiled metadata として保存します。配信側は active snapshot を読み、同期途中の不完全な成果物を避けます。

4. asset proxy を実装する。

   Markdown 内の画像を Cloudflare 側の asset URL に置換し、R2 asset cache から配信します。cache key は query string に依存させず、repository、commit または content hash、path から安定生成します。

5. 権限消失と再同期に対応する。

   `installation` / `installation_repositories` event を処理し、権限が消えた site を非公開にします。初回同期、全量再構築、tarball fallback、rate limit retry もこの段階で整えます。

## 避けるべき設計

- 本文配信時に GitHub API へ read-through する。
- webhook ごとに即時フル同期を実行する。
- Personal Access Token を使う。
- GitHub repository への write 権限を必須にする。
- 生成済み HTML を GitHub repository に書き戻す。
- asset cache key を query string に依存させる。
- installation や repository 権限消失時に古い記事を無期限で配信し続ける。
