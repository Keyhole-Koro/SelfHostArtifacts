# SelfHostArticle 設計

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
[article（ローカルの npm パッケージ）] ── ローカルのファイルを読む・端末の秘密鍵で署名する
   │ HTTPS（署名付きリクエスト）
   ▼
[Worker]  APP_HOST（例: article.keyhole.work）── D1（メタデータ）・R2（ファイル）
   ├ /api/v1/*        エージェント用 API（端末の鍵で認証）
   ├ /                一覧（Google ログイン）
   ├ /a/:id           閲覧の外枠（Google ログイン）
   ├ /settings        端末の管理など（Google ログイン）
   └ /c/:token/*      ページ本体。外枠の sandbox iframe から読む
```

Worker は1つ、ホストも1つ。パスで振り分ける。

### MCP はローカル（stdio）にする

Claude の Artifact ツールが `file_path` を受け取るのは、ツールがローカルで動いているから。リモート MCP にすると、エージェントは HTML の中身を丸ごとツール引数に載せることになり、大きいページでトークンを食うし、画像などのバイナリも送れない。

そこで、ローカルで動く `article` パッケージを1つ作り、次の入口を持たせる:

- `article mcp` — stdio の MCP サーバー。Codex・Gemini・Claude Code のどれにも同じ形で登録できる
- `article publish ./report.html` など — シェルから直接使う CLI。MCP を使わないエージェントや手作業用
- `article setup` — 初期設定（ログイン、MCP の登録、skills の配置）。「インストール」の節を参照

## 設定

ドメインは `wrangler.toml` の変数で決める。コードにドメインを書かない。ホストは1つだけで、サブドメインのワイルドカードも別ドメインも要らない。

```toml
[vars]
APP_HOST = "article.example.com"
ROOT_EMAIL = "you@example.com"   # 持ち主の Google アカウント。1つだけ
KEEP_VERSIONS = "0"              # 残す版の数。0 なら全部残す
TRASH_DAYS = "30"                # 削除してから本当に消すまでの日数

# 秘密情報は wrangler secret put で入れる
# GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET / CONTENT_TOKEN_SECRET
```

- `wrangler.toml` では `APP_HOST` を Workers の Custom Domain にする（DNS と証明書は Cloudflare が用意する）
- 個人の設定（実際のドメインやメールアドレス）は `wrangler.toml` に直接書かず、`wrangler.local.toml`（git 管理外）に分ける。リポジトリには例だけを置く

keyhole.work なら `APP_HOST = "article.keyhole.work"`。

## パス

| パス | 内容 | 認証 |
|---|---|---|
| `/` | 一覧 | root・viewer |
| `/a/:id` | 閲覧の外枠（最新版） | root・viewer |
| `/a/:id/v/:version` | 閲覧の外枠（過去の版） | root・viewer |
| `/settings` | 閲覧者の追加と削除、端末の一覧と失効、外部通信を許可したページ、ゴミ箱 | root |
| `/pair/:code` | `article login` の承認画面 | root |
| `/auth/login`, `/auth/callback`, `/auth/logout` | Google ログイン | — |
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

### 人（ブラウザ）: Google ログイン

Cloudflare Access は使わず、Worker の中で Google の OpenID Connect を実装する。デプロイする人は Google Cloud で OAuth クライアントを作り、ID と secret を入れるだけで済む（Zero Trust の設定が要らない）。

- Authorization Code + PKCE。`state` と `nonce` を検証する
- ID トークンの `email_verified` が true で、`email` が root か閲覧者（下の表）のときだけ通す

### 役割

| 役割 | 誰か | できること |
|---|---|---|
| root | `ROOT_EMAIL` の1人 | すべて。閲覧者の管理、端末の承認と失効、Artifact の削除 |
| viewer | root が `/settings` で登録したメールアドレス | 一覧と閲覧だけ |

- 閲覧者は D1 の `members` に入る。環境変数を編集して再デプロイする必要はない
- root は環境変数でだけ決まり、画面からは消せない。設定を壊しても締め出されない。持ち主を変えるときは `ROOT_EMAIL` を変えて再デプロイする
- 閲覧者を削除したら、その人のセッションも D1 から消す（次のリクエストから見えなくなる）
- メールアドレスは小文字にそろえて比べる。Gmail のドットや `+` の扱いは正規化しない（Google が返した `email` をそのまま使う）
- v1 の閲覧者はすべての Artifact を見られる。Artifact ごとに見せる相手を絞るのは v3
- セッションは D1 に保存し、`APP_HOST` 限定の cookie（`HttpOnly; Secure; SameSite=Strict; __Host-` プレフィックス）を発行する。有効期限は30日
  - `Strict` にするのは、sandbox のページからのリクエストに確実に付かないようにするため。Google からのリダイレクト直後はクロスサイト扱いで cookie が付かないので、`/auth/callback` は cookie を発行したあと同じサイト内のページへ一度リダイレクトする

### エージェント（CLI / MCP）: 端末ごとの公開鍵

API トークンをコピーして貼る方式はやめる。`gh auth login` のように、ブラウザで承認したら端末の公開鍵が登録される方式にする。

1. `article login --host article.keyhole.work` を実行すると、Ed25519 の鍵ペアを作り、秘密鍵を `~/.config/article/key`（パーミッション 600）に保存する
2. CLI は公開鍵と端末名（`codex-laptop` など）を送り、短いコード（`ABCD-1234`）と承認 URL を受け取る
3. ブラウザで承認 URL を開き、root でログインして、同じコードが表示されていることを確かめて承認する（viewer は端末を登録できない）
4. サーバーは公開鍵を D1 に登録する。CLI はポーリングで承認を受け取る

以降のリクエストは秘密鍵で署名する:

```
Authorization: Article-Sig key=<keyId>, ts=<unix秒>, nonce=<ランダム>, sig=<base64>
署名対象: METHOD \n パス?クエリ \n ts \n nonce \n sha256(本文)
```

- サーバーは `ts` のずれを5分まで許し、`nonce` を5分間記録して再送を拒む
- サーバーには秘密がない（漏れても公開鍵だけ）。端末ごとに管理画面から失効できる
- どの端末が作った版かを `versions.created_by` に残す

Codex と Gemini を同じ端末で使うなら、鍵は1つで共有する。分けたければ `article login --profile gemini` のようにプロファイルを分ける。

## API

`/api/v1/*`。すべて署名必須。

| メソッド | パス | 内容 |
|---|---|---|
| `POST` | `/api/v1/artifacts` | 新規作成。multipart（`manifest` + ファイル群）。`{id, url, version}` を返す |
| `PUT` | `/api/v1/artifacts/:id` | 新しい版を作る。`base_version` が最新と違えば 409 と最新の版番号を返す |
| `GET` | `/api/v1/artifacts` | 一覧（更新日時の新しい順） |
| `GET` | `/api/v1/artifacts/:id` | メタデータと版の一覧 |
| `GET` | `/api/v1/artifacts/:id/files/*path` | ファイルを読む（`?version=` で過去の版） |
| `DELETE` | `/api/v1/artifacts/:id` | ゴミ箱へ移す（`TRASH_DAYS` 日後に本当に消える） |
| `POST` | `/api/v1/devices/pair` | `article login` の開始（これだけ署名なし。公開鍵を受け取りコードを返す） |
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

更新時、すでに R2 にあるハッシュのファイルは送らない（サーバーが「足りないハッシュ」を返し、クライアントはそれだけ送る）。

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

create table pairings (         -- article login の承認待ち。10分で期限切れ
  code text primary key,
  name text not null,
  public_key text not null,
  approved_device_id text,
  expires_at text not null
);

create table members (          -- 閲覧者。root はここに入れない（ROOT_EMAIL で決まる）
  email text primary key,       -- 小文字
  added_at text not null
);

create table sessions (
  id text primary key,
  email text not null,
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

個人利用なら、ほぼ確実に無料枠に収まる（下は 2026 年中ごろの知識。デプロイ前に Cloudflare の料金ページで確かめる）。

| サービス | 無料枠 | 超えたとき |
|---|---|---|
| Workers | 1日10万リクエスト | Workers Paid（月 $5）で月1000万リクエスト込み |
| D1 | 保存 5GB、1日あたり読み取り500万行・書き込み10万行 | Workers Paid に含まれる枠が大きく、超過は従量 |
| R2 | 保存 10GB/月、書き込み系100万回・読み取り系1000万回/月。**転送量は無料** | 保存 $0.015/GB・月 |

D1 に入るのはメタデータだけ（1版で数行）なので、無料枠の書き込み10万行/日に届くことはまずない。大きいのは R2 の保存量で、HTML 中心なら 10GB は相当先。動画を多く置くと先に R2 が効いてくる。

ホストは手持ちのドメインのサブドメイン1つなので、ドメインや証明書の追加費用はない。

## インストール

npm で配る。パッケージは `@keyhole-koro/article`、コマンドは `article`。Codex・Gemini・Claude Code はどれも Node 製なので、使う人の手元には必ず Node がある。

```bash
npm i -g @keyhole-koro/article
article setup --host article.keyhole.work
```

- MCP の設定に `npx -y …` は書かない。起動のたびに最新版を取りに行って遅く、乗っ取られた版がそのまま動く。グローバルに入れた固定の版を使い、新しい版があれば `article` が知らせる
- `article setup` がやること:
  1. `article login`（ブラウザで承認して、端末の鍵を登録）
  2. インストールされているエージェントを探し、それぞれの公式コマンドで MCP を登録する（下記）。設定ファイルを直接は編集しない。形式が変わっても公式コマンドが吸収するため
  3. skills をそれぞれのフォルダにコピーする
  4. 何をしたかを表示する。`article uninstall` で MCP の登録と skills を取り除ける
- 余裕があれば、同じリポジトリを Gemini の extension と Claude Code の plugin としても使えるようにする（定義ファイルをルートに置き、`article mcp` と同じ skills を指す）

### MCP の登録

`article mcp` は stdio で話す MCP サーバーで、エージェントが子プロセスとして起動する。

```bash
# Codex       → ~/.codex/config.toml
codex mcp add article -- article mcp

# Gemini      → ~/.gemini/settings.json（--scope user で全プロジェクト共通）
gemini mcp add --scope user article article mcp

# Claude Code → ~/.claude.json
claude mcp add --scope user article -- article mcp
```

書かれる中身は、たとえば Codex なら:

```toml
[mcp_servers.article]
command = "article"
args = ["mcp"]
```

## AI から見た使い方

AI にとって `article` は、**MCP のツール4つ**と **skill 2つ**（`article-design`、`article-publish`）。

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
  "description": "ローカルの HTML を非公開ページとして公開し、URL を返す。url を渡すと同じ URL のまま更新する。同じ file_path を再び公開すると自動で更新になる。書く前に article-design skill を読むこと。",
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

`article` は「このファイルパスはどのページか」を `~/.config/article/state.json` に覚える。

### 会話の流れ

「この CSV をグラフのページにして」と頼まれたら:

1. AI は skill の説明文から作業に合うと判断し、`article-design` を読む
2. `./out/sales.html` を書く
3. `publish({ file_path: "/home/…/out/sales.html", title: "売上の推移" })` を呼ぶ
4. 結果が返る:
   ```
   公開しました: https://article.keyhole.work/a/x7k2m9q4p1r8t3v6（版 1、非公開）
   ```
5. AI は URL をユーザーに伝える

続けて「色を変えて」と頼まれたら、AI はファイルを直して同じ `file_path` で `publish` を呼ぶ。URL はそのままで版 2 になる。

### エラー

エラーは MCP の `isError` で返し、AI が次に何をすればいいか分かる文にする。

| 状況 | 返す文 |
|---|---|
| 未ログイン | 「ログインしていません。ユーザーに `article login` の実行を頼んでください」 |
| 別の端末が先に更新した（409） | 「版 3 が最新です。`read` で最新を確かめ、変更を合わせて公開し直してください」 |
| 大きすぎる | 「1ファイル 25MB までです。sales.mp4 が 80MB あります」 |
| 許可していない種類のファイル | 「.exe は公開できません。公開できる種類: html, css, js, …」 |
| ファイルがない | 「/home/…/out/sales.html が見つかりません」 |

### MCP を使わない場合

同じ機能を CLI でも使える。`--json` で機械が読める形にする。

```bash
article publish ./out/sales.html --title "売上の推移" --json
article list --json
```

## skills

ページの作り方は Agent Skills（`SKILL.md`）で配る。Claude Code・Codex・Gemini CLI がどれも同じ形式を読めるので、1つ書けば全部で使える。

```
skills/
  article-design/
    SKILL.md            # 書く前の手順と守ること（短く）
    references/
      layout.md         # スマホ幅、余白、表やグラフの置き方
      theming.md        # 色のトークン、ダークモード
      libraries.md      # 使ってよい CDN とバージョンの固定（CSP の許可リストと一致させる）
  article-publish/
    SKILL.md            # いつ公開するか、更新のしかた、秘密情報を載せない、delete はユーザーが頼んだときだけ
```

`article-design/SKILL.md` に書くこと:

- `<title>` は2〜4語の名前
- 色は `:root` のトークンで定義し、`prefers-color-scheme: dark` で切り替える。`body` の背景を明示する
- スマホ幅（左右16px の余白、横スクロールなし）で崩れない
- 外部スクリプトは `references/libraries.md` の CDN から、バージョンを固定して読む
- localStorage は try/catch で囲み、なくても動くようにする
- 秘密情報・認証情報・個人データをページに書かない

`article setup` が `~/.codex/skills/`、`~/.gemini/skills/`、`~/.claude/skills/` にコピーする。skills だけ入れ直すときは `article install-skills`（`--agent codex` のように対象を絞れる）。npm で `article` を更新したら、skills も新しい版に入れ直す。

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
- ローカルは `wrangler dev`（D1・R2 はローカル）。Google ログインは開発用の OAuth クライアント（リダイレクト先 `http://localhost:8787/auth/callback`）を使う
  - テストとオフライン開発のために、`DEV_LOGIN_EMAIL` を設定するとログインを省略できる。`APP_HOST` が `localhost` 以外なら起動時にエラーにして、本番で有効にならないようにする
- Worker のテストは `@cloudflare/vitest-pool-workers`（本物に近い D1・R2 で動く）
- 外枠と sandbox の隔離（ページの JS から cookie・親の DOM・`/api` に触れないこと）は Playwright で確かめる
- CLI と MCP は、`wrangler dev` に向けた結合テストで確かめる

## デプロイ

他の人が自分の Cloudflare に立てるときは:

```bash
npx @keyhole-koro/article deploy
```

対話式で次をまとめて行う: ドメインと `ROOT_EMAIL` の入力、D1 と R2 の作成、マイグレーション、secret の入力（Google の OAuth クライアント ID と secret、`SESSION_SECRET` と `CONTENT_TOKEN_SECRET` は自動生成）、`wrangler deploy`。結果は `wrangler.local.toml` に書く。README には同じことを手作業でやる手順も残す。

## 乱用対策

- 認証なしで呼べるのは `POST /api/v1/devices/pair` と `/auth/*` だけ
- `pair` は Cloudflare の Rate Limiting（Workers の binding）で IP ごとに1分5回までにし、承認待ちは全体で同時に10件まで。超えたら 429
- 承認待ちは10分で期限切れ。承認画面ではコードと端末名と要求元の IP を表示し、身に覚えがなければ拒否できる

## リポジトリ構成

```
SelfHostArticle/
  packages/
    worker/        # 管理画面・API・ページ本体を1つの Worker で（Hono）
    cli/           # article（CLI + stdio MCP）
    shared/        # manifest の zod スキーマ、API の型、署名の作り方
  skills/
    article-design/
    article-publish/
  docs/
    design.md
  wrangler.example.toml
  pnpm-workspace.yaml
  LICENSE          # MIT
```

使う技術: TypeScript、pnpm、Hono、zod、`@modelcontextprotocol/sdk`、wrangler、Web Crypto（Ed25519 の検証は Workers で使える）、vitest、Playwright。

npm に公開するのは `packages/cli` だけ（`@keyhole-koro/article`）。skills はこのパッケージに同梱し、`article setup` が配る。`deploy` を使うため、Worker のソースとマイグレーションも同梱する。

## フェーズ

1. **v1（最小）**: Worker（Google ログイン、root と閲覧者、API、閲覧の外枠とページ本体）、D1・R2、`article setup/login/publish/list/read/delete`、stdio MCP、skills。Codex と Gemini の両方から1枚公開して開けるところまで
2. **v2**: 版の履歴と比較、ラベル、タイトル・説明の編集、端末の管理画面
3. **v3（共有）**: Artifact ごとの共有リンク（署名付き、期限つき、失効できる）、Artifact ごとに見せる相手を絞る
4. **v4（ページの機能）**: ページから使える共有 DB とページごとの保存領域（外枠が `postMessage` で受けて、Artifact ごとの Durable Object に読み書きする。sandbox のページは localStorage が使えないので、その代わり）、コメント

## 決定事項

- 名前: npm パッケージ `@keyhole-koro/article`、コマンド `article`、リポジトリ `SelfHostArticle`
- ライセンス: MIT（Keyhole-Koro）
- ホスト: 1つ（keyhole.work では `article.keyhole.work`）。パスで振り分ける。ページ本体は opaque origin で隔離する
- 認証: 人は Google ログイン（`ROOT_EMAIL` と、root が登録した閲覧者）、エージェントは端末ごとの Ed25519 鍵
- 配布: npm。`article setup` が各エージェントの公式コマンドで MCP を登録し、skills を配る
- 言語: UI・README・skills は英語
- 外部通信: 既定で禁止、`allow_connect` でページごとに許可
- 入口は HTML だけ（Markdown は受け付けない）
- 削除は論理削除で30日後に本当に消す。版は既定で全部残す
