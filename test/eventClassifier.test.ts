import { describe, expect, it, vi } from 'vitest';
import {
  classify,
  getSrcUid,
  isDeclinedBySelf,
  isInitialMatched,
  isRecurringException,
} from '../src/eventClassifier';
import { INITIAL_MATCH_KEY, INITIAL_MATCH_VALUE, SRC_UID_KEY } from '../src/config';
import type { CalendarEvent, CalendarRole, LinkEntry } from '../src/types';

let sequence = 0;

function nextICalUID(): string {
  sequence += 1;
  return `ical-${sequence}@example.com`;
}

type EventOptions = {
  iCalUID?: string;
  srcUid?: string;
  initialMatch?: string;
  recurringEventId?: string;
  eventType?: string;
  attendees?: GoogleAppsScript.Calendar.Schema.EventAttendee[];
  extraPrivate?: Record<string, string>;
  recurrence?: string[];
};

function buildEvent(options: EventOptions = {}): CalendarEvent {
  const privateProps: Record<string, string> = { ...options.extraPrivate };
  if (options.srcUid !== undefined) {
    privateProps[SRC_UID_KEY] = options.srcUid;
  }
  if (options.initialMatch !== undefined) {
    privateProps[INITIAL_MATCH_KEY] = options.initialMatch;
  }
  const event: CalendarEvent = {
    iCalUID: options.iCalUID ?? nextICalUID(),
  };
  if (Object.keys(privateProps).length > 0) {
    event.extendedProperties = { private: privateProps };
  }
  if (options.recurringEventId !== undefined) {
    event.recurringEventId = options.recurringEventId;
  }
  if (options.eventType !== undefined) {
    // @types/google-apps-script の eventType は 'default' | 'outOfOffice' | 'focusTime' | 'workingLocation'
    // のみを宣言しており、design.md が言及する 'birthday' / 'fromGmail' を含まない。
    // フィクスチャ用に、その値だけをこの型へ変換する。
    event.eventType = options.eventType as CalendarEvent['eventType'];
  }
  if (options.attendees !== undefined) {
    event.attendees = options.attendees;
  }
  if (options.recurrence !== undefined) {
    event.recurrence = options.recurrence;
  }
  return event;
}

/**
 * 未来回判定の既定フェイク。常に true を返す（従来どおり除外しない）。
 */
function alwaysHasFutureOccurrence(): boolean {
  return true;
}

function buildLink(options: {
  calendar: CalendarRole;
  iCalUID: string;
  srcUid: string;
  kind: LinkEntry['kind'];
}): LinkEntry {
  return {
    calendar: options.calendar,
    iCalUID: options.iCalUID,
    srcUid: options.srcUid,
    kind: options.kind,
    recordedAt: new Date('2026-09-15T00:00:00Z'),
  };
}

describe('getSrcUid', () => {
  it('returns the srcUid string when present', () => {
    const event = buildEvent({ srcUid: 'src-1' });
    expect(getSrcUid(event)).toBe('src-1');
  });

  it('returns null when extendedProperties.private is absent', () => {
    const event = buildEvent();
    expect(getSrcUid(event)).toBeNull();
  });

  it('returns null when srcUid is an empty string', () => {
    const event = buildEvent({ srcUid: '' });
    expect(getSrcUid(event)).toBeNull();
  });
});

describe('isInitialMatched', () => {
  it('returns true when initialMatch equals INITIAL_MATCH_VALUE', () => {
    const event = buildEvent({ initialMatch: INITIAL_MATCH_VALUE });
    expect(isInitialMatched(event)).toBe(true);
  });

  it('returns false when initialMatch has a different value', () => {
    const event = buildEvent({ initialMatch: 'false' });
    expect(isInitialMatched(event)).toBe(false);
  });

  it('returns false when initialMatch is absent', () => {
    const event = buildEvent();
    expect(isInitialMatched(event)).toBe(false);
  });
});

describe('isRecurringException', () => {
  it('returns true when recurringEventId is a non-empty string', () => {
    const event = buildEvent({ recurringEventId: 'parent-1' });
    expect(isRecurringException(event)).toBe(true);
  });

  it('returns false when recurringEventId is absent', () => {
    const event = buildEvent();
    expect(isRecurringException(event)).toBe(false);
  });
});

describe('isDeclinedBySelf', () => {
  it('returns true when the self attendee declined', () => {
    const event = buildEvent({
      attendees: [{ self: true, responseStatus: 'declined' }],
    });
    expect(isDeclinedBySelf(event)).toBe(true);
  });

  it('returns false when the self attendee has a different responseStatus', () => {
    const event = buildEvent({
      attendees: [{ self: true, responseStatus: 'accepted' }],
    });
    expect(isDeclinedBySelf(event)).toBe(false);
  });

  it('returns false when no attendee has self: true', () => {
    const event = buildEvent({
      attendees: [{ self: false, responseStatus: 'declined' }],
    });
    expect(isDeclinedBySelf(event)).toBe(false);
  });

  it('returns false when attendees is undefined', () => {
    const event = buildEvent();
    expect(isDeclinedBySelf(event)).toBe(false);
  });
});

describe('classify - rule 1 (recurring exception)', () => {
  it('excludes a cancelled recurring exception instance for primary', () => {
    const event = buildEvent({ recurringEventId: 'series-1', eventType: 'default' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
    expect(result.observedLinks).toHaveLength(0);
  });

  it('excludes a recurring exception instance even when it carries a srcUid (priority over rule 5)', () => {
    const event = buildEvent({ recurringEventId: 'series-1', srcUid: 'src-1' });
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
    expect(result.observedLinks).toHaveLength(0);
  });
});

describe('classify - rule 2 (initialMatch present)', () => {
  it('treats a todoist event with initialMatch and srcUid as paired, not generated', () => {
    const event = buildEvent({ initialMatch: INITIAL_MATCH_VALUE, srcUid: 'partner-uid' });
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
    expect(result.repairs).toHaveLength(0);
    expect(result.observedLinks).toEqual([
      { calendar: 'todoist', iCalUID: event.iCalUID, srcUid: 'partner-uid', kind: 'paired' },
    ]);
  });

  it('treats a primary event with initialMatch and srcUid as paired, not generated', () => {
    const event = buildEvent({ initialMatch: INITIAL_MATCH_VALUE, srcUid: 'partner-uid' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
    expect(result.observedLinks[0]?.kind).toBe('paired');
  });

  it('falls back to the links row srcUid and creates a repair when srcUid is missing but a paired links row exists', () => {
    const event = buildEvent({ initialMatch: INITIAL_MATCH_VALUE });
    const link = buildLink({ calendar: 'todoist', iCalUID: event.iCalUID as string, srcUid: 'from-links', kind: 'paired' });
    const result = classify('todoist', [event], [link], alwaysHasFutureOccurrence);
    expect(result.observedLinks).toEqual([
      { calendar: 'todoist', iCalUID: event.iCalUID, srcUid: 'from-links', kind: 'paired' },
    ]);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({
      kind: 'repair',
      rule: 'REPAIR',
      direction: 'REPAIR',
      calendar: 'todoist',
      target: event,
      srcUid: 'from-links',
      linkKind: 'paired',
    });
  });

  it('throws when initialMatch is present but neither srcUid nor a links row exists', () => {
    const event = buildEvent({ initialMatch: INITIAL_MATCH_VALUE });
    expect(() => classify('todoist', [event], [], alwaysHasFutureOccurrence)).toThrow();
  });
});

describe('classify - rule 3 (lost initialMatch, paired links row)', () => {
  it('is a key regression case: srcUid still present + paired links row => paired + repair, NOT generated', () => {
    const event = buildEvent({ srcUid: 'partner-uid' });
    const link = buildLink({ calendar: 'primary', iCalUID: event.iCalUID as string, srcUid: 'partner-uid', kind: 'paired' });
    const result = classify('primary', [event], [link], alwaysHasFutureOccurrence);

    expect(result.generated).toHaveLength(0);
    expect(result.origins).toHaveLength(0);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({
      kind: 'repair',
      rule: 'REPAIR',
      direction: 'REPAIR',
      calendar: 'primary',
      target: event,
      srcUid: 'partner-uid',
      linkKind: 'paired',
    });
    expect(result.observedLinks).toEqual([
      { calendar: 'primary', iCalUID: event.iCalUID, srcUid: 'partner-uid', kind: 'paired' },
    ]);
  });

  it('applies the same regression case for todoist', () => {
    const event = buildEvent({ srcUid: 'partner-uid' });
    const link = buildLink({ calendar: 'todoist', iCalUID: event.iCalUID as string, srcUid: 'partner-uid', kind: 'paired' });
    const result = classify('todoist', [event], [link], alwaysHasFutureOccurrence);
    expect(result.generated).toHaveLength(0);
    expect(result.repairs[0]).toMatchObject({ linkKind: 'paired' });
  });

  it('does not match a paired links row recorded for the other calendar', () => {
    const event = buildEvent({ srcUid: 'partner-uid' });
    const link = buildLink({ calendar: 'todoist', iCalUID: event.iCalUID as string, srcUid: 'partner-uid', kind: 'paired' });
    // classify as primary: the links row belongs to 'todoist' and must not match
    const result = classify('primary', [event], [link], alwaysHasFutureOccurrence);
    expect(result.repairs).toHaveLength(0);
    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]?.srcUid).toBe('partner-uid');
  });
});

describe('classify - rule 4 (generated links row, srcUid lost)', () => {
  it('restores a generated todoist event that lost its srcUid and creates a repair', () => {
    const event = buildEvent({});
    const link = buildLink({ calendar: 'todoist', iCalUID: event.iCalUID as string, srcUid: 'origin-uid', kind: 'generated' });
    const result = classify('todoist', [event], [link], alwaysHasFutureOccurrence);

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]).toEqual({ event, srcUid: 'origin-uid' });
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({
      kind: 'repair',
      linkKind: 'generated',
      srcUid: 'origin-uid',
      calendar: 'todoist',
      target: event,
    });
    expect(result.observedLinks).toEqual([
      { calendar: 'todoist', iCalUID: event.iCalUID, srcUid: 'origin-uid', kind: 'generated' },
    ]);
  });

  it('restores a mirrored primary event (M) that lost its srcUid and creates a repair', () => {
    const event = buildEvent({});
    const link = buildLink({ calendar: 'primary', iCalUID: event.iCalUID as string, srcUid: 'origin-uid', kind: 'generated' });
    const result = classify('primary', [event], [link], alwaysHasFutureOccurrence);
    expect(result.generated).toHaveLength(1);
    expect(result.repairs[0]).toMatchObject({ linkKind: 'generated' });
  });

  it('does not apply rule 4 when the event still has its own srcUid (goes to rule 5 instead, no repair)', () => {
    const event = buildEvent({ srcUid: 'still-here' });
    const link = buildLink({ calendar: 'todoist', iCalUID: event.iCalUID as string, srcUid: 'from-links', kind: 'generated' });
    const result = classify('todoist', [event], [link], alwaysHasFutureOccurrence);
    expect(result.repairs).toHaveLength(0);
    expect(result.generated).toEqual([{ event, srcUid: 'still-here' }]);
  });
});

describe('classify - rule 5 (srcUid present)', () => {
  it('classifies a todoist event with srcUid as C (generated)', () => {
    const event = buildEvent({ srcUid: 'origin-uid' });
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.generated).toEqual([{ event, srcUid: 'origin-uid' }]);
    expect(result.origins).toHaveLength(0);
    expect(result.observedLinks).toEqual([
      { calendar: 'todoist', iCalUID: event.iCalUID, srcUid: 'origin-uid', kind: 'generated' },
    ]);
  });

  it('classifies a primary event with srcUid as M (generated)', () => {
    const event = buildEvent({ srcUid: 'origin-uid' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.generated).toEqual([{ event, srcUid: 'origin-uid' }]);
    expect(result.origins).toHaveLength(0);
  });
});

describe('classify - rule 6 (primary eventType not in ORIGIN_EVENT_TYPES)', () => {
  it('excludes a primary workingLocation event', () => {
    const event = buildEvent({ eventType: 'workingLocation' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
  });

  it('excludes a primary outOfOffice event', () => {
    const event = buildEvent({ eventType: 'outOfOffice' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
  });

  it('excludes a primary focusTime event', () => {
    const event = buildEvent({ eventType: 'focusTime' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
  });

  it('excludes a primary birthday event', () => {
    const event = buildEvent({ eventType: 'birthday' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
  });

  it('excludes a primary event with an undefined eventType', () => {
    const event = buildEvent({});
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
  });

  it('keeps a primary default event as an origin (N)', () => {
    const event = buildEvent({ eventType: 'default' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([event]);
  });

  it('does not apply rule 6 to todoist: a todoist event with a non-standard eventType is still an origin', () => {
    const event = buildEvent({ eventType: 'workingLocation' });
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([event]);
  });

  it('keeps a todoist event with an undefined eventType as an origin', () => {
    const event = buildEvent({});
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([event]);
  });
});

describe('classify - rule 7 (declined by self)', () => {
  it('excludes a primary event declined by self', () => {
    const event = buildEvent({
      eventType: 'default',
      attendees: [{ self: true, responseStatus: 'declined' }],
    });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toHaveLength(0);
  });

  it('does not apply rule 7 to todoist', () => {
    const event = buildEvent({
      attendees: [{ self: true, responseStatus: 'declined' }],
    });
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([event]);
  });
});

describe('classify - rule 8 (origin)', () => {
  it('classifies a plain todoist event as an origin (T)', () => {
    const event = buildEvent({});
    const result = classify('todoist', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([event]);
  });

  it('classifies a plain primary default event as an origin (N)', () => {
    const event = buildEvent({ eventType: 'default' });
    const result = classify('primary', [event], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([event]);
  });
});

describe('classify - rule 8, D8 (ended recurring series excluded from origins)', () => {
  it('excludes a recurring origin candidate when hasFutureOccurrence returns false', () => {
    const event = buildEvent({ eventType: 'default', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260817T065959Z;BYDAY=MO'] });
    const result = classify('primary', [event], [], () => false);
    expect(result.origins).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
  });

  it('keeps a recurring origin candidate as an origin when hasFutureOccurrence returns true', () => {
    const event = buildEvent({ eventType: 'default', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    const result = classify('primary', [event], [], () => true);
    expect(result.origins).toEqual([event]);
  });

  it('does not call hasFutureOccurrence for a non-recurring event', () => {
    const event = buildEvent({ eventType: 'default' });
    const hasFutureOccurrence = vi.fn(() => true);
    const result = classify('primary', [event], [], hasFutureOccurrence);
    expect(result.origins).toEqual([event]);
    expect(hasFutureOccurrence).not.toHaveBeenCalled();
  });

  it('keeps a generated event (srcUid present) in generated even when hasFutureOccurrence returns false (not filtered)', () => {
    const event = buildEvent({
      srcUid: 'origin-uid',
      recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260817T065959Z;BYDAY=MO'],
    });
    const result = classify('todoist', [event], [], () => false);
    expect(result.generated).toEqual([{ event, srcUid: 'origin-uid' }]);
    expect(result.origins).toHaveLength(0);
  });
});

describe('classify - duplicate origin iCalUID', () => {
  it('throws when two origins share the same iCalUID', () => {
    const sharedUID = 'duplicate@example.com';
    const eventA = buildEvent({ iCalUID: sharedUID, eventType: 'default' });
    const eventB = buildEvent({ iCalUID: sharedUID, eventType: 'default' });
    expect(() => classify('primary', [eventA, eventB], [], alwaysHasFutureOccurrence)).toThrow(/duplicate@example\.com/);
  });

  it('does not throw when a recurring exception shares its iCalUID with an origin', () => {
    const sharedUID = 'shared@example.com';
    const origin = buildEvent({ iCalUID: sharedUID, eventType: 'default' });
    const exception = buildEvent({ iCalUID: sharedUID, eventType: 'default', recurringEventId: 'series-1' });
    const result = classify('primary', [origin, exception], [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([origin]);
  });
});

describe('classify - result ordering and immutability', () => {
  it('returns origins in input order and does not mutate the input array', () => {
    const eventA = buildEvent({ eventType: 'default' });
    const eventB = buildEvent({ eventType: 'default' });
    const input = [eventA, eventB];
    const result = classify('primary', input, [], alwaysHasFutureOccurrence);
    expect(result.origins).toEqual([eventA, eventB]);
    expect(input).toEqual([eventA, eventB]);
  });

  it('does not mutate the links array', () => {
    const event = buildEvent({ srcUid: 'origin-uid' });
    const links = [buildLink({ calendar: 'todoist', iCalUID: 'other@example.com', srcUid: 'x', kind: 'generated' })];
    const linksSnapshot = [...links];
    classify('todoist', [event], links, alwaysHasFutureOccurrence);
    expect(links).toEqual(linksSnapshot);
  });
});

describe('classify - links row validation', () => {
  it('throws when a links row has an empty srcUid', () => {
    const event = buildEvent({ iCalUID: 'uid@example.com' });
    const links = [buildLink({ calendar: 'todoist', iCalUID: 'uid@example.com', srcUid: '', kind: 'generated' })];
    expect(() => classify('todoist', [event], links, alwaysHasFutureOccurrence)).toThrow(/uid@example\.com/);
  });
});
