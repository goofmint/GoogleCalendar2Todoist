# GoogleCalendar2Todoist

## 概要

Todoist のタスクを Google カレンダーの `primary` カレンダーに実イベントとして表示し（T→P）、`primary` に入っている会議を Todoist のタスクとして作成する（P→T）、双方向の同期ツールです。

- **T→P（Todoist → primary）**: Todoist 公式の Google カレンダー連携が作る「Todoist」カレンダーの予定を読み取り、`primary` にミラーを作ります。このカレンダーの予定は他者の空き時間判定には反映されないため、`primary` に実イベントとしてミラーする必要があります。
- **P→T（primary → Todoist）**: `primary` の会議から **Todoist API を直接呼び出して**タスクを作成・更新・削除します。当初は「Todoist」カレンダーへの複製を経由する設計でしたが、Todoist のヘルプ（[Use the Calendar integration](https://www.todoist.com/help/articles/use-the-calendar-integration-rCqwLCt3G)）にあるとおり、公式連携は「Todoist」カレンダーへの直接追加からタスクを新規作成しないため、この経路は機能しませんでした。そのため P→T は Todoist API 直接呼び出しに変更しています。

本プロジェクトの Google Apps Script（GAS）が、5 分ごとの時間トリガーでこの双方向の同期を行います。

- `sync`：5 分おきの時間トリガーから呼ばれる同期処理本体。カレンダーの予定と Todoist のタスクを取得・分類し、差分に応じて作成・更新・削除を行います。
- `setup`：初期セットアップ用に手動で 1 回実行する関数。`settings` / `log` / `links` シートの作成と、5 分間隔の時間トリガー登録を行います。`sync` のトリガーが既にある場合は何もしないため、何度実行してもトリガーは増えません。
- `cleanupLegacyTodoistCopies`：旧経路（「Todoist」カレンダーへの複製）で作られた残骸を削除するための、手動実行専用の使い捨て関数です。詳細は「旧経路（C 複製）の掃除」を参照してください。

同期の判定ルールや設計上の判断（初回照合、自己修復など）の詳細は `design.md` を参照してください。

## セットアップ手順

### 前提条件

- Node.js
- Google アカウント
- `@google/clasp` がインストールされ、`clasp login` でログイン済みであること
- このスクリプトプロジェクトがバインドされた Google スプレッドシート（`.clasp.json` の `scriptId` で指定されているプロジェクト）

`settings` / `log` / `links` シートは事前に用意する必要はありません。`setup` 実行時に自動で作成されます。

### 手順

1. 依存パッケージをインストールします。

   ```bash
   npm install
   ```

2. TypeScript をビルドします。`dist/Code.js` と `appsscript.json` が `dist/` に生成されます。

   ```bash
   npm run build
   ```

3. Apps Script プロジェクトへ送信します（`build` を実行した上で `clasp push` を呼ぶため、単体で実行しても構いません）。`.clasp.json` の `rootDir` が `dist` のため、`dist/` の内容がそのまま送信されます。

   ```bash
   npm run push
   ```

4. GAS エディタで `setup` 関数を選択し、**手動で 1 回実行**します。初回は Google アカウントへの権限承認を求められるので許可してください。これにより `settings` / `log` / `links` シートが作成され、`sync` を 5 分おきに実行する時間トリガーが登録されます。
   - `setup` は `sync` のトリガーが 1 つでもあれば新しく作りません。以前に別の間隔で `sync` のトリガーを作っている場合は、GAS エディタの「トリガー」画面でそれを削除してから `setup` を実行してください。
5. `settings` シートの `todoistCalendarId` に、「Todoist」カレンダーのカレンダー ID を入力します（取得方法は次節）。
6. Todoist API トークンをスクリプトプロパティに設定します（次々節「Todoist API トークンの設定」を参照）。P→T（会議のタスク化）はこのトークンが無いと動作しません。
7. 失敗通知を設定します（詳細は後述の「失敗通知の設定」を参照）。

以降は時間トリガーにより `sync` が自動的に実行されます。

### Todoist API トークンの設定

P→T（`primary` の会議を Todoist のタスクとして作成・更新・削除する処理）は、Todoist API を直接呼び出します。これには個人の API トークンが必要です。

1. Todoist の Web 版で「設定」→「連携機能」→「開発者」を開き、API トークンをコピーします。
2. Apps Script エディタの左メニューから「プロジェクトの設定」を開き、「スクリプト プロパティ」セクションで以下を追加します。

   | プロパティ | 値 |
   |---|---|
   | `TODOIST_API_TOKEN` | 手順 1 でコピーしたトークン |

   このプロパティが未設定、または空文字の場合、`sync` はタスク一覧の取得時に明確なエラーを出して停止します（フォールバックはしません）。
3. トークンはコードにもスプレッドシートにも書き込まれません。スクリプトプロパティにのみ保存されます。

## 設定（settings シート）

`settings` シートは A 列＝キー、B 列＝値のキーバリュー形式です。`setup` を実行すると、以下のキーの行が空値で自動的に追加されます。

| キー | 内容 |
|---|---|
| `todoistCalendarId` | 「Todoist」カレンダーのカレンダー ID。**手動で入力が必要**です。空欄・未設定、または `primary` を指定した場合は `sync` がエラーを送出します。 |
| `initialMatchDoneAt` | 初回照合が完了した時刻。**自動管理項目**であり、手動で入力する必要はありません。初回照合が完了すると `sync` が自動的に書き込みます。 |

`links` シートも自動管理項目です。生成物と初回照合ペアの対応関係を記録するために `sync` が読み書きするため、**手動で編集しないでください**。列は `calendar` / `iCalUID` / `srcUid` / `kind` / `recordedAt` / `todoistTaskId` の 6 列です。`todoistTaskId` は P→T で作成した Todoist タスクの ID を記録する列で、`calendar` が `todoist` かつ `kind` が `generated` の行だけで使います（他の行は空欄のままです）。

### links シートの移行（既存ユーザー向け）

本バージョンから `links` シートに `todoistTaskId` 列（F 列）を追加しました。旧バージョンで作られた `links` シート（この列が無い 5 列のシート）をそのまま使うと、`sync` はヘッダー行の不一致を検出し、次のような明確なエラーで停止します（黙って読み替えることはしません）。

```
links シートのヘッダー行が現行の形式（calendar, iCalUID, srcUid, kind, recordedAt, todoistTaskId）と一致しません...
```

このエラーが出た場合は、`links` シートの F1 セルに `todoistTaskId` と入力してから、もう一度 `sync`（または次回の時間トリガー）を実行してください。既存のデータ行（F 列）は空欄のままで構いません（P→T が今後作成するタスクの行から使われます）。旧経路の複製の行（`calendar` が `todoist`、`kind` が `generated`、`iCalUID` あり）もそのまま読み込めます。移行後に「旧経路（C 複製）の掃除」の手順で `cleanupLegacyTodoistCopies` を実行してください。

### 「Todoist」カレンダーの準備とカレンダー ID の取得

`todoistCalendarId` に入れる値は、Todoist 公式連携が作る「Todoist」カレンダーの ID です。`primary` は指定できません（指定すると `sync` がエラーになります）。

1. Todoist の設定から Google カレンダー連携を有効にします（[Todoist のヘルプ](https://www.todoist.com/help/articles/use-the-calendar-integration-rCqwLCt3G)）。連携すると、Google カレンダーに「Todoist」という名前のカレンダーが作られます。
2. Google カレンダーを開き、左側のカレンダー一覧で「Todoist」カレンダーの「︙」→「設定と共有」を開きます。
3. 「カレンダーの統合」セクションにある**カレンダー ID**（`...@group.calendar.google.com` の形式）をコピーします。
4. `settings` シートの `todoistCalendarId` の行（B 列）に貼り付けます。

`log` シートには、`sync` の実行結果が以下の列で記録されます。

| 列 | 内容 |
|---|---|
| `ts` | 記録日時 |
| `level` | `INFO` または `WARN` |
| `direction` | 同期の方向。`T→P`（「Todoist」カレンダー→ `primary` のミラー操作）、`P→T`（`primary` の会議 → Todoist タスクの作成・更新・削除操作）、`INIT`（初回照合によるマーク付け）、`REPAIR`（自己修復） |
| `uid` | 対象イベントの `iCalUID` |
| `message` | 処理内容 |

## 失敗通知の設定

本プロジェクトは独自の通知コードを持ちません。GAS 標準のトリガー失敗通知メールで異常を検知する設計です。

1. Apps Script エディタの「トリガー」画面を開きます。
2. `sync` のトリガー（またはプロジェクト全体の通知設定）で、失敗通知の頻度を「すぐに通知」（即時）に設定します。
3. `appsscript.json` の `exceptionLogging: STACKDRIVER` により、例外発生時のスタックトレースが Cloud Logging に記録されます。

本プロジェクトは例外を捕捉しない設計です（`sync` に `catch` はなく、`finally` でログの書き込みとロック解放のみを行います）。異常があれば `sync` が throw し、上記の通知メールと Cloud Logging のログで検知します。

## 既知の制約

| # | 内容 | 運用上の影響 |
|---|---|---|
| R1 | T→P（Todoist → primary のミラー）は公式連携が依存経路上にある。P→T（primary → Todoist のタスク化）は Todoist API を直接呼び出すため、この制約を受けない。 | Todoist 側の障害や仕様変更が起きると、T→P（ミラー作成）だけが止まる可能性がある。 |
| R2 | 繰り返し予定の個別回の編集・削除は同期しない（T→P）。 | 繰り返し会議・タスクの 1 回だけを変更・取り消しても、ミラーには反映されない。 |
| R3 | 会議由来タスク（P→T で作成した Todoist タスク）は `primary` の予定（N）を正とし、Todoist 側の編集は元に戻る。 | Todoist 側でそのタスクの時刻やタイトルを変更しても、次の `sync` で `primary` の内容に戻される。 |
| R4 | 初回照合で対応付けたペアは、以後同期しない。 | ペアの一方を変更・削除しても、もう一方は追従しない（例：会議を取り消してもタスクは残る）。 |
| R5 | 公式連携が予定を再作成し `iCalUID` が変わると、T→P の生成物として認識できない。 | ミラーが誤って新規の起点として扱われ、二重生成や後述の REPAIR が発生する可能性がある。 |
| R7 | 繰り返し（`recurrence` を持つ）会議は、当面 P→T のタスク化の対象外。 | 繰り返し会議からは Todoist タスクが自動作成されない。手動でタスクを作成する必要がある。 |
| R8 | ユーザーが Todoist 側でタスクを完了・削除すると、その会議への自動タスク化はその後行われない。 | 完了・削除したタスクが `sync` によって作り直されることはない。再度タスク化したい場合は、Todoist 側で手動にタスクを作成する必要がある。 |

### 繰り返し会議はタスク化されない（P→T の制約）

`recurrence`（繰り返しルール）を持つ `primary` の会議は、P→T のタスク化の対象外です。RRULE（`FREQ=WEEKLY` など）を Todoist の `due_string`（自然言語の繰り返し表現）へ無損失に変換するのが難しいため、誤った繰り返しタスクを作るより、当面は対象外にする方針にしています。繰り返し会議に対応するタスクが必要な場合は、Todoist 側で手動に作成してください。

### 旧経路（C 複製）の掃除

以前のバージョンでは、`primary` の会議を「Todoist」カレンダーへ複製する経路（C）で P→T を実現しようとしていました。しかし、これは実際にはタスクを作らない設計ミスであったため撤回し、Todoist API 直接呼び出しに置き換えました。旧バージョンを既に運用していた場合、「Todoist」カレンダーにこの複製（`srcUid` を持つが `initialMatch` を持たないイベント）が残っている可能性があります。

`cleanupLegacyTodoistCopies` 関数を GAS エディタから手動で 1 回実行すると、これらの残骸を安全に削除できます。

- 削除するのは、次の条件をすべて満たすイベントだけです。
  - `srcUid`（`extendedProperties.private.srcUid`）を持つ
  - `initialMatch` を持たない
  - `links` シートに対応する行（`calendar: todoist`、`kind: generated`）がある
- 上記のいずれかを満たさないイベント（`srcUid` を持たない本物の Todoist タスクのイベント、`initialMatch` を持つ初回照合ペア）は**絶対に削除しません**。
- 削除したイベントに対応する `links` の行も取り除きます。
- 通常の `sync` からは呼ばれません。実行するとロックを取得し（実行中の `sync` と衝突する場合はエラーになります）、対象範囲は `sync` と同じ「現在時刻以降」です（既に終わった会議の複製は対象外です。busy 判定に影響しないため）。

### 初回照合をやり直す方法

初回照合は、初回の `sync` 実行時にのみ行われる一度きりのブートストラップ処理です。既存の Todoist タスク（T）と `primary` の予定（N）を、開始時刻とタイトルで対応付け、以後の同期対象（S1〜S6）から除外します。

やり直したい場合は、`settings` シートの `initialMatchDoneAt` セルの値を空欄にしてください。次回の `sync` 実行時に、`initialMatchDoneAt` が空であることが検知され、初回照合が自動的にもう一度実行されます。別の関数を手動実行する必要はありません。

ただし、すでにペアになっている予定（予定側に `initialMatch` が残っているもの、または `links` シートに `paired` 行があるもの）は照合の対象外です。もう一度照合されるのは、ペア情報を持たない予定だけです。

### WARN（REPAIR）が出続けたときの確認方法

REPAIR は、生成物（primary のミラー M。旧経路の複製 C が「Todoist」カレンダーに残っている場合はそれも含む）が持つべき `extendedProperties`（`srcUid` や `initialMatch`）が失われた際に、`links` シートに記録されている対応関係から値を書き戻す自己修復処理です。この処理が発生するたびに、`log` シートに `WARN` レベルで記録されます。P→T の Todoist タスクには `extendedProperties` の概念が無いため、この自己修復は T→P（および旧経路の C）にのみ適用されます。

確認方法：

1. `log` シートを開き、`direction` が `REPAIR` の行を確認します。
2. 同じ `uid`（`iCalUID`）に対する `REPAIR` / `WARN` の行が、5 分おきに繰り返し記録されていないか確認します。

REPAIR は、`links` シートに対応行があるにもかかわらず必要な `extendedProperties` が欠けているイベントに対して作られ、`patchEvent` で書き戻したあとに WARN として記録されます。同じ `uid` について 5 分ごとに WARN が出続ける場合は、書き戻した値が次の実行までに再び失われていることを意味します。原因を切り分けるには、次の点を確認してください。

1. 次回の `sync` の直前に、そのイベントの `extendedProperties.private` に `srcUid`（ペアなら `initialMatch` も）が残っているか
2. `links` シートに、そのイベントの `(calendar, iCalUID)` に対応する行が想定どおりあるか
3. REPAIR の書き戻し自体が成功しているか（失敗していれば例外で `sync` が停止し、失敗通知メールが届きます）

イベント側の値だけが毎回失われている場合は、公式連携がそのイベントを書き換えている可能性があります（#1 の V1 で確認する項目です）。

なお、REPAIR で修復できない例外があります。公式連携が予定を削除して作り直し、`iCalUID` そのものが変わってしまった場合です（既知の制約 R5）。この場合は `links` シートの対応関係と実際のイベントが一致しなくなるため、REPAIR による自己修復では防げません。

## npm scripts

| スクリプト | 内容 |
|---|---|
| `npm run build` | TypeScriptを esbuild で `dist/Code.js` にバンドルし、`appsscript.json` を `dist/` にコピーする |
| `npm test` | Vitest で単体テストを実行する |
| `npm run lint` | ESLint でコードを検査する |
| `npm run typecheck` | `tsc --noEmit` で型チェックのみ行う |
| `npm run push` | `build` の後に `clasp push` でApps Scriptプロジェクトへ送信する |
