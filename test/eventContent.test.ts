import { describe, expect, it } from 'vitest';
import {
  normalizeContent,
  isSameContent,
  contentKeyForInitialMatch,
  buildInsertResource,
  buildUpdateResource,
  buildMarkResource,
  buildRepairResource,
} from '../src/eventContent';
import { CalendarEvent } from '../src/types';
import { SRC_UID_KEY, INITIAL_MATCH_KEY, INITIAL_MATCH_VALUE } from '../src/config';

function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    summary: 'Meeting',
    start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
    iCalUID: 'uid-1@example.com',
    ...overrides,
  };
}

describe('normalizeContent / isSameContent', () => {
  it('treats +09:00 and Z as the same instant for non-recurring timed events', () => {
    const a = timedEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00' },
      end: { dateTime: '2026-09-15T11:00:00+09:00' },
    });
    const b = timedEvent({
      start: { dateTime: '2026-09-15T01:00:00Z' },
      end: { dateTime: '2026-09-15T02:00:00Z' },
    });
    expect(isSameContent(a, b)).toBe(true);
  });

  it('distinguishes all-day events from timed events at the same date', () => {
    const allDay = timedEvent({
      start: { date: '2026-09-15' },
      end: { date: '2026-09-16' },
    });
    const timed = timedEvent({
      start: { dateTime: '2026-09-15T00:00:00Z' },
      end: { dateTime: '2026-09-16T00:00:00Z' },
    });
    expect(isSameContent(allDay, timed)).toBe(false);
  });

  it('treats different timeZone on non-recurring events with the same instant as equal', () => {
    const a = timedEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    const b = timedEvent({
      start: { dateTime: '2026-09-15T01:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-09-15T02:00:00Z', timeZone: 'UTC' },
    });
    expect(isSameContent(a, b)).toBe(true);
  });

  it('treats different timeZone on recurring events with the same instant as different', () => {
    const a = timedEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    const b = timedEvent({
      start: { dateTime: '2026-09-15T01:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-09-15T02:00:00Z', timeZone: 'UTC' },
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    expect(isSameContent(a, b)).toBe(false);
  });

  it('treats recurring events with the same instant and same timeZone as equal', () => {
    const a = timedEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    const b = timedEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-09-15T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    expect(isSameContent(a, b)).toBe(true);
  });

  it('throws for recurring timed events with no timeZone set', () => {
    const event = timedEvent({
      start: { dateTime: '2026-09-15T10:00:00+09:00' },
      end: { dateTime: '2026-09-15T11:00:00+09:00' },
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    expect(() => normalizeContent(event)).toThrow();
  });

  it('detects a difference when only the end time differs', () => {
    const a = timedEvent({ end: { dateTime: '2026-09-15T11:00:00+09:00' } });
    const b = timedEvent({ end: { dateTime: '2026-09-15T12:00:00+09:00' } });
    expect(isSameContent(a, b)).toBe(false);
  });

  it('treats missing summary as equal to an empty summary', () => {
    const a = timedEvent({ summary: undefined });
    const b = timedEvent({ summary: '' });
    expect(isSameContent(a, b)).toBe(true);
  });

  it('treats differing summary as different content', () => {
    const a = timedEvent({ summary: 'Meeting A' });
    const b = timedEvent({ summary: 'Meeting B' });
    expect(isSameContent(a, b)).toBe(false);
  });

  it('treats missing recurrence as equal to an empty recurrence array', () => {
    const a = timedEvent({ recurrence: undefined });
    const b = timedEvent({ recurrence: [] });
    expect(isSameContent(a, b)).toBe(true);
  });

  it('joins the recurrence array with newlines and detects differences', () => {
    const a = timedEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const b = timedEvent({ recurrence: ['RRULE:FREQ=WEEKLY', 'EXDATE:20260922T010000Z'] });
    expect(normalizeContent(a).recurrence).toBe('RRULE:FREQ=WEEKLY');
    expect(normalizeContent(b).recurrence).toBe('RRULE:FREQ=WEEKLY\nEXDATE:20260922T010000Z');
    expect(isSameContent(a, b)).toBe(false);
  });

  it('throws when start has neither date nor dateTime', () => {
    const event = timedEvent({ start: {} });
    expect(() => normalizeContent(event)).toThrow();
  });

  it('throws when end has neither date nor dateTime', () => {
    const event = timedEvent({ end: {} });
    expect(() => normalizeContent(event)).toThrow();
  });

  it('throws when start is entirely missing', () => {
    const event = timedEvent({ start: undefined });
    expect(() => normalizeContent(event)).toThrow();
  });
});

describe('contentKeyForInitialMatch', () => {
  it('returns normalized start + | + normalized summary', () => {
    const event = timedEvent();
    const normalized = normalizeContent(event);
    expect(contentKeyForInitialMatch(event)).toBe(`${normalized.start}|${normalized.summary}`);
  });

  it('uses an empty summary segment when summary is missing', () => {
    const event = timedEvent({ summary: undefined });
    const normalized = normalizeContent(event);
    expect(contentKeyForInitialMatch(event)).toBe(`${normalized.start}|`);
  });
});

describe('buildInsertResource', () => {
  it('sets visibility private and silent reminders for the primary mirror (M)', () => {
    const source = timedEvent();
    const resource = buildInsertResource('primary', source);
    expect(resource.visibility).toBe('private');
    expect(resource.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it('does not set visibility or reminders for the todoist copy (C)', () => {
    const source = timedEvent();
    const resource = buildInsertResource('todoist', source);
    expect(resource.visibility).toBeUndefined();
    expect(resource.reminders).toBeUndefined();
  });

  it('copies summary, start, end, and sets extendedProperties.private.srcUid to the source iCalUID', () => {
    const source = timedEvent({ iCalUID: 'origin-uid@example.com' });
    const resource = buildInsertResource('todoist', source);
    expect(resource.summary).toBe(source.summary);
    expect(resource.start).toEqual(source.start);
    expect(resource.end).toEqual(source.end);
    expect(resource.extendedProperties).toEqual({
      private: { [SRC_UID_KEY]: 'origin-uid@example.com' },
    });
  });

  it('sets recurrence: [] when the source has no recurrence', () => {
    const source = timedEvent({ recurrence: undefined });
    const resource = buildInsertResource('primary', source);
    expect(resource.recurrence).toEqual([]);
  });

  it('copies the recurrence array when present', () => {
    const source = timedEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const resource = buildInsertResource('primary', source);
    expect(resource.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('does not invent a summary when the source has none', () => {
    const source = timedEvent({ summary: undefined });
    const resource = buildInsertResource('primary', source);
    expect(resource.summary).toBeUndefined();
  });

  it('throws when the source has no iCalUID', () => {
    const source = timedEvent({ iCalUID: undefined });
    expect(() => buildInsertResource('primary', source)).toThrow();
  });

  it('sets recurrence: [] when the source recurrence is an empty array', () => {
    const source = timedEvent({ recurrence: [] });
    const resource = buildInsertResource('primary', source);
    expect(resource.recurrence).toEqual([]);
  });

  it('copies start/end verbatim as undefined when the source has none', () => {
    const source = timedEvent({ start: undefined, end: undefined });
    const resource = buildInsertResource('todoist', source);
    expect(resource.start).toBeUndefined();
    expect(resource.end).toBeUndefined();
  });

  it('does not mutate the source event (start/end/recurrence)', () => {
    const source = timedEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const snapshotStart = { ...source.start };
    const snapshotRecurrence = [...(source.recurrence ?? [])];
    const resource = buildInsertResource('primary', source);

    // Mutate the returned resource; the source must stay untouched.
    if (resource.start) {
      (resource.start as GoogleAppsScript.Calendar.Schema.EventDateTime).timeZone = 'Mutated/Zone';
    }
    resource.recurrence?.push('MUTATED');

    expect(source.start).toEqual(snapshotStart);
    expect(source.recurrence).toEqual(snapshotRecurrence);
  });
});

describe('buildUpdateResource', () => {
  it('does not include extendedProperties', () => {
    const source = timedEvent();
    const resource = buildUpdateResource('primary', source);
    expect(resource.extendedProperties).toBeUndefined();
  });

  it('does not throw when the source has no iCalUID', () => {
    const source = timedEvent({ iCalUID: undefined });
    expect(() => buildUpdateResource('primary', source)).not.toThrow();
  });

  it('sets visibility private and silent reminders for the primary mirror (M)', () => {
    const source = timedEvent();
    const resource = buildUpdateResource('primary', source);
    expect(resource.visibility).toBe('private');
    expect(resource.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it('does not set visibility or reminders for the todoist copy (C)', () => {
    const source = timedEvent();
    const resource = buildUpdateResource('todoist', source);
    expect(resource.visibility).toBeUndefined();
    expect(resource.reminders).toBeUndefined();
  });

  it('sets recurrence: [] when the source has no recurrence', () => {
    const source = timedEvent({ recurrence: undefined });
    const resource = buildUpdateResource('todoist', source);
    expect(resource.recurrence).toEqual([]);
  });

  it('copies the recurrence array when present', () => {
    const source = timedEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const resource = buildUpdateResource('todoist', source);
    expect(resource.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('does not mutate the source event', () => {
    const source = timedEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] });
    const snapshotRecurrence = [...(source.recurrence ?? [])];
    const resource = buildUpdateResource('primary', source);
    resource.recurrence?.push('MUTATED');
    expect(source.recurrence).toEqual(snapshotRecurrence);
  });
});

describe('buildMarkResource', () => {
  it('sets srcUid and initialMatch, and no other fields', () => {
    const resource = buildMarkResource('origin-uid@example.com');
    expect(resource).toEqual({
      extendedProperties: {
        private: {
          [SRC_UID_KEY]: 'origin-uid@example.com',
          [INITIAL_MATCH_KEY]: INITIAL_MATCH_VALUE,
        },
      },
    });
    expect(resource.summary).toBeUndefined();
    expect(resource.start).toBeUndefined();
  });
});

describe('buildRepairResource', () => {
  it('sets only srcUid for a generated link', () => {
    const resource = buildRepairResource('origin-uid@example.com', 'generated');
    expect(resource).toEqual({
      extendedProperties: {
        private: { [SRC_UID_KEY]: 'origin-uid@example.com' },
      },
    });
  });

  it('sets srcUid and initialMatch for a paired link', () => {
    const resource = buildRepairResource('origin-uid@example.com', 'paired');
    expect(resource).toEqual({
      extendedProperties: {
        private: {
          [SRC_UID_KEY]: 'origin-uid@example.com',
          [INITIAL_MATCH_KEY]: INITIAL_MATCH_VALUE,
        },
      },
    });
  });
});
