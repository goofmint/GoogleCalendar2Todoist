/**
 * design.md §2.2 の logger.ts ブロックに記載された仕様どおりに実装する。
 * ログをメモリに溜め、`log` シートへ一括で追記する。
 * GAS のグローバル（SpreadsheetApp）には、関数内からローカルの getSpreadsheet() 経由でのみアクセスする。
 * `src/config.ts` の定数と `src/types.ts` の型のみに依存する（design.md §2.1 の依存関係）。
 */
import { SHEET_LOG } from './config';
import type { Direction, LogLevel } from './types';

/**
 * スプレッドシートのセルに入りうる値。GAS の Range#setValues が扱う型のうち、
 * このリポジトリが実際に書き込む範囲だけを narrow に表現したもの。
 */
export type CellValue = string | number | boolean | Date;

/**
 * `GoogleAppsScript.Spreadsheet.Range` の構造的部分型。
 */
export type RangeLike = {
  setValues(values: ReadonlyArray<ReadonlyArray<CellValue>>): void;
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

export const LOG_HEADER: ReadonlyArray<string> = ['ts', 'level', 'direction', 'uid', 'message'];

export type Logger = {
  info(direction: Direction, uid: string, message: string): void;
  warn(direction: Direction, uid: string, message: string): void;
  flush(): void; // 溜まった件数が 0 ならシートにアクセスしない
};

type BufferedLogRow = { ts: Date; level: LogLevel; direction: Direction; uid: string; message: string };

/**
 * 実行中の関数内でのみ呼び出すこと（モジュールのトップレベルでは呼ばない）。
 */
function getSpreadsheet(): SpreadsheetLike {
  return SpreadsheetApp.getActive();
}

/**
 * ログをメモリに溜めるロガーを作る。`flush()` を呼ぶまでシートには書き込まれない。
 */
export function createLogger(): Logger {
  const buffer: BufferedLogRow[] = [];

  function record(level: LogLevel, direction: Direction, uid: string, message: string): void {
    buffer.push({ ts: new Date(), level, direction, uid, message });
  }

  return {
    info(direction: Direction, uid: string, message: string): void {
      record('INFO', direction, uid, message);
    },
    warn(direction: Direction, uid: string, message: string): void {
      record('WARN', direction, uid, message);
    },
    flush(): void {
      if (buffer.length === 0) {
        return; // 0 件のときは SpreadsheetApp に触れない
      }

      const sheet = getSpreadsheet().getSheetByName(SHEET_LOG);
      if (!sheet) {
        throw new Error(`"${SHEET_LOG}" シートが見つかりません。setup を実行してください。`);
      }

      const rows = buffer.map((row) => [row.ts.toISOString(), row.level, row.direction, row.uid, row.message]);
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
      buffer.length = 0;
    },
  };
}
