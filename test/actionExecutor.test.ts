import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeActions } from '../src/actionExecutor';
import { insertEvent, patchEvent, removeEvent } from '../src/calendarGateway';
import { buildInsertResource, buildUpdateResource, buildMarkResource, buildRepairResource } from '../src/eventContent';
import type { Logger } from '../src/logger';
import type { CalendarEvent, CalendarRole, Direction, SyncAction } from '../src/types';

vi.mock('../src/calendarGateway', () => ({
  insertEvent: vi.fn(),
  patchEvent: vi.fn(),
  removeEvent: vi.fn(),
}));

const insertEventMock = vi.mocked(insertEvent);
const patchEventMock = vi.mocked(patchEvent);
const removeEventMock = vi.mocked(removeEvent);

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeActions', () => {
  it('returns an empty result and calls no gateway function for an empty action list', () => {
    const logger = createFakeLogger();
    const result = executeActions([], calendarIds, logger);

    expect(result).toEqual({ createdLinks: [], deletedKeys: [] });
    expect(insertEventMock).not.toHaveBeenCalled();
    expect(patchEventMock).not.toHaveBeenCalled();
    expect(removeEventMock).not.toHaveBeenCalled();
    expect(logger.calls).toEqual([]);
  });

  it('create: calls insertEvent with buildInsertResource, records createdLinks (kind: generated), logs INFO', () => {
    const source = timedEvent({ iCalUID: 'src-create@example.com' });
    const action: SyncAction = { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source };
    insertEventMock.mockReturnValue({ iCalUID: 'generated-1@example.com' });

    const logger = createFakeLogger();
    const result = executeActions([action], calendarIds, logger);

    expect(insertEventMock).toHaveBeenCalledTimes(1);
    expect(insertEventMock).toHaveBeenCalledWith('primary-calendar-id', buildInsertResource('primary', source));
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

  it('create: throws when the insertEvent response has no iCalUID', () => {
    const source = timedEvent({ iCalUID: 'src-create-2@example.com' });
    const action: SyncAction = { kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source };
    insertEventMock.mockReturnValue({});

    const logger = createFakeLogger();
    expect(() => executeActions([action], calendarIds, logger)).toThrow();
  });

  it('create: throws before calling insertEvent when the source has no iCalUID', () => {
    const source = timedEvent({ iCalUID: undefined });
    const action: SyncAction = { kind: 'create', rule: 'S1', direction: 'T→P', calendar: 'primary', source };

    const logger = createFakeLogger();
    expect(() => executeActions([action], calendarIds, logger)).toThrow();
    expect(insertEventMock).not.toHaveBeenCalled();
  });

  it('update: calls patchEvent with buildUpdateResource at target.id, logs INFO with source iCalUID', () => {
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
    const result = executeActions([action], calendarIds, logger);

    expect(patchEventMock).toHaveBeenCalledTimes(1);
    expect(patchEventMock).toHaveBeenCalledWith(
      'primary-calendar-id',
      'target-update-1',
      buildUpdateResource('primary', source),
    );
    expect(result.createdLinks).toEqual([]);
    expect(result.deletedKeys).toEqual([]);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].level).toBe('INFO');
    expect(logger.calls[0].uid).toBe('src-update@example.com');
    expect(logger.calls[0].message).toContain('S2');
  });

  it('update: throws when target.id is missing', () => {
    const source = timedEvent({ iCalUID: 'src-update-2@example.com' });
    const target = timedEvent({ id: undefined });
    const action: SyncAction = { kind: 'update', rule: 'S5', direction: 'P→T', calendar: 'todoist', source, target };

    const logger = createFakeLogger();
    expect(() => executeActions([action], calendarIds, logger)).toThrow();
    expect(patchEventMock).not.toHaveBeenCalled();
  });

  it('delete: calls removeEvent(calendarId, target.id), records deletedKeys, logs INFO with srcUid', () => {
    const target = timedEvent({ id: 'target-delete-1', iCalUID: 'target-uid-delete@example.com' });
    const action: SyncAction = {
      kind: 'delete',
      rule: 'S3',
      direction: 'T→P',
      calendar: 'todoist',
      target,
      srcUid: 'src-delete@example.com',
    };

    const logger = createFakeLogger();
    const result = executeActions([action], calendarIds, logger);

    expect(removeEventMock).toHaveBeenCalledTimes(1);
    expect(removeEventMock).toHaveBeenCalledWith('todoist-calendar-id', 'target-delete-1');
    expect(result.deletedKeys).toEqual(['todoist:target-uid-delete@example.com']);
    expect(result.createdLinks).toEqual([]);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].level).toBe('INFO');
    expect(logger.calls[0].uid).toBe('src-delete@example.com');
    expect(logger.calls[0].message).toContain('S3');
  });

  it('delete: throws when target.id or target.iCalUID is missing', () => {
    const missingId = timedEvent({ id: undefined, iCalUID: 'target-uid@example.com' });
    const actionMissingId: SyncAction = {
      kind: 'delete',
      rule: 'S6',
      direction: 'P→T',
      calendar: 'primary',
      target: missingId,
      srcUid: 'src@example.com',
    };
    expect(() => executeActions([actionMissingId], calendarIds, createFakeLogger())).toThrow();

    const missingUid = timedEvent({ id: 'target-id', iCalUID: undefined });
    const actionMissingUid: SyncAction = {
      kind: 'delete',
      rule: 'S6',
      direction: 'P→T',
      calendar: 'primary',
      target: missingUid,
      srcUid: 'src@example.com',
    };
    expect(() => executeActions([actionMissingUid], calendarIds, createFakeLogger())).toThrow();
    expect(removeEventMock).not.toHaveBeenCalled();
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
    const result = executeActions([action], calendarIds, logger);

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
    expect(() => executeActions([action], calendarIds, createFakeLogger())).toThrow();
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
    const result = executeActions([action], calendarIds, logger);

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
    expect(() => executeActions([action], calendarIds, createFakeLogger())).toThrow();
    expect(patchEventMock).not.toHaveBeenCalled();
  });

  it('preserves action order across gateway calls and log entries', () => {
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
      calendar: 'todoist',
      target: timedEvent({ id: 'order-target-3', iCalUID: 'order-target-uid-3@example.com' }),
      srcUid: 'order-src-3@example.com',
    };

    const logger = createFakeLogger();
    executeActions([createAction, updateAction, deleteAction], calendarIds, logger);

    expect(callOrder).toEqual(['insert', 'patch', 'remove']);
    expect(logger.calls.map((call) => call.uid)).toEqual([
      'order-src-1@example.com',
      'order-src-2@example.com',
      'order-src-3@example.com',
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
    expect(() => executeActions([createAction, updateAction], calendarIds, logger)).toThrow('API failure');

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].uid).toBe('midway-src-1@example.com');
    expect(removeEventMock).not.toHaveBeenCalled();
  });
});
