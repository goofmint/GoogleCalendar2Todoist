# タスクリスト - Todoist ⇄ Google カレンダー 同期（GAS）

対象: `requirements.md` / `design.md`
作成日: 2026-09-15

## 概要

- 総タスク数: 16
- 推定作業時間: 約 5 日（事前検証の待ち時間は含まない）
- 優先度: 高
- 最重要の経路: Task 1.1（公式連携の検証）の結果しだいで、設計を見直す可能性がある。Phase 2 のうち eventContent と actionExecutor は、この結果が出てから確定させる

## タスク一覧

### Phase 1: 準備・検証

#### Task 1.1: 公式連携と Calendar API の挙動を検証する（V1〜V5）

- [ ] テスト用の Google アカウントとテスト用の Todoist を用意し、公式連携を有効にする
- [ ] API Explorer か使い捨ての GAS で、「Todoist」カレンダーに `extendedProperties.private.srcUid` 付きのイベントを作る
- [ ] V1: タスク化された後も `extendedProperties.private` が残っているか
- [ ] V2: 5〜10 分待った後も、summary/start/end が変わっていないか
- [ ] V3: 繰り返しの C について、Todoist で 1 回分を完了したときにイベントがどう変わるか（開始日が進む／削除される／変わらない）
- [ ] V4: `patch` に `recurrence: []` を送ると、繰り返しが解除されるか
- [ ] V5: 他のキーを持つイベントに一部のキーだけを patch したとき、他のキーが残るか
- [ ] 結果を `.tmp/verification.md` に記録する
- **完了条件**: V1〜V5 の結果がすべて記録され、NG のものについては設計を変更するか受け入れるかが決まっている
- **依存**: なし
- **推定時間**: 2h

#### Task 1.2: プロジェクトの雛形を作る

- [ ] Context7 で clasp・esbuild・Vitest の最新の使い方を確認する
- [ ] `package.json`（typescript, esbuild, vitest, eslint, typescript-eslint, @types/google-apps-script, @google/clasp）
- [ ] `tsconfig.json`（strict）と ESLint の設定（`no-explicit-any` をエラーにする）
- [ ] `esbuild.config.mjs`（`dist/Code.js` を出力し、footer でトップレベルに `sync` と `setup` を定義する）
- [ ] `appsscript.json`（design.md §4.2）
- [ ] スプレッドシートを作って `clasp` でバインドし、`.clasp.json` の `rootDir` を `dist` にする
- [ ] npm scripts: `build` / `test` / `lint` / `typecheck` / `push`
- **完了条件**: 空の `sync` をデプロイし、GAS エディタから実行できる。test・lint・typecheck が通る
- **依存**: なし（Task 1.1 と並行して進められる）
- **推定時間**: 2h

### Phase 2: 実装

#### Task 2.1: config.ts / types.ts

- [ ] design.md §2.2 の定数と型を定義する
- **完了条件**: typecheck が通る
- **依存**: Task 1.2
- **推定時間**: 0.5h

#### Task 2.2: eventContent.ts ＋ テスト

- [ ] `normalizeContent` / `isSameContent` / `contentKeyForInitialMatch`
- [ ] `buildInsertResource`（M には visibility private と通知なしを付ける） / `buildUpdateResource`（extendedProperties を含めない） / `buildMarkResource` / `buildRepairResource`
- [ ] テスト: `+09:00` と `Z` を同一とみなす、終日か時刻ありか、繰り返しでの timeZone の差、summary がない場合、M と C のリソースの違い
- **完了条件**: テストがすべて通り、分岐網羅が 90% 以上
- **依存**: Task 2.1、Task 1.1（V4/V5 の結果）
- **推定時間**: 2h

#### Task 2.3: eventClassifier.ts ＋ テスト

- [ ] `getSrcUid` / `isInitialMatched` / `isRecurringException` / `isDeclinedBySelf`
- [ ] `classify(calendar, events, links)`（design.md の分類ルール表 1〜8 を上から順に評価する）
- [ ] links から復元したときに repair を作り、`observedLinks` を組み立てる
- [ ] 起点の iCalUID が重複していたら throw する
- [ ] テスト: 1〜8 の各条件と優先順位（特に、`initialMatch` だけが消えたペアが M/C にならないこと）、取消済みの例外回、primary 以外の eventType、辞退、重複での throw
- **完了条件**: テストがすべて通り、分岐網羅が 90% 以上
- **依存**: Task 2.1
- **推定時間**: 2.5h

#### Task 2.4: syncPlanner.ts ＋ テスト

- [ ] 双方向で使う `reconcile` と `planSync` を実装する
- [ ] テスト: S1〜S6、差分がなければ `[]`、生成物の重複削除（S3D/S6D）、エコーが起きないこと、links から復元した生成物で create が出ないこと
- **完了条件**: テストがすべて通り、分岐網羅が 90% 以上
- **依存**: Task 2.2, 2.3
- **推定時間**: 2.5h

#### Task 2.5: initialMatcher.ts ＋ テスト

- [ ] キーでグループ化し、1 対 1 のものだけをペアにして、mark を 2 件ずつ作る
- [ ] テスト（D1 の回帰テスト）:
  - mark を適用した状態に classify と planSync をかけても、何も出ないこと
  - ペアの A だけを削除した状態でも、B の delete が出ないこと（B だけを削除した場合も同様）
  - 同じキーが複数ある場合はペアにしないこと
- **完了条件**: テストがすべて通り、回帰テストが含まれている
- **依存**: Task 2.4
- **推定時間**: 1.5h

#### Task 2.6: linksPlanner.ts ＋ テスト

- [ ] `planLinks`（observed と created を合わせ、deleted を除き、`recordedAt` を引き継いで、`changed` を判定する）
- [ ] テスト: 追加、削除、範囲外になった行の除去、`recordedAt` の引き継ぎ、変更がなければ `changed=false`、mark したペアが記録されること
- **完了条件**: テストがすべて通り、分岐網羅が 90% 以上
- **依存**: Task 2.1
- **推定時間**: 1.5h

#### Task 2.7: settingsRepository.ts / linksRepository.ts / logger.ts

- [ ] `readSettings`（未設定や `primary` 指定のときは throw） / `markInitialMatchDone` / `ensureSheets`（settings/log/links）
- [ ] `readLinks` / `writeLinks`
- [ ] `createLogger`（0 件ならシートにアクセスしない）
- **完了条件**: GAS 上で `ensureSheets` を実行すると 3 シートとヘッダが作られ、links の読み書きが往復できる。未設定の状態で `readSettings` を呼ぶと throw する
- **依存**: Task 2.1
- **推定時間**: 2h

#### Task 2.8: calendarGateway.ts / actionExecutor.ts

- [ ] `listFutureEvents`（全ページ）/ `insertEvent` / `patchEvent` / `removeEvent`（`sendUpdates:'none'`）
- [ ] `executeActions`（kind ごとの API 呼び出し、ログ（repair は WARN）、`ExecutionResult` を返す）
- **完了条件**: テスト用アカウントで、list の件数が Google カレンダーの UI と一致する。insert/patch/remove が 1 件ずつ成功する
- **依存**: Task 2.2, 2.7
- **推定時間**: 2h

#### Task 2.9: main.ts（sync / setup）

- [ ] `sync`: ロック → 設定と links の読み込み → 取得 → 分類 → 初回照合か通常同期か → 実行 → links の更新（変わったときだけ） → `finally` で flush と release
- [ ] `setup`: `ensureSheets` と、重複しないトリガー登録
- **完了条件**: `setup` を 2 回実行してもトリガーは 1 本のまま。`sync` を手動で実行してエラーが出ない
- **依存**: Task 2.5, 2.6, 2.8
- **推定時間**: 1.5h

### Phase 3: 検証・テスト（テスト用アカウントで行う）

#### Task 3.1: 初回照合のシナリオ

- [ ] 同じ時刻・同じタイトルの予定を、両方のカレンダーに用意する → 初回実行で両方に `srcUid` と `initialMatch` が付き、links に paired の行が 2 件できる
- [ ] 2 回目の実行で、そのペアに対する操作が 0 件であること
- [ ] ペアの片方を削除する → もう片方が削除されないこと
- [ ] `initialMatch` だけを手で消す → 次の実行で repair され、WARN が出て、削除されないこと
- **完了条件**: すべて期待どおりで、log シートの記録と実際の状態が一致する
- **依存**: Task 2.9
- **推定時間**: 1.5h

#### Task 3.2: 通常同期のシナリオ（S1〜S6）

- [ ] S1: Todoist でタスクを作る → primary に private かつ通知なしのミラーができる
- [ ] S2: 「Todoist」カレンダーでドラッグ・リネームする → ミラーが更新される
- [ ] S3: Todoist でタスクを削除する → ミラーが削除される
- [ ] S4: 別アカウントから会議を招待する → 複製ができ、タスク化される
- [ ] S5: 会議の時刻を変更する → 複製とタスクが更新される
- [ ] S6: 会議を削除する、または辞退する → 複製とタスクが削除される
- [ ] 繰り返し会議: 系列がコピーされること。1 回だけ変更しても何も起きず、エラーにもならないこと
- [ ] 勤務場所・不在の予定: 複製されないこと
- [ ] 同僚のアカウントから見て、ミラーが「予定あり」と表示されること
- **完了条件**: すべて期待どおりで、招待メールが 1 通も送られていない
- **依存**: Task 3.1
- **推定時間**: 2.5h

#### Task 3.3: 非機能・修復のシナリオ

- [ ] 差分がない状態で実行 → カレンダー・log・links のどれにも書き込みがない
- [ ] 同時実行: 手動実行とトリガー実行を重ねる → 片方がスキップされる
- [ ] 設定エラー: ID を空欄にする → throw され、失敗通知メールが届く
- [ ] 自己修復: ミラーを手で削除または改変する → 次回の実行で元に戻る
- [ ] srcUid の消失: C の `srcUid` を手で消す → repair され、WARN が出て、ミラーは作られない
- [ ] 1 時間放置 → 同じ uid に対して S2/S5/REPAIR が繰り返されていない
- **完了条件**: すべて期待どおり
- **依存**: Task 3.2
- **推定時間**: 2h

### Phase 4: 仕上げ

#### Task 4.1: README / 運用手順

- [ ] セットアップ手順（build → push → setup → settings の入力 → 失敗通知の設定）
- [ ] 既知の制約（design.md §10 の R1〜R6）と、初回照合をやり直す方法
- [ ] WARN（REPAIR）が出続けたときの確認方法
- **完了条件**: README の手順だけで、テスト用アカウントに再セットアップできる
- **依存**: Task 3.3
- **推定時間**: 1h

#### Task 4.2: 本番アカウントへの導入

- [ ] `setup` を実行して `settings` を入力し、初回照合の結果（INIT 行）をすぐに確認する
- [ ] 2 回目の実行で delete が出ていないことを確認してから、様子を見る
- **完了条件**: 本番で 1 日動かし、想定外の delete・重複・REPAIR の繰り返しがない
- **依存**: Task 4.1
- **推定時間**: 1h（＋ 1 日の観察）

## 実装順序

```
1.1 ───────────────┐
1.2 ─► 2.1 ─┬─ 2.2 ┴┬─ 2.4 ─ 2.5 ─┐
            ├─ 2.3 ─┘              │
            ├─ 2.6 ────────────────┼─ 2.9 ─ 3.1 ─ 3.2 ─ 3.3 ─ 4.1 ─ 4.2
            └─ 2.7 ─ 2.8 ──────────┘
```

## リスクと対策

| リスク | 対策 |
|---|---|
| 公式連携が `extendedProperties` を毎回消す（V1） | links から修復する。REPAIR が出続ける場合は、WARN ログで気づけるようにしている |
| 公式連携がイベントを作り直して `iCalUID` が変わる | 防げない（R5）。Task 1.1 で起きないことを確認する |
| 公式連携と S5 が書き換え合う（V2） | Task 1.1 で確認し、Task 3.3 で 1 時間放置して観察する |
| 初回照合の誤りで予定が消える | ペアは同期の対象外にし、回帰テストとテスト用アカウントで検証し、本番導入直後にも確認する |
| 初回実行が 6 分を超える | 途中で打ち切られても、次回に続きから反映される設計にしている |

## 注意事項

- 各タスクはコミット単位で完結させる
- タスクを完了したら `npm run lint`・`npm run typecheck`・`npm test` を実行する
- 本番の primary カレンダーでは、Phase 3 が終わるまで一切実行しない

## 実装開始ガイド

1. このタスクリストに従って、順に実装を進めてください
2. 各タスクの開始時に TodoWrite で in_progress に更新してください
3. 完了したら completed に更新してください
4. 問題が起きたら、すぐに報告してください
