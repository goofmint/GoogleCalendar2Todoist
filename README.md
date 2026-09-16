# GoogleCalendar2Todoist

## 概要

Todoist のタスクを Google カレンダーの `primary` カレンダーに実イベントとして表示し、`primary` に入っている会議を「Todoist」カレンダー経由でタスク化する、双方向の同期ツールです。

Todoist 公式の Google カレンダー連携は「Todoist」という専用カレンダーにしか書き込めず、このカレンダーの予定は他者の空き時間判定には反映されません。そこで本プロジェクトの Google Apps Script（GAS）が、5 分ごとの時間トリガーで「Todoist」カレンダーと `primary` カレンダーの間をコピーし、同僚から見て正しく busy に見える状態を作ります。

- `sync`：5 分おきの時間トリガーから呼ばれる同期処理本体。両カレンダーの予定を取得・分類し、差分に応じて作成・更新・削除を行います。
- `setup`：初期セットアップ用に手動で 1 回実行する関数。`settings` / `log` / `links` シートの作成と、5 分間隔の時間トリガー登録を行います。`sync` のトリガーが既にある場合は何もしないため、何度実行してもトリガーは増えません。

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
6. 失敗通知を設定します（詳細は後述の「失敗通知の設定」を参照）。

以降は時間トリガーにより `sync` が自動的に実行されます。

## 設定（settings シート）

`settings` シートは A 列＝キー、B 列＝値のキーバリュー形式です。`setup` を実行すると、以下のキーの行が空値で自動的に追加されます。

| キー | 内容 |
|---|---|
| `todoistCalendarId` | 「Todoist」カレンダーのカレンダー ID。**手動で入力が必要**です。空欄・未設定、または `primary` を指定した場合は `sync` がエラーを送出します。 |
| `initialMatchDoneAt` | 初回照合が完了した時刻。**自動管理項目**であり、手動で入力する必要はありません。初回照合が完了すると `sync` が自動的に書き込みます。 |

`links` シートも自動管理項目です。生成物と初回照合ペアの対応関係を記録するために `sync` が読み書きするため、**手動で編集しないでください**。

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
| `direction` | 同期の方向。`T→P`（「Todoist」カレンダー→ `primary` のミラー操作）、`P→T`（`primary` → 「Todoist」カレンダーの複製操作）、`INIT`（初回照合によるマーク付け）、`REPAIR`（自己修復） |
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
| R1 | 公式連携（Todoist ⇄「Todoist」カレンダー）が同期の依存経路上にある。 | Todoist 側の障害や仕様変更が起きると、同期全体が止まる。 |
| R2 | 繰り返し予定の個別回の編集・削除は同期しない。 | 繰り返し会議・タスクの 1 回だけを変更・取り消しても、ミラー・複製には反映されない。 |
| R3 | 会議由来タスク（C）は `primary` の予定（N）を正とし、Todoist 側の編集は元に戻る。 | Todoist 側でそのタスクの時刻やタイトルを変更しても、次の `sync` で `primary` の内容に戻される。 |
| R4 | 初回照合で対応付けたペアは、以後同期しない。 | ペアの一方を変更・削除しても、もう一方は追従しない（例：会議を取り消してもタスクは残る）。 |
| R5 | 公式連携が予定を再作成し `iCalUID` が変わると、生成物として認識できない。 | 生成物が誤って新規の起点として扱われ、二重生成や後述の REPAIR が発生する可能性がある。 |
| R6 | 会議終了前にその会議から作ったタスクを完了すると、複製（C）が再作成される場合がある。 | 会議中や会議開始前にタスクを完了させると、複製が再作成されてしまうことがある。 |

### 初回照合をやり直す方法

初回照合は、初回の `sync` 実行時にのみ行われる一度きりのブートストラップ処理です。既存の Todoist タスク（T）と `primary` の予定（N）を、開始時刻とタイトルで対応付け、以後の同期対象（S1〜S6）から除外します。

やり直したい場合は、`settings` シートの `initialMatchDoneAt` セルの値を空欄にしてください。次回の `sync` 実行時に、`initialMatchDoneAt` が空であることが検知され、初回照合が自動的にもう一度実行されます。別の関数を手動実行する必要はありません。

ただし、すでにペアになっている予定（予定側に `initialMatch` が残っているもの、または `links` シートに `paired` 行があるもの）は照合の対象外です。もう一度照合されるのは、ペア情報を持たない予定だけです。

### WARN（REPAIR）が出続けたときの確認方法

REPAIR は、生成物（ミラー M・複製 C）が持つべき `extendedProperties`（`srcUid` や `initialMatch`）が失われた際に、`links` シートに記録されている対応関係から値を書き戻す自己修復処理です。この処理が発生するたびに、`log` シートに `WARN` レベルで記録されます。

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
