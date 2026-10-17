# SelfHostArtifacts 設計

Codex CLI・Gemini CLI（と将来ほかのエージェント）が、HTML のページを公開して非公開 URL で見られるようにする。Claude の Artifact の自前版。Cloudflare（Workers・D1・R2）だけで動き、ドメインは設定で自由に決められる。

## 目標と範囲

v1 でやること:

- エージェントがローカルの HTML（と付属ファイル）を公開し、URL を受け取る
- 同じ URL のまま更新する（版は残す）
- 一覧・読み出し・削除
- 持ち主（root）と、持ち主が登録した閲覧者だけが見られる。非公開が既定

v1 でやらないこと（後述のフェーズで検討）: 他人への共有、コメント、ページから使える共有 DB、ページから LLM を呼ぶ機能。

## 全体像

```
[Codex / Gemini / Claude]
   │ stdio MCP（または CLI）＋ skill
   ▼
[artifact（ローカルの npm パッケージ）] ── ローカルのファイルを読む・端末の秘密鍵で署名する
   │ HTTPS（署名付きリクエスト）
   ▼
[Worker]  APP_HOST（例: artifacts.keyhole.work）── D1（メタデータ）・R2（ファイル）
   ├ /api/v1/*        エージェント用 API（端末の鍵で認証）
   ├ /                一覧（パスキーでログイン）
   ├ /a/:id           閲覧の外枠
   ├ /settings        人・端末の管理（持ち主のみ）
   ├ /account         自分のパスキー
   ├ /invite/:token   招待リンク
   └ /c/:token/*      ページ本体。外枠の sandbox iframe から読む
```

Worker は1つ、ホストも1つ。パスで振り分ける。

### MCP はローカル（stdio）にする

Claude の Artifact ツールが `file_path` を受け取るのは、ツールがローカルで動いているから。リモート MCP にすると、エージェントは HTML の中身を丸ごとツール引数に載せることになり、大きいページでトークンを食うし、画像などのバイナリも送れない。

そこで、ローカルで動く `artifact` パッケージを1つ作り、次の入口を持たせる:

- `artifact mcp` — stdio の MCP サーバー。Codex・Gemini・Claude Code のどれにも同じ形で登録できる
- `artifact publish ./report.html` など — シェルから直接使う CLI。MCP を使わないエージェントや手作業用
- `artifact setup` — 初期設定（ログイン、MCP の登録、skills の配置）。「インストール」の節を参照

## 設定

ドメインは `wrangler.toml` の変数で決める。コードにドメインを書かない。ホストは1つだけで、サブドメインのワイルドカードも別ドメインも要らない。

```toml
[vars]
APP_HOST = "artifacts.example.com"
KEEP_VERSIONS = "0"              # 残す版の数。0 なら全部残す
TRASH_DAYS = "30"                # 削除してから本当に消すまでの日数

# 秘密情報は wrangler secret put で入れる
# SESSION_SECRET / CONTENT_TOKEN_SECRET（deploy スクリプトが自動生成）
```

- `wrangler.toml` では `APP_HOST` を Workers の Custom Domain にする（DNS と証明書は Cloudflare が用意する）
- 個人の設定（実際のドメインやメールアドレス）は `wrangler.toml` に直接書かず、`wrangler.local.toml`（git 管理外）に分ける。リポジトリには例だけを置く

keyhole.work なら `APP_HOST = "artifacts.keyhole.work"`。

## パス

| パス | 内容 | 認証 |
|---|---|---|
| `/` | 一覧 | root・viewer |
| `/a/:id` | 閲覧の外枠（最新版） | root・viewer |
| `/a/:id/v/:version` | 閲覧の外枠（過去の版） | root・viewer |
| `/settings` | 閲覧者の追加と削除、端末の一覧と失効、外部通信を許可したページ、ゴミ箱 | root |
| `/pair/:code` | `artifact login` の承認画面 | root |
| `/auth/login`, `/auth/passkey/*`, `/auth/link/:token`, `/auth/logout` | パスキーとログインリンク | — |
| `/c/:token/*` | ページ本体の配信 | パスの中の署名付きトークン |
| `/api/v1/*` | エージェント用 API | 端末の署名 |

## ページ本体の隔離

エージェントが書いた任意の JS が動く。管理画面と同じオリジンで配信するので、ページ本体は**オリジンを持たない（opaque origin）状態**で動かして隔離する。

- 外枠は `<iframe src="/c/<token>/index.html" sandbox="allow-scripts allow-forms allow-popups allow-downloads">` で読む。`allow-same-origin` は**付けない**
- さらに `/c/*` の応答そのものに `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` を付ける。誰かが `/c/...` を直接（iframe の外で）開いても、やはり opaque origin になる。これが一番大事な防御で、iframe の属性だけに頼らない

これで、ページの JS は:

- 外枠や管理画面の DOM に触れない
- cookie を読み書きできない（`document.cookie` は使えない）
- `/api` を呼んでもセッション cookie が付かない（opaque origin からのリクエストはクロスサイト扱い。セッション cookie は `SameSite=Strict`）。API は端末の署名で認証するので、cookie だけで通る操作もない

代わりに、ページの中では localStorage・IndexedDB・cookie・Service Worker が使えない（例外が出る）。skill に「try/catch で囲み、なくても動くように」と書く。ページの状態を保存したい用途は v4 の共有 DB で受ける。

### トークン

- `/c/:token/` のトークンは HMAC で署名し、artifact id・版・有効期限（1時間）を含む。外枠を開くたびに新しく作る
- トークンがパスの中にあるので、`styles.css` や `data.json` のような相対 URL はそのまま同じトークンの下で解決される。cookie が要らない
- 期限が切れたら、外枠が iframe を新しいトークンで読み直す
- `Referrer-Policy: no-referrer` で、外部 CDN にトークンが漏れないようにする

### `/c/*` の応答ヘッダー

- `Content-Security-Policy`: `sandbox …`（上記）に加えて、`default-src 'self' 'unsafe-inline' data: blob:`、script と style に許可リストの CDN（cdnjs, jsdelivr, unpkg, Google Fonts）、`connect-src 'self'`（と、そのページで許可したホスト）、`frame-ancestors 'self'`

### 外部への通信

既定ではページから外へ通信できない（`connect-src 'self'`）。プロンプトインジェクションを受けたエージェントが、ページに外部送信のコードを仕込むのを防ぐため。

- 外部 API を叩くページが必要なときは、`publish` の引数 `allow_connect: ["api.example.com"]` で許可する。ホスト名だけを受け付け、ワイルドカードは `*.example.com` の形だけ。`*` 単体は拒否する
- 許可は版ごとに保存し、`connect-src` に足す。一覧と閲覧画面のバーに「外部通信あり」の印を付ける
- root は `/settings` で、許可しているページの一覧を見て外せる。外したら、次に公開されるまでその版も許可なしで配信する
- 画像・フォント・CSS の読み込み（`img-src` など）は今までどおり許可リストの CDN と `data:` だけ。外部の画像を使うときは、ファイルとして一緒に公開する
- `Access-Control-Allow-Origin: *`（opaque origin から `fetch('data.json')` や `<script type="module">` を読むと CORS になるため。認可はトークンでしているので問題ない）
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: private, no-store`

管理画面側（`/`, `/a/*`, `/settings` など）は、フォームの POST に `Origin` の検査と CSRF トークンを付ける。sandbox のページが `allow-popups` で開いた窓からフォームを送っても、`Origin: null` になって弾かれる。

## 認証

### 人（ブラウザ）: パスキー

2026-10-17 に Google ログインからパスキーへ切り替え、Google ログインはそのあと削除した。デプロイする人が Google Cloud で OAuth クライアントを作る手間をなくすため。外部サービスの登録は一切要らない。

- 人は D1 の `users`（名前と役割）で表し、ログインはその人のパスキー（`passkeys`）で行う。メールアドレスは使わない
- 検証は `@simplewebauthn/server`（Workers で動く）。attestation は `none`、discoverable credential（`residentKey: required`）なので、ログインでユーザー名を聞かない。user verification は `preferred`
- challenge は D1 に置かず、署名付きの短命 cookie（5分、1回で消費）に入れる
- パスキーの JSON 処理は外部ライブラリなしで自前（`/assets/passkey.js`）。CDN を読まないので、管理画面の CSP は `script-src 'self' 'nonce-…'` のまま
- 1台の端末（またはパスワードマネージャー）に同じ人のパスキーは1つ（`excludeCredentials`）。別の端末からは `/account` で追加する

### 人が増える経路

| 経路 | 使う場面 |
|---|---|
| 持ち主の招待リンク | 最初の持ち主。デプロイスクリプトが owner がいないとき（または `--owner-link`）に D1 へ直接作り、URL を表示する。1日・1回限り |
| 閲覧者の招待リンク | 持ち主が `/settings` で作る。7日・1回限り。開いた人が名前を入れてパスキーを作る |
| `artifact open` | 登録済みの PC から、端末の鍵で署名した使い捨てのログインリンク（2分・1回）を開く。承認した人としてログインする。パスキーをなくしたときの復旧にもなる |
| QR コード | `/account` で使い捨てのログインリンクを QR にして表示し、スマホで読み取ってログインする。そのスマホでパスキーを足す |

招待リンクとログインリンクは、トークンそのものではなく sha256 だけを D1 に保存する。招待の受け付けは「招待を使用済みにする → ユーザーを作る（その招待を自分が使った場合だけ）→ パスキーを登録する」を1トランザクションで行い、同時に開かれても1人しか作られない。

### 役割

| 役割 | できること |
|---|---|
| root（Owner） | すべて。人の招待と削除、端末の承認と失効、外部通信の許可の取り消し、ゴミ箱 |
| viewer | 一覧と閲覧、自分のパスキーの管理（`/account`） |

- 自分自身は削除できないので、持ち主が0人になることはない
- 人を削除すると、その人のパスキーとセッションも消え、次のリクエストから見えなくなる
- 最後の1つのパスキーは削除できない（先に別のパスキーを足す）
- セッションは D1 に保存し、`APP_HOST` 限定の cookie（`HttpOnly; Secure; SameSite=Strict; __Host-` プレフィックス）を発行する。有効期限は30日
  - `Strict` にするのは、sandbox のページからのリクエストに確実に付かないようにするため。CLI や QR コードで開いたリンクから来た直後はクロスサイト扱いで cookie が付かないので、ログイン直後は同じサイト内のページへ一度移ってから表示する
- 端末の鍵で管理画面にもログインできる（`artifact open`）ので、端末の承認は持ち主の権限を渡すのと同じ重さになる。承認画面でコードと要求元の IP を必ず確かめる

### エージェント（CLI / MCP）: 端末ごとの公開鍵

API トークンをコピーして貼る方式はやめる。`gh auth login` のように、ブラウザで承認したら端末の公開鍵が登録される方式にする。

1. `artifact login --host artifacts.keyhole.work` を実行すると、Ed25519 の鍵ペアを作り、秘密鍵を `~/.config/artifact/key`（パーミッション 600）に保存する
2. CLI は公開鍵と端末名（`codex-laptop` など）を送り、短いコード（`ABCD-1234`）と承認 URL を受け取る
3. ブラウザで承認 URL を開き、root でログインして、同じコードが表示されていることを確かめて承認する（viewer は端末を登録できない）
4. サーバーは公開鍵を D1 に登録する。CLI はポーリングで承認を受け取る

以降のリクエストは秘密鍵で署名する:

```
Authorization: Artifact-Sig key=<keyId>, ts=<unix秒>, nonce=<ランダム>, sig=<base64>
署名対象: METHOD \n パス?クエリ \n ts \n nonce \n sha256(本文)
```

- サーバーは `ts` のずれを5分まで許し、`nonce` を5分間記録して再送を拒む
- サーバーには秘密がない（漏れても公開鍵だけ）。端末ごとに管理画面から失効できる
- どの端末が作った版かを `versions.created_by` に残す

Codex と Gemini を同じ端末で使うなら、鍵は1つで共有する。分けたければ `artifact login --profile gemini` のようにプロファイルを分ける。

## API

`/api/v1/*`。すべて署名必須。

| メソッド | パス | 内容 |
|---|---|---|
| `POST` | `/api/v1/blobs/check` | `{hashes: [...]}` を受け、R2 にまだないハッシュを返す |
| `PUT` | `/api/v1/blobs/:sha256` | ファイル1つを生のまま送る。Worker は R2 へそのまま流し込み、R2 がハッシュを検証する |
| `POST` | `/api/v1/artifacts` | 新規作成。本文は `manifest`（JSON）だけ。参照するハッシュが全部 R2 にあることを確かめ、`{id, url, version}` を返す |
| `PUT` | `/api/v1/artifacts/:id` | 新しい版を作る。`base_version` が最新と違えば 409 と最新の版番号を返す |
| `GET` | `/api/v1/artifacts` | 一覧（更新日時の新しい順） |
| `GET` | `/api/v1/artifacts/:id` | メタデータと版の一覧 |
| `GET` | `/api/v1/artifacts/:id/files/*path` | ファイルを読む（`?version=` で過去の版） |
| `DELETE` | `/api/v1/artifacts/:id` | ゴミ箱へ移す（`TRASH_DAYS` 日後に本当に消える） |
| `POST` | `/api/v1/devices/pair` | `artifact login` の開始（これだけ署名なし。公開鍵を受け取りコードを返す） |
| `GET` | `/api/v1/devices/pair/:code` | 承認待ちのポーリング |

`manifest` の形:

```json
{
  "title": "Q3 売上ダッシュボード",
  "description": "地域別の売上推移",
  "entry": "index.html",
  "files": { "index.html": "sha256:…", "data.json": "sha256:…" },
  "allow_connect": ["api.example.com"],
  "base_version": 3
}
```

公開の流れ: `blobs/check` → 足りないファイルだけ `PUT /api/v1/blobs/:sha256` → `manifest` を `POST`（新規）か `PUT`（更新）。すでに R2 にあるファイルは送らない。

### Worker の CPU 時間を使わない

Workers の無料プランは1回の処理あたり CPU 10ms まで。数 MB のファイルを Worker で multipart として解析したり、sha256 を計算したりすると、すぐに超える。

- ファイルは1つずつ生のまま `PUT` し、Worker は本文を読まずに `R2.put(key, request.body, { sha256 })` へ流す。ハッシュの検証は R2 がやるので、Worker の CPU はほとんど使わない（待ち時間は CPU 時間に数えない）
- `PUT /api/v1/blobs/:sha256` の署名は、本文のハッシュの代わりにパスの `sha256` を使う（本文と一致するかは R2 が確かめる）
- 配信も `R2.get()` の本文をそのまま応答に流す
- 署名の検証（Ed25519）、HMAC、パスキーの署名の検証（ES256 など）は Web Crypto のネイティブ実装で、どれも 1ms 前後

### 制限

- 1ファイル 25MB、1版 100MB、1版 200ファイルまで
- 拡張子から決めた Content-Type だけを許可（html, css, js, json, svg, png, jpg, webp, gif, woff2, mp4, pdf, txt, md, csv）
- 入口（`entry`）は `.html` だけ。Markdown のページは受け付けず、skill で「HTML にして公開する」と教える（`.md` は付属ファイルとしては置ける）

## データ

### D1

```sql
create table artifacts (
  id text primary key,          -- 推測できないランダム ID（base32 16文字）。URL の /a/:id になる
  title text not null,
  description text,
  current_version integer not null,
  created_at text not null,
  updated_at text not null,
  deleted_at text               -- ゴミ箱に入れた日時。TRASH_DAYS 日後に Cron で本当に消す
);

create table versions (
  artifact_id text not null references artifacts(id),
  version integer not null,
  entry text not null,
  files text not null,          -- JSON: { path: { sha256, size, type } }
  label text,
  allow_connect text,           -- JSON: ["api.example.com"]。null なら外部通信なし
  created_by text not null references devices(id),
  created_at text not null,
  primary key (artifact_id, version)
);

create table devices (
  id text primary key,
  name text not null,
  public_key text not null,     -- Ed25519（base64）
  created_at text not null,
  last_used_at text,
  revoked_at text
);

create table pairings (         -- artifact login の承認待ち。10分で期限切れ
  code text primary key,
  name text not null,
  public_key text not null,
  approved_device_id text,
  expires_at text not null
);

create table users (            -- 人。2026-10-17 に members（メールアドレス）から移行
  id text primary key,
  name text not null,
  role text not null,           -- root | viewer
  email text unique,            -- 未使用（Google ログインの名残。SQLite は UNIQUE 列を消せない）
  created_at text not null
);

create table passkeys (         -- WebAuthn の公開鍵。1人に複数
  id text primary key,          -- credential id
  user_id text not null references users(id),
  public_key text not null,     -- COSE
  counter integer not null,
  transports text,
  label text not null,          -- "Mac · Safari" など
  created_at text not null,
  last_used_at text
);

create table invites (          -- 招待リンク（sha256 のみ保存）
  token_hash text primary key,
  role text not null,
  created_by text,
  expires_at text not null,
  used_at text,
  used_by text
);

create table login_links (      -- artifact open の使い捨てリンク（2分）
  token_hash text primary key,
  user_id text not null references users(id),
  next text not null,
  expires_at text not null,
  used_at text
);

create table sessions (
  id text primary key,
  user_id text not null references users(id),
  csrf text not null,
  expires_at text not null
);

create table nonces (           -- 再送防止。5分で消す
  nonce text primary key,
  expires_at text not null
);
```

### R2

- キーは内容ハッシュ: `blobs/<sha256>`。版の `files` がそれを指す
- 同じ内容は1回だけ保存される。どの版からも参照されなくなった blob は、Cron Trigger で毎日消す

### 削除と版の保存

- 削除は論理削除。`deleted_at` を入れるとページは見えなくなり、`/settings` のゴミ箱から戻せる。`TRASH_DAYS` 日後に、毎日の Cron が D1 の行と参照されなくなった blob を消す
- 版は既定で全部残す。中身のハッシュで重複を省くので、テキストの更新ではほとんど容量が増えない
- `KEEP_VERSIONS` を 1 以上にすると、Cron が各ページの最新 N 版だけ残して古い版を消す

## 料金

2026-10-16 に Cloudflare の料金ページ（[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)）で確かめた値。

| サービス | 無料プラン | Workers Paid（月 $5 から） |
|---|---|---|
| Workers リクエスト | 1日10万 | 月1000万込み、超過は100万ごとに $0.30 |
| Workers CPU 時間 | 1回 10ms まで | 月3000万 ms 込み |
| D1 読み取り | 1日500万行 | 月250億行込み |
| D1 書き込み | 1日10万行 | 月5000万行込み、超過は100万行ごとに $1 |
| D1 保存 | 5GB | 5GB 込み、超過は $0.75/GB・月 |
| R2 保存 | 月 10GB | 同じ。超過は $0.015/GB・月 |
| R2 Class A（put・list） | 月100万回 | 超過は100万回ごとに $4.50 |
| R2 Class B（get・head） | 月1000万回 | 超過は100万回ごとに $0.36 |
| R2 転送量 | 無料 | 無料 |

R2 は無料プランでも Paid でも無料枠が同じで、超えた分だけ従量になる。Rate Limiting の binding は料金ページに記載がない。使えなかったら D1 で回数を数える。

### 見積もりの前提

1回の操作で使う量:

- 閲覧1回: Worker 6リクエスト（外枠1 + ページ本体とその付属ファイル5）、R2 get 5回、D1 はセッションの読み取り数行
- 公開1回: Worker 4リクエスト（check・ファイルの put 2・manifest）、R2 put 2回と head 数回、D1 書き込み 約10行（版・Artifact の更新・署名の nonce の記録と掃除）
- 保存量は、公開1回で増える分（重複を除いた新しいファイル）で数える

### 個人で使う場合

1日に公開 20回、閲覧 50回。1回の公開で新しく増えるのは 300KB（HTML と小さい画像）。

| 項目 | 使う量 | 無料枠に対して |
|---|---|---|
| Workers リクエスト | 1日 約400 | 0.4% |
| D1 書き込み | 1日 約250行 | 0.25% |
| R2 保存 | 月に 約180MB 増える | 10GB に届くのは約4年半後 |
| R2 Class A | 月 約1200回 | 0.1% |
| R2 Class B | 月 約1万回 | 0.1% |

**月 $0**。

### 多めに使う場合

閲覧者 10人と共有。1日に公開 200回、閲覧 1000回。1回の公開で新しく増えるのは 1MB（画像が多め）。

| 項目 | 使う量 | 無料枠に対して |
|---|---|---|
| Workers リクエスト | 1日 約7000 | 7% |
| D1 書き込み | 1日 約2500行 | 2.5% |
| R2 保存 | 月に 約6GB 増える | 2か月目で 10GB を超える |
| R2 Class A | 月 約2万回 | 2% |
| R2 Class B | 月 約20万回 | 2% |

かかるのは R2 の保存だけ。版を全部残すと1年で約72GB になり、(72 − 10) × $0.015 = **月 約 $0.93**。`KEEP_VERSIONS` で古い版を消せば、もっと下がる。

### Workers Paid（月 $5）が要るとき

- 閲覧が1日 約1万6000回を超える（リクエストが1日10万を超える）
- CPU 時間が1回 10ms を超える処理が要る（上の「Worker の CPU 時間を使わない」を守れば、v1 の範囲では要らない）

### そのほか

- ドメイン: 手持ちのドメインのサブドメインなので追加費用なし。証明書も Cloudflare の無料のもの
- パスキー: 外部サービスなし
- GitHub と npm への公開: 無料

## インストール

npm で配る。パッケージは `@keyhole-koro/artifacts`、コマンドは `artifact`。Codex・Gemini・Claude Code はどれも Node 製なので、使う人の手元には必ず Node がある。

```bash
npm i -g @keyhole-koro/artifacts
artifact setup --host artifacts.keyhole.work
```

- MCP の設定に `npx -y …` は書かない。起動のたびに最新版を取りに行って遅く、乗っ取られた版がそのまま動く。グローバルに入れた固定の版を使い、新しい版があれば `artifact` が知らせる
- `artifact setup` がやること:
  1. `artifact login`（ブラウザで承認して、端末の鍵を登録）
  2. インストールされているエージェントを探し、それぞれの公式コマンドで MCP を登録する（下記）。設定ファイルを直接は編集しない。形式が変わっても公式コマンドが吸収するため
  3. skills をそれぞれのフォルダにコピーする
  4. 何をしたかを表示する。`artifact uninstall` で MCP の登録と skills を取り除ける
- 余裕があれば、同じリポジトリを Gemini の extension と Claude Code の plugin としても使えるようにする（定義ファイルをルートに置き、`artifact mcp` と同じ skills を指す）

### MCP の登録

`artifact mcp` は stdio で話す MCP サーバーで、エージェントが子プロセスとして起動する。

```bash
# Codex       → ~/.codex/config.toml
codex mcp add artifact -- artifact mcp

# Gemini      → ~/.gemini/settings.json（--scope user で全プロジェクト共通）
gemini mcp add --scope user artifact artifact mcp

# Claude Code → ~/.claude.json
claude mcp add --scope user artifact -- artifact mcp
```

書かれる中身は、たとえば Codex なら:

```toml
[mcp_servers.artifact]
command = "artifact"
args = ["mcp"]
```

## AI から見た使い方

AI にとって `artifact` は、**MCP のツール4つ**と **skill 2つ**（`selfhost-artifact-design`、`selfhost-artifact-publish`）。

### ツール

Claude の Artifact ツールに合わせる。エージェントにとって分かりやすく、skill も流用しやすい。

| ツール | 引数 | 内容 |
|---|---|---|
| `publish` | `file_path`, `files?`, `title?`, `description?`, `url?`, `allow_connect?` | `url` なしで新規、ありで更新。`files` は `{公開パス: ローカルパス}`。`allow_connect` はページから通信してよいホスト |
| `read` | `url`, `path?` | 公開中の中身を読む |
| `list` | `limit?` | 一覧 |
| `delete` | `url` | ゴミ箱へ移す。ツール説明に「ユーザーが頼んだときだけ」と書く |

エージェントは MCP の `tools/list` で名前・説明・引数のスキーマを受け取る。`publish` の例:

```jsonc
{
  "name": "publish",
  "description": "ローカルの HTML を非公開ページとして公開し、URL を返す。url を渡すと同じ URL のまま更新する。同じ file_path を再び公開すると自動で更新になる。書く前に selfhost-artifact-design skill を読むこと。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path":   { "type": "string", "description": "公開する HTML の絶対パス" },
      "files":       { "type": "object", "description": "{公開パス: ローカルパス}。CSS・画像・データなど" },
      "title":       { "type": "string" },
      "description": { "type": "string" },
      "url":         { "type": "string", "description": "更新する既存ページの URL" },
      "allow_connect": { "type": "array", "items": { "type": "string" }, "description": "ページから fetch してよいホスト名。必要なときだけ" }
    },
    "required": ["file_path"]
  }
}
```

`artifact` は「このファイルパスはどのページか」を `~/.config/artifact/state.json` に覚える。

### 会話の流れ

「この CSV をグラフのページにして」と頼まれたら:

1. AI は skill の説明文から作業に合うと判断し、`selfhost-artifact-design` を読む
2. `./out/sales.html` を書く
3. `publish({ file_path: "/home/…/out/sales.html", title: "売上の推移" })` を呼ぶ
4. 結果が返る:
   ```
   公開しました: https://artifacts.keyhole.work/a/x7k2m9q4p1r8t3v6（版 1、非公開）
   ```
5. AI は URL をユーザーに伝える

続けて「色を変えて」と頼まれたら、AI はファイルを直して同じ `file_path` で `publish` を呼ぶ。URL はそのままで版 2 になる。

### エラー

エラーは MCP の `isError` で返し、AI が次に何をすればいいか分かる文にする。

| 状況 | 返す文 |
|---|---|
| 未ログイン | 「ログインしていません。ユーザーに `artifact login` の実行を頼んでください」 |
| 別の端末が先に更新した（409） | 「版 3 が最新です。`read` で最新を確かめ、変更を合わせて公開し直してください」 |
| 大きすぎる | 「1ファイル 25MB までです。sales.mp4 が 80MB あります」 |
| 許可していない種類のファイル | 「.exe は公開できません。公開できる種類: html, css, js, …」 |
| ファイルがない | 「/home/…/out/sales.html が見つかりません」 |

### MCP を使わない場合

同じ機能を CLI でも使える。`--json` で機械が読める形にする。

```bash
artifact publish ./out/sales.html --title "売上の推移" --json
artifact list --json
```

## skills

ページの作り方は Agent Skills（`SKILL.md`）で配る。Claude Code・Codex・Gemini CLI がどれも同じ形式を読めるので、1つ書けば全部で使える。

```
skills/
  selfhost-artifact-design/
    SKILL.md            # 書く前の手順と守ること（短く）
    references/
      layout.md         # スマホ幅、余白、表やグラフの置き方
      theming.md        # 色のトークン、ダークモード
      libraries.md      # 使ってよい CDN とバージョンの固定（CSP の許可リストと一致させる）
  selfhost-artifact-publish/
    SKILL.md            # いつ公開するか、更新のしかた、秘密情報を載せない、delete はユーザーが頼んだときだけ
```

`selfhost-artifact-design/SKILL.md` に書くこと:

- `<title>` は2〜4語の名前
- 色は `:root` のトークンで定義し、`prefers-color-scheme: dark` で切り替える。`body` の背景を明示する
- スマホ幅（左右16px の余白、横スクロールなし）で崩れない
- 外部スクリプトは `references/libraries.md` の CDN から、バージョンを固定して読む
- localStorage は try/catch で囲み、なくても動くようにする
- 秘密情報・認証情報・個人データをページに書かない

`artifact setup` が `~/.agents/skills/`（Codex と Gemini CLI の両方が読む）と `~/.claude/skills/`（Claude Code）にコピーする。コピーした skill のフォルダには印のファイルを置き、同じ名前の他人の skill は上書きしない。skills だけ入れ直すときは `artifact install-skills`（`--agent codex` のように対象を絞れる）。npm で `artifact` を更新したら、skills も新しい版に入れ直す。

## 画面

UI は英語。README と skills も英語にする（汎用の OSS として出すため）。ページの本文はエージェントがユーザーの言語で書く。

### 一覧（`/`）

- 更新日時の新しい順。タイトル・説明・更新日時・版、外部通信ありの印
- タイトルと説明で絞り込み（クライアント側。件数が増えたら D1 の検索に変える）
- サムネイルは v2

### 閲覧（`/a/:id`）

- 上に細いバー: タイトル、版、更新日時、「新しいタブで開く」（`/c/:token/` を直接開く。CSP の sandbox で隔離されたまま）、「版の履歴」
- 残りは全部 iframe
- スマホではバーを畳み、タイトルだけの1行にする

## 開発とテスト

- モノレポは pnpm workspaces
- ローカルは `wrangler dev`（D1・R2 はローカル）。パスキーは `localhost` でも動く（ブラウザは localhost を安全なオリジンとして扱う）
  - テストとオフライン開発のために、`DEV_LOGIN_EMAIL` を設定するとログインを省略できる。`APP_HOST` が `localhost` 以外なら起動時にエラーにして、本番で有効にならないようにする
- Worker のテストは `@cloudflare/vitest-pool-workers`（本物に近い D1・R2 で動く）
- 外枠と sandbox の隔離（ページの JS から cookie・親の DOM・`/api` に触れないこと）は Playwright で確かめる
- CLI と MCP は、`wrangler dev` に向けた結合テストで確かめる

## デプロイ

他の人が自分の Cloudflare に立てるときは:

```bash
git clone https://github.com/Keyhole-Koro/SelfHostArtifacts.git
cd SelfHostArtifacts && pnpm install
cd packages/worker && npx wrangler login && pnpm run deploy
```

`scripts/deploy.mjs` が対話式で次をまとめて行う: ホスト名の入力、D1 と R2 の作成（あれば再利用）、`wrangler.local.toml` の生成（`DEV_LOGIN` は消し、Custom Domain を足す）、マイグレーション、`wrangler deploy`、まだない secret の生成（`SESSION_SECRET` と `CONTENT_TOKEN_SECRET`）、持ち主がいなければ持ち主の招待リンクの表示。何度実行してもよい。

当初は npm の CLI に `artifact deploy` として入れる予定だったが、wrangler と Worker のソースを CLI に同梱すると重くなるのでやめた。デプロイする人はリポジトリを clone する。

Cloudflare 側の設定（D1・R2 の binding、Custom Domain、Cron、Rate Limiting）はすべて `wrangler.toml` に書いてあり、これが IaC の代わりになる。Cloudflare 以外に作るものはない。

## 乱用対策

- 認証なしで呼べるのは `POST /api/v1/devices/pair` と `/auth/*` だけ
- `pair` は Cloudflare の Rate Limiting（Workers の binding）で IP ごとに1分5回までにし、承認待ちは全体で同時に10件まで。超えたら 429
- 承認待ちは10分で期限切れ。承認画面ではコードと端末名と要求元の IP を表示し、身に覚えがなければ拒否できる

## リポジトリ構成

```
SelfHostArtifacts/
  packages/
    worker/        # 管理画面・API・ページ本体を1つの Worker で（Hono）
    cli/           # artifact（CLI + stdio MCP）
    shared/        # manifest の zod スキーマ、API の型、署名の作り方
  skills/
    selfhost-artifact-design/
    selfhost-artifact-publish/
  docs/
    design.md
  wrangler.example.toml
  pnpm-workspace.yaml
  LICENSE          # MIT
```

使う技術: TypeScript、pnpm、Hono、zod、`@modelcontextprotocol/sdk`、wrangler、Web Crypto（Ed25519 の検証は Workers で使える）、vitest、Playwright。

npm に公開するのは `packages/cli` だけ（`@keyhole-koro/artifacts`）。skills はこのパッケージに同梱し、`artifact setup` が配る。

## フェーズ

1. **v1（最小）**: Worker（ログイン、root と閲覧者、API、閲覧の外枠とページ本体）、D1・R2、`artifact setup/login/publish/list/read/delete`、stdio MCP、skills。Codex と Gemini の両方から1枚公開して開けるところまで
2. **v2**: 版の履歴と比較、ラベル、タイトル・説明の編集、端末の管理画面
3. **v3（共有）**: Artifact ごとの共有リンク（署名付き、期限つき、失効できる）、Artifact ごとに見せる相手を絞る
4. **v4（ページの機能）**: ページから使える共有 DB とページごとの保存領域（外枠が `postMessage` で受けて、Artifact ごとの Durable Object に読み書きする。sandbox のページは localStorage が使えないので、その代わり）、コメント

## 決定事項

- 名前: npm パッケージ `@keyhole-koro/artifacts`、コマンド `artifact`、リポジトリ `SelfHostArtifacts`
- ライセンス: MIT（Keyhole-Koro）
- ホスト: 1つ（keyhole.work では `artifacts.keyhole.work`）。パスで振り分ける。ページ本体は opaque origin で隔離する
- 認証: 人はパスキー（招待リンクで登録）、エージェントは端末ごとの Ed25519 鍵
- 配布: npm。`artifact setup` が各エージェントの公式コマンドで MCP を登録し、skills を配る
- 言語: UI・README・skills は英語
- 外部通信: 既定で禁止、`allow_connect` でページごとに許可
- 入口は HTML だけ（Markdown は受け付けない）
- 削除は論理削除で30日後に本当に消す。版は既定で全部残す
