# 詳細設計書 - Todoist ⇄ Google カレンダー 同期（GAS）

対象要件: `requirements.md`（2026-09-15）
作成日: 2026-09-15

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

**V3 の補足**: 同期範囲は「現在時刻以降」（`timeMin` は予定の**終了時刻**で判定される）です。終わった会議のタスクを完了しても、C は既に範囲の外なので S4 は動きません。影響が残るのは、次の 2 つだけです。

- 会議が終わる前にタスクを完了した場合（その会議の C は作り直される）
- 繰り返し系列。系列の最後の回が未来にある限り、系列全体が範囲内に残る

---

## 1. アーキテクチャ概要

### 1.1 システム構成図

```
┌──────────┐  公式連携  ┌──────────────────────┐
│ Todoist  │ ⇄───────⇄ │ 「Todoist」カレンダー │
└──────────┘            │   T（起点）/ C（複製）│
                        └──────────┬───────────┘
                                   │ Calendar API v3（Advanced Service）
                    ┌──────────────┴──────────────┐
                    │ GAS（時間トリガー 5 分）     │
                    │  sync()                     │
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
| `src/main.ts` | 公開関数（`sync` / `setup`）。ロック取得と全体の流れ | 全モジュール | あり |
| `src/config.ts` | 定数 | なし | なし |
| `src/types.ts` | 型定義 | なし | なし |
| `src/settingsRepository.ts` | `settings` シートの読み書き、シートの初期化 | config | あり |
| `src/linksRepository.ts` | `links` シートの読み込みと全件の書き換え | config, types | あり |
| `src/logger.ts` | ログをメモリに溜め、`log` シートへ一括で追記 | config | あり |
| `src/calendarGateway.ts` | Calendar API の呼び出し（list/insert/patch/remove） | config | あり |
| `src/eventClassifier.ts` | T/N/M/C/ペア/対象外への分類と、srcUid を失った予定の検出 | config, types | なし |
| `src/eventContent.ts` | 内容の正規化・比較、書き込み用リソースの生成 | config, types | なし |
| `src/initialMatcher.ts` | 初回照合の計画 | eventContent, types | なし |
| `src/syncPlanner.ts` | S1〜S6 の計画 | eventContent, types | なし |
| `src/linksPlanner.ts` | 実行結果から、新しい `links` を組み立てる | types | なし |
| `src/actionExecutor.ts` | 計画した処理を API で実行し、ログに記録して結果を返す | calendarGateway, eventContent, logger | あり |

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
```

#### types.ts

```typescript
export type CalendarEvent = GoogleAppsScript.Calendar.Schema.Event;
export type CalendarRole = 'primary' | 'todoist';
export type Direction = 'T→P' | 'P→T' | 'INIT' | 'REPAIR';

export type LinkKind = 'generated' | 'paired';
export type LinkEntry = {
  calendar: CalendarRole;
  iCalUID: string;
  srcUid: string;
  kind: LinkKind;
  recordedAt: Date;
};

export type GeneratedEvent = { event: CalendarEvent; srcUid: string };

export type ClassifiedEvents = {
  origins: ReadonlyArray<CalendarEvent>;        // T または N
  generated: ReadonlyArray<GeneratedEvent>;     // M または C（srcUid を失い、links から復元したものも含む）
  observedLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;  // 取得範囲内で確認できた生成物・ペア
  repairs: ReadonlyArray<SyncAction>;           // kind: 'repair'
};

export type SyncAction =
  | { kind: 'create'; rule: 'S1' | 'S4'; direction: Direction; calendar: CalendarRole; source: CalendarEvent }
  | { kind: 'update'; rule: 'S2' | 'S5'; direction: Direction; calendar: CalendarRole; source: CalendarEvent; target: CalendarEvent }
  | { kind: 'delete'; rule: 'S3' | 'S6' | 'S3D' | 'S6D'; direction: Direction; calendar: CalendarRole; target: CalendarEvent; srcUid: string }
  | { kind: 'mark'; rule: 'INIT'; direction: 'INIT'; calendar: CalendarRole; target: CalendarEvent; srcUid: string }
  | { kind: 'repair'; rule: 'REPAIR'; direction: 'REPAIR'; calendar: CalendarRole; target: CalendarEvent; srcUid: string; linkKind: LinkKind };

export type ExecutionResult = {
  createdLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;
  deletedKeys: ReadonlyArray<string>;  // `${calendar}:${iCalUID}`
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
export function readLinks(): LinkEntry[];
export function writeLinks(entries: ReadonlyArray<LinkEntry>): void;  // ヘッダ以外を全件書き換える
```

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
```

- `listFutureEvents` は `Calendar.Events.list(calendarId, { timeMin: now.toISOString(), singleEvents: false, showDeleted: false, maxResults: LIST_PAGE_SIZE, pageToken })` を `nextPageToken` がなくなるまで繰り返す
- 書き込みにはすべて `{ sendUpdates: SEND_UPDATES }` を付ける。例外は捕捉しない

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
| 8 | 上記以外 | T | N |

- 3 は、`initialMatch` だけが消えて `srcUid` が残っていた場合に、ペアが M/C と判定されて S3/S6 で削除されるのを防ぐためのルール

- 起点の中で `iCalUID` が重複していたら `Error` を throw する（D2 の除外をした後に重複が残るのは、異常なデータ）

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
```

| フィールド | primary に書く（M） | todoist に書く（C） |
|---|---|---|
| `summary` / `start` / `end` / `recurrence` | コピー元の値をそのまま使う | コピー元の値をそのまま使う |
| `extendedProperties.private.srcUid` | コピー元の `iCalUID`（insert のときだけ送る） | 同左 |
| `visibility` | `'private'` | 設定しない |
| `reminders` | `{ useDefault: false, overrides: [] }` | 設定しない |

- コピー元に `recurrence` がないときは `recurrence: []` を明示する（V4 の結果によって見直す）
- `summary` がない場合に `''` とするのは、比較のための正規化だけ。書き込む値を補うものではない

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

#### syncPlanner.ts

```typescript
export function planSync(input: {
  t: ReadonlyArray<CalendarEvent>;
  n: ReadonlyArray<CalendarEvent>;
  m: ReadonlyArray<GeneratedEvent>;
  c: ReadonlyArray<GeneratedEvent>;
}): SyncAction[];
```

```
reconcile(origins, generated, targetCalendar, rules):
  originByUid    = Map(iCalUID → origin)
  generatedByUid = srcUid ごとにグループ化
  for origin in origins:
    group = generatedByUid[origin.iCalUID]
    if group なし                    → create
    else:
      keep = group[0]（id の昇順で先頭）
      if !isSameContent(origin, keep) → update
      group[1..]                     → delete（S3D/S6D: 重複した生成物）
  for (srcUid, group) in generatedByUid:
    if !originByUid.has(srcUid)      → group をすべて delete
```

- T→P: `reconcile(t, m, 'primary', S1/S2/S3)`
- P→T: `reconcile(n, c, 'todoist', S4/S5/S6)`
- ペアは T/N/M/C のどれにも入らないので、ここで削除されることはない（D1）

#### linksPlanner.ts

```typescript
export function planLinks(input: {
  current: ReadonlyArray<LinkEntry>;
  observed: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;  // 両カレンダーの observedLinks
  result: ExecutionResult;
  now: Date;
}): { entries: LinkEntry[]; changed: boolean };
```

1. `observed ∪ result.createdLinks` から `result.deletedKeys` を除く
2. 同じキーの行が `current` にあれば、その `recordedAt` を引き継ぐ。なければ `now` を入れる
3. `current` にあって上の結果にないキー（過去になった予定、手動で削除された予定）は除く
4. 並び順をキー順に揃え、`current` と比べて `changed` を決める

#### actionExecutor.ts

```typescript
export function executeActions(
  actions: ReadonlyArray<SyncAction>,
  calendarIds: Record<CalendarRole, string>,
  logger: Logger,
): ExecutionResult;
```

| kind | API | ログ |
|---|---|---|
| create | `insertEvent`。レスポンスの `iCalUID` を createdLinks に入れる | INFO |
| update | `patchEvent(buildUpdateResource)` | INFO |
| delete | `removeEvent`。キーを deletedKeys に入れる | INFO |
| mark | `patchEvent(buildMarkResource)` | INFO / INIT |
| repair | `patchEvent(buildRepairResource)` | **WARN** / REPAIR |

#### main.ts（公開関数）

```typescript
function sync(): void;   // 時間トリガーから呼ばれる
function setup(): void;  // 手動で 1 回実行。シートの作成と、トリガーの重複しない登録
```

```
lock = LockService.getScriptLock()
if !lock.tryLock(LOCK_WAIT_MS): console.log('skip: lock busy'); return
logger = createLogger()
try:
  settings = readSettings()
  links = readLinks()
  now = new Date()
  todoist = classify('todoist', listFutureEvents(settings.todoistCalendarId, now), links)
  primary = classify('primary', listFutureEvents(PRIMARY_CALENDAR_ID, now), links)
  repairs = [...todoist.repairs, ...primary.repairs]

  if settings.initialMatchDoneAt が空:
    actions = [...repairs, ...planInitialMatch(todoist.origins, primary.origins)]
  else:
    actions = [...repairs, ...planSync({t: todoist.origins, n: primary.origins, m: primary.generated, c: todoist.generated})]

  result = executeActions(actions, ids, logger)
  // mark したペアは observed に含まれていないので、actions から paired の行を足してから planLinks に渡す
  {entries, changed} = planLinks({current: links, observed, result, now})
  if changed: writeLinks(entries)
  if 初回: markInitialMatchDone(now)   // 通常同期は次回から行う
finally:
  logger.flush()
  lock.releaseLock()
```

- `catch` は書かない。例外は `finally` を通ってそのまま外に出る
- 差分がなければ actions が空、links も変わらず、ログも 0 件になり、書き込みは発生しない
- 途中で throw されたり時間切れになったりして `links` の更新が漏れても、次回の実行で `srcUid` を持つイベントから復元される（`observedLinks`）

---

## 3. データフロー

```
settings / links シート
        │
Calendar.Events.list ×2（全ページ）
        ▼
eventClassifier ──► T,C / N,M / ペア・対象外 / repair
        │
        ├─ 初回 ──► initialMatcher ──► mark[]
        └─ 通常 ──► syncPlanner   ──► create/update/delete[]
                                       ▼
                               actionExecutor ──► Calendar API
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
| `Calendar.Events.list` | 全件取得 | `timeMin`, `singleEvents:false`, `showDeleted:false`, `maxResults`, `pageToken` |
| `Calendar.Events.insert` | S1/S4 | `sendUpdates:'none'` |
| `Calendar.Events.patch` | S2/S5/INIT/REPAIR | `sendUpdates:'none'` |
| `Calendar.Events.remove` | S3/S6/S3D/S6D | `sendUpdates:'none'` |
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
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

---

## 5. エラーハンドリング

### 5.1 エラー分類

| 事象 | 対処 |
|---|---|
| `settings` が未設定、または `primary` が指定されている | `Error` を throw する |
| カレンダーが存在しない、または権限がない | そのまま throw する |
| 起点の iCalUID が重複している | `Error` を throw する |
| API のレート制限や一時エラー | そのまま throw する。次の実行で状態を見直し、回復する |
| 削除しようとしたイベントが既に消えている（404/410） | そのまま throw する。次の実行では対象から外れているので回復する |
| ロックを取得できない | 何もせずに return する |
| 実行時間の上限（6 分）を超える | 強制終了する。途中まで反映した結果は、次回に引き継がれる |
| srcUid が失われている（D6） | 書き戻して WARN を記録する（例外ではない） |

### 5.2 エラー通知

- GAS のトリガーが失敗すると届く通知メールで検知する（通知設定は「即時」にする）
- `exceptionLogging: STACKDRIVER` によって、スタックトレースを残す
- throw された場合も、`finally` でそれまでの操作をログに書き込む

### 5.3 安全性に関する不変条件

- 起点（T・N）の予定は、変更も削除もしない。例外は初回照合の mark と、D6 の repair（srcUid などの書き戻しだけ）
- ペア（`initialMatch`）は、どの処理でも削除・更新しない
- 削除は、両カレンダーの取得がすべて成功した後にしか行わない

---

## 6. セキュリティ設計

- スクリプトの所有者の OAuth で実行する。スコープは §4.2 の最小限にとどめる
- スプレッドシートは共有しない（編集者がスクリプトを編集できてしまうため）
- ミラーは `visibility: 'private'`。`attendees` はコピーせず、`sendUpdates: 'none'` を付ける
- `log` シートには予定のタイトルが残る

---

## 7. テスト戦略

### 7.1 単体テスト（Vitest）

- 対象: `eventClassifier`, `eventContent`, `initialMatcher`, `syncPlanner`, `linksPlanner`
- カバレッジ目標: 分岐網羅 90% 以上
- 主なケース:
  - 分類: 分類ルール表の 1〜8 の各条件、優先順位、iCalUID の重複で throw、links から復元して repair を作る
  - 正規化: `+09:00` と `Z` を同一とみなす、終日と時刻ありを区別する、繰り返しでの timeZone の差
  - 計画: S1〜S6、差分なしで `[]`、生成物の重複削除、エコーが起きないこと
  - 初回照合（D1 の回帰テスト）: mark を適用した状態に `planSync` をかけても何も出ないこと。**ペアの片方を消した状態でも delete が出ないこと**
  - links: 追加、削除、範囲外になった行の除去、`recordedAt` の引き継ぎ、変更がなければ `changed=false`

### 7.2 統合テスト（手動）

- テスト用の Google アカウントと Todoist で行う。シナリオは tasks.md の Phase 3 を参照

---

## 8. パフォーマンス

- 1 回の実行: list が 2 系統とシートの読み込み。差分がなければ書き込みは 0
- ログはまとめて 1 回で追記し、`links` は変わったときだけ全件を書き換える
- `links` の行数は、未来の生成物とペアの数と同じ程度にとどまる（範囲外になった行は除かれる）

---

## 9. デプロイメント

```
repo/
├ src/*.ts
├ test/*.test.ts
├ appsscript.json
├ esbuild.config.mjs     # dist/Code.js を出力し、footer で sync/setup を公開
├ .clasp.json            # rootDir: dist
└ package.json           # build / test / lint / typecheck / push
```

手順: `npm run build` → `clasp push` → `setup` を手動実行 → `settings` に ID を入力

| 場所 | 項目 |
|---|---|
| `settings` シート | `todoistCalendarId`、`initialMatchDoneAt`（空欄にすると初回照合をやり直す） |
| `links` シート | 自動で管理する（手で編集しない） |
| `config.ts` | コードの定数 |

---

## 10. 実装上の注意事項と既知の制約

- `Calendar.Events.delete` ではなく **`Calendar.Events.remove`** を使う
- 更新（S2/S5）では `extendedProperties` を送らない
- トリガーは `setup` で既存のトリガーを確認してから作り、重複させない

| # | 内容 |
|---|---|
| R1 | 公式連携が同期の critical path に入る（要件どおり） |
| R2 | 繰り返し予定の個別回の変更・削除は同期しない（D2） |
| R3 | C は N を正とし、Todoist 側での変更は元に戻される（D5） |
| R4 | 初回照合でペアになった予定は、その後も同期しない（D1） |
| R5 | 公式連携がイベントを作り直して `iCalUID` が変わった場合は、生成物だと判別できない（D6） |
| R6 | 会議が終わる前に、その会議から作ったタスクを完了すると、C が作り直される可能性がある（V3） |
