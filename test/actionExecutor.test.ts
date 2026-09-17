import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeActions } from '../src/actionExecutor';
import { insertEvent, patchEvent, removeEvent } from '../src/calendarGateway';
import { createTask, removeTask, updateTask } from '../src/todoistGateway';
import { buildInsertResource, buildUpdateResource, buildMarkResource, buildRepairResource, buildTodoistTaskPayload } from '../src/eventContent';
import type { Logger } from '../src/logger';
import type { CalendarEvent, CalendarRole, Direction, ExecutionResultAccumulator, SyncAction, TodoistTask } from '../src/types';

vi.mock('../src/calendarGateway', () => ({
  insertEvent: vi.fn(),
  patchEvent: vi.fn(),
  removeEvent: vi.fn(),
}));

vi.mock('../src/todoistGateway', () => ({
  createTask: vi.fn(),
  updateTask: vi.fn(),
  removeTask: vi.fn(),
}));

const insertEventMock = vi.mocked(insertEvent);
const patchEventMock = vi.mocked(patchEvent);
const removeEventMock = vi.mocked(removeEvent);
const createTaskMock = vi.mocked(createTask);
const updateTaskMock = vi.mocked(updateTask);
const removeTaskMock = vi.mocked(removeTask);

const calendarIds: Record<CalendarRole, string> = {
  primary: 'primary-calendar-id',
  todoist: 'todoist-calendar-id',
};

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
    flush(): void {
      // テストでは flush の内容を検証しない。
    },
  };
}

function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    summary: 'Meeting',
    start: { dateTime: '2026-09-16T10:00:00+09:00' },
    end: { dateTime: '2026-09-16T11:00:00+09:00' },
    iCalUID: 'src-uid@example.com',
    id: 'event-id',
    ...overrides,
  };
}

function fakeTask(overrides: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id: 'task-1',
    content: 'Meeting',
    due: { date: '2026-09-16T01:00:00Z', timezone: null },
    ...overrides,
  };
}

// executeActions の 4 番目の引数（result）用の空の accumulator を、テストごとに新しく作る。
function emptyResult(): ExecutionResultAccumulator {
  return { createdLinks: [], deletedKeys: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeActions', () => {
  it('returns an empty result and calls no gateway function for an empty action list', () => {
    const logger = createFakeLogger();
    const result = executeActions([], calendarIds, logger, emptyResult());

    expect(result).toEqual({ createdLinks: [], deletedKeys: [] });
    expect(insertEventMock).not.toHaveBeenCalled();
    expect(patchEventMock).not.toHaveBeenCalled();
    expect(removeEventMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(removeTaskMock).not.toHaveBeenCalled();
    expect(logger.calls).toEqual([]);
  });

  describe('create (primary / S1)', () => {
    it('calls insertEvent with buildInsertResource, records createdLinks (kind: generated), logs INFO', () => {
      const source = timedEvent({ iCalUID: 'src-create@example.com' });
      const action: SyncAction = { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source };
      insertEventMock.mockReturnValue({ iCalUID: 'generated-1@example.com' });

      const logger = createFakeLogger();
      const result = executeActions([action], calendarIds, logger, emptyResult());

      expect(insertEventMock).toHaveBeenCalledTimes(1);
      expect(insertEventMock).toHaveBeenCalledWith('primary-calendar-id', buildInsertResource('primary', source));
      expect(createTaskMock).not.toHaveBeenCalled();
      expect(result.createdLinks).toEqual([
        { calendar: 'primary', iCalUID: 'generated-1@example.com', srcUid: 'src-create@example.com', kind: 'generated' },
      ]);
      expect(result.deletedKeys).toEqual([]);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('INFO');
      expect(logger.calls[0].direction).toBe('T→P');
      expect(logger.calls[0].uid).toBe('src-create@example.com');
      expect(logger.calls[0].message).toContain('S1');
    });

    it('throws when the insertEvent response has no iCalUID', () => {
      const source = timedEvent({ iCalUID: 'src-create-2@example.com' });
      const action: SyncAction = { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source };
      insertEventMock.mockReturnValue({});

      const logger = createFakeLogger();
      expect(() => executeActions([action], calendarIds, logger, emptyResult())).toThrow();
    });

    it('throws before calling insertEvent when the source has no iCalUID', () => {
      const source = timedEvent({ iCalUID: undefined });
      const action: SyncAction = { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source };

      const logger = createFakeLogger();
      expect(() => executeActions([action], calendarIds, logger, emptyResult())).toThrow();
      expect(insertEventMock).not.toHaveBeenCalled();
    });
  });

  describe('create (todoist / S4)', () => {
    it('calls todoistGateway.createTask with buildTodoistTaskPayload, records createdLinks with todoistTaskId, logs INFO', () => {
      const source = timedEvent({ iCalUID: 'src-create-todoist@example.com', summary: 'Meeting from colleague' });
      const action: SyncAction = { kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source };
      const created = fakeTask({ id: 'created-task-1', content: 'Meeting from colleague' });
      createTaskMock.mockReturnValue(created);

      const logger = createFakeLogger();
      const result = executeActions([action], calendarIds, logger, emptyResult());

      expect(createTaskMock).toHaveBeenCalledTimes(1);
      expect(createTaskMock).toHaveBeenCalledWith(buildTodoistTaskPayload(source));
      expect(insertEventMock).not.toHaveBeenCalled();
      expect(result.createdLinks).toEqual([
        {
          calendar: 'todoist',
          iCalUID: '',
          srcUid: 'src-create-todoist@example.com',
          kind: 'generated',
          todoistTaskId: 'created-task-1',
        },
      ]);
      expect(result.deletedKeys).toEqual([]);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('INFO');
      expect(logger.calls[0].direction).toBe('P→T');
      expect(logger.calls[0].uid).toBe('src-create-todoist@example.com');
      expect(logger.calls[0].message).toContain('S4');
    });

    it('throws before calling createTask when the source has no iCalUID', () => {
      const source = timedEvent({ iCalUID: undefined });
      const action: SyncAction = { kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source };

      const logger = createFakeLogger();
      expect(() => executeActions([action], calendarIds, logger, emptyResult())).toThrow();
      expect(createTaskMock).not.toHaveBeenCalled();
    });

    it('propagates the error thrown by buildTodoistTaskPayload when the source has no summary', () => {
      const source = timedEvent({ summary: undefined });
      const action: SyncAction = { kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source };

      const logger = createFakeLogger();
      expect(() => executeActions([action], calendarIds, logger, emptyResult())).toThrow();
      expect(createTaskMock).not.toHaveBeenCalled();
    });
  });

  describe('update (primary / S2)', () => {
    it('calls patchEvent with buildUpdateResource at target.id, logs INFO with source iCalUID', () => {
      const source = timedEvent({ iCalUID: 'src-update@example.com', summary: 'Renamed' });
      const target = timedEvent({ id: 'target-update-1' });
      const action: SyncAction = {
        kind: 'update',
        rule: 'S2',
        direction: 'T→P',
        calendar: 'primary',
        source,
        target,
      };
      patchEventMock.mockReturnValue(timedEvent());

      const logger = createFakeLogger();
      const result = executeActions([action], calendarIds, logger, emptyResult());

      expect(patchEventMock).toHaveBeenCalledTimes(1);
      expect(patchEventMock).toHaveBeenCalledWith(
        'primary-calendar-id',
        'target-update-1',
        buildUpdateResource('primary', source),
      );
      expect(updateTaskMock).not.toHaveBeenCalled();
      expect(result.createdLinks).toEqual([]);
      expect(result.deletedKeys).toEqual([]);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('INFO');
      expect(logger.calls[0].uid).toBe('src-update@example.com');
      expect(logger.calls[0].message).toContain('S2');
    });

    it('throws when target.id is missing', () => {
      const source = timedEvent({ iCalUID: 'src-update-2@example.com' });
      const target = timedEvent({ id: undefined });
      const action: SyncAction = { kind: 'update', rule: 'S2', direction: 'T→P', calendar: 'primary', source, target };

      const logger = createFakeLogger();
      expect(() => executeActions([action], calendarIds, logger, emptyResult())).toThrow();
      expect(patchEventMock).not.toHaveBeenCalled();
    });
  });

  describe('update (todoist / S5)', () => {
    it('calls todoistGateway.updateTask(todoistTaskId, buildTodoistTaskPayload), logs INFO with source iCalUID', () => {
      const source = timedEvent({ iCalUID: 'src-update-todoist@example.com', summary: 'Updated title' });
      const action: SyncAction = {
        kind: 'update',
        rule: 'S5',
        direction: 'P→T',
        calendar: 'todoist',
        source,
        todoistTaskId: 'task-to-update',
      };
      updateTaskMock.mockReturnValue(fakeTask({ id: 'task-to-update' }));

      const logger = createFakeLogger();
      const result = executeActions([action], calendarIds, logger, emptyResult());

      expect(updateTaskMock).toHaveBeenCalledTimes(1);
      expect(updateTaskMock).toHaveBeenCalledWith('task-to-update', buildTodoistTaskPayload(source));
      expect(patchEventMock).not.toHaveBeenCalled();
      expect(result.createdLinks).toEqual([]);
      expect(result.deletedKeys).toEqual([]);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('INFO');
      expect(logger.calls[0].direction).toBe('P→T');
      expect(logger.calls[0].uid).toBe('src-update-todoist@example.com');
      expect(logger.calls[0].message).toContain('S5');
      expect(logger.calls[0].message).toContain('task-to-update');
    });

    it('throws before calling updateTask when the source has no iCalUID', () => {
      const source = timedEvent({ iCalUID: undefined });
      const action: SyncAction = {
        kind: 'update',
        rule: 'S5',
        direction: 'P→T',
        calendar: 'todoist',
        source,
        todoistTaskId: 'task-x',
      };

      const logger = createFakeLogger();
      expect(() => executeActions([action], calendarIds, logger, emptyResult())).toThrow();
      expect(updateTaskMock).not.toHaveBeenCalled();
    });
  });

  describe('delete (primary / S3, S3D)', () => {
    it('calls removeEvent(calendarId, target.id), records deletedKeys, logs INFO with srcUid', () => {
      const target = timedEvent({ id: 'target-delete-1', iCalUID: 'target-uid-delete@example.com' });
      const action: SyncAction = {
        kind: 'delete',
        rule: 'S3',
        direction: 'T→P',
        calendar: 'primary',
        target,
        srcUid: 'src-delete@example.com',
      };

      const logger = createFakeLogger();
      const result = executeActions([action], calendarIds, logger, emptyResult());

      expect(removeEventMock).toHaveBeenCalledTimes(1);
      expect(removeEventMock).toHaveBeenCalledWith('primary-calendar-id', 'target-delete-1');
      expect(removeTaskMock).not.toHaveBeenCalled();
      expect(result.deletedKeys).toEqual(['primary:target-uid-delete@example.com']);
      expect(result.createdLinks).toEqual([]);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('INFO');
      expect(logger.calls[0].uid).toBe('src-delete@example.com');
      expect(logger.calls[0].message).toContain('S3');
    });

    it('throws when target.id or target.iCalUID is missing', () => {
      const missingId = timedEvent({ id: undefined, iCalUID: 'target-uid@example.com' });
      const actionMissingId: SyncAction = {
        kind: 'delete',
        rule: 'S3',
        direction: 'T→P',
        calendar: 'primary',
        target: missingId,
        srcUid: 'src@example.com',
      };
      expect(() => executeActions([actionMissingId], calendarIds, createFakeLogger(), emptyResult())).toThrow();

      const missingUid = timedEvent({ id: 'target-id', iCalUID: undefined });
      const actionMissingUid: SyncAction = {
        kind: 'delete',
        rule: 'S3',
        direction: 'T→P',
        calendar: 'primary',
        target: missingUid,
        srcUid: 'src@example.com',
      };
      expect(() => executeActions([actionMissingUid], calendarIds, createFakeLogger(), emptyResult())).toThrow();
      expect(removeEventMock).not.toHaveBeenCalled();
    });
  });

  describe('delete (todoist / S6, S6D)', () => {
    it('calls todoistGateway.removeTask(todoistTaskId), records deletedKeys as todoist:<todoistTaskId>, logs INFO with srcUid', () => {
      const action: SyncAction = {
        kind: 'delete',
        rule: 'S6',
        direction: 'P→T',
        calendar: 'todoist',
        todoistTaskId: 'task-to-delete',
        srcUid: 'src-delete-todoist@example.com',
      };

      const logger = createFakeLogger();
      const result = executeActions([action], calendarIds, logger, emptyResult());

      expect(removeTaskMock).toHaveBeenCalledTimes(1);
      expect(removeTaskMock).toHaveBeenCalledWith('task-to-delete');
      expect(removeEventMock).not.toHaveBeenCalled();
      expect(result.deletedKeys).toEqual(['todoist:task-to-delete']);
      expect(result.createdLinks).toEqual([]);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('INFO');
      expect(logger.calls[0].direction).toBe('P→T');
      expect(logger.calls[0].uid).toBe('src-delete-todoist@example.com');
      expect(logger.calls[0].message).toContain('S6');
      expect(logger.calls[0].message).toContain('task-to-delete');
    });

    it('does not require calendarIds.todoist to identify the target (no CalendarEvent involved)', () => {
      const action: SyncAction = {
        kind: 'delete',
        rule: 'S6D',
        direction: 'P→T',
        calendar: 'todoist',
        todoistTaskId: 'task-dup',
        srcUid: 'src-dup@example.com',
      };

      const result = executeActions([action], calendarIds, createFakeLogger(), emptyResult());

      expect(removeTaskMock).toHaveBeenCalledWith('task-dup');
      expect(result.deletedKeys).toEqual(['todoist:task-dup']);
    });
  });

  it('mark: calls patchEvent with buildMarkResource(srcUid), logs INFO with direction INIT and target iCalUID', () => {
    const target = timedEvent({ id: 'target-mark-1', iCalUID: 'target-uid-mark@example.com' });
    const action: SyncAction = {
      kind: 'mark',
      rule: 'INIT',
      direction: 'INIT',
      calendar: 'primary',
      target,
      srcUid: 'src-mark@example.com',
    };
    patchEventMock.mockReturnValue(timedEvent());

    const logger = createFakeLogger();
    const result = executeActions([action], calendarIds, logger, emptyResult());

    expect(patchEventMock).toHaveBeenCalledTimes(1);
    expect(patchEventMock).toHaveBeenCalledWith(
      'primary-calendar-id',
      'target-mark-1',
      buildMarkResource('src-mark@example.com'),
    );
    expect(result.createdLinks).toEqual([]);
    expect(result.deletedKeys).toEqual([]);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].level).toBe('INFO');
    expect(logger.calls[0].direction).toBe('INIT');
    expect(logger.calls[0].uid).toBe('target-uid-mark@example.com');
  });

  it('mark: throws when target.id is missing', () => {
    const target = timedEvent({ id: undefined, iCalUID: 'target-uid@example.com' });
    const action: SyncAction = {
      kind: 'mark',
      rule: 'INIT',
      direction: 'INIT',
      calendar: 'primary',
      target,
      srcUid: 'src@example.com',
    };
    expect(() => executeActions([action], calendarIds, createFakeLogger(), emptyResult())).toThrow();
    expect(patchEventMock).not.toHaveBeenCalled();
  });

  it('repair: calls patchEvent with buildRepairResource(srcUid, linkKind), logs WARN (only repair does) including rule and linkKind', () => {
    const target = timedEvent({ id: 'target-repair-1', iCalUID: 'target-uid-repair@example.com' });
    const action: SyncAction = {
      kind: 'repair',
      rule: 'REPAIR',
      direction: 'REPAIR',
      calendar: 'todoist',
      target,
      srcUid: 'src-repair@example.com',
      linkKind: 'paired',
    };
    patchEventMock.mockReturnValue(timedEvent());

    const logger = createFakeLogger();
    const result = executeActions([action], calendarIds, logger, emptyResult());

    expect(patchEventMock).toHaveBeenCalledTimes(1);
    expect(patchEventMock).toHaveBeenCalledWith(
      'todoist-calendar-id',
      'target-repair-1',
      buildRepairResource('src-repair@example.com', 'paired'),
    );
    expect(result.createdLinks).toEqual([]);
    expect(result.deletedKeys).toEqual([]);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].level).toBe('WARN');
    expect(logger.calls[0].direction).toBe('REPAIR');
    expect(logger.calls[0].uid).toBe('target-uid-repair@example.com');
    expect(logger.calls[0].message).toContain('REPAIR');
    expect(logger.calls[0].message).toContain('paired');
  });

  it('repair: throws when target.id is missing', () => {
    const target = timedEvent({ id: undefined, iCalUID: 'target-uid@example.com' });
    const action: SyncAction = {
      kind: 'repair',
      rule: 'REPAIR',
      direction: 'REPAIR',
      calendar: 'todoist',
      target,
      srcUid: 'src@example.com',
      linkKind: 'generated',
    };
    expect(() => executeActions([action], calendarIds, createFakeLogger(), emptyResult())).toThrow();
    expect(patchEventMock).not.toHaveBeenCalled();
  });

  it('preserves action order across gateway calls and log entries (mixing primary and todoist actions)', () => {
    const callOrder: string[] = [];
    insertEventMock.mockImplementation(() => {
      callOrder.push('insert');
      return { iCalUID: 'generated-order@example.com' };
    });
    patchEventMock.mockImplementation(() => {
      callOrder.push('patch');
      return timedEvent();
    });
    removeEventMock.mockImplementation(() => {
      callOrder.push('remove');
    });
    removeTaskMock.mockImplementation(() => {
      callOrder.push('removeTask');
    });

    const createAction: SyncAction = {
      kind: 'create',
      rule: 'S1',
      direction: 'T→P',
      calendar: 'primary',
      source: timedEvent({ iCalUID: 'order-src-1@example.com' }),
    };
    const updateAction: SyncAction = {
      kind: 'update',
      rule: 'S2',
      direction: 'T→P',
      calendar: 'primary',
      source: timedEvent({ iCalUID: 'order-src-2@example.com' }),
      target: timedEvent({ id: 'order-target-2' }),
    };
    const deleteAction: SyncAction = {
      kind: 'delete',
      rule: 'S3',
      direction: 'T→P',
      calendar: 'primary',
      target: timedEvent({ id: 'order-target-3', iCalUID: 'order-target-uid-3@example.com' }),
      srcUid: 'order-src-3@example.com',
    };
    const todoistDeleteAction: SyncAction = {
      kind: 'delete',
      rule: 'S6',
      direction: 'P→T',
      calendar: 'todoist',
      todoistTaskId: 'order-task-4',
      srcUid: 'order-src-4@example.com',
    };

    const logger = createFakeLogger();
    executeActions([createAction, updateAction, deleteAction, todoistDeleteAction], calendarIds, logger, emptyResult());

    expect(callOrder).toEqual(['insert', 'patch', 'remove', 'removeTask']);
    expect(logger.calls.map((call) => call.uid)).toEqual([
      'order-src-1@example.com',
      'order-src-2@example.com',
      'order-src-3@example.com',
      'order-src-4@example.com',
    ]);
  });

  it('propagates an API error thrown mid-way, keeping earlier logs in the logger buffer', () => {
    insertEventMock.mockReturnValue({ iCalUID: 'generated-midway@example.com' });
    patchEventMock.mockImplementation(() => {
      throw new Error('API failure');
    });

    const createAction: SyncAction = {
      kind: 'create',
      rule: 'S1',
      direction: 'T→P',
      calendar: 'primary',
      source: timedEvent({ iCalUID: 'midway-src-1@example.com' }),
    };
    const updateAction: SyncAction = {
      kind: 'update',
      rule: 'S2',
      direction: 'T→P',
      calendar: 'primary',
      source: timedEvent({ iCalUID: 'midway-src-2@example.com' }),
      target: timedEvent({ id: 'midway-target-2' }),
    };

    const logger = createFakeLogger();
    expect(() => executeActions([createAction, updateAction], calendarIds, logger, emptyResult())).toThrow('API failure');

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].uid).toBe('midway-src-1@example.com');
    expect(removeEventMock).not.toHaveBeenCalled();
  });

  it('keeps the createdLinks recorded before a later action throws, in the result passed by the caller', () => {
    insertEventMock.mockReturnValue({ iCalUID: 'generated-before-throw@example.com' });
    createTaskMock.mockReturnValue(fakeTask({ id: 'task-before-throw' }));
    patchEventMock.mockImplementation(() => {
      throw new Error('API failure');
    });

    const createEventAction: SyncAction = {
      kind: 'create',
      rule: 'S1',
      direction: 'T→P',
      calendar: 'primary',
      source: timedEvent({ iCalUID: 'before-throw-src-1@example.com' }),
    };
    const createTaskAction: SyncAction = {
      kind: 'create',
      rule: 'S4',
      direction: 'P→T',
      calendar: 'todoist',
      source: timedEvent({ iCalUID: 'before-throw-src-2@example.com' }),
    };
    const updateAction: SyncAction = {
      kind: 'update',
      rule: 'S2',
      direction: 'T→P',
      calendar: 'primary',
      source: timedEvent({ iCalUID: 'before-throw-src-3@example.com' }),
      target: timedEvent({ id: 'before-throw-target-3' }),
    };

    const result = emptyResult();
    expect(() =>
      executeActions([createEventAction, createTaskAction, updateAction], calendarIds, createFakeLogger(), result),
    ).toThrow('API failure');

    // update で throw する前に成功した 2 件の create は、呼び出し元が渡した result にそのまま残る。
    expect(result.createdLinks).toEqual([
      { calendar: 'primary', iCalUID: 'generated-before-throw@example.com', srcUid: 'before-throw-src-1@example.com', kind: 'generated' },
      {
        calendar: 'todoist',
        iCalUID: '',
        srcUid: 'before-throw-src-2@example.com',
        kind: 'generated',
        todoistTaskId: 'task-before-throw',
      },
    ]);
  });
});
