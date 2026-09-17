/**
 * design.md §2.2 の settingsRepository.ts ブロックに記載された仕様どおりに実装する。
 * `settings` / `log` / `links` シートの初期化（ensureSheets）と、`settings` シートの読み書きを担う。
 * GAS のグローバル（SpreadsheetApp）には、関数内からローカルの getSpreadsheet() 経由でのみアクセスする。
 * `src/config.ts` の定数と `src/types.ts` の型のみに依存する（design.md §2.1 の依存関係）。
 */
import {
  SHEET_SETTINGS,
  SHEET_LOG,
  SHEET_LINKS,
  SETTING_KEY_TODOIST_CALENDAR_ID,
  SETTING_KEY_INITIAL_MATCH_DONE_AT,
  PRIMARY_CALENDAR_ID,
} from './config';
import type { Settings } from './types';

/**
 * スプレッドシートのセルに入りうる値。GAS の Range#getValues/setValues が扱う型のうち、
 * このリポジトリが実際に読み書きする範囲だけを narrow に表現したもの。
 */
export type CellValue = string | number | boolean | Date;

/**
 * `GoogleAppsScript.Spreadsheet.Range` の構造的部分型。
 * 実際の Range はこれを満たすため、キャストなしで代入できる。
 */
export type RangeLike = {
  getValues(): CellValue[][];
  setValues(values: ReadonlyArray<ReadonlyArray<CellValue>>): void;
  clearContent(): void;
};

/**
 * `GoogleAppsScript.Spreadsheet.Sheet` の構造的部分型。
 */
export type SheetLike = {
  getLastRow(): number;
  getRange(row: number, column: number, numRows: number, numColumns: number): RangeLike;
};

/**
 * `GoogleAppsScript.Spreadsheet.Spreadsheet` の構造的部分型。
 */
export type SpreadsheetLike = {
  getSheetByName(name: string): SheetLike | null;
  insertSheet(name: string): SheetLike;
};

export const SETTINGS_HEADER: ReadonlyArray<string> = ['key', 'value'];
export const LOG_HEADER: ReadonlyArray<string> = ['ts', 'level', 'direction', 'uid', 'message'];
export const LINKS_HEADER: ReadonlyArray<string> = [
  'calendar',
  'iCalUID',
  'srcUid',
  'kind',
  'recordedAt',
  'todoistTaskId',
];

const REQUIRED_SETTINGS_KEYS: ReadonlyArray<string> = [
  SETTING_KEY_TODOIST_CALENDAR_ID,
  SETTING_KEY_INITIAL_MATCH_DONE_AT,
];

/**
 * 実行中の関数内でのみ呼び出すこと（モジュールのトップレベルでは呼ばない）。
 * `GoogleAppsScript.Spreadsheet.Spreadsheet` は構造的に `SpreadsheetLike` を満たすため、
 * キャストなしでそのまま返せる。
 */
function getSpreadsheet(): SpreadsheetLike {
  return SpreadsheetApp.getActive();
}

function getOrCreateSheet(spreadsheet: SpreadsheetLike, name: string): SheetLike {
  const existing = spreadsheet.getSheetByName(name);
  if (existing) {
    return existing;
  }
  return spreadsheet.insertSheet(name);
}

function writeHeaderIfEmpty(sheet: SheetLike, header: ReadonlyArray<string>): void {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function readSettingsKeys(sheet: SheetLike): Set<string> {
  const rowCount = sheet.getLastRow() - 1;
  const keys = new Set<string>();
  if (rowCount <= 0) {
    return keys;
  }
  const values = sheet.getRange(2, 1, rowCount, 2).getValues();
  for (const row of values) {
    keys.add(String(row[0]));
  }
  return keys;
}

function ensureSettingsKeyRows(sheet: SheetLike): void {
  const existingKeys = readSettingsKeys(sheet);
  const missingKeys = REQUIRED_SETTINGS_KEYS.filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return;
  }
  const startRow = sheet.getLastRow() + 1;
  const rows = missingKeys.map((key) => [key, '']);
  sheet.getRange(startRow, 1, rows.length, 2).setValues(rows);
}

/**
 * `setup` から呼ばれる。settings/log/links シートが無ければ作り、空ならヘッダ行を書く。
 * settings シートには、`todoistCalendarId` / `initialMatchDoneAt` の行が無ければ空値で追加する。
 * 何度呼んでも結果が変わらない（idempotent）。
 */
export function ensureSheets(): void {
  const spreadsheet = getSpreadsheet();

  const settingsSheet = getOrCreateSheet(spreadsheet, SHEET_SETTINGS);
  writeHeaderIfEmpty(settingsSheet, SETTINGS_HEADER);
  ensureSettingsKeyRows(settingsSheet);

  const logSheet = getOrCreateSheet(spreadsheet, SHEET_LOG);
  writeHeaderIfEmpty(logSheet, LOG_HEADER);

  const linksSheet = getOrCreateSheet(spreadsheet, SHEET_LINKS);
  writeHeaderIfEmpty(linksSheet, LINKS_HEADER);
}

function findSettingsRow(sheet: SheetLike, key: string): number | null {
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount <= 0) {
    return null;
  }
  const values = sheet.getRange(2, 1, rowCount, 2).getValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === key) {
      return index + 2; // ヘッダの次の行が 2 行目
    }
  }
  return null;
}

function getSettingsSheetOrThrow(): SheetLike {
  const sheet = getSpreadsheet().getSheetByName(SHEET_SETTINGS);
  if (!sheet) {
    throw new Error(`"${SHEET_SETTINGS}" シートが見つかりません。setup を実行してください。`);
  }
  return sheet;
}

function normalizeInitialMatchDoneAt(raw: CellValue | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (String(raw).trim() === '') {
    return null;
  }
  return String(raw);
}

/**
 * settings シートを読み込む。`todoistCalendarId` が無い・空・`primary` の場合は throw する。
 * デフォルト値で補うことはしない。
 */
export function readSettings(): Settings {
  const sheet = getSettingsSheetOrThrow();
  const rowNumber = findSettingsRow(sheet, SETTING_KEY_TODOIST_CALENDAR_ID);
  if (rowNumber === null) {
    throw new Error(`"${SETTING_KEY_TODOIST_CALENDAR_ID}" の行が settings シートにありません。`);
  }
  const todoistCalendarIdRaw = sheet.getRange(rowNumber, 2, 1, 1).getValues()[0][0];
  const todoistCalendarId = String(todoistCalendarIdRaw).trim();
  if (todoistCalendarId === '') {
    throw new Error(`"${SETTING_KEY_TODOIST_CALENDAR_ID}" の値が空です。`);
  }
  if (todoistCalendarId === PRIMARY_CALENDAR_ID) {
    throw new Error(`"${SETTING_KEY_TODOIST_CALENDAR_ID}" に "${PRIMARY_CALENDAR_ID}" を指定することはできません。`);
  }

  const initialMatchDoneAtRow = findSettingsRow(sheet, SETTING_KEY_INITIAL_MATCH_DONE_AT);
  const initialMatchDoneAtRaw =
    initialMatchDoneAtRow === null ? undefined : sheet.getRange(initialMatchDoneAtRow, 2, 1, 1).getValues()[0][0];
  const initialMatchDoneAt = normalizeInitialMatchDoneAt(initialMatchDoneAtRaw);

  return { todoistCalendarId, initialMatchDoneAt };
}

/**
 * `initialMatchDoneAt` の行に `at.toISOString()` を書き込む。
 * シートまたは行が無ければ throw する（自動で作らない）。
 */
export function markInitialMatchDone(at: Date): void {
  const sheet = getSettingsSheetOrThrow();
  const rowNumber = findSettingsRow(sheet, SETTING_KEY_INITIAL_MATCH_DONE_AT);
  if (rowNumber === null) {
    throw new Error(`"${SETTING_KEY_INITIAL_MATCH_DONE_AT}" の行が settings シートにありません。`);
  }
  sheet.getRange(rowNumber, 2, 1, 1).setValues([[at.toISOString()]]);
}
