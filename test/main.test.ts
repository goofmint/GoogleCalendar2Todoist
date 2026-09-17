import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupLegacyTodoistCopies, setup, sync } from '../src/main';
import { PRIMARY_CALENDAR_ID, TRIGGER_HANDLER, TRIGGER_INTERVAL_MINUTES } from '../src/config';
import { ensureSheets, markInitialMatchDone, readSettings } from '../src/settingsRepository';
import { readLinks, writeLinks } from '../src/linksRepository';
import { createLogger } from '../src/logger';
import { hasFutureInstance, listFutureEvents, removeEvent } from '../src/calendarGateway';
import { listTasks } from '../src/todoistGateway';
import { classify, getSrcUid, isInitialMatched } from '../src/eventClassifier';
import { planInitialMatch } from '../src/initialMatcher';
import { excludeOwnTaskMirrors, planSync, resolveTodoistTaskLinks } from '../src/syncPlanner';
import { executeActions } from '../src/actionExecutor';
import { planLinks } from '../src/linksPlanner';
import type { Logger } from '../src/logger';
import type { CalendarEvent, ClassifiedEvents, Direction, ExecutionResult, LinkEntry, Settings, SyncAction } from '../src/types';
import type { InitialMatchResult } from '../src/initialMatcher';

vi.mock('../src/settingsRepository', () => ({
  ensureSheets: vi.fn(),
  markInitialMatchDone: vi.fn(),
  readSettings: vi.fn(),
}));
vi.mock('../src/linksRepository', () => ({
  readLinks: vi.fn(),
  writeLinks: vi.fn(),
}));
vi.mock('../src/logger', () => ({
  createLogger: vi.fn(),
}));
vi.mock('../src/calendarGateway', () => ({
  listFutureEvents: vi.fn(),
  hasFutureInstance: vi.fn(),
  removeEvent: vi.fn(),
}));
vi.mock('../src/todoistGateway', () => ({
  listTasks: vi.fn(),
}));
vi.mock('../src/eventClassifier', () => ({
  classify: vi.fn(),
  getSrcUid: vi.fn(),
  isInitialMatched: vi.fn(),
}));
vi.mock('../src/initialMatcher', () => ({
  planInitialMatch: vi.fn(),
}));
vi.mock('../src/syncPlanner', () => ({
  planSync: vi.fn(),
  resolveTodoistTaskLinks: vi.fn(),
  excludeOwnTaskMirrors: vi.fn(),
}));
vi.mock('../src/actionExecutor', () => ({
  executeActions: vi.fn(),
}));
vi.mock('../src/linksPlanner', () => ({
  planLinks: vi.fn(),
}));

const ensureSheetsMock = vi.mocked(ensureSheets);
const markInitialMatchDoneMock = vi.mocked(markInitialMatchDone);
const readSettingsMock = vi.mocked(readSettings);
const readLinksMock = vi.mocked(readLinks);
const writeLinksMock = vi.mocked(writeLinks);
const createLoggerMock = vi.mocked(createLogger);
const listFutureEventsMock = vi.mocked(listFutureEvents);
const hasFutureInstanceMock = vi.mocked(hasFutureInstance);
const removeEventMock = vi.mocked(removeEvent);
const listTasksMock = vi.mocked(listTasks);
const classifyMock = vi.mocked(classify);
const getSrcUidMock = vi.mocked(getSrcUid);
const isInitialMatchedMock = vi.mocked(isInitialMatched);
const planInitialMatchMock = vi.mocked(planInitialMatch);
const planSyncMock = vi.mocked(planSync);
const resolveTodoistTaskLinksMock = vi.mocked(resolveTodoistTaskLinks);
const excludeOwnTaskMirrorsMock = vi.mocked(excludeOwnTaskMirrors);
const executeActionsMock = vi.mocked(executeActions);
const planLinksMock = vi.mocked(planLinks);

type LoggedCall = { level: 'INFO' | 'WARN'; direction: Direction; uid: string; message: string };

function createFakeLogger(): Logger & { calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  return {
    calls,
    info(direction: Direction, uid: string, message: string): void {
      calls.push({ level: 'INFO', direction, uid, message });
    },
    warn(direction: Direction, uid: string, message: string): void {
      calls.push({ level: 'WARN', direction, uid, message });
    },
    flush: vi.fn(),
  };
}

type FakeLock = { tryLock: (ms: number) => boolean; releaseLock: () => void };
type FakeLockService = { getScriptLock: () => FakeLock };

function createFakeLock(overrides: Partial<FakeLock> = {}): FakeLock {
  return {
    tryLock: vi.fn().mockReturnValue(true),
    releaseLock: vi.fn(),
    ...overrides,
  };
}

function fakeEvent(iCalUID: string): CalendarEvent {
  return { iCalUID };
}

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    todoistCalendarId: 'todoist-calendar-id',
    initialMatchDoneAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeLink(overrides: Partial<LinkEntry> = {}): LinkEntry {
  return {
    calendar: 'primary',
    iCalUID: 'link-uid',
    srcUid: 'link-src',
    kind: 'generated',
    recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function fakeClassified(overrides: Partial<ClassifiedEvents> = {}): ClassifiedEvents {
  return {
    origins: [],
    generated: [],
    observedLinks: [],
    repairs: [],
    ...overrides,
  };
}

function fakeExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    createdLinks: [],
    deletedKeys: [],
    ...overrides,
  };
}

let fakeLock: FakeLock;

function stubLockService(lock: FakeLock): void {
  const lockService: FakeLockService = { getScriptLock: () => lock };
  vi.stubGlobal('LockService', lockService);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeLock = createFakeLock();
  stubLockService(fakeLock);
  vi.stubGlobal('console', { log: vi.fn() });

  readSettingsMock.mockReturnValue(fakeSettings());
  readLinksMock.mockReturnValue([]);
  listFutureEventsMock.mockReturnValue([]);
  hasFutureInstanceMock.mockReturnValue(true);
  listTasksMock.mockReturnValue([]);
  classifyMock.mockImplementation(() => fakeClassified());
  resolveTodoistTaskLinksMock.mockReturnValue({
    generated: [],
    observed: [],
    inactiveLinks: [],
  });
  excludeOwnTaskMirrorsMock.mockImplementation((todoistOrigins) => ({
    origins: [...todoistOrigins],
    ambiguousKeys: [],
  }));
  planSyncMock.mockReturnValue([]);
  planInitialMatchMock.mockReturnValue({ actions: [], ambiguousKeys: [] });
  executeActionsMock.mockReturnValue(fakeExecutionResult());
  planLinksMock.mockReturnValue({ entries: [], changed: false });
  createLoggerMock.mockReturnValue(createFakeLogger());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync', () => {
  it('returns without reading settings when the lock is busy', () => {
    fakeLock.tryLock = vi.fn().mockReturnValue(false);

    sync();

    expect(console.log).toHaveBeenCalledWith('skip: lock busy');
    expect(readSettingsMock).not.toHaveBeenCalled();
    expect(createLoggerMock).not.toHaveBeenCalled();
    expect(fakeLock.releaseLock).not.toHaveBeenCalled();
  });

  it('runs a normal sync via planSync (not planInitialMatch), and writes links only when changed', () => {
    readSettingsMock.mockReturnValue(fakeSettings({ initialMatchDoneAt: '2026-01-01T00:00:00.000Z' }));
    const todoistOrigin = fakeEvent('todoist-origin');
    const primaryOrigin = fakeEvent('primary-origin');
    classifyMock.mockImplementation((calendar) =>
      calendar === 'todoist'
        ? fakeClassified({ origins: [todoistOrigin] })
        : fakeClassified({ origins: [primaryOrigin] }),
    );
    const syncAction: SyncAction = { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source: todoistOrigin };
    planSyncMock.mockReturnValue([syncAction]);
    const entries = [fakeLink()];
    planLinksMock.mockReturnValue({ entries, changed: true });

    sync();

    expect(planSyncMock).toHaveBeenCalledWith({
      t: [todoistOrigin],
      n: [primaryOrigin],
      m: [],
      c: [],
    });
    expect(planInitialMatchMock).not.toHaveBeenCalled();
    expect(executeActionsMock).toHaveBeenCalledWith(
      [syncAction],
      { primary: PRIMARY_CALENDAR_ID, todoist: 'todoist-calendar-id' },
      expect.anything(),
      expect.anything(),
    );
    expect(writeLinksMock).toHaveBeenCalledWith(entries);
    expect(markInitialMatchDoneMock).not.toHaveBeenCalled();
  });

  it('does not write links when planLinks reports no change', () => {
    planLinksMock.mockReturnValue({ entries: [], changed: false });

    sync();

    expect(writeLinksMock).not.toHaveBeenCalled();
  });

  it('passes a hasFutureOccurrence closure to classify that calls hasFutureInstance with the calendar id, event id, and now', () => {
    readSettingsMock.mockReturnValue(fakeSettings({ todoistCalendarId: 'todoist-cal-id' }));

    sync();

    expect(classifyMock).toHaveBeenCalledTimes(2);
    const [todoistCall, primaryCall] = classifyMock.mock.calls;
    expect(todoistCall[0]).toBe('todoist');
    expect(primaryCall[0]).toBe('primary');

    const todoistHasFutureOccurrence = todoistCall[3];
    const primaryHasFutureOccurrence = primaryCall[3];
    const event: CalendarEvent = { id: 'event-1' };

    todoistHasFutureOccurrence(event);
    expect(hasFutureInstanceMock).toHaveBeenCalledWith('todoist-cal-id', 'event-1', expect.any(Date));

    hasFutureInstanceMock.mockClear();
    primaryHasFutureOccurrence(event);
    expect(hasFutureInstanceMock).toHaveBeenCalledWith(PRIMARY_CALENDAR_ID, 'event-1', expect.any(Date));
  });

  it('throws when the event passed to the hasFutureOccurrence closure has no id', () => {
    sync();

    const [todoistCall] = classifyMock.mock.calls;
    const todoistHasFutureOccurrence = todoistCall[3];
    expect(() => todoistHasFutureOccurrence({})).toThrow();
  });

  it('runs the initial match via planInitialMatch, logs WARN for ambiguous keys, includes mark rows as paired in observed, and marks the initial match done', () => {
    readSettingsMock.mockReturnValue(fakeSettings({ initialMatchDoneAt: null }));
    const markTarget = fakeEvent('mark-target-todoist');
    const markAction: SyncAction = {
      kind: 'mark',
      rule: 'INIT',
      direction: 'INIT',
      calendar: 'todoist',
      target: markTarget,
      srcUid: 'mark-target-primary',
    };
    const matchResult: InitialMatchResult = { actions: [markAction], ambiguousKeys: ['b-key', 'a-key'] };
    planInitialMatchMock.mockReturnValue(matchResult);
    const loggerSpy = createFakeLogger();
    createLoggerMock.mockReturnValue(loggerSpy);

    sync();

    expect(planInitialMatchMock).toHaveBeenCalled();
    expect(planSyncMock).not.toHaveBeenCalled();
    expect(loggerSpy.calls).toEqual([
      { level: 'WARN', direction: 'INIT', uid: 'b-key', message: 'initial match skipped: multiple events share this start/title' },
      { level: 'WARN', direction: 'INIT', uid: 'a-key', message: 'initial match skipped: multiple events share this start/title' },
    ]);
    const [{ observed }] = planLinksMock.mock.calls[0];
    expect(observed).toContainEqual({
      calendar: 'todoist',
      iCalUID: 'mark-target-todoist',
      srcUid: 'mark-target-primary',
      kind: 'paired',
    });
    expect(markInitialMatchDoneMock).toHaveBeenCalledTimes(1);
    expect(markInitialMatchDoneMock.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it('propagates an exception from executeActions, but still flushes the logger and releases the lock, without writing links or marking the initial match', () => {
    const loggerSpy = createFakeLogger();
    createLoggerMock.mockReturnValue(loggerSpy);
    executeActionsMock.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => sync()).toThrow('boom');

    expect(loggerSpy.flush).toHaveBeenCalledTimes(1);
    expect(fakeLock.releaseLock).toHaveBeenCalledTimes(1);
    expect(writeLinksMock).not.toHaveBeenCalled();
    expect(markInitialMatchDoneMock).not.toHaveBeenCalled();
  });

  it('writes links for progress already made by executeActions before it throws, without marking the initial match', () => {
    // Todoist タスクには calendar イベントの srcUid のような自己修復手段が無いため、途中の throw
    // でもここまでに作成した links 行（createdLinks）だけは書き戻さないと、次回 S4 が再発生し
    // Todoist タスクが重複作成されてしまう（本改訂の対象そのもの）。
    const createdLink: Omit<LinkEntry, 'recordedAt'> = {
      calendar: 'todoist',
      iCalUID: '',
      srcUid: 'src-created-before-throw',
      kind: 'generated',
      todoistTaskId: 'task-created-before-throw',
    };
    executeActionsMock.mockImplementation((_actions, _calendarIds, _logger, result) => {
      result.createdLinks.push(createdLink);
      throw new Error('boom mid-way');
    });
    const entriesWithCreatedLink: LinkEntry[] = [{ ...createdLink, recordedAt: new Date('2026-01-01T00:00:00.000Z') }];
    planLinksMock.mockReturnValue({ entries: entriesWithCreatedLink, changed: true });

    expect(() => sync()).toThrow('boom mid-way');

    expect(planLinksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ createdLinks: [createdLink] }),
      }),
    );
    expect(writeLinksMock).toHaveBeenCalledWith(entriesWithCreatedLink);
    expect(markInitialMatchDoneMock).not.toHaveBeenCalled();
  });

  it('places repairs before other actions when calling executeActions', () => {
    const repairTarget = fakeEvent('repair-target');
    const todoistRepair: SyncAction = {
      kind: 'repair',
      rule: 'REPAIR',
      direction: 'REPAIR',
      calendar: 'todoist',
      target: repairTarget,
      srcUid: 'repair-src',
      linkKind: 'generated',
    };
    classifyMock.mockImplementation((calendar) =>
      calendar === 'todoist' ? fakeClassified({ repairs: [todoistRepair] }) : fakeClassified(),
    );
    const otherAction: SyncAction = {
      kind: 'create',
      rule: 'S1',
      direction: 'T→P',
      calendar: 'primary',
      source: fakeEvent('other-source'),
    };
    planSyncMock.mockReturnValue([otherAction]);

    sync();

    expect(executeActionsMock.mock.calls[0][0]).toEqual([todoistRepair, otherAction]);
  });

  describe('P→T Todoist task wiring (corrections 3 and 4)', () => {
    it('excludes an N whose linked task was completed/deleted from the n passed to planSync (does not recreate)', () => {
      const keptN = fakeEvent('n-kept');
      const completedN = fakeEvent('n-completed');
      classifyMock.mockImplementation((calendar) =>
        calendar === 'primary' ? fakeClassified({ origins: [keptN, completedN] }) : fakeClassified(),
      );
      resolveTodoistTaskLinksMock.mockReturnValue({
        generated: [],
        observed: [],
        inactiveLinks: [
          {
            srcUid: 'n-completed',
            observedRow: {
              calendar: 'todoist',
              iCalUID: '',
              srcUid: 'n-completed',
              kind: 'generated',
              todoistTaskId: 'gone-task-1',
            },
          },
        ],
      });

      sync();

      expect(planSyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ n: [keptN] }),
      );
      // N がまだ存在するので、links 行は残す（S4 を再発生させないため observed に含める）。
      const [{ observed }] = planLinksMock.mock.calls[0];
      expect(observed).toContainEqual({
        calendar: 'todoist',
        iCalUID: '',
        srcUid: 'n-completed',
        kind: 'generated',
        todoistTaskId: 'gone-task-1',
      });
    });

    it('drops the links row (no observed entry) when both the task and the N are gone', () => {
      classifyMock.mockImplementation((calendar) =>
        calendar === 'primary' ? fakeClassified({ origins: [] }) : fakeClassified(),
      );
      resolveTodoistTaskLinksMock.mockReturnValue({
        generated: [],
        observed: [],
        inactiveLinks: [
          {
            srcUid: 'n-gone',
            observedRow: {
              calendar: 'todoist',
              iCalUID: '',
              srcUid: 'n-gone',
              kind: 'generated',
              todoistTaskId: 'gone-task-2',
            },
          },
        ],
      });

      sync();

      const [{ observed }] = planLinksMock.mock.calls[0];
      expect(observed).not.toContainEqual(
        expect.objectContaining({ srcUid: 'n-gone' }),
      );
    });

    it('passes only N events with an active generated task to excludeOwnTaskMirrors (S1 double-mirror exclusion)', () => {
      const nWithTask = fakeEvent('n-with-task');
      const nWithoutTask = fakeEvent('n-without-task');
      const todoistOrigin = fakeEvent('todoist-origin');
      classifyMock.mockImplementation((calendar) =>
        calendar === 'primary'
          ? fakeClassified({ origins: [nWithTask, nWithoutTask] })
          : fakeClassified({ origins: [todoistOrigin] }),
      );
      resolveTodoistTaskLinksMock.mockReturnValue({
        generated: [{ task: { id: 'task-1', content: 'x', due: null }, srcUid: 'n-with-task' }],
        observed: [],
        inactiveLinks: [],
      });

      sync();

      expect(excludeOwnTaskMirrorsMock).toHaveBeenCalledWith([todoistOrigin], [nWithTask]);
    });

    it('uses the origins returned by excludeOwnTaskMirrors as the t input to planSync, and logs WARN for its ambiguousKeys', () => {
      const todoistOrigin = fakeEvent('todoist-origin');
      classifyMock.mockImplementation((calendar) =>
        calendar === 'todoist' ? fakeClassified({ origins: [todoistOrigin] }) : fakeClassified(),
      );
      excludeOwnTaskMirrorsMock.mockReturnValue({ origins: [], ambiguousKeys: ['ambiguous-key-1'] });
      const loggerSpy = createFakeLogger();
      createLoggerMock.mockReturnValue(loggerSpy);

      sync();

      expect(planSyncMock).toHaveBeenCalledWith(expect.objectContaining({ t: [] }));
      expect(loggerSpy.calls).toContainEqual({
        level: 'WARN',
        direction: 'P→T',
        uid: 'ambiguous-key-1',
        message: 'todoist mirror exclusion skipped: multiple events share this start/title',
      });
    });

    it('passes resolveTodoistTaskLinks().generated as the c input to planSync', () => {
      const generatedTask = { task: { id: 'task-1', content: 'x', due: null }, srcUid: 'n-1' };
      resolveTodoistTaskLinksMock.mockReturnValue({
        generated: [generatedTask],
        observed: [],
        inactiveLinks: [],
      });

      sync();

      expect(planSyncMock).toHaveBeenCalledWith(expect.objectContaining({ c: [generatedTask] }));
    });

    it('includes resolveTodoistTaskLinks().observed rows in the observed passed to planLinks', () => {
      const observedRow: Omit<LinkEntry, 'recordedAt'> = {
        calendar: 'todoist',
        iCalUID: '',
        srcUid: 'n-1',
        kind: 'generated',
        todoistTaskId: 'task-1',
      };
      resolveTodoistTaskLinksMock.mockReturnValue({
        generated: [],
        observed: [observedRow],
        inactiveLinks: [],
      });

      sync();

      const [{ observed }] = planLinksMock.mock.calls[0];
      expect(observed).toContainEqual(observedRow);
    });
  });
});

describe('setup', () => {
  type FakeTrigger = { getHandlerFunction: () => string };
  type FakeClockTriggerBuilder = { everyMinutes: (n: number) => FakeClockTriggerBuilder; create: () => FakeTrigger };
  type FakeTriggerBuilder = { timeBased: () => FakeClockTriggerBuilder };
  type FakeScriptApp = {
    getProjectTriggers: () => FakeTrigger[];
    newTrigger: (functionName: string) => FakeTriggerBuilder;
  };

  function stubScriptApp(triggers: FakeTrigger[]): { newTrigger: ReturnType<typeof vi.fn>; everyMinutes: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } {
    const createdTrigger: FakeTrigger = { getHandlerFunction: () => TRIGGER_HANDLER };
    const create = vi.fn().mockReturnValue(createdTrigger);
    const everyMinutes = vi.fn().mockReturnValue({ create });
    const timeBased = vi.fn().mockReturnValue({ everyMinutes });
    const newTrigger = vi.fn().mockReturnValue({ timeBased });
    const scriptApp: FakeScriptApp = {
      getProjectTriggers: () => triggers,
      newTrigger,
    };
    vi.stubGlobal('ScriptApp', scriptApp);
    return { newTrigger, everyMinutes, create };
  }

  it('creates a trigger when none exists', () => {
    const { newTrigger, everyMinutes, create } = stubScriptApp([]);

    setup();

    expect(ensureSheetsMock).toHaveBeenCalledTimes(1);
    expect(newTrigger).toHaveBeenCalledWith(TRIGGER_HANDLER);
    expect(everyMinutes).toHaveBeenCalledWith(TRIGGER_INTERVAL_MINUTES);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not create a second trigger when a sync trigger already exists', () => {
    const { newTrigger } = stubScriptApp([
      { getHandlerFunction: () => 'someOtherHandler' },
      { getHandlerFunction: () => TRIGGER_HANDLER },
    ]);

    setup();

    expect(ensureSheetsMock).toHaveBeenCalledTimes(1);
    expect(newTrigger).not.toHaveBeenCalled();
  });

  it('creates a trigger when only other-handler triggers exist (they do not count as the sync trigger)', () => {
    const { newTrigger } = stubScriptApp([{ getHandlerFunction: () => 'someOtherHandler' }]);

    setup();

    expect(newTrigger).toHaveBeenCalledWith(TRIGGER_HANDLER);
  });

  it('runs under the script lock and releases it after completing', () => {
    stubScriptApp([]);

    setup();

    expect(fakeLock.tryLock).toHaveBeenCalledTimes(1);
    expect(fakeLock.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('throws without touching sheets or triggers when the lock is busy', () => {
    fakeLock.tryLock = vi.fn().mockReturnValue(false);
    const { newTrigger } = stubScriptApp([]);

    expect(() => setup()).toThrow();
    expect(ensureSheetsMock).not.toHaveBeenCalled();
    expect(newTrigger).not.toHaveBeenCalled();
    expect(fakeLock.releaseLock).not.toHaveBeenCalled();
  });

  it('releases the lock even when sheet initialization throws', () => {
    ensureSheetsMock.mockImplementation(() => {
      throw new Error('sheet error');
    });
    const { newTrigger } = stubScriptApp([]);

    expect(() => setup()).toThrow('sheet error');
    expect(newTrigger).not.toHaveBeenCalled();
    expect(fakeLock.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('cleanupLegacyTodoistCopies', () => {
  function fakeCopyEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return { id: 'copy-id', iCalUID: 'copy-uid', ...overrides };
  }

  beforeEach(() => {
    getSrcUidMock.mockReturnValue(null);
    isInitialMatchedMock.mockReturnValue(false);
  });

  it('deletes an event with srcUid, no initialMatch, and a matching todoist/generated links row; removes the links row', () => {
    const event = fakeCopyEvent({ id: 'copy-id-1', iCalUID: 'copy-uid-1' });
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue('n-src-1');
    isInitialMatchedMock.mockReturnValue(false);
    readLinksMock.mockReturnValue([
      fakeLink({ calendar: 'todoist', iCalUID: 'copy-uid-1', srcUid: 'n-src-1', kind: 'generated' }),
    ]);

    cleanupLegacyTodoistCopies();

    expect(removeEventMock).toHaveBeenCalledWith('todoist-calendar-id', 'copy-id-1');
    expect(writeLinksMock).toHaveBeenCalledWith([]);
  });

  it('never deletes an event without srcUid (a real Todoist task event)', () => {
    const event = fakeCopyEvent();
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue(null);
    readLinksMock.mockReturnValue([
      fakeLink({ calendar: 'todoist', iCalUID: 'copy-uid', srcUid: 'n-src', kind: 'generated' }),
    ]);

    cleanupLegacyTodoistCopies();

    expect(removeEventMock).not.toHaveBeenCalled();
    expect(writeLinksMock).not.toHaveBeenCalled();
  });

  it('never deletes an initialMatch (paired) event even when it has srcUid and a generated links row exists', () => {
    const event = fakeCopyEvent();
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue('n-src');
    isInitialMatchedMock.mockReturnValue(true);
    readLinksMock.mockReturnValue([
      fakeLink({ calendar: 'todoist', iCalUID: 'copy-uid', srcUid: 'n-src', kind: 'generated' }),
    ]);

    cleanupLegacyTodoistCopies();

    expect(removeEventMock).not.toHaveBeenCalled();
    expect(writeLinksMock).not.toHaveBeenCalled();
  });

  it('never deletes an event with srcUid and no initialMatch when no matching todoist/generated links row exists', () => {
    const event = fakeCopyEvent();
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue('n-src');
    isInitialMatchedMock.mockReturnValue(false);
    readLinksMock.mockReturnValue([]);

    cleanupLegacyTodoistCopies();

    expect(removeEventMock).not.toHaveBeenCalled();
    expect(writeLinksMock).not.toHaveBeenCalled();
  });

  it('never deletes a paired links row even if calendar/iCalUID happen to match (kind must be generated)', () => {
    const event = fakeCopyEvent();
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue('n-src');
    isInitialMatchedMock.mockReturnValue(false);
    readLinksMock.mockReturnValue([fakeLink({ calendar: 'todoist', iCalUID: 'copy-uid', srcUid: 'n-src', kind: 'paired' })]);

    cleanupLegacyTodoistCopies();

    expect(removeEventMock).not.toHaveBeenCalled();
  });

  it('keeps unrelated links rows intact when deleting a legacy copy', () => {
    const event = fakeCopyEvent({ id: 'copy-id-1', iCalUID: 'copy-uid-1' });
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue('n-src-1');
    const unrelated = fakeLink({ calendar: 'primary', iCalUID: 'm-1', srcUid: 't-1', kind: 'generated' });
    readLinksMock.mockReturnValue([
      unrelated,
      fakeLink({ calendar: 'todoist', iCalUID: 'copy-uid-1', srcUid: 'n-src-1', kind: 'generated' }),
    ]);

    cleanupLegacyTodoistCopies();

    expect(writeLinksMock).toHaveBeenCalledWith([unrelated]);
  });

  it('throws when a legacy copy to delete has no id, without deleting anything', () => {
    const event = fakeCopyEvent({ id: undefined, iCalUID: 'copy-uid-1' });
    listFutureEventsMock.mockReturnValue([event]);
    getSrcUidMock.mockReturnValue('n-src-1');
    readLinksMock.mockReturnValue([
      fakeLink({ calendar: 'todoist', iCalUID: 'copy-uid-1', srcUid: 'n-src-1', kind: 'generated' }),
    ]);

    expect(() => cleanupLegacyTodoistCopies()).toThrow(/id/);
    expect(removeEventMock).not.toHaveBeenCalled();
    expect(writeLinksMock).not.toHaveBeenCalled();
  });

  it('throws when the lock is busy and does not touch links or events', () => {
    fakeLock.tryLock = vi.fn().mockReturnValue(false);

    expect(() => cleanupLegacyTodoistCopies()).toThrow();
    expect(listFutureEventsMock).not.toHaveBeenCalled();
    expect(removeEventMock).not.toHaveBeenCalled();
  });

  it('releases the lock and flushes the logger even when nothing is deleted', () => {
    listFutureEventsMock.mockReturnValue([]);
    readLinksMock.mockReturnValue([]);
    const loggerSpy = createFakeLogger();
    createLoggerMock.mockReturnValue(loggerSpy);

    cleanupLegacyTodoistCopies();

    expect(loggerSpy.flush).toHaveBeenCalledTimes(1);
    expect(fakeLock.releaseLock).toHaveBeenCalledTimes(1);
    expect(writeLinksMock).not.toHaveBeenCalled();
  });
});
