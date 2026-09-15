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

`npm run push` で `dist/` の内容がGoogle Apps Scriptプロジェクトへ送信されます。送信後、GASエディタで `sync` / `setup` 関数が選択できることを確認してください。

> **注意**: 現時点の `setup` と `sync` は空の雛形です。シートの作成・トリガーの登録・同期処理は Task 2.9（#11）で実装されるまで行われません。

Task 2.9 の実装後は、GASエディタで `setup` 関数を手動で1回実行し（シートの作成とトリガーの登録）、`settings` シートに `todoistCalendarId` を入力してください。

### npm scripts

| スクリプト | 内容 |
|---|---|
| `npm run build` | TypeScriptを esbuild で `dist/Code.js` にバンドルし、`appsscript.json` を `dist/` にコピーする |
| `npm test` | Vitest で単体テストを実行する |
| `npm run lint` | ESLint でコードを検査する |
| `npm run typecheck` | `tsc --noEmit` で型チェックのみ行う |
| `npm run push` | `build` の後に `clasp push` でApps Scriptプロジェクトへ送信する |
