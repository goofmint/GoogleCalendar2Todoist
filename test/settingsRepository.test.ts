import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSheets,
  markInitialMatchDone,
  readSettings,
  LINKS_HEADER,
  LOG_HEADER,
  SETTINGS_HEADER,
  type CellValue,
  type RangeLike,
  type SheetLike,
  type SpreadsheetLike,
} from '../src/settingsRepository';

type FakeSheet = SheetLike & { snapshot(): CellValue[][] };

function createFakeSheet(initialRows: ReadonlyArray<ReadonlyArray<CellValue>> = []): FakeSheet {
  const rows: CellValue[][] = initialRows.map((row) => [...row]);

  function getRange(row: number, column: number, numRows: number, numColumns: number): RangeLike {
    return {
      getValues(): CellValue[][] {
        const out: CellValue[][] = [];
        for (let r = 0; r < numRows; r += 1) {
          const source = rows[row - 1 + r] ?? [];
          const line: CellValue[] = [];
          for (let c = 0; c < numColumns; c += 1) {
            line.push(source[column - 1 + c] ?? '');
          }
          out.push(line);
        }
        return out;
      },
      setValues(values: ReadonlyArray<ReadonlyArray<CellValue>>): void {
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
      clearContent(): void {
        for (let r = 0; r < numRows; r += 1) {
          const rowIndex = row - 1 + r;
          if (rows[rowIndex]) {
            for (let c = 0; c < numColumns; c += 1) {
              rows[rowIndex][column - 1 + c] = '';
            }
          }
        }
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

function createFakeSpreadsheet(initial: Record<string, FakeSheet> = {}): SpreadsheetLike & { sheets: Record<string, FakeSheet> } {
  const sheets: Record<string, FakeSheet> = { ...initial };
  return {
    sheets,
    getSheetByName(name: string): SheetLike | null {
      return sheets[name] ?? null;
    },
    insertSheet(name: string): SheetLike {
      const sheet = createFakeSheet();
      sheets[name] = sheet;
      return sheet;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureSheets', () => {
  it('creates settings/log/links sheets with headers and required key rows when nothing exists', () => {
    const spreadsheet = createFakeSpreadsheet();
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });

    ensureSheets();

    expect(spreadsheet.sheets.settings.snapshot()).toEqual([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', ''],
      ['initialMatchDoneAt', ''],
    ]);
    expect(spreadsheet.sheets.log.snapshot()).toEqual([[...LOG_HEADER]]);
    expect(spreadsheet.sheets.links.snapshot()).toEqual([[...LINKS_HEADER]]);
  });

  it('does not touch sheets or rows that already exist (idempotent)', () => {
    const settingsSheet = createFakeSheet([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', 'cal-1'],
      ['initialMatchDoneAt', '2026-01-01T00:00:00.000Z'],
    ]);
    const logSheet = createFakeSheet([[...LOG_HEADER], ['2026-01-01T00:00:00.000Z', 'INFO', 'INIT', 'uid', 'msg']]);
    const linksSheet = createFakeSheet([[...LINKS_HEADER]]);
    const spreadsheet = createFakeSpreadsheet({ settings: settingsSheet, log: logSheet, links: linksSheet });
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });

    ensureSheets();
    ensureSheets();

    expect(spreadsheet.sheets.settings.snapshot()).toEqual([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', 'cal-1'],
      ['initialMatchDoneAt', '2026-01-01T00:00:00.000Z'],
    ]);
    expect(spreadsheet.sheets.log.snapshot()).toEqual([
      [...LOG_HEADER],
      ['2026-01-01T00:00:00.000Z', 'INFO', 'INIT', 'uid', 'msg'],
    ]);
    expect(spreadsheet.sheets.links.snapshot()).toEqual([[...LINKS_HEADER]]);
  });

  it('adds only the missing required key row when one of the two already exists', () => {
    const settingsSheet = createFakeSheet([[...SETTINGS_HEADER], ['todoistCalendarId', 'cal-1']]);
    const spreadsheet = createFakeSpreadsheet({
      settings: settingsSheet,
      log: createFakeSheet([[...LOG_HEADER]]),
      links: createFakeSheet([[...LINKS_HEADER]]),
    });
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });

    ensureSheets();

    expect(spreadsheet.sheets.settings.snapshot()).toEqual([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', 'cal-1'],
      ['initialMatchDoneAt', ''],
    ]);
  });
});

describe('readSettings', () => {
  function stubSpreadsheetWithSettings(rows: ReadonlyArray<ReadonlyArray<CellValue>> | null): void {
    const sheets: Record<string, FakeSheet> = {};
    if (rows !== null) {
      sheets.settings = createFakeSheet(rows);
    }
    const spreadsheet = createFakeSpreadsheet(sheets);
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });
  }

  it('reads todoistCalendarId and initialMatchDoneAt (string cell) when both are present', () => {
    stubSpreadsheetWithSettings([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', 'cal-1'],
      ['initialMatchDoneAt', '2026-01-01T00:00:00.000Z'],
    ]);

    expect(readSettings()).toEqual({ todoistCalendarId: 'cal-1', initialMatchDoneAt: '2026-01-01T00:00:00.000Z' });
  });

  it('converts a Date cell for initialMatchDoneAt to an ISO string', () => {
    const date = new Date('2026-02-02T03:04:05.000Z');
    stubSpreadsheetWithSettings([[...SETTINGS_HEADER], ['todoistCalendarId', 'cal-1'], ['initialMatchDoneAt', date]]);

    expect(readSettings().initialMatchDoneAt).toBe(date.toISOString());
  });

  it('returns null for initialMatchDoneAt when the row is absent', () => {
    stubSpreadsheetWithSettings([[...SETTINGS_HEADER], ['todoistCalendarId', 'cal-1']]);

    expect(readSettings().initialMatchDoneAt).toBeNull();
  });

  it('returns null for initialMatchDoneAt when the cell is empty', () => {
    stubSpreadsheetWithSettings([[...SETTINGS_HEADER], ['todoistCalendarId', 'cal-1'], ['initialMatchDoneAt', '']]);

    expect(readSettings().initialMatchDoneAt).toBeNull();
  });

  it('throws when the settings sheet is missing', () => {
    stubSpreadsheetWithSettings(null);

    expect(() => readSettings()).toThrow();
  });

  it('throws when the todoistCalendarId row is missing', () => {
    stubSpreadsheetWithSettings([[...SETTINGS_HEADER], ['initialMatchDoneAt', '']]);

    expect(() => readSettings()).toThrow();
  });

  it('throws when todoistCalendarId is empty', () => {
    stubSpreadsheetWithSettings([[...SETTINGS_HEADER], ['todoistCalendarId', '   ']]);

    expect(() => readSettings()).toThrow();
  });

  it('throws when todoistCalendarId equals PRIMARY_CALENDAR_ID', () => {
    stubSpreadsheetWithSettings([[...SETTINGS_HEADER], ['todoistCalendarId', 'primary']]);

    expect(() => readSettings()).toThrow();
  });
});

describe('markInitialMatchDone', () => {
  it('writes at.toISOString() into the initialMatchDoneAt row value', () => {
    const settingsSheet = createFakeSheet([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', 'cal-1'],
      ['initialMatchDoneAt', ''],
    ]);
    const spreadsheet = createFakeSpreadsheet({ settings: settingsSheet });
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });

    const at = new Date('2026-03-03T00:00:00.000Z');
    markInitialMatchDone(at);

    expect(settingsSheet.snapshot()).toEqual([
      [...SETTINGS_HEADER],
      ['todoistCalendarId', 'cal-1'],
      ['initialMatchDoneAt', at.toISOString()],
    ]);
  });

  it('throws when the settings sheet is missing', () => {
    const spreadsheet = createFakeSpreadsheet({});
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });

    expect(() => markInitialMatchDone(new Date())).toThrow();
  });

  it('throws when the initialMatchDoneAt row is missing', () => {
    const settingsSheet = createFakeSheet([[...SETTINGS_HEADER], ['todoistCalendarId', 'cal-1']]);
    const spreadsheet = createFakeSpreadsheet({ settings: settingsSheet });
    vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });

    expect(() => markInitialMatchDone(new Date())).toThrow();
  });
});
