import { describe, expect, it } from 'vitest';
import { linkKey, planLinks } from '../src/linksPlanner';
import type { ExecutionResult, LinkEntry } from '../src/types';

const NOW = new Date('2026-09-15T00:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');

function makeLink(overrides: Partial<LinkEntry> = {}): LinkEntry {
  return {
    calendar: 'primary',
    iCalUID: 'uid-1',
    srcUid: 'src-1',
    kind: 'generated',
    recordedAt: PAST,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    createdLinks: [],
    deletedKeys: [],
    ...overrides,
  };
}

describe('linkKey', () => {
  it('formats calendar and iCalUID as calendar:iCalUID', () => {
    expect(linkKey({ calendar: 'todoist', iCalUID: 'abc' })).toBe('todoist:abc');
  });
});

describe('planLinks', () => {
  it('records a new observed row with recordedAt=now and marks changed', () => {
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-new', srcUid: 'src-new', kind: 'generated' as const },
    ];

    const { entries, changed } = planLinks({ current: [], observed, result: makeResult(), now: NOW });

    expect(entries).toHaveLength(1);
    expect(entries[0].iCalUID).toBe('uid-new');
    expect(entries[0].recordedAt.getTime()).toBe(NOW.getTime());
    expect(changed).toBe(true);
  });

  it('keeps recordedAt and marks unchanged when observed matches current exactly', () => {
    const current = [makeLink()];
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-1', srcUid: 'src-1', kind: 'generated' as const },
    ];

    const { entries, changed } = planLinks({ current, observed, result: makeResult(), now: NOW });

    expect(entries).toHaveLength(1);
    expect(entries[0].recordedAt.getTime()).toBe(PAST.getTime());
    expect(entries[0].recordedAt).not.toBe(current[0].recordedAt); // 別インスタンスであること
    expect(changed).toBe(false);
  });

  it('adds rows from result.createdLinks', () => {
    const result = makeResult({
      createdLinks: [{ calendar: 'todoist', iCalUID: 'uid-created', srcUid: 'src-created', kind: 'generated' }],
    });

    const { entries, changed } = planLinks({ current: [], observed: [], result, now: NOW });

    expect(entries).toHaveLength(1);
    expect(entries[0].iCalUID).toBe('uid-created');
    expect(entries[0].recordedAt.getTime()).toBe(NOW.getTime());
    expect(changed).toBe(true);
  });

  it('prefers createdLinks over observed when the same key appears in both', () => {
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-1', srcUid: 'src-old', kind: 'generated' as const },
    ];
    const result = makeResult({
      createdLinks: [{ calendar: 'primary', iCalUID: 'uid-1', srcUid: 'src-new', kind: 'paired' }],
    });

    const { entries } = planLinks({ current: [], observed, result, now: NOW });

    expect(entries).toHaveLength(1);
    expect(entries[0].srcUid).toBe('src-new');
    expect(entries[0].kind).toBe('paired');
  });

  it('excludes rows whose key is in deletedKeys even if they are also observed', () => {
    const current = [makeLink()];
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-1', srcUid: 'src-1', kind: 'generated' as const },
    ];
    const result = makeResult({ deletedKeys: ['primary:uid-1'] });

    const { entries, changed } = planLinks({ current, observed, result, now: NOW });

    expect(entries).toHaveLength(0);
    expect(changed).toBe(true);
  });

  it('drops current rows that are no longer observed or created (past or manually deleted events)', () => {
    const current = [makeLink({ iCalUID: 'uid-gone' })];

    const { entries, changed } = planLinks({ current, observed: [], result: makeResult(), now: NOW });

    expect(entries).toHaveLength(0);
    expect(changed).toBe(true);
  });

  it('marks changed when srcUid differs for the same key, while preserving recordedAt', () => {
    const current = [makeLink()];
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-1', srcUid: 'src-changed', kind: 'generated' as const },
    ];

    const { entries, changed } = planLinks({ current, observed, result: makeResult(), now: NOW });

    expect(entries[0].srcUid).toBe('src-changed');
    expect(entries[0].recordedAt.getTime()).toBe(PAST.getTime());
    expect(changed).toBe(true);
  });

  it('marks changed when kind differs for the same key, while preserving recordedAt', () => {
    const current = [makeLink({ kind: 'generated' })];
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-1', srcUid: 'src-1', kind: 'paired' as const },
    ];

    const { entries, changed } = planLinks({ current, observed, result: makeResult(), now: NOW });

    expect(entries[0].kind).toBe('paired');
    expect(entries[0].recordedAt.getTime()).toBe(PAST.getTime());
    expect(changed).toBe(true);
  });

  it('marks changed when the key differs even though the row count stays the same', () => {
    const current = [makeLink({ iCalUID: 'uid-old' })];
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-new', srcUid: 'src-1', kind: 'generated' as const },
    ];

    const { entries, changed } = planLinks({ current, observed, result: makeResult(), now: NOW });

    expect(entries).toHaveLength(1);
    expect(entries[0].iCalUID).toBe('uid-new');
    expect(changed).toBe(true);
  });

  it('returns no entries and changed=false when current, observed, and result are all empty', () => {
    const { entries, changed } = planLinks({ current: [], observed: [], result: makeResult(), now: NOW });

    expect(entries).toEqual([]);
    expect(changed).toBe(false);
  });

  it('sorts entries by key ascending and treats reordering of current alone as unchanged', () => {
    const rowA = makeLink({ iCalUID: 'uid-a', srcUid: 'src-a' });
    const rowB = makeLink({ iCalUID: 'uid-b', srcUid: 'src-b' });
    // current をキー降順（b, a）で保持しておき、並び替えだけでは changed にならないことを確認する。
    const current = [rowB, rowA];
    const observed = [
      { calendar: 'primary' as const, iCalUID: 'uid-a', srcUid: rowA.srcUid, kind: rowA.kind },
      { calendar: 'primary' as const, iCalUID: 'uid-b', srcUid: rowB.srcUid, kind: rowB.kind },
    ];

    const { entries, changed } = planLinks({ current, observed, result: makeResult(), now: NOW });

    expect(entries.map((entry) => linkKey(entry))).toEqual(['primary:uid-a', 'primary:uid-b']);
    expect(changed).toBe(false);
  });

  it('records paired rows synthesized from mark actions and passed in via observed', () => {
    // design.md §2.2 main.ts: mark で作ったペアは actions からしか分からず、observedLinks に
    // 含まれない。そのため main.ts が kind: 'paired' の行を合成して observed に加えてから
    // planLinks に渡す想定。ここではその合成済みの行が正しく記録されることを検証する。
    const observed = [
      { calendar: 'todoist' as const, iCalUID: 'uid-pair', srcUid: 'uid-pair-partner', kind: 'paired' as const },
    ];

    const { entries, changed } = planLinks({ current: [], observed, result: makeResult(), now: NOW });

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('paired');
    expect(entries[0].calendar).toBe('todoist');
    expect(changed).toBe(true);
  });

  it('does not mutate the current, observed, or result inputs', () => {
    const current = [makeLink()];
    const observed = [
      { calendar: 'todoist' as const, iCalUID: 'uid-new', srcUid: 'src-new', kind: 'generated' as const },
    ];
    const result = makeResult({
      createdLinks: [{ calendar: 'primary', iCalUID: 'uid-created', srcUid: 'src-created', kind: 'generated' }],
      deletedKeys: ['primary:uid-other'],
    });

    const currentBefore = current.map((entry) => ({ ...entry, recordedAt: entry.recordedAt.getTime() }));
    const observedBefore = observed.map((entry) => ({ ...entry }));
    const resultBefore = {
      createdLinks: result.createdLinks.map((entry) => ({ ...entry })),
      deletedKeys: [...result.deletedKeys],
    };

    planLinks({ current, observed, result, now: NOW });

    expect(current.map((entry) => ({ ...entry, recordedAt: entry.recordedAt.getTime() }))).toEqual(currentBefore);
    expect(observed.map((entry) => ({ ...entry }))).toEqual(observedBefore);
    expect({
      createdLinks: result.createdLinks.map((entry) => ({ ...entry })),
      deletedKeys: [...result.deletedKeys],
    }).toEqual(resultBefore);
  });
});
