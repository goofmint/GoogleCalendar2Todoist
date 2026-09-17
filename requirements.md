# Todoist ⇄ Google カレンダー 同期 要件定義

実装基盤: Google Apps Script（Google スプレッドシートにコンテナバインド） / 2026-09-15（2026-09-17 改訂: P→T を Todoist API 直接呼び出しに変更）

## 1. 目的

Todoist のタスクを **primary カレンダーの実イベント**として反映し、同僚から見て正しく busy に見える状態にする。あわせて同僚が primary に入れた予定を Todoist のタスクとして取り込む。

Todoist 公式連携は専用の「Todoist」カレンダーにしか書き込めず、セカンダリカレンダーは他者の空き判定に反映されない。primary に実イベントが必要。

### 改訂の経緯（2026-09-17）

当初の設計は、`primary` の会議を「Todoist」カレンダーに複製（C）すれば、Todoist 公式の Google カレンダー連携がそれを取り込んでタスク化してくれる、という前提に立っていた。

しかし Todoist のヘルプ（[Use the Calendar integration](https://www.todoist.com/help/articles/use-the-calendar-integration-rCqwLCt3G)）によれば、**「Todoist」カレンダーに直接追加したイベントは新しいタスクを作らない**。公式連携は「既にタスクに紐づいているイベント」の変更をタスク側に反映するだけで、逆方向（カレンダー→タスクの新規作成）は行わない。そのため、この複製経路は一度もタスクを生成していなかった。

この事実を受けて、**P→T（`primary` の会議 → Todoist のタスク）は Todoist API を直接呼び出す方式に変更する**。T→P（Todoist のタスク → `primary` のミラー）は、公式連携が「Todoist」カレンダーに作るイベントを引き続き読み取るだけなので、従来どおり有効である。

## 2. 構成

Todoist 公式 Google カレンダー連携は **T→P（Todoist → primary）方向のためだけに残して利用する**。GAS は「Todoist」カレンダーと `primary` カレンダーの間のミラーリング（T→P）に加えて、`primary` の会議から Todoist のタスクを直接作成・更新・削除する（P→T）。

```
Todoist ⇄（公式連携。T→P 方向のみ利用）⇄ 「Todoist」カレンダー
   ▲                                          ⇅  GAS（5分トリガー）
   │ Todoist API v1（P→T 方向。直接呼び出し）  primary カレンダー ⇄ 同僚
   └──────────────────────────────────────────┘
```

| レイヤー | 役割 |
|---|---|
| 「Todoist」カレンダー | **T→P の入力面。** Todoist 公式連携が作るタスクのイベントをここから読み取る。ここでのドラッグ・リネームはタスク側に反映される（公式連携の機能） |
| primary のミラー（M） | **出力専用。** 同僚に busy を見せるためだけに存在する。編集しない |
| primary のネイティブ予定（N） | 同僚が入れた会議など。**GAS が Todoist API を直接呼び出してタスク化する（P→T）**。「Todoist」カレンダーへの複製は行わない |
| Todoist のタスク（P→T の生成物） | N から作成されたタスク。`content`/`due_date`/`due_datetime` を N の内容で上書きする |

Webhook、`doPost`、`onEventUpdated` は使わない。5分間隔の時間トリガー1本のみ。Todoist API の呼び出しには `UrlFetchApp`（`https://www.googleapis.com/auth/script.external_request`）を使う。

## 3. 同一性の記憶

T→P 側（primary のミラー M）は、従来どおり `extendedProperties.private.srcUid` に**コピー元の `iCalUID`** を記録する。

| 作成物 | `srcUid` の値 |
|---|---|
| primary のミラー（M） | 「Todoist」カレンダー側の `iCalUID` |

Google カレンダーの `id` ではなく `iCalUID` を使う。`iCalUID` は RFC5545 のイベント識別子で、同期クライアントがイベントを削除・再作成しても引き継がれるため、`id` の変化に影響されない。

`srcUid` を**持たない**予定が起点、**持つ**予定が生成物。生成物は起点集合から除外する。これがエコー防止になる（T→P 側）。

P→T 側（Todoist のタスク）には `extendedProperties` に相当する仕組みが無いため、対応付けは **`links` シートの `srcUid ↔ todoistTaskId`** だけで管理する。タスク本体（`content`/`description`）には何も書き込まない。

### スプレッドシート

| シート | 用途 |
|---|---|
| `settings` | 「Todoist」カレンダーの ID |
| `log` | `ts` / `level` / `direction` / `uid` / `message` |
| `links` | 生成物と初回照合ペアの対応表（`calendar` / `iCalUID` / `srcUid` / `kind` / `recordedAt` / `todoistTaskId`）。T→P 側はイベントの `srcUid` などが失われたときに検出・書き戻し、WARN を記録する。P→T 側（`calendar: 'todoist'`, `kind: 'generated'`）は `todoistTaskId` を識別子とし、`iCalUID` は空欄を許容する |

**links シートの移行**: 本改訂で `todoistTaskId` 列（F 列）を追加した。旧形式（この列が無い 5 列のシート）を読み込むと、`sync` はヘッダー行の不一致を検出して明確なエラーで停止する（黙って読み替えない）。既存の `links` シートの F1 セルに `todoistTaskId` と入力してから再実行すること（README 参照）。

### Todoist API トークン

Todoist API を呼ぶために、個人の API トークン（Todoist の設定画面から取得）をスクリプトプロパティ（キー名: `TODOIST_API_TOKEN`）に保存する。未設定・空文字の場合、`sync` はタスク一覧取得の時点で明確な `Error` を throw する。トークンをコード・スプレッドシートに書かない。

## 4. 同期ロジック

5分ごとに、「Todoist」カレンダー・`primary` カレンダーの**現在時刻以降**の予定と、Todoist のアクティブなタスク一覧を全件取得して突き合わせる。`syncToken` は使わない（毎回の全件照合により状態がなく、自己修復する）。

### T→P（ミラー方向。カレンダーイベントのみで完結。従来どおり）

- 起点 **T** = 「Todoist」カレンダーの予定のうち `srcUid` を持たないもの
- 生成物 **M** = primary の予定のうち `srcUid` を持つもの
- 繰り返し予定の例外回（`recurringEventId` を持つもの）は T/M のどちらにも含めない
- 初回照合のペア（`initialMatch` を持つもの）は T/M のどちらにも含めない

| ID | 条件 | 動作 |
|---|---|---|
| S1 | T の `iCalUID` に対応する M がない | ミラーを作成する |
| S2 | T と対応する M の内容が異なる | ミラーを更新する |
| S3 | M の `srcUid` が T に存在しない | ミラーを削除する |

### P→T（タスク化方向。Todoist API を直接呼び出す。本改訂の変更点）

- 起点 **N** = primary の予定のうち `srcUid` を持たず、辞退しておらず、`eventType` が `default` / `fromGmail` のもの（勤務場所・不在・サイレント・誕生日は対象外）。**繰り返し（`recurrence` を持つ）予定は当面対象外**（8. 既知の制約 参照）
- 生成物 = Todoist のアクティブなタスクのうち、`links` シートに `srcUid ↔ todoistTaskId` の対応がある（かつそのタスクがまだアクティブな）もの
- 初回照合のペア（`initialMatch` を持つもの）は N に含めない

| ID | 条件 | 動作 |
|---|---|---|
| S4 | N の `iCalUID` に対応するアクティブな生成タスクが無い | Todoist API でタスクを作成する（`links` に `srcUid ↔ todoistTaskId` を記録する） |
| S5 | N と対応するタスクの `content`/`due` が異なる | Todoist API でタスクを更新する |
| S6 | 生成タスクの `srcUid` が N に存在しない（N が削除・対象外化された） | Todoist API でタスクを削除する（対応するタスクが既に無ければ何もしない） |

**S4 の再作成防止**: `links` に対応行があるのに、そのタスクがアクティブ一覧に無い場合（ユーザーが Todoist 側でタスクを完了・削除した場合）は、S4 を発生させない。ユーザーの完了・削除操作を尊重し、勝手に作り直さない。この場合、対応する N がまだ存在する限り `links` の該当行は残し続ける（S4 の再発生を防ぐ記録として使う）。N 自体が無くなった場合（会議が削除された等）は、`links` の該当行を取り除く。

**S1 の二重ミラー除外**: 日時付きのタスクは、Todoist 公式連携が「Todoist」カレンダーに（タスクの echo として）イベントを作る。このイベントは `srcUid` を持たないため T として分類され、放置すると S1 で primary に二重のミラーができてしまう。そこで、有効な生成タスクを持つ N と同じコンテンツキー（`start + '|' + summary`）を持つ T 候補は、自作タスクの echo とみなして T から除外する（曖昧一致時は安全側に倒し、除外せず WARN を記録する）。

### コピーする内容

T→P（ミラー M）: `summary` / `start` / `end` / `recurrence` をそのままコピーする。繰り返しは `singleEvents: false` で系列として取得し、`recurrence` を verbatim で複製する（個別回への展開は行わない）。ミラーには `visibility: 'private'` を付け、同僚には「予定あり」のみ見せる。ミラーには通知を付けない（`reminders: { useDefault: false, overrides: [] }`）。

P→T（Todoist タスク）: `summary → content`、`start`（終日）→ `due_date`、`start`（時刻あり）→ `due_datetime`（UTC に変換して送る）。Todoist のタスクに `end` は無いため終了時刻は使わない。`description` や `project_id` などその他のフィールドは設定しない（プロジェクトを指定しないため Inbox に作られる）。

### 初回実行

既存の予定・タスクは `srcUid`／`links` の対応を持たないため全件が起点になる。両カレンダーに実質同じ予定が既に存在する場合の二重生成を防ぐため、**初回のみ (開始日時, タイトル) で T（Todoist カレンダー側のイベント）と N（primary の予定）を突き合わせ、一致するものは互いに `srcUid` を書き込み、`initialMatch` を付けて同期対象から除外する**。除外されたペアは S1〜S6 のいずれでも作成・更新・削除されない（片方が削除されても、もう片方は削除しない）。2回目以降はこの照合を行わない。この初回照合は T→P 側の従来の意味のままであり、本改訂による変更はない。

## 5. Todoist 側の設定に委ねる項目

### T→P（公式連携。GAS からは制御できない）

- Todoist のタスクをどう「Todoist」カレンダーに表示するか（既定所要時間、終日タスクの扱いなど）
- 繰り返しタスクをどう展開するか

### P→T（Todoist API 直接呼び出し。GAS 側の設計判断）

- **投入先プロジェクトは指定しない**（Todoist のデフォルト = Inbox に作成する）。プロジェクト ID の設定項目は設けない
- 繰り返し（`recurrence` を持つ）N はタスク化の対象外とする（8. 既知の制約 R7 参照）

## 6. 非機能要件

| 項目 | 要件 |
|---|---|
| 遅延 | Todoist → primary で最大 5 分 ＋ 公式連携の同期遅延（1〜2分）。合計 3〜7分 |
| 同期範囲 | 現在時刻以降。過去は対象外。未来の上限は設けず、カレンダーに存在する予定をすべて対象とする |
| エラー処理 | **例外は捕捉せず throw する。** GAS のトリガー実行失敗通知メールで検知する |
| 同時実行 | `LockService.getScriptLock()` で直列化。取得失敗時はスキップして次回 |
| 実行時間 | 差分がなければ書き込みを行わず終了する |
| ログ | 全操作を `log` シートに記録する |

## 7. 既知の制約

| # | 内容 |
|---|---|
| R1 | T→P は公式連携が critical path に入るため、Todoist 側の障害・仕様変更で T→P の同期が止まる（P→T は Todoist API 直接呼び出しのため、この制約を受けない） |
| R2 | 繰り返し予定の個別回の変更・削除は同期しない（T→P） |
| R3 | P→T のタスクは primary の予定（N）を正とし、Todoist 側でのタイトル・日時の変更は S5 により元に戻される |
| R4 | 初回照合でペアになった予定は、その後も同期しない |
| R5 | 公式連携がイベントを作り直して `iCalUID` が変わった場合は、T→P の生成物だと判別できない |
| R7 | 繰り返し（`recurrence` を持つ）N は、P→T のタスク化の対象外とする。RRULE から Todoist の `due_string`（自然言語の繰り返し表現）への無損失変換が難しいため、誤変換より対象外化を優先する |
| R8 | ユーザーが Todoist 側でタスクを完了・削除すると、その N に対する自動タスク化はその後行われなくなる。`links` の対応行（`srcUid ↔ todoistTaskId`）が「既にタスク化を試みた」記録として残り続けるため（N が存在する限り消えない）。再度タスク化したい場合は、Todoist 側で手動でタスクを作る必要がある |

## 8. 参考

- [Use the Calendar integration | Todoist Help](https://www.todoist.com/help/articles/use-the-calendar-integration-rCqwLCt3G)
- [Check your availability across calendars | Google Calendar Help](https://support.google.com/calendar/answer/16287054)