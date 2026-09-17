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

export const LINKS_HEADER: ReadonlyArray<string> = [
  'calendar',
  'iCalUID',
  'srcUid',
  'kind',
  'recordedAt',
  'todoistTaskId',
];

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

/**
 * links シートのヘッダー行が現行の LINKS_HEADER（todoistTaskId 列を含む 6 列）と一致するかを
 * 検証する。旧形式（5 列。todoistTaskId 列が無い）のシートは、ヘッダー文字列が一致しないため
 * ここで検出され、何を直せばよいかが分かる明確なメッセージで throw する（正しく読めているつもりで
 * 実は列がずれている、という事故を防ぐ。フォールバックや黙った読み替えはしない）。
 * ヘッダー行そのものが無い（まっさらなシート）場合は何もしない（setup 前の状態。呼び出し元で別途扱う）。
 */
function validateHeaderOrThrow(sheet: SheetLike): void {
  if (sheet.getLastRow() < 1) {
    return;
  }
  const headerRow = sheet
    .getRange(1, 1, 1, LINKS_HEADER.length)
    .getValues()[0]
    .map((value) => String(value));
  const matches =
    headerRow.length === LINKS_HEADER.length && LINKS_HEADER.every((header, index) => header === headerRow[index]);
  if (!matches) {
    throw new Error(
      `links シートのヘッダー行が現行の形式（${LINKS_HEADER.join(', ')}）と一致しません` +
        `（見つかった値: ${headerRow.join(', ')}）。` +
        'todoistTaskId 列が無い旧形式の links シートの可能性があります。' +
        'README の「links シートの移行手順」を確認し、F1 セルに "todoistTaskId" を追記してから再実行してください。',
    );
  }
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
  validateHeaderOrThrow(sheet);
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount <= 0) {
    return [];
  }

  const rows = sheet.getRange(2, 1, rowCount, LINKS_HEADER.length).getValues();
  return rows.map((row, index) => {
    const rowNumber = index + 2; // ヘッダの次の行が 2 行目
    const [calendarRaw, iCalUIDRaw, srcUidRaw, kindRaw, recordedAtRaw, todoistTaskIdRaw] = row;

    const calendarValue = String(calendarRaw);
    if (!isCalendarRole(calendarValue)) {
      throw new Error(`links シートの ${rowNumber} 行目: calendar "${calendarValue}" は primary/todoist のいずれかにしてください。`);
    }

    const kindValue = String(kindRaw);
    if (!isLinkKind(kindValue)) {
      throw new Error(`links シートの ${rowNumber} 行目: kind "${kindValue}" は generated/paired のいずれかにしてください。`);
    }

    // todoist の generated 行には 2 種類ある。
    //   - Todoist タスク由来の行: iCalUID 空欄・todoistTaskId あり
    //   - 旧経路の C 複製の行（移行前から残る行。cleanupLegacyTodoistCopies が削除する）: iCalUID あり・todoistTaskId 空欄
    // どちらか一方だけを持つことを必須にする。それ以外（primary/paired）は従来どおり iCalUID を必須にする。
    const isTodoistGenerated = calendarValue === 'todoist' && kindValue === 'generated';

    const iCalUID = String(iCalUIDRaw).trim();
    if (!isTodoistGenerated && iCalUID === '') {
      throw new Error(`links シートの ${rowNumber} 行目: iCalUID が空です。`);
    }

    const srcUid = String(srcUidRaw).trim();
    if (srcUid === '') {
      throw new Error(`links シートの ${rowNumber} 行目: srcUid が空です。`);
    }

    const todoistTaskId = String(todoistTaskIdRaw).trim();
    if (isTodoistGenerated && (iCalUID === '') === (todoistTaskId === '')) {
      throw new Error(
        `links シートの ${rowNumber} 行目: todoist の generated 行には iCalUID（旧経路の複製）と todoistTaskId（タスク）のどちらか一方だけを入れてください。`,
      );
    }

    const recordedAt = parseRecordedAt(recordedAtRaw, rowNumber);

    const entry: LinkEntry = { calendar: calendarValue, iCalUID, srcUid, kind: kindValue, recordedAt };
    if (todoistTaskId !== '') {
      entry.todoistTaskId = todoistTaskId;
    }
    return entry;
  });
}

/**
 * links シートのヘッダ以下を entries で置き換える。
 * 書き込む行をすべて組み立て・検証してからシートに触れるため、途中で throw しても既存の行は失われない。
 * 置き換え範囲（新しい行数と既存の行数の大きいほう）を 1 回の setValues で書き、余った行は空文字で埋める。
 * シートが無ければ throw する。
 */
export function writeLinks(entries: ReadonlyArray<LinkEntry>): void {
  const sheet = getLinksSheetOrThrow();

  const rows: CellValue[][] = entries.map((entry) => {
    if (Number.isNaN(entry.recordedAt.getTime())) {
      throw new Error(`links に書き込む行の recordedAt が不正です (calendar=${entry.calendar}, iCalUID=${entry.iCalUID})。`);
    }
    return [
      entry.calendar,
      entry.iCalUID,
      entry.srcUid,
      entry.kind,
      entry.recordedAt.toISOString(),
      entry.todoistTaskId === undefined ? '' : entry.todoistTaskId,
    ];
  });

  const existingRowCount = Math.max(sheet.getLastRow() - 1, 0);
  const totalRowCount = Math.max(rows.length, existingRowCount);
  if (totalRowCount === 0) {
    return;
  }

  const blankRow: CellValue[] = LINKS_HEADER.map(() => '');
  const paddedRows = [...rows];
  while (paddedRows.length < totalRowCount) {
    paddedRows.push([...blankRow]);
  }
  sheet.getRange(2, 1, totalRowCount, LINKS_HEADER.length).setValues(paddedRows);
}
