import { afterEach, describe, expect, it, vi } from 'vitest';
import { listFutureEvents, insertEvent, patchEvent, removeEvent, hasFutureInstance } from '../src/calendarGateway';
import type { CalendarEvent } from '../src/types';
import { INSTANCE_LOOKUP_MAX_RESULTS, LIST_PAGE_SIZE, SEND_UPDATES } from '../src/config';

/**
 * `Calendar` advanced service のうち、このモジュールが使う範囲だけを narrow に表現した型。
 * `GoogleAppsScript.Calendar` 全体（Acl / CalendarList など）を実装する必要はない。
 */
type ListOptionalArgs = {
  timeMin: string;
  singleEvents: boolean;
  showDeleted: boolean;
  maxResults: number;
  pageToken: string | undefined;
};

type WriteOptionalArgs = { sendUpdates: string };

type InstancesOptionalArgs = {
  timeMin: string;
  maxResults: number;
  showDeleted: boolean;
  pageToken: string | undefined;
};

type FakeEventsListResponse = { items?: CalendarEvent[]; nextPageToken?: string };

type FakeEventsCollection = {
  list(calendarId: string, optionalArgs: ListOptionalArgs): FakeEventsListResponse;
  insert(resource: CalendarEvent, calendarId: string, optionalArgs: WriteOptionalArgs): CalendarEvent;
  patch(resource: CalendarEvent, calendarId: string, eventId: string, optionalArgs: WriteOptionalArgs): CalendarEvent;
  remove(calendarId: string, eventId: string, optionalArgs: WriteOptionalArgs): void;
  instances(calendarId: string, eventId: string, optionalArgs: InstancesOptionalArgs): FakeEventsListResponse;
};

type FakeCalendarService = { Events: FakeEventsCollection };

function fakeEvent(id: string): CalendarEvent {
  return { id, iCalUID: `${id}@example.com` };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listFutureEvents', () => {
  it('concatenates items across 3 pages, and a page without items contributes nothing', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const list = vi.fn((_calendarId: string, optionalArgs: ListOptionalArgs): FakeEventsListResponse => {
      if (optionalArgs.pageToken === undefined) {
        return { items: [fakeEvent('a'), fakeEvent('b')], nextPageToken: 'token-2' };
      }
      if (optionalArgs.pageToken === 'token-2') {
        return { nextPageToken: 'token-3' }; // items が無いページ
      }
      if (optionalArgs.pageToken === 'token-3') {
        return { items: [fakeEvent('c')] };
      }
      throw new Error(`unexpected pageToken: ${optionalArgs.pageToken}`);
    });
    const fakeService: FakeCalendarService = {
      Events: {
        list,
        insert: vi.fn(),
        patch: vi.fn(),
        remove: vi.fn(),
        instances: vi.fn(),
      },
    };
    vi.stubGlobal('Calendar', fakeService);

    const result = listFutureEvents('cal-1', now);

    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenNthCalledWith(1, 'cal-1', {
      timeMin: now.toISOString(),
      singleEvents: false,
      showDeleted: false,
      maxResults: LIST_PAGE_SIZE,
      pageToken: undefined,
    });
    expect(list).toHaveBeenNthCalledWith(2, 'cal-1', {
      timeMin: now.toISOString(),
      singleEvents: false,
      showDeleted: false,
      maxResults: LIST_PAGE_SIZE,
      pageToken: 'token-2',
    });
    expect(list).toHaveBeenNthCalledWith(3, 'cal-1', {
      timeMin: now.toISOString(),
      singleEvents: false,
      showDeleted: false,
      maxResults: LIST_PAGE_SIZE,
      pageToken: 'token-3',
    });
  });

  it('returns an empty array when the single page has no items', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const list = vi.fn((): FakeEventsListResponse => ({}));
    const fakeService: FakeCalendarService = {
      Events: { list, insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), instances: vi.fn() },
    };
    vi.stubGlobal('Calendar', fakeService);

    expect(listFutureEvents('cal-1', now)).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('throws when the Calendar advanced service is not enabled', () => {
    vi.stubGlobal('Calendar', undefined);
    expect(() => listFutureEvents('cal-1', new Date())).toThrow();
  });
});

describe('insertEvent / patchEvent / removeEvent', () => {
  it('insertEvent calls Calendar.Events.insert with (resource, calendarId, { sendUpdates })', () => {
    const inserted = fakeEvent('new-1');
    const insert = vi.fn(() => inserted);
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert, patch: vi.fn(), remove: vi.fn(), instances: vi.fn() },
    };
    vi.stubGlobal('Calendar', fakeService);

    const resource: CalendarEvent = { summary: 'test' };
    const result = insertEvent('cal-1', resource);

    expect(result).toBe(inserted);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(resource, 'cal-1', { sendUpdates: SEND_UPDATES });
    expect(SEND_UPDATES).toBe('none');
  });

  it('patchEvent calls Calendar.Events.patch with (resource, calendarId, eventId, { sendUpdates })', () => {
    const patched = fakeEvent('e-1');
    const patch = vi.fn(() => patched);
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch, remove: vi.fn(), instances: vi.fn() },
    };
    vi.stubGlobal('Calendar', fakeService);

    const resource: CalendarEvent = { summary: 'updated' };
    const result = patchEvent('cal-1', 'e-1', resource);

    expect(result).toBe(patched);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(resource, 'cal-1', 'e-1', { sendUpdates: SEND_UPDATES });
  });

  it('removeEvent calls Calendar.Events.remove (not delete) with (calendarId, eventId, { sendUpdates })', () => {
    const remove = vi.fn();
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove, instances: vi.fn() },
    };
    vi.stubGlobal('Calendar', fakeService);

    removeEvent('cal-1', 'e-1');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('cal-1', 'e-1', { sendUpdates: SEND_UPDATES });
  });
});

describe('hasFutureInstance', () => {
  it('returns true when instances returns at least one item', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const instances = vi.fn((): FakeEventsListResponse => ({ items: [fakeEvent('a')] }));
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), instances },
    };
    vi.stubGlobal('Calendar', fakeService);

    expect(hasFutureInstance('cal-1', 'series-1', now)).toBe(true);
    expect(instances).toHaveBeenCalledTimes(1);
    expect(instances).toHaveBeenCalledWith('cal-1', 'series-1', {
      timeMin: now.toISOString(),
      maxResults: INSTANCE_LOOKUP_MAX_RESULTS,
      showDeleted: false,
    });
  });

  it('returns false when instances returns no items', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const instances = vi.fn((): FakeEventsListResponse => ({}));
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), instances },
    };
    vi.stubGlobal('Calendar', fakeService);

    expect(hasFutureInstance('cal-1', 'series-1', now)).toBe(false);
  });

  it('returns false when instances returns an empty items array', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const instances = vi.fn((): FakeEventsListResponse => ({ items: [] }));
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), instances },
    };
    vi.stubGlobal('Calendar', fakeService);

    expect(hasFutureInstance('cal-1', 'series-1', now)).toBe(false);
  });

  it('skips pages containing only cancelled instances and returns true when a later page has an active one', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const instances = vi.fn(
      (_calendarId: string, _eventId: string, optionalArgs: InstancesOptionalArgs): FakeEventsListResponse => {
        if (optionalArgs.pageToken === undefined) {
          return { items: [{ ...fakeEvent('a'), status: 'cancelled' }], nextPageToken: 'token-2' };
        }
        if (optionalArgs.pageToken === 'token-2') {
          return { items: [{ ...fakeEvent('b'), status: 'confirmed' }] };
        }
        throw new Error(`unexpected pageToken: ${optionalArgs.pageToken}`);
      },
    );
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), instances },
    };
    vi.stubGlobal('Calendar', fakeService);

    expect(hasFutureInstance('cal-1', 'series-1', now)).toBe(true);
    expect(instances).toHaveBeenCalledTimes(2);
    expect(instances.mock.calls[1][2].pageToken).toBe('token-2');
  });

  it('returns false when every page contains only cancelled instances', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const instances = vi.fn(
      (_calendarId: string, _eventId: string, optionalArgs: InstancesOptionalArgs): FakeEventsListResponse => {
        if (optionalArgs.pageToken === undefined) {
          return { items: [{ ...fakeEvent('a'), status: 'cancelled' }], nextPageToken: 'token-2' };
        }
        return { items: [{ ...fakeEvent('b'), status: 'cancelled' }] };
      },
    );
    const fakeService: FakeCalendarService = {
      Events: { list: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), instances },
    };
    vi.stubGlobal('Calendar', fakeService);

    expect(hasFutureInstance('cal-1', 'series-1', now)).toBe(false);
    expect(instances).toHaveBeenCalledTimes(2);
  });

  it('throws when the Calendar advanced service is not enabled', () => {
    vi.stubGlobal('Calendar', undefined);
    expect(() => hasFutureInstance('cal-1', 'series-1', new Date())).toThrow();
  });
});
