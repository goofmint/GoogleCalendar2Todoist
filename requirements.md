# Todoist ⇄ Google カレンダー 同期 要件定義

実装基盤: Google Apps Script（Google スプレッドシートにコンテナバインド） / 2026-09-15

## 1. 目的

Todoist のタスクを **primary カレンダーの実イベント**として反映し、同僚から見て正しく busy に見える状態にする。あわせて同僚が primary に入れた予定を Todoist に取り込む。

Todoist 公式連携は専用の「Todoist」カレンダーにしか書き込めず、セカンダリカレンダーは他者の空き判定に反映されない。primary に実イベントが必要。

## 2. 構成

Todoist 公式 Google カレンダー連携を**残して利用する**。GAS は 2 つのカレンダー間のコピーだけを行い、Todoist API には一切触れない。

```
Todoist ⇄（公式連携）⇄ 「Todoist」カレンダー
                              ⇅  GAS（5分トリガー）
                          primary カレンダー ⇄ 同僚
```

| レイヤー | 役割 |
|---|---|
| 「Todoist」カレンダー | **作業面。** Google カレンダー UI 上でここの予定をドラッグ・リネームする |
| primary のミラー | **出力専用。** 同僚に busy を見せるためだけに存在する。編集しない |
| primary のネイティブ予定 | 同僚が入れた会議など。「Todoist」カレンダーに複製し、公式連携経由でタスク化される |

Webhook、`doPost`、`onEventUpdated`、Todoist API は使わない。5分間隔の時間トリガー1本のみ。

## 3. 同一性の記憶

同期で作成したイベントには `extendedProperties.private.srcUid` に**コピー元の `iCalUID`** を記録する。

| 作成物 | `srcUid` の値 |
|---|---|
| primary のミラー（M） | 「Todoist」カレンダー側の `iCalUID` |
| 「Todoist」カレンダーの複製（C） | primary 側の `iCalUID` |

Google カレンダーの `id` ではなく `iCalUID` を使う。`iCalUID` は RFC5545 のイベント識別子で、同期クライアントがイベントを削除・再作成しても引き継がれるため、`id` の変化に影響されない。

`srcUid` を**持たない**予定が起点、**持つ**予定が生成物。生成物は起点集合から除外する。これがエコー防止になる。

### スプレッドシート

| シート | 用途 |
|---|---|
| `settings` | 「Todoist」カレンダーの ID |
| `log` | `ts` / `level` / `direction` / `uid` / `message` |
| `links` | 生成物と初回照合ペアの対応表（`calendar` / `iCalUID` / `srcUid` / `kind` / `recordedAt`）。イベント側の `srcUid` などが失われたときに検出・書き戻し、WARN を記録する |

## 4. 同期ロジック

5分ごとに、両カレンダーの**現在時刻以降**の予定を全件取得して突き合わせる。`syncToken` は使わない（毎回の全件照合により状態がなく、自己修復する）。

- 起点 **T** = 「Todoist」カレンダーの予定のうち `srcUid` を持たないもの
- 起点 **N** = primary の予定のうち `srcUid` を持たず、辞退しておらず、`eventType` が `default` / `fromGmail` のもの（勤務場所・不在・サイレント・誕生日は対象外）
- 繰り返し予定の例外回（`recurringEventId` を持つもの）は、両カレンダーとも T/N/M/C のどれにも含めない
- 初回照合のペア（`initialMatch` を持つもの）は、T/N/M/C のどれにも含めない
- 生成物 **M** = primary の予定のうち `srcUid` を持つもの
- 生成物 **C** = 「Todoist」カレンダーの予定のうち `srcUid` を持つもの

| ID | 条件 | 動作 |
|---|---|---|
| S1 | T の `iCalUID` に対応する M がない | ミラーを作成する |
| S2 | T と対応する M の内容が異なる | ミラーを更新する |
| S3 | M の `srcUid` が T に存在しない | ミラーを削除する |
| S4 | N の `iCalUID` に対応する C がない | 複製を作成する |
| S5 | N と対応する C の内容が異なる | 複製を更新する |
| S6 | C の `srcUid` が N に存在しない | 複製を削除する |

| 起点の操作 | 結果 |
|---|---|
| Todoist でタスク作成 | 公式連携が T を作る → S1 でミラー作成 |
| 「Todoist」カレンダーでドラッグ／リネーム | S2 でミラー更新。公式連携がタスクを更新 |
| Todoist でタスク削除 | S3 でミラー削除 |
| 同僚が primary に会議を入れる | S4 で複製 → 公式連携がタスク化 |
| primary のネイティブ会議を削除 | S6 で複製削除 → 公式連携がタスク削除 |

### コピーする内容

`summary` / `start` / `end` / `recurrence` をそのままコピーする。繰り返しは `singleEvents: false` で系列として取得し、`recurrence` を verbatim で複製する（個別回への展開は行わない）。ミラーには `visibility: 'private'` を付け、同僚には「予定あり」のみ見せる。ミラーには通知を付けない（`reminders: { useDefault: false, overrides: [] }`）。

### 初回実行

既存の予定はどちらも `srcUid` を持たないため全件が起点になる。両カレンダーに実質同じ予定が既に存在する場合の二重生成を防ぐため、**初回のみ (開始日時, タイトル) で突き合わせ、一致するものは `srcUid` を相互に書き込み、`initialMatch` を付けて同期対象から除外する**。除外されたペアは S1〜S6 のいずれでも作成・更新・削除されない（片方が削除されても、もう片方は削除しない）。2回目以降はこの照合を行わない。

## 5. Todoist 側の設定に委ねる項目

GAS からは制御できない。Todoist の連携設定で決まる。

- カレンダー起点タスクの投入先プロジェクト
- タスクの既定所要時間（イベント長）
- 終日タスクを同期するか
- 繰り返しタスクをどう展開するか

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
| R1 | 公式連携が同期の critical path に入るため、Todoist 側の障害・仕様変更で同期が止まる |
| R2 | 繰り返し予定の個別回の変更・削除は同期しない |
| R3 | 複製（C）は primary 側を正とし、Todoist 側での変更は元に戻される |
| R4 | 初回照合でペアになった予定は、その後も同期しない |
| R5 | 公式連携がイベントを作り直して `iCalUID` が変わった場合は、生成物だと判別できない |
| R6 | 会議が終わる前に、その会議から作ったタスクを完了すると、複製が作り直される可能性がある |

## 8. 参考

- [Use the Calendar integration | Todoist Help](https://www.todoist.com/help/articles/use-the-calendar-integration-rCqwLCt3G)
- [Check your availability across calendars | Google Calendar Help](https://support.google.com/calendar/answer/16287054)