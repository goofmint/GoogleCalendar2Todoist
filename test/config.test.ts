import { describe, expect, it } from 'vitest';
import { SRC_UID_KEY, PRIMARY_CALENDAR_ID, ORIGIN_EVENT_TYPES, SEND_UPDATES, TRIGGER_HANDLER } from '../src/config';

describe('config', () => {
  it('defines the extendedProperties key used to mark srcUid', () => {
    expect(SRC_UID_KEY).toBe('srcUid');
  });

  it('defines primary as the primary calendar id', () => {
    expect(PRIMARY_CALENDAR_ID).toBe('primary');
  });

  it('lists the origin event types allowed to be treated as origins', () => {
    expect(ORIGIN_EVENT_TYPES).toEqual(['default', 'fromGmail']);
  });

  it('defines SEND_UPDATES as none for silent writes', () => {
    expect(SEND_UPDATES).toBe('none');
  });

  it('defines the trigger handler function name', () => {
    expect(TRIGGER_HANDLER).toBe('sync');
  });
});
