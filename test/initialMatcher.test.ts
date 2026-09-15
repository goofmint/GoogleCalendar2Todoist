import { describe, expect, it } from 'vitest';
import { planInitialMatch } from '../src/initialMatcher';
import { contentKeyForInitialMatch, buildMarkResource } from '../src/eventContent';
import { classify } from '../src/eventClassifier';
import { planSync } from '../src/syncPlanner';
import type { CalendarEvent, SyncAction } from '../src/types';

let sequence = 0;

function nextICalUID(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}@example.com`;
}

type EventOptions = {
  iCalUID?: string;
  summary?: string;
  start?: GoogleAppsScript.Calendar.Schema.EventDateTime;
  end?: GoogleAppsScript.Calendar.Schema.EventDateTime;
};

/**
 * iCalUID / summary / start（/ end）を指定して CalendarEvent を組み立てる。
 * iCalUID を省略すると連番の一意な値になる。
 */
function buildEvent(options: EventOptions = {}): CalendarEvent {
  return {
    iCalUID: options.iCalUID ?? nextICalUID('ical'),
    summary: options.summary ?? 'Meeting',
    start: options.start ?? { dateTime: '2026-09-15T10:00:00+09:00' },
    end: options.end ?? { dateTime: '2026-09-15T11:00:00+09:00' },
  };
}

/**
 * iCalUID を持たない CalendarEvent を組み立てる（missing iCalUID のテスト専用）。
 */
function buildEventWithoutICalUID(options: Omit<EventOptions, 'iCalUID'> = {}): CalendarEvent {
  const event: CalendarEvent = {
    summary: options.summary ?? 'Meeting',
    start: options.start ?? { dateTime: '2026-09-15T10:00:00+09:00' },
    end: options.end ?? { dateTime: '2026-09-15T11:00:00+09:00' },
  };
  return event;
}

type MarkAction = Extract<SyncAction, { kind: 'mark' }>;

function isMarkAction(action: SyncAction): action is MarkAction {
  return action.kind === 'mark';
}

/**
 * mark アクションを対象イベントのコピーへ適用する。
 * buildMarkResource(srcUid).extendedProperties.private を、既存の private プロパティに
 * マージした新しいイベントを返す（回帰テスト用。入力イベントは変更しない）。
 */
function applyMark(event: CalendarEvent, mark: MarkAction): CalendarEvent {
  const markPrivate = buildMarkResource(mark.srcUid).extendedProperties?.private ?? {};
  return {
    ...event,
    extendedProperties: {
      ...event.extendedProperties,
      private: {
        ...event.extendedProperties?.private,
        ...markPrivate,
      },
    },
  };
}

// テスト内での意図しない書き込みを検出するための deep freeze。
// `any` / `unknown` を使わず、object 制約だけで再帰する。
function deepFreeze<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    const child = value[key];
    if (child !== null && typeof child === 'object') {
      deepFreeze(child as object);
    }
  }
  return Object.freeze(value);
}

describe('planInitialMatch: pairing', () => {
  it('pairs a single T event with a single N event sharing the same start+summary key', () => {
    const a = buildEvent();
    const b = buildEvent();
    const result = planInitialMatch([a], [b]);

    expect(result.ambiguousKeys).toEqual([]);
    expect(result.actions).toEqual([
      { kind: 'mark', rule: 'INIT', direction: 'INIT', calendar: 'todoist', target: a, srcUid: b.iCalUID },
      { kind: 'mark', rule: 'INIT', direction: 'INIT', calendar: 'primary', target: b, srcUid: a.iCalUID },
    ]);
  });

  it('pairs events whose start differs only by +09:00 vs Z offset notation (same instant)', () => {
    const a = buildEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00' },
      end: { dateTime: '2026-09-15T11:00:00+09:00' },
    });
    const b = buildEvent({
      start: { dateTime: '2026-09-15T01:00:00Z' },
      end: { dateTime: '2026-09-15T02:00:00Z' },
    });
    const result = planInitialMatch([a], [b]);

    expect(result.ambiguousKeys).toEqual([]);
    expect(result.actions).toHaveLength(2);
    expect(result.actions).toEqual([
      { kind: 'mark', rule: 'INIT', direction: 'INIT', calendar: 'todoist', target: a, srcUid: b.iCalUID },
      { kind: 'mark', rule: 'INIT', direction: 'INIT', calendar: 'primary', target: b, srcUid: a.iCalUID },
    ]);
  });

  it('does not pair when summary differs', () => {
    const a = buildEvent({ summary: 'Meeting A' });
    const b = buildEvent({ summary: 'Meeting B' });
    const result = planInitialMatch([a], [b]);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([]);
  });

  it('does not pair when start differs', () => {
    const a = buildEvent({ start: { dateTime: '2026-09-15T10:00:00+09:00' } });
    const b = buildEvent({ start: { dateTime: '2026-09-16T10:00:00+09:00' } });
    const result = planInitialMatch([a], [b]);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([]);
  });

  it('does not pair an all-day event with a timed event on the same date', () => {
    const a = buildEvent({ start: { date: '2026-09-15' }, end: { date: '2026-09-16' } });
    const b = buildEvent({
      start: { dateTime: '2026-09-15T00:00:00+09:00' },
      end: { dateTime: '2026-09-15T01:00:00+09:00' },
    });
    const result = planInitialMatch([a], [b]);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([]);
  });
});

describe('planInitialMatch: ambiguous keys', () => {
  it('does not pair when T has 2 events and N has 1 event for the same key; records the key as ambiguous', () => {
    const t1 = buildEvent({ summary: 'Dup' });
    const t2 = buildEvent({ summary: 'Dup' });
    const n1 = buildEvent({ summary: 'Dup' });
    const key = contentKeyForInitialMatch(t1);

    const result = planInitialMatch([t1, t2], [n1]);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([key]);
  });

  it('does not pair when N has 2 events and T has 1 event for the same key; records the key as ambiguous', () => {
    const t1 = buildEvent({ summary: 'Dup' });
    const n1 = buildEvent({ summary: 'Dup' });
    const n2 = buildEvent({ summary: 'Dup' });
    const key = contentKeyForInitialMatch(t1);

    const result = planInitialMatch([t1], [n1, n2]);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([key]);
  });

  it('ignores a key present on only one side (not ambiguous)', () => {
    const t1 = buildEvent({ summary: 'Only on T' });
    const result = planInitialMatch([t1], []);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([]);
  });

  it('sorts and deduplicates ambiguousKeys', () => {
    const tZ1 = buildEvent({ summary: 'Zeta' });
    const tZ2 = buildEvent({ summary: 'Zeta' });
    const nZ1 = buildEvent({ summary: 'Zeta' });
    const nZ2 = buildEvent({ summary: 'Zeta' });

    const tA1 = buildEvent({ summary: 'Alpha' });
    const tA2 = buildEvent({ summary: 'Alpha' });
    const nA1 = buildEvent({ summary: 'Alpha' });

    const keyZeta = contentKeyForInitialMatch(tZ1);
    const keyAlpha = contentKeyForInitialMatch(tA1);

    const result = planInitialMatch([tZ1, tZ2, tA1, tA2], [nZ1, nZ2, nA1]);

    expect(result.actions).toEqual([]);
    expect(result.ambiguousKeys).toEqual([keyAlpha, keyZeta].sort());
  });
});

describe('planInitialMatch: missing iCalUID', () => {
  it('throws when the T-side event of a matched pair has no iCalUID', () => {
    const a = buildEventWithoutICalUID();
    const b = buildEvent();
    expect(() => planInitialMatch([a], [b])).toThrow();
  });

  it('throws when the N-side event of a matched pair has an empty iCalUID', () => {
    const a = buildEvent();
    const b = buildEvent({ iCalUID: '' });
    expect(() => planInitialMatch([a], [b])).toThrow();
  });
});

describe('planInitialMatch: immutability', () => {
  it('does not mutate the input arrays or events', () => {
    const a = deepFreeze(buildEvent());
    const b = deepFreeze(buildEvent());
    const t = Object.freeze([a]);
    const n = Object.freeze([b]);

    expect(() => planInitialMatch(t, n)).not.toThrow();
  });
});

describe('planInitialMatch: D1 regression', () => {
  function buildPairAndMarks(): { a: CalendarEvent; b: CalendarEvent; markA: MarkAction; markB: MarkAction } {
    const a = buildEvent();
    const b = buildEvent();
    const result = planInitialMatch([a], [b]);
    const markActions = result.actions.filter(isMarkAction);
    const markA = markActions.find((action) => action.calendar === 'todoist');
    const markB = markActions.find((action) => action.calendar === 'primary');
    if (markA === undefined || markB === undefined) {
      throw new Error('test setup failed: expected both mark actions to be present');
    }
    return { a, b, markA, markB };
  }

  it('produces no classify/planSync actions once the pair is marked (both sides present)', () => {
    const { a, b, markA, markB } = buildPairAndMarks();
    const markedA = applyMark(a, markA);
    const markedB = applyMark(b, markB);

    const todoistClassified = classify('todoist', [markedA], []);
    const primaryClassified = classify('primary', [markedB], []);

    expect(todoistClassified.origins).toEqual([]);
    expect(todoistClassified.generated).toEqual([]);
    expect(primaryClassified.origins).toEqual([]);
    expect(primaryClassified.generated).toEqual([]);

    const actions = planSync({
      t: todoistClassified.origins,
      n: primaryClassified.origins,
      m: primaryClassified.generated,
      c: todoistClassified.generated,
    });
    expect(actions).toEqual([]);

    expect(todoistClassified.observedLinks).toEqual([
      { calendar: 'todoist', iCalUID: markedA.iCalUID, srcUid: b.iCalUID, kind: 'paired' },
    ]);
    expect(primaryClassified.observedLinks).toEqual([
      { calendar: 'primary', iCalUID: markedB.iCalUID, srcUid: a.iCalUID, kind: 'paired' },
    ]);
  });

  it('emits no delete action for B when the paired A (todoist side) has been deleted', () => {
    const { b, markB } = buildPairAndMarks();
    const markedB = applyMark(b, markB);

    // A はカレンダーから削除され、次回取得時の一覧に含まれない
    const todoistClassified = classify('todoist', [], []);
    const primaryClassified = classify('primary', [markedB], []);

    const actions = planSync({
      t: todoistClassified.origins,
      n: primaryClassified.origins,
      m: primaryClassified.generated,
      c: todoistClassified.generated,
    });

    expect(actions).toEqual([]);
    expect(actions.some((action) => action.kind === 'delete')).toBe(false);
  });

  it('emits no delete action for A when the paired B (primary side) has been deleted', () => {
    const { a, markA } = buildPairAndMarks();
    const markedA = applyMark(a, markA);

    // B はカレンダーから削除され、次回取得時の一覧に含まれない
    const todoistClassified = classify('todoist', [markedA], []);
    const primaryClassified = classify('primary', [], []);

    const actions = planSync({
      t: todoistClassified.origins,
      n: primaryClassified.origins,
      m: primaryClassified.generated,
      c: todoistClassified.generated,
    });

    expect(actions).toEqual([]);
    expect(actions.some((action) => action.kind === 'delete')).toBe(false);
  });
});
