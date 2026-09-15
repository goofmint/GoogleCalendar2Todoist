# GoogleCalendar2Todoist

## セットアップ

### 前提条件

- Node.js
- `clasp login` でGoogleアカウントにログイン済みであること

### 手順

```bash
npm install
npm run build
npm run push
```

`npm run push` で `dist/` の内容がGoogle Apps Scriptプロジェクトへ送信されます。送信後、GASエディタで以下を行ってください。

1. GASエディタで `setup` 関数を選択して**手動で1回実行**する（初回はGoogleアカウントの認可を求められるので許可する）。これにより `settings` / `log` / `links` シートが作成され、`sync` を5分おきに実行する時間トリガーが登録されます（`setup` は何度実行してもトリガーが1本のままになります）。
2. `settings` シートの `todoistCalendarId` の行に、「Todoist」カレンダーのカレンダーIDを入力する。
3. 以降は時間トリガーにより `sync` が自動実行されます。

`settings` シートの `initialMatchDoneAt` を空欄に戻すと、次回の `sync` 実行で初回照合（既存の予定同士をペアリングする処理）がやり直されます。

### npm scripts

| スクリプト | 内容 |
|---|---|
| `npm run build` | TypeScriptを esbuild で `dist/Code.js` にバンドルし、`appsscript.json` を `dist/` にコピーする |
| `npm test` | Vitest で単体テストを実行する |
| `npm run lint` | ESLint でコードを検査する |
| `npm run typecheck` | `tsc --noEmit` で型チェックのみ行う |
| `npm run push` | `build` の後に `clasp push` でApps Scriptプロジェクトへ送信する |
