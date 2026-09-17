import { describe, expect, it } from 'vitest';
import { planSync } from '../src/syncPlanner';
import { classify } from '../src/eventClassifier';
import { SRC_UID_KEY } from '../src/config';
import type { CalendarEvent, GeneratedEvent } from '../src/types';

let sequence = 0;

function nextUid(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}@example.com`;
}

function originEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    iCalUID: nextUid('origin'),
    summary: 'Meeting',
    start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
    ...overrides,
  };
}

function generatedEvent(srcUid: string, id: string, overrides: Partial<CalendarEvent> = {}): GeneratedEvent {
  return {
    event: {
      id,
      summary: 'Meeting',
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
      ...overrides,
    },
    srcUid,
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

describe('planSync: S1/S4 create', () => {
  it('creates into primary when a T origin has no matching M (S1)', () => {
    const t = originEvent();
    const actions = planSync({ t: [t], n: [], m: [], c: [] });
    expect(actions).toEqual([{ kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source: t }]);
  });

  it('creates into todoist when an N origin has no matching C (S4)', () => {
    const n = originEvent();
    const actions = planSync({ t: [], n: [n], m: [], c: [] });
    expect(actions).toEqual([{ kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source: n }]);
  });

  it('emits creates in origin input order', () => {
    const a = originEvent();
    const b = originEvent();
    const actions = planSync({ t: [a, b], n: [], m: [], c: [] });
    expect(actions).toEqual([
      { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source: a },
      { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source: b },
    ]);
  });
});

describe('planSync: S2/S5 update', () => {
  it('updates the mirror when content differs (S2)', () => {
    const t = originEvent({ summary: 'New title' });
    const m = generatedEvent(t.iCalUID as string, 'm-1', { summary: 'Old title' });
    const actions = planSync({ t: [t], n: [], m: [m], c: [] });
    expect(actions).toEqual([
      { kind: 'update', rule: 'S2', direction: 'T→P', calendar: 'primary', source: t, target: m.event },
    ]);
  });

  it('updates the copy when content differs (S5)', () => {
    const n = originEvent({ summary: 'New title' });
    const c = generatedEvent(n.iCalUID as string, 'c-1', { summary: 'Old title' });
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
    expect(actions).toEqual([
      { kind: 'update', rule: 'S5', direction: 'P→T', calendar: 'todoist', source: n, target: c.event },
    ]);
  });

  it('emits no action when content is identical', () => {
    const t = originEvent();
    const m = generatedEvent(t.iCalUID as string, 'm-1');
    const actions = planSync({ t: [t], n: [], m: [m], c: [] });
    expect(actions).toEqual([]);
  });

  it('treats +09:00 and Z as the same instant (no update)', () => {
    const t = originEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00' },
      end: { dateTime: '2026-09-15T11:00:00+09:00' },
    });
    const m = generatedEvent(t.iCalUID as string, 'm-1', {
      start: { dateTime: '2026-09-15T01:00:00Z' },
      end: { dateTime: '2026-09-15T02:00:00Z' },
    });
    const actions = planSync({ t: [t], n: [], m: [m], c: [] });
    expect(actions).toEqual([]);
  });
});

describe('planSync: S3/S6 orphan delete', () => {
  it('deletes an M whose srcUid has no matching T (S3)', () => {
    const m = generatedEvent(nextUid('gone'), 'm-1');
    const actions = planSync({ t: [], n: [], m: [m], c: [] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S3', direction: 'T→P', calendar: 'primary', target: m.event, srcUid: m.srcUid },
    ]);
  });

  it('deletes a C whose srcUid has no matching N (S6)', () => {
    const c = generatedEvent(nextUid('gone'), 'c-1');
    const actions = planSync({ t: [], n: [], m: [], c: [c] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S6', direction: 'P→T', calendar: 'todoist', target: c.event, srcUid: c.srcUid },
    ]);
  });

  it('orders orphan deletes by first appearance of srcUid in generated', () => {
    const srcA = nextUid('orphanA');
    const srcB = nextUid('orphanB');
    // srcA が先に出現し、間に srcB が挟まる。同じ srcUid のグループ内は id 昇順になる
    const a1 = generatedEvent(srcA, 'a-2');
    const b1 = generatedEvent(srcB, 'b-1');
    const a2 = generatedEvent(srcA, 'a-1');
    const actions = planSync({ t: [], n: [], m: [a1, b1, a2], c: [] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S3', direction: 'T→P', calendar: 'primary', target: a2.event, srcUid: srcA },
      { kind: 'delete', rule: 'S3', direction: 'T→P', calendar: 'primary', target: a1.event, srcUid: srcA },
      { kind: 'delete', rule: 'S3', direction: 'T→P', calendar: 'primary', target: b1.event, srcUid: srcB },
    ]);
  });
});

describe('planSync: S3D/S6D duplicate delete', () => {
  it('keeps the smallest id and deletes the rest (S3D), update still applied to the kept one', () => {
    const t = originEvent({ summary: 'Current title' });
    const uid = t.iCalUID as string;
    const m3 = generatedEvent(uid, '3', { summary: 'Stale' });
    const m1 = generatedEvent(uid, '1', { summary: 'Different from origin' });
    const m2 = generatedEvent(uid, '2', { summary: 'Stale' });
    const actions = planSync({ t: [t], n: [], m: [m3, m1, m2], c: [] });
    expect(actions).toEqual([
      { kind: 'update', rule: 'S2', direction: 'T→P', calendar: 'primary', source: t, target: m1.event },
      { kind: 'delete', rule: 'S3D', direction: 'T→P', calendar: 'primary', target: m2.event, srcUid: uid },
      { kind: 'delete', rule: 'S3D', direction: 'T→P', calendar: 'primary', target: m3.event, srcUid: uid },
    ]);
  });

  it('keeps the smallest id and deletes the rest (S6D), no update when kept content matches', () => {
    const n = originEvent();
    const uid = n.iCalUID as string;
    const c2 = generatedEvent(uid, '20');
    const c1 = generatedEvent(uid, '10');
    const actions = planSync({ t: [], n: [n], m: [], c: [c2, c1] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S6D', direction: 'P→T', calendar: 'todoist', target: c2.event, srcUid: uid },
    ]);
  });
});

describe('planSync: empty and fully-in-sync inputs', () => {
  it('returns [] for empty inputs', () => {
    expect(planSync({ t: [], n: [], m: [], c: [] })).toEqual([]);
  });

  it('returns [] when everything is already in sync in both directions', () => {
    const t = originEvent();
    const n = originEvent();
    const m = generatedEvent(t.iCalUID as string, 'm-1');
    const c = generatedEvent(n.iCalUID as string, 'c-1');
    expect(planSync({ t: [t], n: [n], m: [m], c: [c] })).toEqual([]);
  });
});

describe('planSync: directions do not mix', () => {
  it('an M whose srcUid matches an N iCalUID (but no T) is still an S3 orphan delete, independent of S4', () => {
    const n = originEvent();
    const m = generatedEvent(n.iCalUID as string, 'm-1');
    const actions = planSync({ t: [], n: [n], m: [m], c: [] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S3', direction: 'T→P', calendar: 'primary', target: m.event, srcUid: m.srcUid },
      { kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source: n },
    ]);
  });
});

describe('planSync: echo prevention via classify', () => {
  it('produces [] when fed a realistic state classified by eventClassifier', () => {
    const tOrigin: CalendarEvent = {
      iCalUID: 'todoist-task-1@example.com',
      summary: 'Task from Todoist',
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
    };
    const mirror: CalendarEvent = {
      id: 'm-1',
      iCalUID: 'primary-mirror-1@example.com',
      summary: 'Task from Todoist',
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
      extendedProperties: { private: { [SRC_UID_KEY]: 'todoist-task-1@example.com' } },
    };
    const nOrigin: CalendarEvent = {
      iCalUID: 'primary-meeting-1@example.com',
      summary: 'Meeting from colleague',
      start: { dateTime: '2026-09-16T13:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-16T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
      eventType: 'default',
    };
    const copy: CalendarEvent = {
      id: 'c-1',
      iCalUID: 'todoist-copy-1@example.com',
      summary: 'Meeting from colleague',
      start: { dateTime: '2026-09-16T13:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-16T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
      extendedProperties: { private: { [SRC_UID_KEY]: 'primary-meeting-1@example.com' } },
    };

    const todoistClassified = classify('todoist', [tOrigin, copy], [], () => true);
    const primaryClassified = classify('primary', [nOrigin, mirror], [], () => true);

    const actions = planSync({
      t: todoistClassified.origins,
      n: primaryClassified.origins,
      m: primaryClassified.generated,
      c: todoistClassified.generated,
    });

    expect(actions).toEqual([]);
  });
});

describe('planSync: generated events restored from links', () => {
  it('produces no create when srcUid is supplied by GeneratedEvent even though the event itself lacks extendedProperties', () => {
    const t = originEvent();
    // links から復元された生成物は、event 自体に extendedProperties を持たないことがある（D6）。
    // その場合でも GeneratedEvent.srcUid を通じて対応付けが成立する。
    const restored: GeneratedEvent = {
      event: {
        id: 'restored-1',
        summary: t.summary,
        start: t.start,
        end: t.end,
      },
      srcUid: t.iCalUID as string,
    };
    const actions = planSync({ t: [t], n: [], m: [restored], c: [] });
    expect(actions).toEqual([]);
  });
});

describe('planSync: inputs are not mutated', () => {
  it('does not mutate origins or generated arrays/objects', () => {
    const t = deepFreeze(originEvent());
    const n = deepFreeze(originEvent());
    const m = deepFreeze(generatedEvent(t.iCalUID as string, 'm-1', { summary: 'Different' }));
    const c = deepFreeze(generatedEvent(n.iCalUID as string, 'c-1', { summary: 'Different' }));
    const tArr = Object.freeze([t]);
    const nArr = Object.freeze([n]);
    const mArr = Object.freeze([m]);
    const cArr = Object.freeze([c]);

    expect(() => planSync({ t: tArr, n: nArr, m: mArr, c: cArr })).not.toThrow();
  });
});

describe('planSync: validation errors', () => {
  it('throws when an origin lacks iCalUID', () => {
    const badOrigin = originEvent();
    delete badOrigin.iCalUID;
    expect(() => planSync({ t: [badOrigin], n: [], m: [], c: [] })).toThrow();
  });

  it('throws when a generated event lacks id', () => {
    const badGenerated: GeneratedEvent = {
      event: { summary: 'No id', start: originEvent().start, end: originEvent().end },
      srcUid: nextUid('orphan'),
    };
    expect(() => planSync({ t: [], n: [], m: [badGenerated], c: [] })).toThrow();
  });
});
