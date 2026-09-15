/**
 * design.md §2.2 の linksRepository.ts ブロック / §0 D6 に記載された仕様どおりに実装する。
 * `links` シートの読み込みと全件の書き換えを担う。
 * GAS のグローバル（SpreadsheetApp）には、関数内からローカルの getSpreadsheet() 経由でのみアクセスする。
 * `src/config.ts` の定数と `src/types.ts` の型のみに依存する（design.md §2.1 の依存関係）。
 */
import { SHEET_LINKS } from './config';
import type { CalendarRole, LinkEntry, LinkKind } from './types';

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
};

export const LINKS_HEADER: ReadonlyArray<string> = ['calendar', 'iCalUID', 'srcUid', 'kind', 'recordedAt'];

const CALENDAR_ROLES: ReadonlyArray<CalendarRole> = ['primary', 'todoist'];
const LINK_KINDS: ReadonlyArray<LinkKind> = ['generated', 'paired'];

/**
 * 実行中の関数内でのみ呼び出すこと（モジュールのトップレベルでは呼ばない）。
 */
function getSpreadsheet(): SpreadsheetLike {
  return SpreadsheetApp.getActive();
}

function getLinksSheetOrThrow(): SheetLike {
  const sheet = getSpreadsheet().getSheetByName(SHEET_LINKS);
  if (!sheet) {
    throw new Error(`"${SHEET_LINKS}" シートが見つかりません。setup を実行してください。`);
  }
  return sheet;
}

function isCalendarRole(value: string): value is CalendarRole {
  return (CALENDAR_ROLES as ReadonlyArray<string>).includes(value);
}

function isLinkKind(value: string): value is LinkKind {
  return (LINK_KINDS as ReadonlyArray<string>).includes(value);
}

function parseRecordedAt(value: CellValue, rowNumber: number): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`links シートの ${rowNumber} 行目: recordedAt の日付が不正です。`);
    }
    return value;
  }
  const raw = String(value);
  const parsed = new Date(raw);
  if (raw.trim() === '' || Number.isNaN(parsed.getTime())) {
    throw new Error(`links シートの ${rowNumber} 行目: recordedAt "${raw}" は日付として解釈できません。`);
  }
  return parsed;
}

/**
 * links シートのヘッダ以下を読み込む。1 行でも不正なら、その行番号を含めて throw する。
 * ヘッダのみ（データ 0 件）なら空配列を返す。シートが無ければ throw する。
 */
export function readLinks(): LinkEntry[] {
  const sheet = getLinksSheetOrThrow();
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount <= 0) {
    return [];
  }

  const rows = sheet.getRange(2, 1, rowCount, 5).getValues();
  return rows.map((row, index) => {
    const rowNumber = index + 2; // ヘッダの次の行が 2 行目
    const [calendarRaw, iCalUIDRaw, srcUidRaw, kindRaw, recordedAtRaw] = row;

    const calendarValue = String(calendarRaw);
    if (!isCalendarRole(calendarValue)) {
      throw new Error(`links シートの ${rowNumber} 行目: calendar "${calendarValue}" は primary/todoist のいずれかにしてください。`);
    }

    const iCalUID = String(iCalUIDRaw).trim();
    if (iCalUID === '') {
      throw new Error(`links シートの ${rowNumber} 行目: iCalUID が空です。`);
    }

    const srcUid = String(srcUidRaw).trim();
    if (srcUid === '') {
      throw new Error(`links シートの ${rowNumber} 行目: srcUid が空です。`);
    }

    const kindValue = String(kindRaw);
    if (!isLinkKind(kindValue)) {
      throw new Error(`links シートの ${rowNumber} 行目: kind "${kindValue}" は generated/paired のいずれかにしてください。`);
    }

    const recordedAt = parseRecordedAt(recordedAtRaw, rowNumber);

    const entry: LinkEntry = { calendar: calendarValue, iCalUID, srcUid, kind: kindValue, recordedAt };
    return entry;
  });
}

/**
 * links シートのヘッダ以下を全件クリアしたうえで、entries を 1 回の setValues で書き込む。
 * シートが無ければ throw する。
 */
export function writeLinks(entries: ReadonlyArray<LinkEntry>): void {
  const sheet = getLinksSheetOrThrow();

  const staleRowCount = sheet.getLastRow() - 1;
  if (staleRowCount > 0) {
    sheet.getRange(2, 1, staleRowCount, 5).clearContent();
  }

  if (entries.length === 0) {
    return;
  }

  const rows = entries.map((entry) => [entry.calendar, entry.iCalUID, entry.srcUid, entry.kind, entry.recordedAt.toISOString()]);
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);
}
