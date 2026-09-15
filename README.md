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

`npm run push` で `dist/` の内容がGoogle Apps Scriptプロジェクトへ送信されます。送信後、GASエディタを開き、`setup` 関数を手動で1回実行してください（シートの作成とトリガーの登録を行います）。

その後、`settings` シートに `todoistCalendarId` などの必要な値を入力してください（詳細は後続タスクを参照）。

### npm scripts

| スクリプト | 内容 |
|---|---|
| `npm run build` | TypeScriptを esbuild で `dist/Code.js` にバンドルし、`appsscript.json` を `dist/` にコピーする |
| `npm test` | Vitest で単体テストを実行する |
| `npm run lint` | ESLint でコードを検査する |
| `npm run typecheck` | `tsc --noEmit` で型チェックのみ行う |
| `npm run push` | `build` の後に `clasp push` でApps Scriptプロジェクトへ送信する |
