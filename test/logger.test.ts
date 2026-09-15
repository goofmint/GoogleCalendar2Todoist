import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, LOG_HEADER, type CellValue, type RangeLike, type SheetLike } from '../src/logger';

type FakeSheet = SheetLike & { snapshot(): CellValue[][] };

function createFakeSheet(initialRows: ReadonlyArray<ReadonlyArray<CellValue>> = []): FakeSheet {
  const rows: CellValue[][] = initialRows.map((row) => [...row]);

  function getRange(row: number, column: number, numRows: number, numColumns: number): RangeLike {
    return {
      setValues(values: ReadonlyArray<ReadonlyArray<CellValue>>): void {
        if (values.length !== numRows || (values[0]?.length ?? numColumns) !== numColumns) {
          throw new Error('setValues called with a shape different from the getRange call');
        }
        values.forEach((line, r) => {
          const rowIndex = row - 1 + r;
          while (rows.length <= rowIndex) {
            rows.push([]);
          }
          line.forEach((value, c) => {
            rows[rowIndex][column - 1 + c] = value;
          });
        });
      },
    };
  }

  return {
    getLastRow(): number {
      return rows.length;
    },
    getRange,
    snapshot(): CellValue[][] {
      return rows.map((row) => [...row]);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLogger', () => {
  it('does not call SpreadsheetApp.getActive when flush() runs with 0 buffered entries', () => {
    const getActive = vi.fn(() => {
      throw new Error('SpreadsheetApp.getActive should not be called for an empty buffer');
    });
    vi.stubGlobal('SpreadsheetApp', { getActive });

    const logger = createLogger();
    logger.flush();

    expect(getActive).not.toHaveBeenCalled();
  });

  it('flushes buffered info/warn entries with one setValues call, then a second flush writes nothing', () => {
    const sheet = createFakeSheet([[...LOG_HEADER]]);
    const getActive = vi.fn(() => ({
      getSheetByName: (name: string): SheetLike | null => (name === 'log' ? sheet : null),
    }));
    vi.stubGlobal('SpreadsheetApp', { getActive });

    const logger = createLogger();
    logger.info('T→P', 'uid-1', 'created mirror');
    logger.warn('REPAIR', 'uid-2', 'srcUid missing, repaired');

    logger.flush();

    const snapshot = sheet.snapshot();
    expect(snapshot).toHaveLength(3); // header + 2 entries
    expect(snapshot[1][1]).toBe('INFO');
    expect(snapshot[1][2]).toBe('T→P');
    expect(snapshot[1][3]).toBe('uid-1');
    expect(snapshot[1][4]).toBe('created mirror');
    expect(snapshot[2][1]).toBe('WARN');
    expect(snapshot[2][2]).toBe('REPAIR');
    expect(snapshot[2][3]).toBe('uid-2');
    expect(snapshot[2][4]).toBe('srcUid missing, repaired');
    expect(typeof snapshot[1][0]).toBe('string'); // ts はISO文字列で書かれる
    expect(() => new Date(String(snapshot[1][0])).toISOString()).not.toThrow();

    // 2 回目の flush はバッファが空なので、何も追記しない
    getActive.mockClear();
    logger.flush();
    expect(getActive).not.toHaveBeenCalled();
    expect(sheet.snapshot()).toEqual(snapshot);
  });

  it('throws when the log sheet is missing and the buffer is non-empty', () => {
    const getActive = vi.fn(() => ({
      getSheetByName: (): SheetLike | null => null,
    }));
    vi.stubGlobal('SpreadsheetApp', { getActive });

    const logger = createLogger();
    logger.info('INIT', 'uid-1', 'message');

    expect(() => logger.flush()).toThrow();
  });
});
