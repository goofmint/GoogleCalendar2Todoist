/**
 * Calendar Advanced Service（`Calendar` グローバル）を呼び出す薄いラッパーモジュール。
 * design.md §2.2「calendarGateway.ts」/ §4.2 に記載された呼び出し方をそのまま実装する。
 * `CalendarApp` は使わない（`extendedProperties` / `iCalUID` / `recurrence` を扱えないため）。
 * `Calendar` グローバルへのアクセスは、各エクスポート関数の中からのみ行う。
 * 例外はキャッチせず、呼び出し元へ伝播させる（design.md §5.1）。
 */

import { INSTANCE_LOOKUP_MAX_RESULTS, LIST_PAGE_SIZE, SEND_UPDATES } from './config';
import type { CalendarEvent } from './types';

/**
 * `Calendar` advanced service のグローバルを取得する。
 * 型定義上 `GoogleAppsScript.Calendar | undefined` であるため、有効化されていない場合にここで
 * 明確に throw する（フォールバックはしない）。
 */
function getCalendarService(): GoogleAppsScript.Calendar {
  if (!Calendar) {
    throw new Error('Calendar advanced service is not enabled.');
  }
  return Calendar;
}

/**
 * 指定したカレンダーの、`now` 以降のイベントを全件取得する。
 * `nextPageToken` が無くなるまでページングし、全ページの `items` を連結して返す。
 * `items` を持たないページは、結果に何も追加しない。
 */
export function listFutureEvents(calendarId: string, now: Date): CalendarEvent[] {
  const service = getCalendarService();
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const response = service.Events.list(calendarId, {
      timeMin: now.toISOString(),
      singleEvents: false,
      showDeleted: false,
      maxResults: LIST_PAGE_SIZE,
      pageToken,
    });
    if (response.items) {
      events.push(...response.items);
    }
    pageToken = response.nextPageToken;
  } while (pageToken !== undefined);

  return events;
}

/**
 * 繰り返し予定に、`now` 以降の回が残っているかどうかを判定する。
 * `Calendar.Events.instances(calendarId, eventId, { timeMin: now.toISOString(),
 * maxResults: INSTANCE_LOOKUP_MAX_RESULTS, showDeleted: false })` を呼び、
 * `response.items` が 1 件以上あれば true を返す。
 */
export function hasFutureInstance(calendarId: string, eventId: string, now: Date): boolean {
  const service = getCalendarService();
  const response = service.Events.instances(calendarId, eventId, {
    timeMin: now.toISOString(),
    maxResults: INSTANCE_LOOKUP_MAX_RESULTS,
    showDeleted: false,
  });
  return response.items !== undefined && response.items.length > 0;
}

/**
 * イベントを新規作成する。`sendUpdates: SEND_UPDATES`（'none'）を常に付ける。
 */
export function insertEvent(calendarId: string, resource: CalendarEvent): CalendarEvent {
  const service = getCalendarService();
  return service.Events.insert(resource, calendarId, { sendUpdates: SEND_UPDATES });
}

/**
 * イベントを部分更新する。`sendUpdates: SEND_UPDATES`（'none'）を常に付ける。
 */
export function patchEvent(calendarId: string, eventId: string, resource: CalendarEvent): CalendarEvent {
  const service = getCalendarService();
  return service.Events.patch(resource, calendarId, eventId, { sendUpdates: SEND_UPDATES });
}

/**
 * イベントを削除する。`Calendar.Events.delete` ではなく `Calendar.Events.remove` を使う（design.md §10）。
 * `sendUpdates: SEND_UPDATES`（'none'）を常に付ける。
 */
export function removeEvent(calendarId: string, eventId: string): void {
  const service = getCalendarService();
  service.Events.remove(calendarId, eventId, { sendUpdates: SEND_UPDATES });
}
