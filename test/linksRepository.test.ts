import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLinks, writeLinks, LINKS_HEADER, type CellValue, type RangeLike, type SheetLike, type SpreadsheetLike } from '../src/linksRepository';
import type { LinkEntry } from '../src/types';

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
      // 実際の GAS の getLastRow は「内容がある最後の行」を返す。clearContent で末尾を
      // 空にした場合に、その行を含めないようにするため、末尾から内容のある行を探す。
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const hasContent = (rows[index] ?? []).some((cell) => cell !== '' && cell !== undefined);
        if (hasContent) {
          return index + 1;
        }
      }
      return 0;
    },
    getRange,
    snapshot(): CellValue[][] {
      return rows.map((row) => [...row]);
    },
  };
}

function stubSpreadsheet(sheets: Record<string, FakeSheet>): void {
  const spreadsheet: SpreadsheetLike = {
    getSheetByName(name: string): SheetLike | null {
      return sheets[name] ?? null;
    },
  };
  vi.stubGlobal('SpreadsheetApp', { getActive: () => spreadsheet });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readLinks', () => {
  it('throws when the links sheet is missing', () => {
    stubSpreadsheet({});

    expect(() => readLinks()).toThrow();
  });

  it('returns [] when only the header row exists', () => {
    stubSpreadsheet({ links: createFakeSheet([[...LINKS_HEADER]]) });

    expect(readLinks()).toEqual([]);
  });

  it('reads valid rows with an ISO string recordedAt', () => {
    stubSpreadsheet({
      links: createFakeSheet([
        [...LINKS_HEADER],
        ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
      ]),
    });

    expect(readLinks()).toEqual([
      { calendar: 'primary', iCalUID: 'uid-1', srcUid: 'src-1', kind: 'generated', recordedAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
  });

  it('reads valid rows with a Date recordedAt cell', () => {
    const date = new Date('2026-02-02T00:00:00.000Z');
    stubSpreadsheet({
      links: createFakeSheet([[...LINKS_HEADER], ['todoist', 'uid-2', 'src-2', 'paired', date]]),
    });

    const result = readLinks();
    expect(result).toHaveLength(1);
    expect(result[0].recordedAt.getTime()).toBe(date.getTime());
  });

  it('throws with the sheet row number when calendar is invalid', () => {
    stubSpreadsheet({
      links: createFakeSheet([
        [...LINKS_HEADER],
        ['other', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
      ]),
    });

    expect(() => readLinks()).toThrow(/2/);
  });

  it('throws with the sheet row number when kind is invalid', () => {
    stubSpreadsheet({
      links: createFakeSheet([
        [...LINKS_HEADER],
        ['primary', 'uid-1', 'src-1', 'bogus', '2026-01-01T00:00:00.000Z'],
      ]),
    });

    expect(() => readLinks()).toThrow(/2/);
  });

  it('throws when iCalUID is empty', () => {
    stubSpreadsheet({
      links: createFakeSheet([[...LINKS_HEADER], ['primary', '', 'src-1', 'generated', '2026-01-01T00:00:00.000Z']]),
    });

    expect(() => readLinks()).toThrow();
  });

  it('throws when srcUid is empty', () => {
    stubSpreadsheet({
      links: createFakeSheet([[...LINKS_HEADER], ['primary', 'uid-1', '', 'generated', '2026-01-01T00:00:00.000Z']]),
    });

    expect(() => readLinks()).toThrow();
  });

  it('throws when recordedAt is not a valid date', () => {
    stubSpreadsheet({
      links: createFakeSheet([[...LINKS_HEADER], ['primary', 'uid-1', 'src-1', 'generated', 'not-a-date']]),
    });

    expect(() => readLinks()).toThrow();
  });

  it('reports the correct row number for the second data row', () => {
    stubSpreadsheet({
      links: createFakeSheet([
        [...LINKS_HEADER],
        ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
        ['primary', 'uid-2', 'src-2', 'invalid-kind', '2026-01-01T00:00:00.000Z'],
      ]),
    });

    expect(() => readLinks()).toThrow(/3/);
  });

  describe('todoistTaskId column (P→T migration)', () => {
    it('throws a clear migration error when the sheet still has the old 5-column header', () => {
      stubSpreadsheet({
        links: createFakeSheet([
          ['calendar', 'iCalUID', 'srcUid', 'kind', 'recordedAt'],
          ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
        ]),
      });

      expect(() => readLinks()).toThrow(/todoistTaskId/);
    });

    it('reads a todoist/generated row with an empty iCalUID and a todoistTaskId', () => {
      stubSpreadsheet({
        links: createFakeSheet([
          [...LINKS_HEADER],
          ['todoist', '', 'src-1', 'generated', '2026-01-01T00:00:00.000Z', 'task-123'],
        ]),
      });

      expect(readLinks()).toEqual([
        {
          calendar: 'todoist',
          iCalUID: '',
          srcUid: 'src-1',
          kind: 'generated',
          recordedAt: new Date('2026-01-01T00:00:00.000Z'),
          todoistTaskId: 'task-123',
        },
      ]);
    });

    it('throws when a todoist/generated row has neither iCalUID nor todoistTaskId', () => {
      stubSpreadsheet({
        links: createFakeSheet([
          [...LINKS_HEADER],
          ['todoist', '', 'src-1', 'generated', '2026-01-01T00:00:00.000Z', ''],
        ]),
      });

      expect(() => readLinks()).toThrow(/todoistTaskId/);
    });

    it('reads a legacy todoist/generated row (old C copy) with an iCalUID and an empty todoistTaskId', () => {
      stubSpreadsheet({
        links: createFakeSheet([
          [...LINKS_HEADER],
          ['todoist', 'copy-uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z', ''],
        ]),
      });

      expect(readLinks()).toEqual([
        {
          calendar: 'todoist',
          iCalUID: 'copy-uid-1',
          srcUid: 'src-1',
          kind: 'generated',
          recordedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
    });

    it('throws when a todoist/generated row has both iCalUID and todoistTaskId', () => {
      stubSpreadsheet({
        links: createFakeSheet([
          [...LINKS_HEADER],
          ['todoist', 'copy-uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z', 'task-123'],
        ]),
      });

      expect(() => readLinks()).toThrow(/todoistTaskId/);
    });

    it('still requires iCalUID for a non-(todoist/generated) row even with the new header', () => {
      stubSpreadsheet({
        links: createFakeSheet([[...LINKS_HEADER], ['primary', '', 'src-1', 'generated', '2026-01-01T00:00:00.000Z', '']]),
      });

      expect(() => readLinks()).toThrow(/iCalUID/);
    });
  });
});

describe('writeLinks', () => {
  it('throws when the links sheet is missing', () => {
    stubSpreadsheet({});

    expect(() => writeLinks([])).toThrow();
  });

  it('round-trips entries written and then read back', () => {
    const sheet = createFakeSheet([[...LINKS_HEADER]]);
    stubSpreadsheet({ links: sheet });

    const entries: LinkEntry[] = [
      { calendar: 'primary', iCalUID: 'uid-1', srcUid: 'src-1', kind: 'generated', recordedAt: new Date('2026-01-01T00:00:00.000Z') },
      { calendar: 'todoist', iCalUID: 'uid-2', srcUid: 'src-2', kind: 'paired', recordedAt: new Date('2026-01-02T00:00:00.000Z') },
    ];

    writeLinks(entries);

    expect(readLinks()).toEqual(entries);
  });

  it('clears stale rows when writing fewer entries than before', () => {
    const sheet = createFakeSheet([
      [...LINKS_HEADER],
      ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
      ['primary', 'uid-2', 'src-2', 'generated', '2026-01-01T00:00:00.000Z'],
      ['primary', 'uid-3', 'src-3', 'generated', '2026-01-01T00:00:00.000Z'],
    ]);
    stubSpreadsheet({ links: sheet });

    writeLinks([
      { calendar: 'primary', iCalUID: 'uid-new', srcUid: 'src-new', kind: 'generated', recordedAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    expect(sheet.snapshot()).toEqual([
      [...LINKS_HEADER],
      ['primary', 'uid-new', 'src-new', 'generated', '2026-02-01T00:00:00.000Z', ''],
      ['', '', '', '', '', ''],
      ['', '', '', '', '', ''],
    ]);
    expect(readLinks()).toEqual([
      { calendar: 'primary', iCalUID: 'uid-new', srcUid: 'src-new', kind: 'generated', recordedAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);
  });

  it('writes nothing beyond clearing when entries is empty', () => {
    const sheet = createFakeSheet([
      [...LINKS_HEADER],
      ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
    ]);
    stubSpreadsheet({ links: sheet });

    writeLinks([]);

    expect(sheet.snapshot()).toEqual([[...LINKS_HEADER], ['', '', '', '', '', '']]);
    expect(readLinks()).toEqual([]);
  });
});

describe('writeLinks - atomic replacement', () => {
  it('throws on an invalid recordedAt without touching existing rows', () => {
    const initial: CellValue[][] = [
      [...LINKS_HEADER],
      ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
    ];
    const sheet = createFakeSheet(initial);
    stubSpreadsheet({ links: sheet });

    expect(() =>
      writeLinks([
        { calendar: 'todoist', iCalUID: 'uid-ok', srcUid: 'src-ok', kind: 'generated', recordedAt: new Date('2026-02-01T00:00:00.000Z') },
        { calendar: 'todoist', iCalUID: 'uid-bad', srcUid: 'src-bad', kind: 'generated', recordedAt: new Date('invalid') },
      ]),
    ).toThrow(/uid-bad/);
    expect(sheet.snapshot()).toEqual(initial);
  });

  it('writes the whole replacement range with a single setValues call', () => {
    const sheet = createFakeSheet([
      [...LINKS_HEADER],
      ['primary', 'uid-1', 'src-1', 'generated', '2026-01-01T00:00:00.000Z'],
      ['primary', 'uid-2', 'src-2', 'generated', '2026-01-01T00:00:00.000Z'],
    ]);
    const getRangeSpy = vi.spyOn(sheet, 'getRange');
    stubSpreadsheet({ links: sheet });

    writeLinks([
      { calendar: 'todoist', iCalUID: 'uid-new', srcUid: 'src-new', kind: 'paired', recordedAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    expect(getRangeSpy).toHaveBeenCalledTimes(1);
    expect(getRangeSpy).toHaveBeenCalledWith(2, 1, 2, LINKS_HEADER.length);
  });
});
