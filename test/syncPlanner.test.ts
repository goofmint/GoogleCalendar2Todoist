import { describe, expect, it } from 'vitest';
import { excludeOwnTaskMirrors, planSync, resolveTodoistTaskLinks } from '../src/syncPlanner';
import { classify } from '../src/eventClassifier';
import { SRC_UID_KEY } from '../src/config';
import type { CalendarEvent, GeneratedEvent, GeneratedTodoistTask, LinkEntry, TodoistTask } from '../src/types';

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

// originEvent() の既定の start（2026-09-15T10:00:00+09:00）と同じ内容の Todoist タスク。
function todoistTask(id: string, overrides: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id,
    content: 'Meeting',
    due: { date: '2026-09-15T01:00:00Z', timezone: null },
    ...overrides,
  };
}

function generatedTask(srcUid: string, id: string, overrides: Partial<TodoistTask> = {}): GeneratedTodoistTask {
  return { task: todoistTask(id, overrides), srcUid };
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

  it('creates a todoist task when an N origin has no matching generated task (S4)', () => {
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

  it('updates the todoist task when content differs (S5)', () => {
    const n = originEvent({ summary: 'New title' });
    const c = generatedTask(n.iCalUID as string, 'task-1', { content: 'Old title' });
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
    expect(actions).toEqual([
      { kind: 'update', rule: 'S5', direction: 'P→T', calendar: 'todoist', source: n, todoistTaskId: 'task-1' },
    ]);
  });

  it('emits no action when content is identical (S2)', () => {
    const t = originEvent();
    const m = generatedEvent(t.iCalUID as string, 'm-1');
    const actions = planSync({ t: [t], n: [], m: [m], c: [] });
    expect(actions).toEqual([]);
  });

  it('emits no action when content is identical (S5)', () => {
    const n = originEvent();
    const c = generatedTask(n.iCalUID as string, 'task-1');
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
    expect(actions).toEqual([]);
  });

  it('treats +09:00 and Z as the same instant (no update, S2)', () => {
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

  it('updates when the due date differs from the origin start (S5)', () => {
    const n = originEvent();
    const c = generatedTask(n.iCalUID as string, 'task-1', { due: { date: '2026-09-20T01:00:00Z', timezone: null } });
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
    expect(actions).toEqual([
      { kind: 'update', rule: 'S5', direction: 'P→T', calendar: 'todoist', source: n, todoistTaskId: 'task-1' },
    ]);
  });

  it('updates when the linked task has no due at all (S5)', () => {
    const n = originEvent();
    const c = generatedTask(n.iCalUID as string, 'task-1', { due: null });
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
    expect(actions).toHaveLength(1);
    expect(actions[0].rule).toBe('S5');
  });

  it('creates an all-day due_date task and matches it back with no update (S4/S5)', () => {
    const n = originEvent({ start: { date: '2026-09-15' }, end: { date: '2026-09-16' } });
    const created = planSync({ t: [], n: [n], m: [], c: [] });
    expect(created).toEqual([{ kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source: n }]);

    const c = generatedTask(n.iCalUID as string, 'task-allday', { due: { date: '2026-09-15', timezone: null } });
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
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

  it('deletes a todoist task whose srcUid has no matching N (S6)', () => {
    const c = generatedTask(nextUid('gone'), 'task-1');
    const actions = planSync({ t: [], n: [], m: [], c: [c] });
    expect(actions).toEqual([
      {
        kind: 'delete',
        rule: 'S6',
        direction: 'P→T',
        calendar: 'todoist',
        todoistTaskId: 'task-1',
        srcUid: c.srcUid,
      },
    ]);
  });

  it('orders orphan deletes by first appearance of srcUid in generated (M)', () => {
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

  it('orders orphan deletes by first appearance of srcUid in generated (todoist tasks)', () => {
    const srcA = nextUid('orphanA');
    const srcB = nextUid('orphanB');
    const a1 = generatedTask(srcA, 'a-2');
    const b1 = generatedTask(srcB, 'b-1');
    const a2 = generatedTask(srcA, 'a-1');
    const actions = planSync({ t: [], n: [], m: [], c: [a1, b1, a2] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S6', direction: 'P→T', calendar: 'todoist', todoistTaskId: 'a-1', srcUid: srcA },
      { kind: 'delete', rule: 'S6', direction: 'P→T', calendar: 'todoist', todoistTaskId: 'a-2', srcUid: srcA },
      { kind: 'delete', rule: 'S6', direction: 'P→T', calendar: 'todoist', todoistTaskId: 'b-1', srcUid: srcB },
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
    const c2 = generatedTask(uid, '20');
    const c1 = generatedTask(uid, '10');
    const actions = planSync({ t: [], n: [n], m: [], c: [c2, c1] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S6D', direction: 'P→T', calendar: 'todoist', todoistTaskId: '20', srcUid: uid },
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
    const c = generatedTask(n.iCalUID as string, 'task-1');
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

describe('planSync: recurring N is excluded from P→T task creation', () => {
  it('does not create a todoist task for a recurring N (create suppressed)', () => {
    const n = originEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const actions = planSync({ t: [], n: [n], m: [], c: [] });
    expect(actions).toEqual([]);
  });

  it('deletes an existing generated task when its origin N becomes recurring', () => {
    const n = originEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const uid = n.iCalUID as string;
    const c = generatedTask(uid, 'task-1');
    const actions = planSync({ t: [], n: [n], m: [], c: [c] });
    expect(actions).toEqual([
      { kind: 'delete', rule: 'S6', direction: 'P→T', calendar: 'todoist', todoistTaskId: 'task-1', srcUid: uid },
    ]);
  });

  it('still creates a mirror (S1) for T even when a recurring N is present (directions independent)', () => {
    const t = originEvent();
    const n = originEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const actions = planSync({ t: [t], n: [n], m: [], c: [] });
    expect(actions).toEqual([{ kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source: t }]);
  });
});

describe('planSync: echo prevention via classify', () => {
  it('produces [] for the T→P side when fed a realistic state classified by eventClassifier', () => {
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

    const todoistClassified = classify('todoist', [tOrigin], [], () => true);
    const primaryClassified = classify('primary', [mirror], [], () => true);

    const actions = planSync({
      t: todoistClassified.origins,
      n: [],
      m: primaryClassified.generated,
      c: [],
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

  it('produces no S4 create when a GeneratedTodoistTask is supplied for the N (task resolved from links)', () => {
    const n = originEvent();
    const restored = generatedTask(n.iCalUID as string, 'task-restored');
    const actions = planSync({ t: [], n: [n], m: [], c: [restored] });
    expect(actions).toEqual([]);
  });
});

describe('planSync: inputs are not mutated', () => {
  it('does not mutate origins or generated arrays/objects', () => {
    const t = deepFreeze(originEvent());
    const n = deepFreeze(originEvent());
    const m = deepFreeze(generatedEvent(t.iCalUID as string, 'm-1', { summary: 'Different' }));
    const c = deepFreeze(generatedTask(n.iCalUID as string, 'task-1', { content: 'Different' }));
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

  it('throws when an N origin (P→T side) lacks iCalUID', () => {
    const badOrigin = originEvent();
    delete badOrigin.iCalUID;
    expect(() => planSync({ t: [], n: [badOrigin], m: [], c: [] })).toThrow();
  });
});

describe('resolveTodoistTaskLinks', () => {
  function link(overrides: Partial<LinkEntry> = {}): LinkEntry {
    return {
      calendar: 'todoist',
      iCalUID: '',
      srcUid: nextUid('src'),
      kind: 'generated',
      recordedAt: new Date('2026-09-01T00:00:00Z'),
      todoistTaskId: 'task-1',
      ...overrides,
    };
  }

  it('resolves a links row to a GeneratedTodoistTask when the task is still active', () => {
    const l = link({ srcUid: 'n-1@example.com', todoistTaskId: 'active-1' });
    const activeTasks: TodoistTask[] = [todoistTask('active-1')];

    const result = resolveTodoistTaskLinks({ links: [l], activeTasks });

    expect(result.generated).toEqual([{ task: activeTasks[0], srcUid: 'n-1@example.com' }]);
    expect(result.observed).toEqual([
      { calendar: 'todoist', iCalUID: '', srcUid: 'n-1@example.com', kind: 'generated', todoistTaskId: 'active-1' },
    ]);
    expect(result.inactiveLinks).toEqual([]);
  });

  it('does not recreate a task the user completed or deleted: it is returned as inactiveLinks, not generated/observed', () => {
    const l = link({ srcUid: 'n-2@example.com', todoistTaskId: 'gone-1' });

    const result = resolveTodoistTaskLinks({ links: [l], activeTasks: [] });

    expect(result.generated).toEqual([]);
    expect(result.observed).toEqual([]);
    expect(result.inactiveLinks).toEqual([
      {
        srcUid: 'n-2@example.com',
        observedRow: { calendar: 'todoist', iCalUID: '', srcUid: 'n-2@example.com', kind: 'generated', todoistTaskId: 'gone-1' },
      },
    ]);
  });

  it('ignores non-todoist-generated links (primary rows, paired rows)', () => {
    const primaryLink = link({ calendar: 'primary', todoistTaskId: undefined, iCalUID: 'm-1@example.com' });
    const pairedLink = link({ kind: 'paired', todoistTaskId: undefined, iCalUID: 't-1@example.com' });

    const result = resolveTodoistTaskLinks({ links: [primaryLink, pairedLink], activeTasks: [] });

    expect(result.generated).toEqual([]);
    expect(result.observed).toEqual([]);
    expect(result.inactiveLinks).toEqual([]);
  });
});

describe('excludeOwnTaskMirrors', () => {
  it('excludes a T candidate whose content key matches an N that has an active generated task', () => {
    const n = originEvent({ summary: 'Own task meeting' });
    const echo = originEvent({
      iCalUID: 'todoist-echo-1@example.com',
      summary: 'Own task meeting',
      start: n.start,
      end: n.end,
    });

    const result = excludeOwnTaskMirrors([echo], [n]);

    expect(result.origins).toEqual([]);
    expect(result.ambiguousKeys).toEqual([]);
  });

  it('keeps T candidates unrelated to any N with a generated task', () => {
    const unrelated = originEvent({ summary: 'Someone else task' });
    const n = originEvent({ summary: 'Different meeting' });

    const result = excludeOwnTaskMirrors([unrelated], [n]);

    expect(result.origins).toEqual([unrelated]);
  });

  it('does not exclude and logs an ambiguous key when multiple T candidates share the same content key', () => {
    const n = originEvent({ summary: 'Dup' });
    const t1 = originEvent({ summary: 'Dup', start: n.start, end: n.end });
    const t2 = originEvent({ summary: 'Dup', start: n.start, end: n.end });

    const result = excludeOwnTaskMirrors([t1, t2], [n]);

    expect(result.origins).toEqual([t1, t2]);
    expect(result.ambiguousKeys).toHaveLength(1);
  });

  it('does not exclude and logs an ambiguous key when multiple N with active tasks share the same content key', () => {
    const n1 = originEvent({ summary: 'Dup' });
    const n2 = originEvent({ summary: 'Dup', start: n1.start, end: n1.end });
    const t = originEvent({ summary: 'Dup', start: n1.start, end: n1.end });

    const result = excludeOwnTaskMirrors([t], [n1, n2]);

    expect(result.origins).toEqual([t]);
    expect(result.ambiguousKeys).toHaveLength(1);
  });

  it('returns the original origins unchanged when there are no N with a generated task', () => {
    const t = originEvent();
    const result = excludeOwnTaskMirrors([t], []);
    expect(result.origins).toEqual([t]);
    expect(result.ambiguousKeys).toEqual([]);
  });
});
