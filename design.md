# 詳細設計書 - Todoist ⇄ Google カレンダー 同期（GAS）

対象要件: `requirements.md`（2026-09-15、2026-09-17 改訂）
作成日: 2026-09-15（2026-09-17 改訂: D9〜D11、P→T を Todoist API 直接呼び出しに変更）

---

## 0. 設計判断

### D1. 初回照合で対応付けた予定は削除しない【確定】

**問題**: 要件の書き方どおりに `srcUid` を相互に書き込むだけだと、対応付けた予定がどちらも M・C（生成物）に分類されます。それぞれの `srcUid` が指す予定は起点集合 T・N に含まれないため、S3 で primary の B が、S6 で「Todoist」カレンダーの A が削除されます。

**対策**: 相互に `srcUid` を書き込むときに `extendedProperties.private.initialMatch = 'true'` も付けます。このフラグが付いた予定は **T/N/M/C のどれにも含めず、同期の対象から外します**。

- S1〜S6 の作成・更新・削除の対象にならない
- ペアの片方が後で削除されても、もう片方は削除されない
- トレードオフ: ペアになった予定は、その後の変更も追従しない。タスクを動かしても primary 側は動かず、会議が取り消されてもタスクは残る（要件の「同期対象から除外」どおり）

### D2. 繰り返し予定の例外回は同期しない【確定・理由を補足】

ご指摘のとおり、Todoist ではタスクの特定の回だけを変更できません。そのため、T 側（Todoist 起点）には例外回がありません。この除外が必要なのは **primary 側** のためです。

- 同僚が繰り返し会議の 1 回だけを変更・削除すると、primary に例外回のイベント（`recurringEventId` あり）ができる
- `singleEvents: false` で取得すると、例外回は親の系列と**同じ `iCalUID`** を持つ別のイベントとして返る。取り消された回（`status: 'cancelled'`）も `showDeleted: false` のまま返る
- ミラーの 1 回だけを誰かが UI で変更した場合も、同じように例外回ができる

`iCalUID` をキーに突き合わせているので、例外回を除外しないとキーが衝突し、照合が壊れます。Todoist ではもともと回ごとの変更を表現できないので、例外回を除外しても失われるものはありません。

### D3. primary の特殊なイベント種別はタスク化しない【確定】

N に含めるのは `eventType` が `default` と `fromGmail` の予定だけです（`workingLocation` / `outOfOffice` / `focusTime` / `birthday` は対象外）。

### D4. ミラーには通知を付けない【確定】

M には `reminders: { useDefault: false, overrides: [] }` を設定します。

### D5. C は N を正とする【確定】

「Todoist」カレンダーや Todoist で C（会議から作ったタスク）を変更しても、S5 によって N の内容に戻ります。

### D6. srcUid を失ったときに備え、スプレッドシートに対応表を残す【V1 への対策】

公式連携が `extendedProperties` を消した場合、生成物（C）が起点（T）と誤判定され、primary にミラーが作られて会議が二重になります。そこで、イベントの `extendedProperties` とは別に、スプレッドシートの `links` シートにも対応関係を記録します。

| 列 | 内容 |
|---|---|
| `calendar` | `primary` / `todoist` |
| `iCalUID` | 生成物またはペアの予定自身の `iCalUID` |
| `srcUid` | コピー元（ペアの場合は相手）の `iCalUID` |
| `kind` | `generated` / `paired` |
| `recordedAt` | 記録した日時 |

- **正はイベント側の `extendedProperties`** とし、`links` は記録として持つ
- `srcUid` を持たない予定が `links` に載っていたら、`srcUid` が消えたと判断する。`links` の内容で `srcUid`（ペアなら `initialMatch` も）を書き戻し、**WARN ログを出す**。黙って読み替えることはせず、修復したことを必ず記録する
- 公式連携が毎回 `srcUid` を消す場合は、5 分ごとに WARN が出続けるので、ログを見れば分かる
- 公式連携がイベントを削除して作り直す（`iCalUID` まで変わる）場合は、この方法でも防げない。R5 として既知の制約にする

### D7. 事前検証（Phase 1 で確認）

| # | 確認内容 | 崩れた場合の影響 |
|---|---|---|
| V1 | C をタスク化した後も、公式連携が C の `extendedProperties.private` を残すか | D6 で修復できる。ただし毎回消されるなら、5 分ごとに修復が続く |
| V2 | 公式連携が C の summary/start/end を書き換えないか（所要時間の丸めなど） | S5 と公式連携が書き換え合い、5 分ごとに更新が続く |
| V3 | 繰り返しの C（会議の系列）について、Todoist で 1 回分を完了したときに公式連携がイベントの開始日を進めるか・削除するか | 開始日を進めると S5 で元に戻され、削除すると S4 で作り直される。繰り返しでない C は、会議が終われば同期範囲の外に出るので影響しない（下記の補足） |
| V4 | `Events.patch` に `recurrence: []` を送ると、繰り返しが解除されるか | 解除されなければ、繰り返しをやめた予定を更新できない |
| V5 | `Events.patch` で `extendedProperties.private` の一部のキーだけを送ったとき、他のキーが残るか | 残らなければ、mark や修復のときに公式連携が書いたキーを消してしまう |

**V3 の補足（修正）**: 単発の予定については、同期範囲は「現在時刻以降」（`timeMin` は予定の**終了時刻**で判定される）です。終わった会議のタスクを完了しても、C は既に範囲の外なので S4 は動きません。

ただし、繰り返し予定（`recurrence` あり、`singleEvents: false`）には `timeMin` が効きません。**`Calendar.Events.list` は、系列の最終回がとうに終わっていても、その系列を返します**（系列変更後などに顕著）。`requirements.md` の「同期範囲」（過去は対象外）に反するため、D8 で取得後にもう一段のフィルタを設ける。

影響が残るのは、次の 2 つだけです。

- 会議が終わる前にタスクを完了した場合（その会議の C は作り直される。※本改訂により C 自体が廃止されたため、この項目は D9 以降に読み替える）
- 繰り返し系列。系列の最後の回が未来にある限り、系列全体が範囲内に残る（D8 適用後も、未来回が残っている系列はこれまでどおり範囲内）

### D8. 全回終了済みの繰り返し系列を起点分類から除外する【確定】

**問題**: `listFutureEvents` の `timeMin` は予定の終了時刻で判定されるが、`singleEvents: false` で取得した繰り返し系列には効かない。`RRULE:FREQ=WEEKLY;UNTIL=20260817T065959Z;BYDAY=MO` のように全回が過去に終わっている系列でも API がそのまま返してくる。これを起点（T/N）として分類すると、`requirements.md`（同期範囲: 過去は対象外）に反して S1/S4 でミラー・複製が作られ続ける。

**対策（案A、instances API 呼び出し）**: `recurrence` を持つ起点候補に限り、`calendarGateway.hasFutureInstance(calendarId, eventId, now)` で `Calendar.Events.instances(calendarId, eventId, { timeMin: now.toISOString(), maxResults: INSTANCE_LOOKUP_MAX_RESULTS, showDeleted: false })` を呼び、未来回の有無を確認する。未来回がなければ `classify()` のルール8（起点確定）でその予定を起点から除外する。

- `COUNT` 指定や例外回（EXDATE/RDATE）も API 側の展開結果で正確に判定できる（自前で RRULE を解析しない）
- `classify()` の純粋性を保つため、判定は `hasFutureOccurrence: (event: CalendarEvent) => boolean` として注入する。`classify()` 自体は GAS グローバル（`Calendar`）を直接呼ばない
- 除外するのは起点候補（ルール8）だけで、生成物（ルール4・5、M/C）には適用しない。除外した起点の生成物は `origins` から欠落するため、`reconcile()` の S3/S6 の孤児削除により次回同期で自動的に消える。既存の「終了系列の複製」もこれで解消する
- 繰り返しを持つ起点候補ごとに `Events.instances` の呼び出しが 1 回増える（API 呼び出しの追加コスト）

### D9. P→T を「Todoist」カレンダーへの複製（C）から Todoist API 直接呼び出しに変更する【確定・本改訂の中心】

**問題**: Todoist のヘルプによれば、公式の Google カレンダー連携は「Todoist」カレンダーに直接追加されたイベントからタスクを新規作成しない（既にタスクに紐づいたイベントの変更を反映するだけ）。そのため、当初の設計（N を「Todoist」カレンダーに複製すれば公式連携がタスク化する）は、一度もタスクを生成していなかった。

**対策**: P→T は GAS から Todoist API v1（`https://api.todoist.com/api/v1`）を `UrlFetchApp` で直接呼び出す方式に変更する。T→P（公式連携が作る「Todoist」カレンダーのイベントを primary にミラーする方向）は、公式連携の障害・仕様に依存しないため、そのまま維持する。

- ベース URL: `https://api.todoist.com/api/v1`。認証は `Authorization: Bearer <token>`（トークンはスクリプトプロパティ `TODOIST_API_TOKEN` から読む。未設定・空文字なら明確に throw する）
- `GET /tasks` はカーソルベースのページング（レスポンスの `results` / `next_cursor`）。`next_cursor` が `null` になるまで `cursor` クエリパラメータを渡して繰り返す。1 ページの上限は 200 件
- 作成: `POST /tasks`（`content` 必須、`due_date` または `due_datetime` のどちらか）。更新: `POST /tasks/{id}`（同じボディ）。削除: `DELETE /tasks/{id}`
- プロジェクトは指定しない（Inbox に作られる）。プロジェクト ID の設定項目は設けない（要件どおり）
- `due_datetime` は UTC（`Z` 付き、秒精度）に変換して送る。タスクの `due.date` は、終日なら `'YYYY-MM-DD'`、時刻ありなら `'YYYY-MM-DDTHH:MM:SSZ'`（自分たちが作ったタスクは常にこの形式で返る前提。本番導入直後に確認すること。V6 参照）
- 対応付けは `links` シートの `srcUid ↔ todoistTaskId` だけで行う。タスク本体（`content`/`description`）には何も書き込まない（Design Choice 2）
- 繰り返し（`recurrence` を持つ）N は、当面 P→T タスク化の対象外とする（RRULE → `due_string` の無損失変換が困難なため。Design Choice 4）

### D10. S1 の二重ミラー除外（自作タスクの echo 対策）【確定】

**問題**: 日時付きのタスクは、Todoist 公式連携が「Todoist」カレンダーにイベント（echo）を作る。このイベントは GAS が付けた `srcUid` を持たないため、`classify()` によって無条件に T（起点）と判定され、S1 で primary に不要なミラーが作られてしまう（同じ会議が primary に二重に見える）。

**対策**: `main.ts` で、有効な生成タスクを持つ N（`resolveTodoistTaskLinks` の `generated` に含まれる N）の集合を作り、`excludeOwnTaskMirrors()`（`syncPlanner.ts`）でコンテンツキー（`start + '|' + summary`。初回照合と同じ関数 `contentKeyForInitialMatch` を再利用する）が一致する T 候補を、`planSync` に渡す前に除外する。

- 曖昧一致（同じキーの T 候補、または同じキーの N-with-task が複数）は安全側に倒し、除外せず `WARN` を記録する（無関係な自然発生の同名タスクを誤って隠さないため）
- `classify()` 自体は変更しない（`eventClassifier.ts` は calendar イベントの分類だけを純粋に担当する既存の責務を保つ）。除外は `main.ts` の orchestration 層で行う

### D11. Todoist タスクの完了・削除を尊重する（再作成しない）【確定】

**問題**: N に対応する Todoist タスクをユーザーが完了・削除した場合、次回の同期で S4（作成）が再び走ると、ユーザーの操作を無視してタスクを作り直してしまう。

**対策**: `resolveTodoistTaskLinks()`（`syncPlanner.ts`）が `links` の `todoist`/`generated` 行を現在のアクティブなタスク一覧（`GET /tasks`。完了済みタスクは含まれない）と突き合わせる。

| 状態 | 扱い |
|---|---|
| タスクがアクティブ、対応する N もある | 通常どおり `generated` に含める（S5/S6 の対象） |
| タスクがアクティブ、対応する N が無い（会議が削除された） | `generated` に含める。`reconcileTodoistTasks` の孤児削除ロジックにより S6 で削除される |
| タスクが非アクティブ（完了・削除済み）、対応する N がまだある | `generated`/`origins` のどちらにも含めない（S4 を再発生させない）。`links` の行は残す（再発生防止の記録として） |
| タスクが非アクティブ、対応する N も無い | `links` の行を取り除く（掃除。タスクは既に無いので削除アクションは出さない） |

判定に必要な「対応する N があるか」は `main.ts` が `primary.origins` の `iCalUID` 集合と突き合わせて決める（`resolveTodoistTaskLinks()` 自体は `links` と `activeTasks` しか見ない純粋関数のため）。

### D12. 事前検証（本改訂分。V6）

| # | 確認内容 | 崩れた場合の影響 |
|---|---|---|
| V6 | `due_datetime` に UTC（`Z` 付き）で送った場合、`GET /tasks` のレスポンスの `due.date` が同じ `Z` 付き UTC 文字列で返るか（別のタイムゾーンの壁時計表記に変換されて返らないか） | 変換されて返る場合、`isSameTodoistTaskContent` の文字列比較が常に不一致となり、5 分ごとに S5 update が空振りし続ける。本番導入直後に `log` シートで S5 の頻度を確認すること |

---

## 1. アーキテクチャ概要

### 1.1 システム構成図

```
┌──────────┐  公式連携（T→P のみ）  ┌──────────────────────┐
│ Todoist  │ ⇄──────────────────⇄ │ 「Todoist」カレンダー │
└────┬─────┘                       │   T（起点）           │
     │ ▲                          └──────────┬───────────┘
     │ │ Todoist API v1                      │ Calendar API v3（Advanced Service）
     │ │ （P→T。UrlFetchApp 直接呼び出し）     │
     │ │                       ┌──────────────┴──────────────┐
     │ └───────────────────────┤ GAS（時間トリガー 5 分）     │
     └─────────────────────────┤  sync()                     │
                                │   ├ LockService             │
                                │   ├ 取得 → 分類 → 計画 → 実行│
                                │   └ log / links シート       │
                                └──────────────┬──────────────┘
                                               │
                                    ┌──────────┴───────────┐
                                    │ primary カレンダー    │ ⇄ 同僚
                                    │   N（起点）/ M（ミラー）│
                                    └──────────────────────┘
                      Spreadsheet: settings / log / links
```

### 1.2 技術スタック

| 区分 | 採用 | 理由 |
|---|---|---|
| 実行環境 | Google Apps Script（V8）、スプレッドシートにコンテナバインド | 要件 |
| カレンダーアクセス | Advanced Calendar Service（Calendar API v3） | `CalendarApp` では `extendedProperties`、`iCalUID`、`recurrence` を扱えない |
| Todoist アクセス | Todoist API v1（`UrlFetchApp` による直接呼び出し） | 公式カレンダー連携は「Todoist」カレンダーへの直接追加からタスクを新規作成しないため（D9） |
| 言語 | TypeScript（`any`/`unknown`/`class` は使わない） | 型で分類ミスを防ぐ |
| 型定義 | `@types/google-apps-script` | `GoogleAppsScript.Calendar.Schema.Event` などを使う |
| バンドル | esbuild（1 ファイルにまとめ、トップレベル関数を footer で公開） | clasp 3 系は TypeScript を変換しないため |
| デプロイ | `@google/clasp` | |
| 単体テスト | Vitest | 判断ロジックは副作用のない純粋関数にし、ローカルでテストする |
| Lint | ESLint + typescript-eslint | |

---

## 2. コンポーネント設計

### 2.1 コンポーネント一覧

| ファイル | 責務 | 依存 | 副作用 |
|---|---|---|---|
| `src/main.ts` | 公開関数（`sync` / `setup` / `cleanupLegacyTodoistCopies`）。ロック取得と全体の流れ | 全モジュール | あり |
| `src/config.ts` | 定数 | なし | なし |
| `src/types.ts` | 型定義 | なし | なし |
| `src/settingsRepository.ts` | `settings` シートの読み書き、シートの初期化 | config | あり |
| `src/linksRepository.ts` | `links` シートの読み込みと全件の書き換え | config, types | あり |
| `src/logger.ts` | ログをメモリに溜め、`log` シートへ一括で追記 | config | あり |
| `src/calendarGateway.ts` | Calendar API の呼び出し（list/insert/patch/remove/instances） | config | あり |
| `src/todoistGateway.ts` | Todoist API v1 の呼び出し（listTasks/createTask/updateTask/removeTask） | config | あり |
| `src/eventClassifier.ts` | T/N/M/ペア/対象外への分類と、srcUid を失った予定の検出（calendar イベントのみ。P→T のタスク側は扱わない） | config, types | なし |
| `src/eventContent.ts` | 内容の正規化・比較、書き込み用リソース／Todoist タスクペイロードの生成 | config, types, todoistGateway（型のみ） | なし |
| `src/initialMatcher.ts` | 初回照合の計画（T↔N のペアリング。本改訂による変更なし） | eventContent, types | なし |
| `src/syncPlanner.ts` | S1〜S6 の計画、P→T 用の links/アクティブタスク突き合わせ（`resolveTodoistTaskLinks`）、S1 二重ミラー除外（`excludeOwnTaskMirrors`） | eventContent, types | なし |
| `src/linksPlanner.ts` | 実行結果から、新しい `links` を組み立てる | types | なし |
| `src/actionExecutor.ts` | 計画した処理を API で実行し、ログに記録して結果を返す（`calendar: 'todoist'` の create/update/delete は todoistGateway へ振り分ける） | calendarGateway, todoistGateway, eventContent, logger | あり |

### 2.2 各コンポーネントの詳細

#### config.ts

```typescript
export const SRC_UID_KEY = 'srcUid';
export const INITIAL_MATCH_KEY = 'initialMatch';
export const INITIAL_MATCH_VALUE = 'true';
export const PRIMARY_CALENDAR_ID = 'primary';
export const TRIGGER_INTERVAL_MINUTES = 5;
export const LOCK_WAIT_MS = 1000;
export const LIST_PAGE_SIZE = 2500;
export const SEND_UPDATES = 'none';
export const SHEET_SETTINGS = 'settings';
export const SHEET_LOG = 'log';
export const SHEET_LINKS = 'links';
export const SETTING_KEY_TODOIST_CALENDAR_ID = 'todoistCalendarId';
export const SETTING_KEY_INITIAL_MATCH_DONE_AT = 'initialMatchDoneAt';
export const ORIGIN_EVENT_TYPES: ReadonlyArray<string> = ['default', 'fromGmail'];
export const TRIGGER_HANDLER = 'sync';

// Todoist API v1 関連（本改訂で追加）
export const TODOIST_API_BASE_URL = 'https://api.todoist.com/api/v1';
export const TODOIST_API_TOKEN_PROPERTY_KEY = 'TODOIST_API_TOKEN';
export const TODOIST_TASKS_LIST_LIMIT = 200;
```

#### types.ts

```typescript
export type CalendarEvent = GoogleAppsScript.Calendar.Schema.Event;
export type CalendarRole = 'primary' | 'todoist';
export type Direction = 'T→P' | 'P→T' | 'INIT' | 'REPAIR';

export type LinkKind = 'generated' | 'paired';
export type LinkEntry = {
  calendar: CalendarRole;
  iCalUID: string;           // todoist の generated 行（Todoist タスク由来）では空文字を許容する
  srcUid: string;
  kind: LinkKind;
  recordedAt: Date;
  todoistTaskId?: string;    // todoist の generated 行でのみ設定する（本改訂で追加）
};

export type GeneratedEvent = { event: CalendarEvent; srcUid: string };

// Todoist タスクの最小表現（本改訂で追加）
export type TodoistTaskDue = {
  date: string;              // 'YYYY-MM-DD' | 'YYYY-MM-DDTHH:MM:SS' | 'YYYY-MM-DDTHH:MM:SSZ'
  timezone: string | null;
};
export type TodoistTask = { id: string; content: string; due: TodoistTaskDue | null };
export type GeneratedTodoistTask = { task: TodoistTask; srcUid: string };

export type ClassifiedEvents = {
  origins: ReadonlyArray<CalendarEvent>;        // T または N
  generated: ReadonlyArray<GeneratedEvent>;     // M（primary）または、T→P 側の旧 C の残骸（todoist。本改訂後は新規に増えない）
  observedLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;  // 取得範囲内で確認できた生成物・ペア
  repairs: ReadonlyArray<SyncAction>;           // kind: 'repair'
};

// S1〜S3/S3D は primary（calendar イベント）、S4〜S6/S6D は todoist（Todoist タスク）に
// 固定されるため、rule と calendar の対応が 1:1 になるよう union を分けた（本改訂で変更）。
export type SyncAction =
  | { kind: 'create'; rule: 'S1'; direction: Direction; calendar: 'primary'; source: CalendarEvent }
  | { kind: 'create'; rule: 'S4'; direction: Direction; calendar: 'todoist'; source: CalendarEvent }
  | { kind: 'update'; rule: 'S2'; direction: Direction; calendar: 'primary'; source: CalendarEvent; target: CalendarEvent }
  | { kind: 'update'; rule: 'S5'; direction: Direction; calendar: 'todoist'; source: CalendarEvent; todoistTaskId: string }
  | { kind: 'delete'; rule: 'S3' | 'S3D'; direction: Direction; calendar: 'primary'; target: CalendarEvent; srcUid: string }
  | { kind: 'delete'; rule: 'S6' | 'S6D'; direction: Direction; calendar: 'todoist'; todoistTaskId: string; srcUid: string }
  | { kind: 'mark'; rule: 'INIT'; direction: 'INIT'; calendar: CalendarRole; target: CalendarEvent; srcUid: string }
  | { kind: 'repair'; rule: 'REPAIR'; direction: 'REPAIR'; calendar: CalendarRole; target: CalendarEvent; srcUid: string; linkKind: LinkKind };

export type ExecutionResult = {
  createdLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;
  deletedKeys: ReadonlyArray<string>;  // primary/paired 系は `${calendar}:${iCalUID}`、todoist の generated 系は `todoist:${todoistTaskId}`
};

export type Settings = {
  todoistCalendarId: string;
  initialMatchDoneAt: string | null;  // 空欄なら未実施。値の有無で判定するだけで、代わりの値で補うことはしない
};

export type LogLevel = 'INFO' | 'WARN';
```

#### settingsRepository.ts

```typescript
export function readSettings(): Settings;
export function markInitialMatchDone(at: Date): void;
export function ensureSheets(): void;  // setup 用。settings/log/links シートとヘッダ行がなければ作る
```

- `settings` シートは A 列 = key、B 列 = value のキーバリュー形式にする
- `todoistCalendarId` が空欄または見つからないとき、`primary` が指定されているときは `Error` を throw する

#### linksRepository.ts

```typescript
export const LINKS_HEADER: ReadonlyArray<string>;  // ['calendar','iCalUID','srcUid','kind','recordedAt','todoistTaskId']（本改訂で列追加）
export function readLinks(): LinkEntry[];
export function writeLinks(entries: ReadonlyArray<LinkEntry>): void;  // ヘッダ以外を全件書き換える
```

- ヘッダー行を `LINKS_HEADER` と厳密照合する（`validateHeaderOrThrow`）。旧形式（`todoistTaskId` 列が無い 5 列）のシートは、ヘッダー不一致として明確なメッセージで throw する（黙って読み替えない。README に移行手順を記載）
- 行検証: `calendar === 'todoist' && kind === 'generated'` の行は、`iCalUID`（移行前から残る旧経路の C 複製の行。`cleanupLegacyTodoistCopies` が削除する）と `todoistTaskId`（タスク由来の行）のどちらか一方だけを持つことを必須にする。両方空・両方ありは throw する。それ以外は従来どおり `iCalUID` を必須にし、`todoistTaskId` は必須にしない（空でもよい）

#### logger.ts

```typescript
export function createLogger(): {
  info(direction: Direction, uid: string, message: string): void;
  warn(direction: Direction, uid: string, message: string): void;
  flush(): void;  // 溜まった件数が 0 ならシートにアクセスしない
};
```

#### calendarGateway.ts

```typescript
export function listFutureEvents(calendarId: string, now: Date): CalendarEvent[];
export function insertEvent(calendarId: string, resource: CalendarEvent): CalendarEvent;
export function patchEvent(calendarId: string, eventId: string, resource: CalendarEvent): CalendarEvent;
export function removeEvent(calendarId: string, eventId: string): void;
export function hasFutureInstance(calendarId: string, eventId: string, now: Date): boolean;
```

- `listFutureEvents` は `Calendar.Events.list(calendarId, { timeMin: now.toISOString(), singleEvents: false, showDeleted: false, maxResults: LIST_PAGE_SIZE, pageToken })` を `nextPageToken` がなくなるまで繰り返す
- 書き込みにはすべて `{ sendUpdates: SEND_UPDATES }` を付ける。例外は捕捉しない
- `hasFutureInstance`（D8）は `Calendar.Events.instances(calendarId, eventId, { timeMin: now.toISOString(), maxResults: INSTANCE_LOOKUP_MAX_RESULTS, showDeleted: false })` を呼び、`response.items` が 1 件以上あれば `true` を返す
- 本改訂による変更なし（T→P はこれまでどおり Calendar API のみで完結する）

#### todoistGateway.ts（本改訂で新規追加）

```typescript
export type TodoistTaskPayload = { content: string; due_date?: string; due_datetime?: string };

export function listTasks(): TodoistTask[];
export function createTask(payload: TodoistTaskPayload): TodoistTask;
export function updateTask(taskId: string, payload: TodoistTaskPayload): TodoistTask;
export function removeTask(taskId: string): void;
```

- `calendarGateway.ts` と同じパターン（サービス取得関数＋1 関数 1 API 呼び出し＋try/catch なし）を踏襲する
- トークンはスクリプトプロパティ `TODOIST_API_TOKEN_PROPERTY_KEY` から読む。未設定・空文字なら明確に throw する
- 共通ヘルパー（`fetchTodoist`）で `Authorization: Bearer <token>` を付け、`muteHttpExceptions: true` を使う。`getResponseCode()` が 2xx 以外なら本文を含む `Error` を throw する
- `listTasks` は `GET /tasks?limit=200[&cursor=...]` をレスポンスの `next_cursor` が `null` になるまで繰り返す
- タスク完了ではなく削除（`DELETE /tasks/{id}`）を基本とする（S6/S6D）

#### eventClassifier.ts

```typescript
export function getSrcUid(event: CalendarEvent): string | null;
export function isInitialMatched(event: CalendarEvent): boolean;
export function isRecurringException(event: CalendarEvent): boolean;
export function isDeclinedBySelf(event: CalendarEvent): boolean;
export function classify(
  calendar: CalendarRole,
  events: ReadonlyArray<CalendarEvent>,
  links: ReadonlyArray<LinkEntry>,
  hasFutureOccurrence: (event: CalendarEvent) => boolean,  // D8。GAS グローバルを呼ばないための注入
): ClassifiedEvents;
```

分類ルール（上から順に評価し、最初に当てはまったものに決める）:

| # | 条件 | todoist | primary |
|---|---|---|---|
| 1 | `recurringEventId` あり（D2） | 対象外 | 対象外 |
| 2 | `initialMatch` あり（D1） | ペア（対象外。observedLinks に入れる） | 同左 |
| 3 | `links` に `(calendar, iCalUID)` の行があり、`kind = paired`（`initialMatch` だけが失われた状態） | ペアとして扱い、repair を作る | 同左 |
| 4 | `links` に `kind = generated` の行があり、`srcUid` がない（D6） | C として扱い、repair を作る | M として扱い、repair を作る |
| 5 | `srcUid` あり | C | M |
| 6 | `eventType` が `ORIGIN_EVENT_TYPES` にない（D3） | ― | 対象外 |
| 7 | 自分が辞退している | ― | 対象外 |
| 8 | 上記以外 | T | N（ただし `recurrence` があり `hasFutureOccurrence(event)` が偽なら対象外。D8） |

- 3 は、`initialMatch` だけが消えて `srcUid` が残っていた場合に、ペアが M/C と判定されて S3/S6 で削除されるのを防ぐためのルール
- 8 の `hasFutureOccurrence` は、`recurrence` を持つ起点候補だけに適用する（API 呼び出しを最小化する）。生成物（4・5、M/C）には適用しない（D8）

- 起点の中で `iCalUID` が重複していたら `Error` を throw する（D2 の除外をした後に重複が残るのは、異常なデータ）

**本改訂による `classify()` への影響: なし。** `classify('todoist', ...)` の「C（`kind: 'generated'` の todoist イベント）」は、旧経路（本改訂前に作られた「Todoist」カレンダーへの複製）の残骸を指す。本改訂後は新たに作られないため、`main.ts` はこの `generated` バケットを P→T の `planSync` 入力に使わない（`resolveTodoistTaskLinks` が返す Todoist タスクの `generated` を使う）。残骸の掃除は Phase 4 の `cleanupLegacyTodoistCopies`（`main.ts`）を参照。

#### eventContent.ts

```typescript
export type NormalizedContent = {
  summary: string;
  start: string;       // 終日: 'D:2026-09-15' / 時刻あり: 'T:<epoch ms>'（繰り返しなら '@<timeZone>' を付ける）
  end: string;
  recurrence: string;  // recurrence 配列を '\n' で連結。なければ ''
};

export function normalizeContent(event: CalendarEvent): NormalizedContent;
export function isSameContent(a: CalendarEvent, b: CalendarEvent): boolean;
export function contentKeyForInitialMatch(event: CalendarEvent): string;  // start + '|' + summary
export function buildInsertResource(calendar: CalendarRole, source: CalendarEvent): CalendarEvent;
export function buildUpdateResource(calendar: CalendarRole, source: CalendarEvent): CalendarEvent;  // extendedProperties を含めない
export function buildMarkResource(srcUid: string): CalendarEvent;                                  // srcUid + initialMatch
export function buildRepairResource(srcUid: string, linkKind: LinkKind): CalendarEvent;

// 本改訂で追加。P→T（Todoist タスク）用。
export type TodoistTaskPayload = { content: string; due_date?: string; due_datetime?: string };
export function hasNonEmptyRecurrence(event: CalendarEvent): boolean;  // 既存の private 関数を export に変更しただけ
export function buildTodoistTaskPayload(source: CalendarEvent): TodoistTaskPayload;
export function isSameTodoistTaskContent(source: CalendarEvent, task: TodoistTask): boolean;
```

| フィールド | primary に書く（M） | todoist に書く（C。旧経路） |
|---|---|---|
| `summary` / `start` / `end` / `recurrence` | コピー元の値をそのまま使う | コピー元の値をそのまま使う |
| `extendedProperties.private.srcUid` | コピー元の `iCalUID`（insert のときだけ送る） | 同左 |
| `visibility` | `'private'` | 設定しない |
| `reminders` | `{ useDefault: false, overrides: [] }` | 設定しない |

- コピー元に `recurrence` がないときは `recurrence: []` を明示する
- `summary` がない場合に `''` とするのは、比較のための正規化だけ。書き込む値を補うものではない

**`buildTodoistTaskPayload`（本改訂で追加）**: N の `summary → content`、`start`（終日）→ `due_date`（そのまま）、`start`（時刻あり）→ `due_datetime`（UTC・秒精度・`Z` 付きに変換）。`content` が空になる場合（`summary` が無い）は Todoist API が拒否するため、この関数が明確に throw する（フォールバックしない）。`end` は使わない（Todoist にその概念が無い）。

**`isSameTodoistTaskContent`（本改訂で追加）**: `buildTodoistTaskPayload(source)` で期待値を作り、`task.content` と `task.due.date` を文字列比較する。`task.due` が `null`、または期待した形式（`due_date`/`due_datetime` のどちらを送ったか）と一致しなければ「異なる」とみなし S5 update を出す（不確実な場合は更新側に倒す。V6 で本番動作を確認すること）。

#### initialMatcher.ts

```typescript
export function planInitialMatch(
  t: ReadonlyArray<CalendarEvent>,
  n: ReadonlyArray<CalendarEvent>,
): SyncAction[];  // kind: 'mark'。ペア 1 組につき 2 件
```

1. T と N をそれぞれ `contentKeyForInitialMatch` でグループ化する
2. 同じキーが **T 側 1 件・N 側 1 件**のときだけペアにする。片側に 2 件以上ある場合はペアにせず、WARN ログを出す
3. ペアごとに mark を 2 件作る
   - A（todoist）には `srcUid = uid(B)` と `initialMatch`
   - B（primary）には `srcUid = uid(A)` と `initialMatch`

**本改訂による変更: なし。** T↔N のペアリングは calendar イベントだけで完結し、Todoist タスク API とは無関係のため、意味・実装ともに変更していない。

#### syncPlanner.ts

```typescript
export function planSync(input: {
  t: ReadonlyArray<CalendarEvent>;
  n: ReadonlyArray<CalendarEvent>;
  m: ReadonlyArray<GeneratedEvent>;
  c: ReadonlyArray<GeneratedTodoistTask>;  // 本改訂で変更: 旧「Todoist」カレンダーの C ではなく Todoist タスク
}): SyncAction[];

// 本改訂で追加
export function resolveTodoistTaskLinks(input: {
  links: ReadonlyArray<LinkEntry>;
  activeTasks: ReadonlyArray<TodoistTask>;
}): {
  generated: GeneratedTodoistTask[];
  observed: Array<Omit<LinkEntry, 'recordedAt'>>;
  inactiveLinks: Array<{ srcUid: string; observedRow: Omit<LinkEntry, 'recordedAt'> }>;
};

export function excludeOwnTaskMirrors(
  todoistOrigins: ReadonlyArray<CalendarEvent>,
  nEventsWithGeneratedTask: ReadonlyArray<CalendarEvent>,
): { origins: CalendarEvent[]; ambiguousKeys: string[] };
```

```
reconcile(origins, generated):                    # T→P（primary 固定。旧: targetCalendar/rules 引数を撤去）
  originByUid    = Map(iCalUID → origin)
  generatedByUid = srcUid ごとにグループ化
  for origin in origins:
    group = generatedByUid[origin.iCalUID]
    if group なし                    → create（S1）
    else:
      keep = group[0]（id の昇順で先頭）
      if !isSameContent(origin, keep) → update（S2）
      group[1..]                     → delete（S3D: 重複した生成物）
  for (srcUid, group) in generatedByUid:
    if !originByUid.has(srcUid)      → group をすべて delete（S3）

reconcileTodoistTasks(n, generated):               # P→T（todoist 固定。本改訂で新規追加）
  n から recurrence を持つものを除外する（要件の制約）
  以降は reconcile と同じロジック（create=S4, update=S5, delete=S6, duplicateDelete=S6D）
  ただし generated は GeneratedTodoistTask（task.id で識別）、
  update/delete アクションは target ではなく todoistTaskId を持つ
```

- T→P: `reconcile(t, m)`
- P→T: `reconcileTodoistTasks(n, c)`（`planSync` 内部で呼ぶ。公開 API ではない）
- ペアは T/N/M のどれにも入らないので、ここで削除されることはない（D1）

**`resolveTodoistTaskLinks`（D11）**: `links` の `todoist`/`generated` 行を `activeTasks`（`GET /tasks` の結果）と突き合わせる。アクティブなタスクは `generated`/`observed` に入れる（N の有無に関わらず。N が無ければ `reconcileTodoistTasks` の孤児削除が S6 を出す）。非アクティブ（ユーザーが完了・削除した）なら `inactiveLinks` として返すだけにとどめる。実際に links 行を残すか消すかは、対応する N がまだ `primary.origins` にあるかどうかで `main.ts` が決める（この関数自体は N の集合を知らない）。

**`excludeOwnTaskMirrors`（D10）**: 有効な生成タスクを持つ N と同じコンテンツキー（`contentKeyForInitialMatch` を再利用）を持つ T 候補を、自作タスクの echo とみなして除外する。曖昧一致は安全側（除外しない）にし、`ambiguousKeys` で呼び出し元に知らせる。

#### linksPlanner.ts

```typescript
export function linkKey(entry: { calendar: CalendarRole; iCalUID: string; todoistTaskId?: string }): string;
// todoist の generated 行（todoistTaskId を持つ）は `todoist:${todoistTaskId}`、
// それ以外は従来どおり `${calendar}:${iCalUID}`（本改訂で変更）

export function planLinks(input: {
  current: ReadonlyArray<LinkEntry>;
  observed: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;  // 両カレンダーの observedLinks + resolveTodoistTaskLinks の結果
  result: ExecutionResult;
  now: Date;
}): { entries: LinkEntry[]; changed: boolean };
```

1. `observed ∪ result.createdLinks` から `result.deletedKeys` を除く
2. 同じキーの行が `current` にあれば、その `recordedAt` を引き継ぐ。なければ `now` を入れる
3. `current` にあって上の結果にないキー（過去になった予定、手動で削除された予定、掃除された旧タスクの links 行）は除く
4. 並び順をキー順に揃え、`current` と比べて `changed` を決める

#### actionExecutor.ts

```typescript
export function executeActions(
  actions: ReadonlyArray<SyncAction>,
  calendarIds: Record<CalendarRole, string>,
  logger: Logger,
): ExecutionResult;
```

| kind | calendar | API | ログ |
|---|---|---|---|
| create | primary（S1） | `insertEvent`。レスポンスの `iCalUID` を createdLinks に入れる | INFO |
| create | todoist（S4） | `todoistGateway.createTask(buildTodoistTaskPayload)`。レスポンスの `id` を `todoistTaskId` として createdLinks に入れる（`iCalUID: ''`） | INFO |
| update | primary（S2） | `patchEvent(buildUpdateResource)` | INFO |
| update | todoist（S5） | `todoistGateway.updateTask(action.todoistTaskId, buildTodoistTaskPayload)` | INFO |
| delete | primary（S3/S3D） | `removeEvent`。キー `${calendar}:${iCalUID}` を deletedKeys に入れる | INFO |
| delete | todoist（S6/S6D） | `todoistGateway.removeTask(action.todoistTaskId)`。キー `todoist:${todoistTaskId}` を deletedKeys に入れる | INFO |
| mark | primary/todoist | `patchEvent(buildMarkResource)` | INFO / INIT |
| repair | primary/todoist | `patchEvent(buildRepairResource)` | **WARN** / REPAIR |

`action.kind` と `action.calendar` の分岐で `todoistGateway` へ振り分ける（本改訂で追加）。`primary` の場合は従来どおり `calendarGateway` を呼ぶ。Calendar 前提の `requireId`/`requireICalUID` は `todoist` の update/delete には適用しない（`CalendarEvent` を持たないため）。

#### main.ts（公開関数）

```typescript
function sync(): void;                        // 時間トリガーから呼ばれる
function setup(): void;                       // 手動で 1 回実行。シートの作成と、トリガーの重複しない登録
function cleanupLegacyTodoistCopies(): void;  // 手動で 1 回実行。旧経路の C の残骸を削除する（本改訂で追加）
```

```
lock = LockService.getScriptLock()
if !lock.tryLock(LOCK_WAIT_MS): console.log('skip: lock busy'); return
logger = createLogger()
try:
  settings = readSettings()
  links = readLinks()
  now = new Date()
  todoist = classify('todoist', listFutureEvents(settings.todoistCalendarId, now), links,
                      (event) => hasFutureInstance(settings.todoistCalendarId, requireEventId(event), now))
  primary = classify('primary', listFutureEvents(PRIMARY_CALENDAR_ID, now), links,
                      (event) => hasFutureInstance(PRIMARY_CALENDAR_ID, requireEventId(event), now))
  repairs = [...todoist.repairs, ...primary.repairs]

  # ここから P→T 用の準備（本改訂で追加）
  activeTasks = listTasks()
  resolved = resolveTodoistTaskLinks({ links, activeTasks })

  nOriginICalUIDs = primary.origins の iCalUID 集合
  completedTaskSrcUidsWithExistingN = {}
  keptInactiveObserved = []
  for inactive in resolved.inactiveLinks:
    if nOriginICalUIDs.has(inactive.srcUid):
      completedTaskSrcUidsWithExistingN.add(inactive.srcUid)   # N はまだある → S4 を再発生させない
      keptInactiveObserved.push(inactive.observedRow)          # links 行を残す
    # else: N も無い → 何もしない（links 行を捨てる。掃除）

  todoistTaskOrigins = primary.origins.filter(e => !completedTaskSrcUidsWithExistingN.has(e.iCalUID))

  activeGeneratedSrcUids = Set(resolved.generated.map(g => g.srcUid))
  nEventsWithGeneratedTask = todoistTaskOrigins.filter(e => activeGeneratedSrcUids.has(e.iCalUID))
  mirrorExclusion = excludeOwnTaskMirrors(todoist.origins, nEventsWithGeneratedTask)
  for key in mirrorExclusion.ambiguousKeys: logger.warn('P→T', key, '...')
  # ここまで P→T 用の準備

  if settings.initialMatchDoneAt が空:
    actions = [...repairs, ...planInitialMatch(todoist.origins, primary.origins)]
  else:
    actions = [...repairs, ...planSync({
      t: mirrorExclusion.origins, n: todoistTaskOrigins, m: primary.generated, c: resolved.generated,
    })]

  result = executeActions(actions, ids, logger)
  observed = [...todoist.observedLinks, ...primary.observedLinks, ...resolved.observed,
              ...keptInactiveObserved, ...markedLinksFromActions(actions)]
  {entries, changed} = planLinks({current: links, observed, result, now})
  if changed: writeLinks(entries)
  if 初回: markInitialMatchDone(now)   // 通常同期は次回から行う
finally:
  logger.flush()
  lock.releaseLock()
```

- `catch` は書かない。例外は `finally` を通ってそのまま外に出る
- 差分がなければ actions が空、links も変わらず、ログも 0 件になり、書き込みは発生しない
- 途中で throw されたり時間切れになったりして `links` の更新が漏れても、次回の実行で `srcUid` を持つイベントから復元される（`observedLinks`）。P→T 側の対応は `links` の `todoistTaskId` 行が唯一の記録であるため、この行が失われると復元できない（R9。calendar イベントの `extendedProperties` のような自己修復手段が無い）

**`cleanupLegacyTodoistCopies`（本改訂で追加。手動実行専用）**: `listFutureEvents(todoistCalendarId, now)` の中から、`getSrcUid(event) !== null && !isInitialMatched(event)` かつ `links` に `(calendar: 'todoist', iCalUID, kind: 'generated')` の対応行があるイベントだけを `removeEvent` で削除し、対応する links 行を取り除く。`srcUid` を持たない（本物の Todoist タスクのイベント）、または `initialMatch` を持つ（ペア）イベントは、条件に合致しても絶対に削除しない。通常の `sync` からは呼ばれない。

---

## 3. データフロー

```
settings / links シート
        │
Calendar.Events.list ×2（全ページ）/ Todoist API GET /tasks
        ▼
eventClassifier（calendar イベントのみ） ──► T / N,M / ペア・対象外 / repair
        │                    resolveTodoistTaskLinks（Todoist タスク）──► P→T の generated
        ├─ 初回 ──► initialMatcher ──► mark[]
        └─ 通常 ──► excludeOwnTaskMirrors（T の二重ミラー除外）
                     └─► syncPlanner ──► create/update/delete[]
                                       ▼
                               actionExecutor ──► Calendar API（primary）/ Todoist API（todoist）
                                  │        │
                                  ▼        ▼
                           log シート   linksPlanner ──► links シート（変わったときだけ）
```

---

## 4. API インターフェース

### 4.1 内部 API

§2.2 のとおりです。純粋関数のモジュール（classifier/content/matcher/syncPlanner/linksPlanner）は GAS のグローバルを参照しません。

### 4.2 外部 API

| API | 用途 | 主なパラメータ |
|---|---|---|
| `Calendar.Events.list` | 全件取得（T→P） | `timeMin`, `singleEvents:false`, `showDeleted:false`, `maxResults`, `pageToken` |
| `Calendar.Events.insert` | S1 | `sendUpdates:'none'` |
| `Calendar.Events.patch` | S2/INIT/REPAIR | `sendUpdates:'none'` |
| `Calendar.Events.remove` | S3/S3D、`cleanupLegacyTodoistCopies` | `sendUpdates:'none'` |
| `GET /tasks`（Todoist API v1） | アクティブなタスク一覧取得（P→T） | `limit=200`, `cursor` |
| `POST /tasks`（Todoist API v1） | S4 | `content`, `due_date` または `due_datetime` |
| `POST /tasks/{id}`（Todoist API v1） | S5 | 同上 |
| `DELETE /tasks/{id}`（Todoist API v1） | S6/S6D | なし |
| `SpreadsheetApp.getActive()` | settings/log/links | コンテナバインド |
| `LockService.getScriptLock` | 直列化 | `tryLock` |
| `ScriptApp.newTrigger` | setup | `everyMinutes(5)` |

`appsscript.json`:

```json
{
  "timeZone": "Asia/Tokyo",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Calendar", "serviceId": "calendar", "version": "v3" }
    ]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/spreadsheets.currentonly",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

`script.external_request` は Todoist API を `UrlFetchApp` で呼ぶために本改訂で追加した（Advanced Service の追加は不要。素の REST API のため）。

---

## 5. エラーハンドリング

### 5.1 エラー分類

| 事象 | 対処 |
|---|---|
| `settings` が未設定、または `primary` が指定されている | `Error` を throw する |
| カレンダーが存在しない、または権限がない | そのまま throw する |
| 起点の iCalUID が重複している | `Error` を throw する |
| Todoist API トークン（スクリプトプロパティ）が未設定・空文字 | `Error` を throw する（本改訂で追加） |
| Todoist API が 2xx 以外を返す | 本文を含む `Error` を throw する（本改訂で追加） |
| `links` シートが旧形式（`todoistTaskId` 列が無い） | ヘッダー不一致を検出し、移行手順を示す `Error` を throw する（本改訂で追加） |
| API のレート制限や一時エラー | そのまま throw する。次の実行で状態を見直し、回復する |
| 削除しようとしたイベントが既に消えている（404/410） | そのまま throw する。次の実行では対象から外れているので回復する |
| ロックを取得できない | 何もせずに return する |
| 実行時間の上限（6 分）を超える | 強制終了する。途中まで反映した結果は、次回に引き継がれる |
| srcUid が失われている（D6。T→P のみ） | 書き戻して WARN を記録する（例外ではない） |

### 5.2 エラー通知

- GAS のトリガーが失敗すると届く通知メールで検知する（通知設定は「即時」にする）
- `exceptionLogging: STACKDRIVER` によって、スタックトレースを残す
- throw された場合も、`finally` でそれまでの操作をログに書き込む

### 5.3 安全性に関する不変条件

- 起点（T・N）の予定は、変更も削除もしない。例外は初回照合の mark と、D6 の repair（srcUid などの書き戻しだけ）
- ペア（`initialMatch`）は、どの処理でも削除・更新しない
- 削除は、両カレンダー・Todoist タスク一覧の取得がすべて成功した後にしか行わない
- ユーザーが Todoist 側で完了・削除したタスクは、S4 で作り直さない（D11）
- `cleanupLegacyTodoistCopies` は、`srcUid` を持たない（本物のタスクの）イベントと、`initialMatch` を持つ（ペアの）イベントを絶対に削除しない

---

## 6. セキュリティ設計

- スクリプトの所有者の OAuth で実行する。スコープは §4.2 の最小限にとどめる
- スプレッドシートは共有しない（編集者がスクリプトを編集できてしまうため）
- ミラーは `visibility: 'private'`。`attendees` はコピーせず、`sendUpdates: 'none'` を付ける
- `log` シートには予定のタイトルが残る
- Todoist API トークンはスクリプトプロパティに保存し、コード・スプレッドシートには書かない（本改訂で追加）

---

## 7. テスト戦略

### 7.1 単体テスト（Vitest）

- 対象: `eventClassifier`, `eventContent`, `initialMatcher`, `syncPlanner`, `linksPlanner`, `todoistGateway`（本改訂で追加）
- カバレッジ目標: 分岐網羅 90% 以上
- 主なケース:
  - 分類: 分類ルール表の 1〜8 の各条件、優先順位、iCalUID の重複で throw、links から復元して repair を作る（T→P。本改訂による変更なし）
  - 正規化: `+09:00` と `Z` を同一とみなす、終日と時刻ありを区別する、繰り返しでの timeZone の差
  - 計画（T→P）: S1〜S3/S3D、差分なしで `[]`、生成物の重複削除、エコーが起きないこと
  - 計画（P→T。本改訂で追加）: S4〜S6/S6D、Todoist タスクの `due` との差分判定、繰り返し N の対象外化、`resolveTodoistTaskLinks` の 4 状態（アクティブ×N有無、非アクティブ×N有無）、`excludeOwnTaskMirrors` の除外・非除外・曖昧一致
  - 初回照合（D1 の回帰テスト）: mark を適用した状態に `planSync` をかけても何も出ないこと。**ペアの片方を消した状態でも delete が出ないこと**
  - links: 追加、削除、範囲外になった行の除去、`recordedAt` の引き継ぎ、変更がなければ `changed=false`、`todoistTaskId` 列の読み書き、旧形式ヘッダーの検出（本改訂で追加）
  - `todoistGateway`（本改訂で追加）: トークン未設定・空文字での throw、非 2xx での throw、`listTasks` のカーソルページング、各エンドポイントの引数

### 7.2 統合テスト（手動）

- テスト用の Google アカウントと Todoist で行う。シナリオは tasks.md の Phase 3 を参照
- 本改訂で追加: V6（`due_datetime` の往復確認）、S4〜S6 が実際に Todoist にタスクを作成・更新・削除すること、完了済みタスクが再作成されないこと、二重ミラーが起きないこと

---

## 8. パフォーマンス

- 1 回の実行: Calendar の list が 2 系統、Todoist の `GET /tasks` が 1〜数ページ、シートの読み込み。差分がなければ書き込みは 0
- ログはまとめて 1 回で追記し、`links` は変わったときだけ全件を書き換える
- `links` の行数は、未来の生成物とペアの数と同じ程度にとどまる（範囲外になった行は除かれる）。ただし、ユーザーが完了・削除した P→T のタスクの links 行は、対応する N が存在する限り残り続ける（D11）

---

## 9. デプロイメント

```
repo/
├ src/*.ts
├ test/*.test.ts
├ appsscript.json
├ esbuild.config.mjs     # dist/Code.js を出力し、footer で sync/setup/cleanupLegacyTodoistCopies を公開
├ .clasp.json            # rootDir: dist
└ package.json           # build / test / lint / typecheck / push
```

手順: `npm run build` → `clasp push` → `setup` を手動実行 → `settings` に ID を入力 → スクリプトプロパティに `TODOIST_API_TOKEN` を設定

| 場所 | 項目 |
|---|---|
| `settings` シート | `todoistCalendarId`、`initialMatchDoneAt`（空欄にすると初回照合をやり直す） |
| スクリプトプロパティ | `TODOIST_API_TOKEN`（本改訂で追加。Todoist の設定画面から取得する個人トークン） |
| `links` シート | 自動で管理する（手で編集しない）。本改訂で `todoistTaskId` 列（F 列）を追加。旧形式のシートは移行が必要（README 参照） |
| `config.ts` | コードの定数 |

---

## 10. 実装上の注意事項と既知の制約

- `Calendar.Events.delete` ではなく **`Calendar.Events.remove`** を使う
- 更新（S2）では `extendedProperties` を送らない
- トリガーは `setup` で既存のトリガーを確認してから作り、重複させない
- P→T（S4/S5/S6/S6D）は Todoist API を直接呼び出す。「Todoist」カレンダーへの複製（C）はもう作らない（本改訂）

| # | 内容 |
|---|---|
| R1 | T→P は公式連携が critical path に入る（要件どおり）。P→T は Todoist API 直接呼び出しのため、この制約を受けない |
| R2 | 繰り返し予定の個別回の変更・削除は同期しない（D2） |
| R3 | P→T のタスクは N を正とし、Todoist 側での変更は S5 により元に戻される |
| R4 | 初回照合でペアになった予定は、その後も同期しない（D1） |
| R5 | 公式連携がイベントを作り直して `iCalUID` が変わった場合は、T→P の生成物だと判別できない（D6） |
| R7 | `Calendar.Events.list` の `timeMin` は繰り返し系列（`singleEvents: false`）には効かない。全回終了済みの系列も返ってくるため、`hasFutureInstance` による追加判定（D8）で起点分類から除外する。`requirements.md`「同期範囲」（過去は対象外）を守るための補完措置 |
| R9 | 繰り返し（`recurrence` を持つ）N は、P→T のタスク化の対象外（D9）。ユーザーが Todoist 側でタスクを完了・削除すると、その N への自動タスク化はその後行われなくなる（`links` の行が残り続けるため。D11）。`links` の `todoistTaskId` 行が失われると、対応するタスクの存在を知る手段が無く、二重作成や孤児化が起こりうる（calendar イベントの `extendedProperties` のような自己修復手段が無いため。D6 相当の仕組みは P→T には無い） |
