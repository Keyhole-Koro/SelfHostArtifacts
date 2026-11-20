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
| `/a/:id/share`, `/a/:id/share/reset`, `/a/:id/share/off` | 公開リンクを作る・延長する／作り直す／止める（POST） | root（パスキーのセッション） |
| `/s/:id/:key` | 公開リンクの外枠（最新版だけ） | パスの中の鍵 |
| `/c/:token/*` | ページ本体の配信 | パスの中の署名付きトークン |
| `/api/v1/*` | エージェント用 API | 端末の署名 |

## ページ本体の隔離

エージェントが書いた任意の JS が動く。管理画面と同じオリジンで配信するので、ページ本体は**オリジンを持たない（opaque origin）状態**で動かして隔離する。

- 外枠は `<iframe src="/c/<token>/index.html" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals">` で読む。`allow-same-origin` は**付けない**
- さらに `/c/*` の応答そのものに、同じフラグで `Content-Security-Policy: sandbox …` を付ける。誰かが `/c/...` を直接（iframe の外で）開いても、やはり opaque origin になる。これが一番大事な防御で、iframe の属性だけに頼らない

これで、ページの JS は:

- 外枠や管理画面の DOM に触れない
- cookie を読み書きできない（`document.cookie` は使えない）
- `/api` を呼んでもセッション cookie が付かない（opaque origin からのリクエストはクロスサイト扱い。セッション cookie は `SameSite=Strict`）。API は端末の署名で認証するので、cookie だけで通る操作もない

代わりに、ページの中では localStorage・IndexedDB・cookie・Service Worker が使えない（例外が出る）。skill に「try/catch で囲み、なくても動くように」と書く。ページの状態を保存したい用途は v4 の共有 DB で受ける。

### トークン

- `/c/:token/` のトークンは HMAC で署名し、artifact id・版・有効期限（10分）を含む。外枠を開くたびに新しく作り、表示中は期限前に更新する
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

管理画面側（`/`, `/a/*`, `/settings` など）は、フォームの POST に `Origin` の検査と CSRF トークンを付ける。sandbox のページ自身がフォームを送っても、`Origin: null` になって弾かれる。

`allow-popups-to-escape-sandbox` は 2026-11-18 に足した。ないと、ページの中の `target="_blank"` のリンクで開いたタブも sandbox を引き継ぎ、そこで開いた別のページやログイン画面が opaque origin で動いて、パスキーのログインが「Failed to fetch」で失敗する。足しても、ページ本体は sandbox のままで、そのタブで `/c/*` を開いても応答の CSP で再び sandbox になる。新しいタブはページから見てクロスサイトなので、`SameSite=Strict` のセッション cookie は最初の読み込みに付かない（ログイン画面が出ることがある）。

## 認証

### 人（ブラウザ）: パスキー

2026-10-17 に Google ログインからパスキーへ切り替え、Google ログインはそのあと削除した。デプロイする人が Google Cloud で OAuth クライアントを作る手間をなくすため。外部サービスの登録は一切要らない。

- 人は D1 の `users`（名前と役割）で表し、ログインはその人のパスキー（`passkeys`）で行う。メールアドレスは使わない
- 検証は `@simplewebauthn/server`（Workers で動く）。attestation は `none`、discoverable credential（`residentKey: required`）なので、ログインでユーザー名を聞かない。user verification は `required`
- challenge は D1 に置かず、署名付きの短命 cookie（5分、1回で消費）に入れる
- パスキーの JSON 処理は外部ライブラリなしで自前（`/assets/passkey.js`）。CDN を読まないので、管理画面の CSP は `script-src 'self' 'nonce-…'` のまま
- 1台の端末（またはパスワードマネージャー）に同じ人のパスキーは1つ（`excludeCredentials`）。別の端末からは `/account` で追加する

### 人が増える経路

| 経路 | 使う場面 |
|---|---|
| 持ち主の招待リンク | 最初の持ち主。デプロイスクリプトが owner がいないとき（または `--owner-link`）に D1 へ直接作り、URL を表示する。1日・1回限り |
| 閲覧者の招待リンク | 持ち主が `/settings` で作る。7日・1回限り。開いた人が名前を入れてパスキーを作る |
| `artifact open` | 登録済みの PC から、端末の鍵で署名した使い捨てのログインリンク（2分・1回）を開く。承認した人として成果物を閲覧できるが、アカウント・設定・ペアリング操作はできない |
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
- `artifact open` で作るセッションは閲覧専用。アカウント、管理画面、端末承認はパスキーで作った通常セッションだけに許可する
- ログイン、パスキー・ユーザー・端末の変更、成果物の公開・削除は追記専用の `audit_events` に記録し、Settings に直近50件を表示する。トークン・コード・Cookie・本文は記録せず、180日を過ぎた行は日次処理で削除する

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
| `GET` | `/api/v1/artifacts` | 一覧（更新日時の新しい順）。`?project=<名前>` でそのプロジェクトだけ、`?project=` で属さないものだけ |
| `PATCH` | `/api/v1/artifacts/:id` | 版を作らずに動かす。`{project}` で別のプロジェクトへ（下のページごと。`null` で外す）、`{parent}` で同じプロジェクトの別のページの下へ（`null` で一番上）、`{position}` で兄弟の中の何番目か（1 から） |
| `GET` | `/api/v1/projects` | プロジェクトとページ数（属さないものは `null`） |
| `GET` | `/api/v1/artifacts/:id/comments` | ページのコメント。スレッドの最初のコメントの後に、その返信が続く |
| `POST` | `/api/v1/artifacts/:id/comments` | `{body, reply_to?, quote?, resolve?}` でコメントか返信（端末の名前で）。`resolve` は返信したスレッドを解決にする |
| `PUT` | `/api/v1/artifacts/:id/text` | `{version, text, links}` で今の版の本文とリンクを入れ直す。版は作らない（`artifact reindex` が、0009 より前のページに使う） |
| `GET` | `/api/v1/search?q=` | タイトル・説明・本文に、言葉を全部含むページ（スペース区切り）。抜粋では見つかった所を `[[` と `]]` で囲む |
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

- 1ファイル 25MB、1版 100MB、1版 500ファイルまで（画面キャプチャの一覧のような、画像の多いページが収まるように。files の JSON は500件でも D1 の1行に十分収まる）
- 拡張子から決めた Content-Type だけを許可（html, css, js, json, svg, png, jpg, webp, gif, woff2, mp4, pdf, txt, md, csv）
- 入口（`entry`）は `.html` か `.md`。`.md` は人がブラウザで書くページ（「ブラウザで書くページ」の節）。エージェントは新しいページを HTML で作り、`.md` はそのページを直すときだけ使う

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
  deleted_at text,              -- ゴミ箱に入れた日時。TRASH_DAYS 日後に Cron で本当に消す
  share_nonce text,             -- 公開リンクの nonce。null なら公開していない
  share_expires_at text,        -- 公開リンクの期限
  project text,                 -- 0007。属するプロジェクト（1 つだけ）。null なら属さない
  parent text,                  -- 0008。同じプロジェクトの中の、上のページ。null なら一番上
  position integer not null default 0 -- 0008。同じ親を持つページの中の順番
);

create table versions (
  artifact_id text not null references artifacts(id),
  version integer not null,
  entry text not null,
  files text not null,          -- JSON: { path: { sha256, size, type } }
  label text,
  allow_connect text,           -- JSON: ["api.example.com"]。null なら外部通信なし
  text text,                    -- 0009。CLI が読んだページの本文。検索と版の比較に使う
  created_by text not null references devices(id),
  created_at text not null,
  primary key (artifact_id, version)
);

create table spaces (           -- 0008。プロジェクトの説明と見せる相手。行の無いプロジェクトは everyone と同じ
  name text primary key,        -- artifacts.project と同じ名前
  description text,
  access text not null default 'everyone',  -- everyone | members
  created_at text not null
);

create table space_members (    -- 0008。Members only のプロジェクトを見られる人と、ブラウザから並べ替えられる人
  space text not null references spaces(name) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null,           -- viewer | editor
  primary key (space, user_id)
);

create table links (            -- 0009。今の版が指すページ
  from_id text not null,
  to_id text not null,
  primary key (from_id, to_id)
);
-- 0009。今の版のタイトル・説明・本文の全文検索
-- create virtual table page_text using fts5(id unindexed, title, description, body, tokenize = 'trigram');

create table comments (         -- 0010。ページのコメント。reply_to が null ならスレッドの最初
  id text primary key,
  artifact_id text not null,
  version integer not null,     -- 書いたときの版
  reply_to text,
  author_user text,             -- 人なら users.id
  author_device text,           -- エージェントなら devices.id
  author_name text not null,
  body text not null,
  quote text,                   -- 本文の一部へのコメントなら、その文字
  resolved_at text,
  created_at text not null
);

create table page_chunks (      -- 0011。意味検索の段落（Vectorize の <id>:<n> の文字）
  artifact_id text not null,
  n integer not null,
  text text not null,
  primary key (artifact_id, n)
);

create table page_vectors (     -- 0011。Vectorize に入っている版と段落の数
  artifact_id text primary key,
  version integer not null,
  chunks integer not null,
  indexed_at text not null
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
  used_at text,
  session_kind text not null     -- full | device
);

create table sessions (
  id text primary key,
  user_id text not null references users(id),
  csrf text not null,
  expires_at text not null,
  session_kind text not null     -- full | device
);

create table nonces (           -- 再送防止。5分で消す
  nonce text primary key,
  expires_at text not null
);

create table audit_events (     -- セキュリティ操作の追記専用ログ。180日保持
  id text primary key,
  event_at text not null,
  request_id text not null,
  actor_type text not null,     -- user | device | anonymous | system
  actor_id text,
  actor_label text,
  action text not null,
  target_type text not null,
  target_id text,
  result text not null,         -- success | denied | error
  ip_address text,
  user_agent text,
  metadata text                 -- 秘密値を含まない小さな JSON
);
```

### R2

- キーは内容ハッシュ: `blobs/<sha256>`。版の `files` がそれを指す
- 同じ内容は1回だけ保存される。どの版からも参照されなくなった blob は、Cron Trigger で毎日消す

### 削除と版の保存

- 削除は論理削除。`deleted_at` を入れるとページは見えなくなり、`/settings` のゴミ箱から戻せる。`TRASH_DAYS` 日後に、毎日の Cron が D1 の行と参照されなくなった blob を消す
- 版は既定で全部残す。中身のハッシュで重複を省くので、テキストの更新ではほとんど容量が増えない
- `KEEP_VERSIONS` を 1 以上にすると、Cron が各ページの最新 N 版だけ残して古い版を消す

## 秘密の受け渡し

2026-11-18 に足した。パスワードや API キーを、ページにも会話にも平文で出さずに人へ渡す。受け取る人のブラウザが鍵の組を作り、送る側（エージェント）はその公開鍵へ手元で暗号化する。Worker は公開鍵と暗号文を中継するだけで、平文を見ない。

1. エージェントが `secret_request`（CLI は `artifact secret request`）でリクエストを作る。受け取り用の URL `/secret/<token>` が返る。token は 256 ビットの乱数で、D1 には sha256 だけを置く
2. ユーザーが URL を相手へ送る。チャットやメールでよい
3. 相手がリンクを開くと、ブラウザが ECDH P-256 の鍵の組を作る。秘密鍵は取り出せない形（`extractable: false`）で IndexedDB に置き、公開鍵だけを送る。登録できるのは最初に開いたブラウザだけで、ほかのブラウザには「別のブラウザで開かれている」と出る
4. エージェントは `secret_status` で、開いた時刻・IP・ブラウザと、公開鍵の指紋（12 桁）を見る。指紋は CLI が公開鍵から自分で計算する。サーバーが鍵をすり替えても、相手の画面の数字と合わなくなる
5. `secret_send` が、ファイル（.env、JSON、テキスト）から値を読み、手元で暗号化して置く。結果には名前と指紋だけを返し、値は返さない
6. 相手の画面が暗号文を取り、秘密鍵で復号して表示する。「保存した」を押すと、サーバーの暗号文とブラウザの鍵を消す

- **暗号**: 送る側が使い捨ての P-256 鍵で ECDH → HKDF-SHA256（salt は送る側と受け取る側の公開鍵を続けたもの、info は `artifact-secret v1\0<id>`）→ AES-256-GCM（追加認証データも同じ）。別のリクエストへ暗号文を付け替えると復号できない。ブラウザ側のコードは `@artifact/shared` の `SECRET_CRYPTO_JS` で、`/assets/secret.js` と CLI のテストが同じものを使う
- **artifact と分けた理由**: artifact は版を残し、消してもゴミ箱に残り、一覧に出て、中身を平文で置き、sandbox の枠で動く（鍵を保存できない）。秘密のリクエストは版を持たず、受け取り・削除・期限で暗号文をその場で消し、一覧は `/settings` の Secrets にだけ出す。受け取る画面はサイト本体の画面（パスキーのログインと同じ CSP）
- **期限**: 既定 72 時間、最長 168 時間。Safari は 7 日使われなかったサイトのデータ（鍵）を消すため。毎日の Cron が期限切れの暗号文を消し、終わったリクエストは 30 日後に行ごと消す
- **受け取る人のアカウントは求めない**: 外の人にパスキーを作ってもらわずに済む。代わりに、受け取る前のリンクの横取りは、開いた時刻・IP・指紋を見てから送ることで防ぐ
- **守れないこと**: Worker を乗っ取られて偽の受け取り画面を配られる場合と、受け取る人の端末が乗っ取られている場合。Web で暗号化する仕組みに共通の限界
- **画面の言葉**: 受け取る画面だけ、`Accept-Language` で日本語と英語を切り替える

### 先に置くリンク（share）

2026-11-19 に足した。上の流れは、相手が開くのを待ってから送るので、やり取りが 2 往復になる。share は、送る側が先に暗号文を置き、相手はリンクを開いて「表示する」を押すだけで読める。1Password の共有や Bitwarden Send と同じく、鍵はリンクの `#` の後ろに入れる（ブラウザは `#` の後ろをサーバーに送らない）。さらに、最初に開いたブラウザだけが読めるようにする。

1. エージェントが `secret_share`（CLI は `artifact secret share`）を呼ぶ。CLI が 32 バイトのリンクの秘密を作り、HKDF-SHA256（salt なし、info `artifact-secret share v1`）で AES-256-GCM の鍵にして、値を暗号化する（内側の封筒）。Worker には内側の封筒だけを送り、リンク `/secret/<token>#<リンクの秘密>` を受け取る
2. ユーザーがリンクを相手へ送る
3. 相手がリンクを開くと、画面は「表示する」ボタンを出すだけで、何も登録しない。チャットやメールの下見（プレビュー、ウイルス検査）もリンクを開くため
4. ボタンを押すと、ブラウザが `#` からリンクの鍵を作り、ECDH P-256 の鍵の組を作って、どちらも取り出せない形で IndexedDB に置く。公開鍵を送る
5. Worker は、内側の封筒を、その公開鍵あての封筒 v1（上と同じ暗号）で包み、内側の封筒と置き換える。登録と置き換えは 1 つの更新で行い、行がまだ内側の封筒を持っているときだけ通るので、同時に押しても 1 台だけが勝つ
6. ブラウザは包んだ封筒を取り、自分の秘密鍵で開き、リンクの鍵で内側を開いて表示する。`#` はアドレスバーから消す。同じブラウザなら、あとで `#` なしで開いても読める

- **守れること**: 開かれる前は、サーバーにあるのはリンクの鍵がないと開けない暗号文だけ。開かれたあとは、リンクを手に入れても、そのブラウザの秘密鍵がないと開けない。ほかのブラウザは登録で断られる
- **守れないこと**: 相手より先にリンクを開いた人は読める（1Password の共有と同じ）。`secret_status` と `/settings` に開いた時刻・IP・ブラウザが出るので、違えば消して作り直す。Worker を乗っ取られた場合は、上と同じく守れない
- **D1 に残るもの**: 開かれる前の内側の封筒は D1 に入る。D1 の Time Travel で過去の状態に戻すと読めるが、それでもリンクの秘密がないと開けない
- **指紋は使わない**: 送る前に相手を確かめる手順がないため。確かめたいときは `secret_request` を使う
- **`PUT /api/v1/secrets/:id/sealed` は share には使えない**（409 `share_mode`）。`GET /secret/:token/sealed` は、開かれる前は 409 を返し、内側の封筒を渡さない

| パス | 認証 | 内容 |
|---|---|---|
| `GET /secret/:token` | URL のトークン | 受け取る画面 |
| `GET /secret/:token/state` | 同上 | 状態と、登録された公開鍵 |
| `POST /secret/:token/claim` | 同上と Origin | 公開鍵を登録する（1 回だけ。P-256 の点か確かめる）。share はここで暗号文を包む |
| `GET /secret/:token/sealed` | 同上 | 暗号文。最初に取られた時刻を記録する |
| `POST /secret/:token/received` | 同上と Origin | 受け取った。暗号文を消す |
| `POST /api/v1/secrets`、`GET /api/v1/secrets` | 端末の署名 | 作る（`share` を付けると先に置くリンク）、一覧 |
| `GET /api/v1/secrets/:id`、`DELETE /api/v1/secrets/:id` | 端末の署名 | 状態、消す |
| `PUT /api/v1/secrets/:id/sealed` | 端末の署名 | 暗号文を置く（開かれたあと 1 回だけ） |
| `POST /settings/secrets/:id/delete` | root | 消す |

```sql
create table secrets (          -- 0005_secrets.sql
  id text primary key,
  token_hash text not null unique,  -- 受け取り用 URL のトークンの sha256
  label text not null,              -- 受け取る人に見せる名前（秘密ではない）
  created_by text not null,         -- 端末 id。端末を失効しても記録は残すので外部キーは付けない
  created_at text not null,
  expires_at text not null,
  claimed_at text, claim_ip text, claim_user_agent text,
  public_key text,                  -- 受け取る人の公開鍵（P-256、raw を base64url）
  sealed_at text,
  ciphertext text,                  -- 暗号文（JSON）。終わったら null
  opened_at text,
  finished_at text,
  finished_by text                  -- recipient | owner | device | expiry
);
-- 0006_secret_share.sql
alter table secrets add column mode text not null default 'request';  -- request | share。share は開かれるまで ciphertext に内側の封筒
```

## 金庫（vault）

2026-11-19 に足した。API キーやパスワードを、持ち主の鍵と端末の鍵でしか開けない形で保管する。Worker に置くのは暗号文・公開鍵・包んだ鍵だけで、平文も秘密鍵も持たない。設計の合意は https://artifacts.keyhole.work/a/b243c7kyg2nm5pzt （既定の 6 項目で進めた）。

受け渡し（上の節）は「外の人に 1 回渡す」もので、金庫は「自分の端末とエージェントが何度も使う」もの。エージェントは値を見ずに、決めたコマンドの標準入力か 600 のファイルへ流す。

### 鍵の重ね方

| 鍵 | 何を包むか | 秘密鍵の置き場所 | Worker に置くもの |
|---|---|---|---|
| 非常用の鍵（recovery key） | 持ち主の鍵 | 1Password か紙。`artifact vault init` が 1 回だけ表示する | なし |
| 持ち主の鍵（owner key、P-256） | コレクションの鍵 | どこにも平文で置かない。復旧のときだけメモリーに置く | 公開鍵と、非常用の鍵で包んだ秘密鍵（`vault_owner_key_wraps`） |
| 端末の鍵（P-256。署名の Ed25519 鍵とは別） | コレクションの鍵 | OS のキーリング（libsecret / Keychain / Credential Manager、`@napi-rs/keyring`）。使えなければプロファイルの `vault-key.json`（600）。`ARTIFACT_KEYRING=file` で強制 | 公開鍵（`vault_members`） |
| コレクションの鍵（P-256） | 秘密ごとのデータ鍵 | 使うときだけメモリーに置く | メンバーごとに包んだ秘密鍵（`vault_grants`）と公開鍵 |
| データ鍵（AES-256、版ごと） | 値 | 使うときだけメモリーに置く | コレクションの公開鍵で包んだもの（`vault_versions.wrapped_dek`） |

- 公開鍵へ包むのは受け渡しと同じ封筒 v1（使い捨ての P-256 で ECDH → HKDF-SHA256 → AES-256-GCM）。HKDF の info と追加認証データは `artifact-vault v1\0<用途>\0<コレクション>\0<版や相手>` で、別の場所へ暗号文を付け替えると開かない（`vaultContext`、`@artifact/shared` の vault.ts）
- 値は AES-256-GCM。追加認証データにコレクション・秘密の名前・版を入れる
- 非常用の鍵は 32 バイトの乱数を Crockford base32（I・L・O・U なし）13 組で表示する。HKDF-SHA256 で AES の鍵にして持ち主の秘密鍵（JWK）を包む
- 読める相手を足すときは、コレクションの秘密鍵を相手の公開鍵へ包み直すだけ（秘密を 1 つずつ包み直さない）。端末を外したときは、コレクションの鍵を作り直し、残るメンバーに包み直し、生きている版のデータ鍵も新しい鍵で包み直す（`rotate`）

### 流れ

1. `artifact vault init`（持ち主が 1 回）: 端末の鍵を作ってキーリングへ、公開鍵を登録。持ち主の鍵を作り、非常用の鍵で包んで置き、非常用の鍵を表示する
2. `artifact vault create <collection>`: コレクションの鍵を作り、この端末と持ち主の鍵に包んで置く。コレクションはプロジェクトと環境ごと（`medishare-prod`、`medishare-stg`）
3. `vault put`: 値をファイルから読むか生成し、新しいデータ鍵で暗号化、データ鍵をコレクションの公開鍵へ包んで、次の版として置く。読む権限は要らない（公開鍵だけで入れられる）
4. `vault use`: 端末の鍵で自分の grant を開き、コレクションの鍵でデータ鍵を開き、値を開く。流し先はファイル（600）か、下の「流せるコマンド」の標準入力。人が端末で `--reveal` を付けたときだけ表示する。MCP の `vault_use` はコマンドだけで、ファイルは書かない。読み出しは `audit_events`（`vault.read`）に残る
5. `vault grant <collection> <device>`: 相手の端末が `artifact vault key` で作った鍵の指紋（公開鍵の SHA-256 の 12 桁）を、`vault devices` の表示と見比べてから包む
6. `vault revoke`: grant を消して `rotate`。外した端末が読めた値は変えるよう促す
7. `vault recover --recovery-key`: 持ち主の鍵を開き、すべてのコレクションの持ち主向けの grant を開いて、この端末向けに包み直す。端末は自分自身への grant だけは権限なしで置ける（本物のコレクションの鍵が無ければ開けない grant しか作れないため）

### API（`/api/v1/vault/*`、端末の署名）

| メソッド | パス | 内容 |
|---|---|---|
| `PUT` | `/members/me` | この端末の暗号化用の公開鍵を登録する。鍵を替えると前の grant は消える |
| `GET` | `/members` | メンバー（端末と持ち主）の一覧 |
| `GET` / `PUT` | `/owner` | 持ち主の鍵と包み。鍵は 1 つだけで、包みは足せる |
| `POST` / `GET` | `/collections`、`/collections/:name` | 作る（自分と持ち主の grant が必須）、一覧（この端末が読めるか付き）、詳細（自分の grant 付き） |
| `POST` / `DELETE` | `/collections/:name/grants`、`…/grants/:member` | grant を足す（他人には自分の grant が要る。自分には要らない）、消す（持ち主は消せない。応答に rotate の材料） |
| `GET` / `POST` | `/collections/:name/rotation`、`…/rotate` | rotate の材料（残るメンバーと生きている版）、鍵の入れ替え（生きている版を全部包み直さないと 409） |
| `GET` | `/collections/:name/owner-grant` | 持ち主向けの grant（復旧で使う。持ち主の鍵が無ければ開けない） |
| `GET` / `PUT` / `PATCH` / `DELETE` | `/collections/:name/secrets`、`…/secrets/:secret` | 一覧、新しい版（`version` は今の版 + 1。違えば 409）、台帳（説明・使っているもの）、秘密ごと削除 |
| `GET` / `DELETE` | `…/secrets/:secret/versions/:version` | 開くための材料（暗号文・包んだデータ鍵・自分の grant・コレクションの公開鍵。`latest` 可）、版の破棄 |

一覧・読み出し・台帳・破棄は、その時点のコレクションの鍵への grant を持つ端末だけ。`put` は端末であれば誰でも。端末を設定画面で失効すると `vault_members` も失効する（`revokeMembersOfDevice`）。

### D1（0016_vault.sql）

`vault_members`（端末か持ち主。公開鍵）、`vault_owner_key_wraps`（持ち主の秘密鍵の包み。`recovery`、将来 `passkey:<id>`）、`vault_collections`（名前、公開鍵、`key_version`）、`vault_grants`（コレクションの秘密鍵をメンバーごとに包んだもの、`key_version` ごと）、`vault_secrets`（名前、説明、`used_by`、`current_version`）、`vault_versions`（`wrapped_dek`、`ciphertext`、`destroyed_at`）。破棄した版は行を残して値を空にする。

### 守れること、守れないこと

| 起きること | 結果 |
|---|---|
| D1 のデータが漏れる | 守れる。暗号文と包んだ鍵、公開鍵しかない |
| 端末を 1 台なくす | `revoke`（鍵の入れ替え）で以後は読めない。その端末が読めた値は変える |
| 端末もパスキーも全部なくす | 非常用の鍵で `recover` |
| Worker が乗っ取られ、偽の公開鍵を渡される | `grant` の前に指紋を両方の画面で見比べる |
| 端末そのものが乗っ取られる | 守れない。その端末が読めるコレクションは読まれる |
| エージェントが値を持ち出そうとする（MCP の道具だけで） | ほぼ守れる。流せるのは下の 4 つの使い方だけで、結果に値が入らない。ファイルは人が端末で作るものだけ。残るのは、行き先にその端末のログインで書ける他人の置き場（他人が IAM にこちらを足した GCP のプロジェクトなど）を選ばれること |
| エージェントが端末でコマンドを自由に実行でき、ファイルを書き換えられる | 守れない（端末の乗っ取りと同じ）。`--reveal` や `--out` を使える。ツールの設定ファイルや PATH を書き換えて行き先を変えられる。守りはエージェントの実行許可のほう |

### 流せるコマンド（`vault use --run` と MCP の `vault_use`）

2026-11-21 に絞った。前はコマンドの名前（gcloud・gh・wrangler・circleci）だけを見ていて、引数は自由だった。`gh gist create --public -` で外へ出せ、コマンドの標準出力はそのままエージェントに返っていた。

流せるのは、秘密を置き場へしまう次の 4 つの使い方だけ（`packages/cli/src/vault-command.ts`）。

| 使い方 | 足せるもの |
|---|---|
| `gcloud secrets versions add SECRET_ID --data-file=-` | `--project`、`--location`、`--account`、`--quiet` |
| `gh secret set NAME` | `--repo OWNER/REPO`（ホストなし）・`--org`・`--user` のどれか 1 つ（必須）、`--env`、`--app`、`--visibility`、`--repos`、`--no-repos-selected` |
| `wrangler secret put NAME` | `--name` か `--config <絶対パス>/wrangler.{toml,json,jsonc}`（どちらか必須）、`--env` |
| `circleci context store-secret` | `--org-id ID CONTEXT NAME` か `github\|bitbucket ORG CONTEXT NAME`、`--skip-update-check` |

- 語ごとに確かめる（サブコマンド、位置引数、フラグ、フラグの値の形）。許可リストで、ほかは全部断る。値を表示するもの（`gh auth token`、`gcloud secrets versions access`、`--log-http`、`--debug`、`--no-store`）、ほかのファイルを読み込むもの（`--flags-file`、`--env-file`、`gh secret set -f`）、行き先を変えるもの（`--host`、`--token`、`--configuration`、`--repo HOST/…`、`--cwd`）が通らない。断るときは許される使い方を全部書いて返す
- 実行するのは、確かめた部品から組み立て直したもの。シェルは通さない。`ARTIFACT_GCLOUD`（vault push と同じ wrapper）は使う
- 作業ディレクトリは毎回作る空の一時ディレクトリ。エージェントが作業する場所のファイルで行き先を変えられないようにするため。wrangler 4 は作業ディレクトリの `.env` を自分の環境変数に読み、そこの `CLOUDFLARE_API_BASE_URL` に値とログインを送る。gh は git の remote からリポジトリを選ぶ（なので `--repo` などが必須）
- 出力（標準出力・標準エラー）に値が入っていれば、その出力は丸ごと返さない。見るのは、そのままの値、前後の空白を除いたもの、12 文字以上の各行、JSON・URL のエスケープ、16 進、base64（3 通りのずれ、URL 用も）。64 KiB を超える出力も返さない。返すのは終了コードと、ツールの短いメッセージ（2000 文字まで）
- MCP の `vault_use` はファイルを書かない。0600 でも、同じユーザーで動くエージェントは読める。ファイルが要るときは、人が端末で `artifact vault use … --out` を使う（エージェントはそれを頼む）
- 残るもの: どのプロジェクト・リポジトリ・Worker に置くかはエージェントが選べる。その端末のログインで書ける所に限られるが、GCP は他人が自分のプロジェクトの IAM にこちらのアカウントを足せる（承諾が要らない）ので、そこへは置けてしまう

### まだないもの

- ブラウザで開く・入れる（パスキーの PRF で持ち主の鍵を開く）。`vault_owner_key_wraps.wrapped_by` に `passkey:<credential id>` の形を用意してある
- 人から値をもらう「受け入れるまで保留」のリンク
- 署名の鍵（`key.pem`）のキーリングへの移行。今回は暗号化用の鍵だけキーリングに置く
- `/settings` の一覧。いまは CLI と MCP の `vault_list` だけ

### 配達（vault push）

2026-11-19 に足した。秘密ごとに「どこへ配るか」を `種類://住所` で台帳に登録し、`artifact vault push` が遅れている配達先にだけ今の版を配って、何が届いたかを記録する。設計: https://artifacts.keyhole.work/a/cq4gqx5824re9v4c 。Secret Manager の置き換えではない。Cloud Run の起動は Secret Manager から読むままにし、金庫は正本と配達の元になる。

| 種類 | 書き方 | 流し方 | 確かめ方・記録 |
|---|---|---|---|
| Secret Manager | `gcp://<project>/<secret id>` | `gcloud secrets versions add … --data-file=-`（`ARTIFACT_GCLOUD` で wrapper を指定できる） | 作られた版番号。`--no-verify` を付けなければ `versions access` で読み戻し、SHA-256 を比べて捨てる |
| CircleCI の context | `circleci://<gh\|bb>/<org>/<context>/<VARIABLE>[?token=<collection>/<name>]`。GitHub App でつないだ組織は slug が無いので `circleci://<組織の id>/<context>/<VARIABLE>` | v2 API の `PUT /context/{id}/environment-variable/{name}`。token は金庫の秘密から読む（無ければ `CIRCLECI_TOKEN`） | 読み戻せない。一覧の `updated_at` を記録 |
| GitHub Actions の secret | `github://<owner>/<repo>/<NAME>[?environment=…]` | `gh secret set NAME`（標準入力） | 読み戻せない。`gh secret list` の `updatedAt` を記録 |
| Cloudflare Worker | `wrangler://<worker>/<NAME>[?config=…&cwd=…]` | `wrangler secret put NAME`（標準入力）。Worker の新しいバージョンが出る | `wrangler secret list` に名前があるか |
| 手元のファイル | `envfile:///絶対パス#KEY` | 600 のファイルの `KEY=` の行を書き換える | 読み戻して比べる。平文が残る唯一の口なので、登録に `--plaintext-ok` が要り、一覧に印が付く |

- 値が端末の外へ出るのは配達先への入力（標準入力か TLS の本文）だけ。引数・ログ・MCP の結果には出ない。配達先の認証情報は Worker に置かず、gcloud・gh・wrangler はその端末のログインを使う
- 配達先と配達の記録は D1（`vault_targets`・`vault_deliveries`、0017）に置き、どの端末からも同じ台帳が見える。配達先の住所は秘密ではないが、どこに何があるかは分かるので、grant のある端末にだけ返す
- push は配達先ごとに「記録の版」と「今の版」を比べ、遅れているものだけ配る（`--force` で全部）。`--dry-run` は値を開かずに予定だけ出す。失敗は結果に残して次へ進み、`failed` として記録する。MCP の `vault_push` は既定で dry-run で、`apply: true` のときだけ配る
- `artifact vault import <collection> <name> gcp://…` は Secret Manager の最新の版を読んで金庫の版にし、配達先を登録して「届いた」と記録する。CircleCI と GitHub は値を読み戻せないので取り込めない
- push は Cloud Run を再デプロイしない。Secret Manager の新しい版は次のリビジョンから効く
- API: `GET /collections/:name/status`、`GET|POST /…/secrets/:secret/targets`、`DELETE /…/targets/:id`、`POST /…/targets/:id/deliveries`。監査は `vault.target_add`・`vault.target_remove`・`vault.push`（配達先と版と結果。値は含まない）

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
| Workers AI（意味検索の埋め込み） | 1日 10,000 Neurons。使い切るとその日は失敗する | 同じ量込み、超過は 1,000 Neurons ごとに $0.011 |
| Vectorize（意味検索の索引） | 保存 500万次元、検索 月3000万次元 | 保存 1000万次元・検索 月5000万次元込み |

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

AI にとって `artifact` は、**ページの MCP ツール4つ**（と秘密の受け渡しの5つ。「秘密の受け渡し」の節）と **skill 2つ**（`selfhost-artifact-design`、`selfhost-artifact-publish`）。

### ツール

Claude の Artifact ツールに合わせる。エージェントにとって分かりやすく、skill も流用しやすい。

| ツール | 引数 | 内容 |
|---|---|---|
| `publish` | `file_path`, `files?`, `title?`, `description?`, `url?`, `allow_connect?`, `project?`, `parent?` | `url` なしで新規、ありで更新。`files` は `{公開パス: ローカルパス}`。`allow_connect` はページから通信してよいホスト。`project` を省くと、新規は作業中の git リポジトリの名前のプロジェクトに入り、更新はそのまま。`parent`（ページの URL）を渡すと、そのページの下の子ページになり、そのページのプロジェクトに入る |
| `read` | `url`, `path?` | 公開中の中身を読む |
| `list` | `limit?`, `project?` | 一覧。`project` でそのプロジェクトだけ |
| `move` | `url`, `project?`, `parent?`, `position?` | 版を作らずに動かす。別のプロジェクトへ（下のページごと）、別のページの下へ、兄弟の中の順番へ |
| `comments` | `url`, `all?` | ページのコメントのスレッド（解決したものは `all` のときだけ） |
| `comment` | `url`, `body`, `reply_to?`, `quote?`, `resolve?` | コメントするか、スレッドに返信する。頼まれたことをしたら `resolve` で解決にする |
| `search` | `query`, `limit?` | タイトル・説明・本文の全文検索。書く前に、既にあるページを探してリンクするため |
| `delete` | `url` | ゴミ箱へ移す。ツール説明に「ユーザーが頼んだときだけ」と書く |
| `secret_share` | `label`, `file_path`, `keys?`, `expires_in_hours?` | ファイルの値を手元で暗号化して置き、`#` の後ろに鍵の入ったリンクを返す。最初に開いたブラウザだけが読める |
| `secret_request` | `label`, `expires_in_hours?` | 秘密の受け取り用の URL を作る |
| `secret_status` | `id?` | 開かれたか（時刻・IP・ブラウザ）と鍵の指紋。`id` なしで一覧 |
| `secret_send` | `id`, `file_path`, `keys?` | ファイルの値を手元で暗号化して置く。値は引数にも結果にも出さない |
| `secret_delete` | `id` | リクエストと暗号文を消す。ユーザーが頼んだときだけ |

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
      diagrams.md       # いつ図にするか、Mermaid の設定（トークンの色・ダークモード・スマホ）と構文の落とし穴
  selfhost-artifact-publish/
    SKILL.md            # いつ公開するか、更新のしかた、秘密情報を載せない、delete はユーザーが頼んだときだけ
```

`selfhost-artifact-design/SKILL.md` に書くこと:

- `<title>` は2〜4語の名前
- 色は `:root` のトークンで定義し、`prefers-color-scheme: dark` で切り替える。`body` の背景を明示する
- スマホ幅（左右16px の余白、横スクロールなし）で崩れない
- 手順・システム間のやりとり・状態の変化・構成が出てきたら図にする（`references/diagrams.md`）。文章や箇条書きだけで済ませない
- 外部スクリプトは `references/libraries.md` の CDN から、バージョンを固定して読む
- localStorage は try/catch で囲み、なくても動くようにする
- 秘密情報・認証情報・個人データをページに書かない

`artifact setup` が `~/.agents/skills/`（Codex と Gemini CLI の両方が読む）と `~/.claude/skills/`（Claude Code）にコピーする。コピーした skill のフォルダには印のファイルを置き、同じ名前の他人の skill は上書きしない。skills だけ入れ直すときは `artifact install-skills`（`--agent codex` のように対象を絞れる）。npm で `artifact` を更新したら、skills も新しい版に入れ直す。

## 画面

UI は英語。README と skills も英語にする（汎用の OSS として出すため）。ページの本文はエージェントがユーザーの言語で書く。

### 一覧（`/`）

- 更新日時の新しい順。タイトル・説明・更新日時・版、外部通信ありの印
- タイトルと説明で絞り込み（クライアント側。件数が増えたら D1 の検索に変える）
- プロジェクトのボタンで絞り込み（`/?project=<名前>`。サーバー側）。「All」のときは各行にプロジェクト名を出す
- サムネイルは v2

### プロジェクト

2026-11-19 に足した。ページが増えて、別々の作業のページが 1 つの一覧に混ざったため。

- 1 ページは 1 つのプロジェクトに入る（フォルダの形）。タグにしなかったのは、付け方がばらつくため
- 新しいページは、CLI（MCP サーバー）が動いているフォルダの git リポジトリの名前のプロジェクトに入る。名前は `origin` の URL の最後（`git@github.com:Owner/MediShare.git` なら `MediShare`）。`origin` がなければ、元のチェックアウトのフォルダ名（worktree のフォルダ名は使わない）。git の外ならプロジェクトなし。`ARTIFACT_PROJECT` で上書きできる（空ならなし）
- 更新はプロジェクトを変えない。`project` を渡したときだけ移す
- 一覧（`/`）の上にプロジェクトのボタンを並べ、`/?project=<名前>` で絞る。ページの画面の「Move」から持ち主が移せる

### スペース（プロジェクトの木と、見せる相手）

2026-11-19 に足した。Confluence のスペースのように、プロジェクトをページの置き場として使えるようにする計画の 1 段目。計画は「フェーズ」の節にある。

- プロジェクトの中のページは木になる。`artifacts.parent` が上のページ（同じプロジェクトの中だけ）、`position` が兄弟の中の順番。新しいページは兄弟の最後に付く
  - エージェントは `publish` の `parent`（ページの URL）で子ページを作り、`move` の `parent` と `position` で動かす。親を渡すと、ページは親のプロジェクトに入る
  - 自分自身や自分の下のページの下には置けない（Worker が確かめる）
  - 別のプロジェクトへ移すと、下のページもいっしょに移り、移ったページはそのプロジェクトの一番上に付く
  - ゴミ箱に入れると、下のページは 1 つ上へ上がる（木がゴミ箱の中を指さない）。戻したページは、親がもう無ければ一番上に戻る
- `/?project=<名前>` は、そのプロジェクトを木で見せる（版と更新日時つき）。検索は、合ったページとその上のページを残す
- ページの画面は、左にそのプロジェクトの木（今のページの上は開いておく）、上にパンくず（上のページ › … › 今のページ）を出す。左の木は「☰」で畳め、畳んだかどうかはブラウザに覚える（幅 900px 未満では最初から畳む）
- プロジェクトの設定（`/projects/:name`、持ち主だけ）: 説明、見せる相手、メンバー
  - 見せる相手は「Everyone」（閲覧者の全員。これまでと同じで、既定）か「Members only」（持ち主と、メンバーに入れた人だけ）
  - Members only のプロジェクトのページは、メンバーでない閲覧者には、一覧にもプロジェクトのボタンにも出ず、`/a/:id` と `/a/:id/token` は 404（無いページと同じ答え）
  - メンバーの役割は viewer か editor。editor は、そのプロジェクトのページの親と順番をブラウザから変えられる（別のプロジェクトへの移動は持ち主だけ）。ブラウザでページを書くこと（フェーズ 3）も editor に許す予定
  - 公開リンク（`/s/:id/:key`）はプロジェクトの見せる相手に関係なく、リンクを知っている人が開ける。エージェント（端末の署名）は持ち主の代わりなので、すべてのプロジェクトを読める
- D1: `spaces`（name、description、access）と `space_members`（space、user_id、role）。プロジェクトに初めてページが入ったときに `spaces` の行を作る。行の無いプロジェクトは Everyone と同じ。人を削除すると、その人のメンバーの行も消える

### 検索・リンク・版の比較

2026-11-19 に足した。スペースの 2 段目。

- 公開のとき、CLI がページの HTML（入口と、ほかの .html）から本文とリンク先を読み、`manifest` の `text`（10万字まで）と `links`（`/a/<id>` の id）で送る。Worker は解析しない（CPU の節を参照）。本文は script・style・コメントを除き、ブロックごとに 1 行にする。ページの script が実行時に書く文字は入らない
  - 古い CLI は `text` も `links` も送らない。そのときは前の本文とリンクを残す（タイトルと説明は更新する）
- 本文は版ごとに `versions.text` に置く（版の比較のため。版を整理すると一緒に消える）。今の版の本文は FTS5 の `page_text`（`trigram`）にも入れる。trigram は 3 文字の並びで引くので、単語の間に空白の無い日本語も、言葉の一部で見つかる
  - 検索はスペース区切りの言葉を全部含むページ。2 文字以下の言葉が混ざると trigram が使えないので、`like` で全部を見る（個人の規模なら十分速い）
  - 並びは bm25 で、タイトル、説明、本文の順に重くする。ゴミ箱のページは出さず、本当に消すときに索引からも消す
  - 画面: 上のバーの検索欄と `/search?q=`。抜粋は見つかった所に印を付け、残りは全部エスケープする。Members only のプロジェクトのページは、見られる人にしか出ない。エージェント（`GET /api/v1/search`、MCP の `search`、`artifact search`）は全部を探せる
- リンクは `links`（from_id、to_id）に今の版の分だけ置く。ページの画面の「Links」に、このページを指すページ（Linked from）と、このページが指すページ（Links to）を出す。見られないページは出さない
- ページの中のリンクで別のページへ移れるようにする。sandbox はページから外枠を動かさせないので、`/c/*` が HTML の最後のバイトの後ろに `<script src="/c/<token>/!artifact/nav.js">` を足す（解析しないので CPU は使わない。`</html>` の後ろでも body として動く）。この script は、同じホストの `/a/<id>` へのリンクのクリックを受けて、外枠に `postMessage` で頼む。外枠は、送り主が自分の iframe であることとパスの形を確かめてから移る
  - `!` は公開できるファイル名に使えないので、ページのファイルと重ならない
  - 公開リンクの iframe と、新しいタブで直接開いたページには足さない・働かない（そのときはふつうのリンクとして動く）。`target="_blank"` のリンクは今までどおり新しいタブで開く
- 版の比較（`/a/:id/diff?from=&to=`）: ブラウザが 2 つの版の本文（`/a/:id/text?v=`）を取り、行ごとに比べる（最長共通部分列）。変わった行の前後 2 行だけ見せ、残りは畳む。本文の無い版（0009 より前、古い CLI）はそう伝える

### 最近の動き・ウォッチ・通知

2026-11-19 に足した。Confluence に近づける 2 回目の 1 段目。

- ページの作成・変更、コメント・返信・解決を、1 件ずつ `activity` に記録する（誰が、どのページで、どの版・どのコメント）。プロジェクトの画面の「Recent activity」と `/activity`（見られるページの分だけ）、エージェントの `activity`（`GET /api/v1/activity`）で見る。180 日で消す
- ウォッチ（`watches`）: ページか、プロジェクト全体。ページの「Watch」とプロジェクトの「Watch this project」で切り替える。人がページを作る・保存する・コメントすると、そのページを自動でウォッチする
- 通知（`notifications`）: 動きを、それにかかわる人に 1 件ずつ届ける。理由は強い順に「mentioned」（コメントで名前を出された）、「thread」（自分が書いたスレッドへの返信と解決）、「watching」。やった本人と、そのページを見られない人（Members only のプロジェクトのメンバーでない人）には届けない。90 日で消す
  - 上のバーとページのバーのベルに未読の数を出す（セッションを読むときに一緒に数える）。`/notifications` で一覧、開くと既読、「Mark all as read」で全部既読
  - 届けるのはアプリの中だけ。メールやブラウザのプッシュ通知はしない
- メンション: コメント欄で「@」を打つと、そのページを見られる人の名前を出す。選ぶと本文に「@名前」が入り、その人の id がフォームと一緒に送られる。本文に「@名前」が残っている人だけに届ける（名前の文字から推測はしない）。表示では「@名前」を強調する（DOM で組み立て、HTML として読まない）

### ラベル

2026-11-19 に足した。2 段目。

- ラベルは、プロジェクトや木をまたいでページをまとめる言葉（「decision」「draft」「template」）。1 語（文字・数字・`-`・`_`、30 字まで）で、小文字にそろえ、空白は `-` にする。1 ページ 20 個まで（`labels` 表、0013）
- 付け方: 公開のとき（manifest の `labels`。更新で省くと今のまま、渡すと置き換え）、`POST /api/v1/artifacts/:id/labels`（`set`・`add`・`remove`）、ブラウザのページのバーの「Labels」（そのページを直せる人だけ）。ラベルを変えても新しい版にはしない
- 見方: ページのバーと木と一覧に小さなチップで出し、押すと `/?label=…` でそのラベルのページを並べる。一覧の上に、使われているラベルと数を出す（プロジェクトを開いているときは、そのプロジェクトの分だけ）
- 検索: 語の中の `label:名前` は、そのラベルを持つページだけに絞る。`label:` だけなら、そのラベルのページを新しい順に並べる
- ゴミ箱から消えたページは、ラベル・最近の動き・その通知・ウォッチも消す

### テンプレートとマクロ

2026-11-19 に足した。3 段目。

- テンプレート: ブラウザで新しいページを書くとき、何から始めるかを選ぶ。組み込みは Blank page・Meeting notes・Decision record・How-to・Overview of a section（`src/templates.ts`）。決めたラベル（decision など）も付く。同じプロジェクトの Markdown ページに「template」ラベルを付けると、それもテンプレートとして選べる。本文の最初の見出しを新しい題に替え、「template」以外のラベルを引き継ぐ
- マクロ: Markdown のページで、1 行に 1 つだけ書いた `{{…}}`。コードブロックの中と、文の途中のものは展開しない
  - `{{toc}}` 見出し（h2・h3）の目次。見出しには id を振る
  - `{{children}}` このページの下のページ
  - `{{recent}}` このプロジェクトで最近変わったページ（10 件）
  - `{{label 名前}}` そのラベルのページ（見られるものだけ、50 件）
  - `{{include URL}}` 同じプロジェクトの Markdown ページを、その場に埋め込む（1 ページに 5 つまで、200 KB まで。埋め込んだ先のマクロは展開しない）
- データの渡し方: 描画はサンドボックスの中（`doc.js`、marked の拡張）。目次以外は `/c/<token>/!artifact/macros.json` に問い合わせる。サーバーはそのときページの Markdown を読んでマクロを拾い、トークンを発行した人（viewer トークンに `u` として入れる）が見られるページだけを返す。公開リンクのトークンには何も返さない（`{"public":true}`）ので、公開ページから他のページの題名は漏れない
- エディタの「Insert…」で、目次・子ページ・最近・ラベル・埋め込みを、1 行として差し込める。Toast UI は `{}` を、見出しやリストなどに見える行のときしかエスケープしないので、マクロの行はそのまま保存される

### ページごとの権限

2026-11-19 に足した。4 段目。

- ページは 3 通り: Open（プロジェクトの決まりどおり）、Only some can edit（だれでも見られるが、挙げた人だけが直せる）、Only some can view（挙げた人だけが見られる。「can edit」の人は直せる）。`artifacts.restriction` と `page_access`（0014）
- 下のページにも効く。ページが見えるのは、そのページと上のページのすべての制限が、その人を通すときだけ。直せるのも同じ。プロジェクトの決まり（Members only、editor）が先にかかり、制限はそれを狭めるだけ。持ち主（root）はいつでも全部見て直せる。エージェントは持ち主の代わりなので、API は全部見える
- 設定するのは、そのページを直せる人（ページのバーの「Access」/「Restricted」）。制限をかけた人は自動で「can edit」に入り、自分を外すことはできない。挙げられるのは、そのプロジェクトを見られる人だけ
- 効く場所: ページ（見えなければ 404）、トークン、版の比較、コメント、ウォッチ、一覧・木・プロジェクトのページ数、検索、リンク、ラベル、最近の動き、通知（作るときも出すときも）、@ の候補、マクロ、エディタのメニュー、テンプレート、新しいページの親（直せるページの下にだけ）。数え方は再帰の CTE で、制限のあるページが 1 つも無ければ 1 回の問い合わせで終わる
- 制限のあるページをゴミ箱に入れると、下のページは上に移るので、そのページの制限を引き継ぐ（強いほうの制限と、各人について 2 つのうち弱いほうの権限）。だれも、それで見られるようにはならない
- 開いているページのトークン（10 分）は、制限をかけてもその間は使える。次の取り直しで断られる

### 同時編集

2026-11-19 に足した。5 段目。打った文字がその場で互いに見える共同編集ではなく、「誰が編集中か」を見せ、保存がぶつかったら 3-way マージする形。

- 編集画面は開いている間、20 秒ごとに `POST /a/:id/presence` を送る（`presence` 表、0015。1 分より古い行は数えず、毎日の掃除で消す）。答えで、ほかに編集中の人と、その間に保存された版を知らせる（「Sam Lee is editing too」「v6 was saved meanwhile」）。閉じるときと保存したときに行を消す
- ページを見ている人には、30 秒ごと（タブが見えている間だけ）`GET /a/:id/state` で、新しい版（「v6 by Sam · show it」）と編集中の人を出す
- 保存は `merge: true` を付けて送る。始めた版より新しい版があれば、サーバーが行ごとの 3-way マージ（`src/merge.ts`、Myers の差分で両方が残した行を軸にする）をする
  - 別々の行の変更なら、合わせたものを新しい版として保存する（`merged: true`）
  - 同じ行を違うように変えていたら保存せず、git と同じ印（`<<<<<<< your text` / `=======` / `>>>>>>> v6 by Sam`）を付けた本文を返す。編集画面はそれを Markdown 表示で入れ、直してもらう。印が残ったままの保存は断る
  - `merge` を付けない保存（以前の動き）は、これまでどおり 409

### HTML のページをブラウザで直す

2026-11-19 に足した。6 段目。

- エージェントが書いた HTML のページも、直せる人（持ち主・プロジェクトの editor・ページの制限で通る人）は「Edit source」でソースを直せる
- 編集器はページのサンドボックスの中（`!artifact/source.html`、`src/source.ts`）。CodeMirror 5.65.21 を cdnjs から版を固定し、SRI（sha512）付きで読む。読めなければ普通の入力欄になる
- 直せるのはテキストのファイル（html・css・js・json・svg・txt・md・csv・xml・yaml、1 MB まで）。最初に `!artifact/raw/<path>` から 1 回ずつ読む（viewer が足すリンク用のスクリプトの付かない、そのままのバイト。viewer トークンだけ）。トークンは 10 分で切れるので、外の編集画面が 8 分ごとに新しいものを渡す
- プレビューは、編集中の HTML を `srcdoc` にし、`<base href>` をそのページのファイルの場所にしたもの。変えた CSS と JS は、リンクの代わりに中に入れて見せる
- 保存は、変えたファイルだけを送る（`files`）。サーバーが HTML から本文とリンクを取り出し直す（CLI と同じ `pageText` / `pageLinks`。shared に移した）。間に保存されていれば、ファイルごとに 3-way マージする（同時編集と同じ）

### 意味で探す

2026-11-19 に足した。スペースの 4 段目。言葉が違っても、同じことを書いたページが見つかるようにする（「パスキーの登録」で「ログインの鍵を足す」の段落）。

- ページのタイトルと本文を 800 字ほどの段落に分け（1 ページ 16 段落まで）、Workers AI の `@cf/baai/bge-m3`（多言語、1,024 次元）でベクトルにして、Vectorize の索引 `artifacts-pages`（cosine）に `<id>:<n>` で入れる。どの版のベクトルを持っているかは D1 の `page_vectors`、段落の文字は `page_chunks` に置く
- 公開・保存のたびに、応答を返した後（`waitUntil`）で埋め込む。版の変わっていないページはやり直さない。短くなったページの余った段落は消す。ゴミ箱を本当に空にするときに、ベクトルも消す
- 前からあるページは、Settings の「Search by meaning」のボタンで 10 件ずつ埋め込む（ボタンは残りが無くなるまで繰り返す）。毎日の後片付けでも 10 件ずつ進める。1 回のリクエストで呼べる数に収めるため
  - 0009 より前のページは本文が D1 に無いので、先に `artifact reindex` で、CLI が今の版のファイルから本文とリンクを読み直して送る（`PUT /api/v1/artifacts/:id/text`。版は作らない）
- 検索は、言葉の検索（FTS5）と、言葉をベクトルにして近い段落を 40 個引いたもの（cosine 0.5 未満は捨てる）を、順位の逆数（RRF、k = 60）で 1 つに並べる。意味だけで見つかったページには「by meaning」を付け、合った段落を抜粋にする。Members only の扱いとゴミ箱は言葉の検索と同じ
- Workers AI と Vectorize の binding はデプロイの設定（`scripts/config.mjs` が書く `wrangler.local.toml`）にだけある。テストと `wrangler dev` は言葉だけで探し、意味の部分は偽物の AI と索引を渡して確かめる。binding が無いとき、Workers AI が断ったとき（無料プランで 1 日分を使い切ったなど）は、言葉の検索だけで答える
- 費用: 埋め込みは 100 万トークンで 1,075 Neurons。無料の 1 日 10,000 Neurons で、毎日 900 万トークンほど埋め込める。保存は 1 段落 1,024 次元なので、無料プランの 500 万次元で約 4,900 段落。検索は 1 回 1,024 次元で、月 約 29,000 回
- 索引は `scripts/deploy.mjs` が無ければ作る（`wrangler vectorize create artifacts-pages --dimensions=1024 --metric=cosine`）

### ブラウザで書くページ

2026-11-19 に足した。スペースの 3 段目。エージェントの HTML のページとは別に、人がブラウザで書くページ。

- 中身は Markdown（入口は `index.md`）。持ち主と、プロジェクトの editor が書ける。プロジェクトの画面の「Write a page」、ページの「Move → New page under this one」で作り（`POST /new`）、ページの「Edit」（`/a/:id/edit`）で直す
- 表示も編集も、ほかのページと同じ sandbox の中で動く。`/c/:token/!artifact/` の下に、Worker が持っている表示用の HTML（`doc.html`）と編集器（`editor.html`）を出す。`!` は公開できるファイル名に使えないので、ページのファイルとは重ならない
  - 表示は marked と DOMPurify（jsDelivr。版を固定し、integrity を付ける）で描く。読み込めなかったときは、Markdown をそのまま見せる
  - 編集器は Toast UI Editor 3.2.3（jsDelivr の `+esm`。ProseMirror も同じ CDN から読む）。Markdown と、見たまま編集（WYSIWYG）を切り替えられる。CDN が使えないときは、Markdown を直接書く欄になる
  - 管理画面（外枠）の側は外部のスクリプトを何も読まない。編集器は `postMessage` で Markdown を外枠に渡し、外枠が CSRF のヘッダー（`x-csrf`）を付けて `POST /a/:id/edit` に送る
- 保存は新しい版になる。`base_version` が今の版と違えば 409 で、今の版の番号を返す（上書きしない）。本文（Markdown）は検索と版の比較に、`[文字](/a/<id>)` はリンクに入る。1 MB まで
- 版の `created_by` は端末を指すので、ブラウザでの編集は人ごとの「ブラウザ用の端末」（`web-<user id>`、公開鍵なし、最初から失効）で記録する。署名には使えず、Settings の端末の一覧にも出ない
- エージェントも、`.md` のファイルを `publish`（`url` 付き）すれば、そのページを直せる。CLI は `.md` のとき、本文に Markdown を、リンクに Markdown のリンクを送る

### コメント

2026-11-19 に足した。スペースの 3 段目。

- ページ全体へのコメントと、本文の一部（選んだ文字）へのコメント。どちらもスレッドになり、返信できる。スレッドは解決（Resolve）にでき、戻せる
- ページの画面の「Comments」で右にパネルを開く。本文の文字を選ぶと「Comment on the selection」が出る。選んだ文字は、ページの中の `nav.js` が外枠に知らせる。コメントの付いた箇所は、外枠が `nav.js` に頼んで黄色く印を付け、押すとそのスレッドへ移る
- 書けるのは、そのページを見られる人（パスキーのセッション）。解決にできるのは、持ち主、プロジェクトの editor、スレッドを始めた人。消せるのは持ち主と書いた人（スレッドの最初を消すと、スレッドごと消える）
- 一覧には、ページごとに開いているスレッドの数を出す
- エージェントは `comments` で読み、`comment` で返信して、頼まれたことをしたら `resolve` で解決にする。名前は端末の名前で、「(agent)」と付く
- D1: `comments`（id、artifact_id、version、reply_to、author_user か author_device、author_name、body、quote、resolved_at、created_at）。ページを本当に消すときに一緒に消す
- コメントの本文と引用は文字として扱い、外枠では全部エスケープする。引用をスクリプトに渡すときは、`</script>` で閉じられないように `<` などを逃がす

### 公開リンク（`/s/:id/:key`）

ログインしていない人にも見せたいとき（応募書類に載せる URL など）のための、リンクを知っている人なら誰でも開ける URL。2026-11-02 に追加。

- 持ち主が閲覧画面の「Share」から作る。既定で30日有効。「Extend 30 days」で同じ URL のまま延長、「New link」で作り直し（古い URL は即座に無効）、「Turn off」で止める
- 鍵は `HMAC(CONTENT_TOKEN_SECRET, "share-link" ‖ id ‖ share_nonce)`（256 bit）。D1 には nonce だけを置くので、D1 の中身だけでは使える URL を作れない。nonce を消せば止まり、新しくすれば作り直しになる
- 見せるのは常に最新版だけ。一覧・版の履歴・持ち主の操作は出さない。中身は `/a/:id` と同じ `/c/:token/` の sandbox で表示する
- 公開リンクから出した `/c/:token/` には nonce を入れ、配信のたびに今の nonce と期限を確かめる。止めたり期限が切れたりすると、表示中のページもその場で読めなくなる（通常のトークンのように10分待たない）
- 期限切れのリンクを延長すると新しい URL になる。一度死んだ URL は生き返らない
- ゴミ箱に入れると止まり、戻しても止まったまま
- 切り替えられるのは root のパスキーのセッションだけ。`artifact open` の閲覧専用セッション、viewer、エージェント（端末の署名）からは操作できない。エージェントが勝手に公開することを防ぐため
- 公開リンクの応答には `X-Robots-Tag: noindex` を付ける。作成・延長・作り直し・停止は `audit_events` に記録する（鍵は記録しない）
- 一覧では `public` の印を付ける

### 閲覧（`/a/:id`）

- 上に細いバー: プロジェクトへ戻るリンク、パンくず、タイトル、版、更新日時、「新しいタブで開く」（`/c/:token/` を直接開く。CSP の sandbox で隔離されたまま）、「版の履歴」
- プロジェクトのページなら、左にそのプロジェクトの木（スペースの節を参照）
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
- `pair` は Cloudflare の Rate Limiting（Workers の binding）で IP ごとに1分5回までにし、承認待ちは同じ IP ごとに同時3件まで。超えたら 429。全体上限は設けず、別IPから待ち行列を埋めても正規の申請を妨害できないようにする
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
4. **スペース（Confluence のように）**: 2026-11-19 に持ち主と決めた計画。段階ごとに本番に出す
   1. プロジェクトの木と見せる相手（済み。「スペース」の節）
   2. ページどうしのリンクと被リンク、本文の全文検索、版どうしの差分（済み。「検索・リンク・版の比較」の節）
   3. ブラウザで書くページ（Markdown を元にし、見たまま編集もできる）と、ページ全体・本文の一部へのコメント（済み。「ブラウザで書くページ」と「コメント」の節）
   4. 意味で探す検索（済み。「意味で探す」の節）
5. **v4（ページの機能）**: ページから使える共有 DB とページごとの保存領域（外枠が `postMessage` で受けて、Artifact ごとの Durable Object に読み書きする。sandbox のページは localStorage が使えないので、その代わり）、コメント

## 決定事項

- 名前: npm パッケージ `@keyhole-koro/artifacts`、コマンド `artifact`、リポジトリ `SelfHostArtifacts`
- ライセンス: MIT（Keyhole-Koro）
- ホスト: 1つ（keyhole.work では `artifacts.keyhole.work`）。パスで振り分ける。ページ本体は opaque origin で隔離する
- 認証: 人はパスキー（招待リンクで登録）、エージェントは端末ごとの Ed25519 鍵
- 配布: npm。`artifact setup` が各エージェントの公式コマンドで MCP を登録し、skills を配る
- 言語: UI・README・skills は英語
- 外部通信: 既定で禁止、`allow_connect` でページごとに許可
- 入口は HTML か Markdown（`.md`）。Markdown のページは、人がブラウザで書くページ（2026-11-19 に、HTML だけという決定を変えた。エージェントは今までどおり HTML のページを作る）
- 削除は論理削除で30日後に本当に消す。版は既定で全部残す
