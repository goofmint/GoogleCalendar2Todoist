/**
 * イベント内容の正規化・比較と、Calendar API へ渡す書き込み用リソースの生成を行うモジュール。
 * design.md §2.2「eventContent.ts」に記載されたシグネチャと振る舞い表に従う。
 * このモジュールは純粋関数のみを持ち、GAS のグローバルを参照しない。
 */

import { CalendarEvent, CalendarRole, LinkKind } from './types';
import { SRC_UID_KEY, INITIAL_MATCH_KEY, INITIAL_MATCH_VALUE } from './config';

export type NormalizedContent = {
  summary: string;
  start: string; // 終日: 'D:2026-09-15' / 時刻あり: 'T:<epoch ms>'（繰り返しなら '@<timeZone>' を付ける）
  end: string;
  recurrence: string; // recurrence 配列を '\n' で連結。なければ ''
};

function hasNonEmptyRecurrence(event: CalendarEvent): boolean {
  return event.recurrence !== undefined && event.recurrence.length > 0;
}

// RFC3339 の末尾オフセット（Z または ±HH:MM）を要求する。Calendar API は常にこの形式で dateTime を返すため、
// オフセット無しの値をホストのタイムゾーンで解釈してしまう挙動を避ける（タイムゾーン変換は実装しない）。
const DATE_TIME_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * start / end の一方を正規形の文字列にする。
 * date（終日）または dateTime（時刻あり）のいずれも無い場合は Error を throw する（フォールバックしない）。
 */
function normalizeEventDateTime(
  dateTime: GoogleAppsScript.Calendar.Schema.EventDateTime | undefined,
  appendTimeZone: boolean,
): string {
  if (dateTime === undefined) {
    throw new Error('Event start/end must have either date or dateTime.');
  }
  if (dateTime.date) {
    return `D:${dateTime.date}`;
  }
  if (dateTime.dateTime) {
    if (!DATE_TIME_OFFSET_PATTERN.test(dateTime.dateTime)) {
      throw new Error(`Event dateTime must include a UTC offset (Z or ±HH:MM): ${dateTime.dateTime}`);
    }
    const epochMs = new Date(dateTime.dateTime).getTime();
    if (Number.isNaN(epochMs)) {
      throw new Error(`Event dateTime is not a valid date: ${dateTime.dateTime}`);
    }
    if (!appendTimeZone) {
      return `T:${epochMs}`;
    }
    if (!dateTime.timeZone) {
      throw new Error('Recurring event start/end must have timeZone.');
    }
    return `T:${epochMs}@${dateTime.timeZone}`;
  }
  throw new Error('Event start/end must have either date or dateTime.');
}

export function normalizeContent(event: CalendarEvent): NormalizedContent {
  const recurring = hasNonEmptyRecurrence(event);
  return {
    summary: event.summary ?? '',
    start: normalizeEventDateTime(event.start, recurring),
    end: normalizeEventDateTime(event.end, recurring),
    recurrence: recurring ? (event.recurrence as string[]).join('\n') : '',
  };
}

export function isSameContent(a: CalendarEvent, b: CalendarEvent): boolean {
  const na = normalizeContent(a);
  const nb = normalizeContent(b);
  return na.summary === nb.summary && na.start === nb.start && na.end === nb.end && na.recurrence === nb.recurrence;
}

export function contentKeyForInitialMatch(event: CalendarEvent): string {
  const normalized = normalizeContent(event);
  return `${normalized.start}|${normalized.summary}`;
}

function copyEventDateTime(
  dateTime: GoogleAppsScript.Calendar.Schema.EventDateTime,
): GoogleAppsScript.Calendar.Schema.EventDateTime {
  return { ...dateTime };
}

/**
 * コピー元に recurrence が無い場合は recurrence: [] を明示する。
 * V4（Events.patch に recurrence: [] を送ると繰り返しが解除されるか）の結果に応じて見直す 1 箇所として、
 * この関数に集約する。
 */
function copyRecurrenceForWrite(recurrence: ReadonlyArray<string> | undefined): string[] {
  return recurrence !== undefined && recurrence.length > 0 ? [...recurrence] : [];
}

function applyMirrorOnlyFields(resource: CalendarEvent, calendar: CalendarRole): void {
  if (calendar === 'primary') {
    resource.visibility = 'private';
    resource.reminders = { useDefault: false, overrides: [] };
  }
}

/**
 * insert 用のリソースを生成する。
 * srcUid は insert のときだけ送る（extendedProperties.private.srcUid）。
 * calendar が 'primary'（M）の場合は visibility: 'private' と通知なしの reminders を付ける（D4）。
 * calendar が 'todoist'（C）の場合は visibility / reminders を設定しない。
 */
export function buildInsertResource(calendar: CalendarRole, source: CalendarEvent): CalendarEvent {
  if (!source.iCalUID) {
    throw new Error('Source event must have iCalUID to build an insert resource.');
  }
  if (source.start === undefined) {
    throw new Error('Source event must have start to build an insert resource.');
  }
  if (source.end === undefined) {
    throw new Error('Source event must have end to build an insert resource.');
  }
  const resource: CalendarEvent = {
    summary: source.summary,
    start: copyEventDateTime(source.start),
    end: copyEventDateTime(source.end),
    recurrence: copyRecurrenceForWrite(source.recurrence),
    extendedProperties: {
      private: {
        [SRC_UID_KEY]: source.iCalUID,
      },
    },
  };
  applyMirrorOnlyFields(resource, calendar);
  return resource;
}

/**
 * update 用のリソースを生成する。
 * extendedProperties は含めない（公式連携が書いた private キーを上書きしないため。V5 が動機）。
 * M / C の visibility と reminders の差異は buildInsertResource と同じ規則を適用する。
 */
export function buildUpdateResource(calendar: CalendarRole, source: CalendarEvent): CalendarEvent {
  if (source.start === undefined) {
    throw new Error('Source event must have start to build an update resource.');
  }
  if (source.end === undefined) {
    throw new Error('Source event must have end to build an update resource.');
  }
  const resource: CalendarEvent = {
    summary: source.summary,
    start: copyEventDateTime(source.start),
    end: copyEventDateTime(source.end),
    recurrence: copyRecurrenceForWrite(source.recurrence),
  };
  applyMirrorOnlyFields(resource, calendar);
  return resource;
}

/**
 * 初回照合の mark 用リソースを生成する。srcUid と initialMatch = INITIAL_MATCH_VALUE を設定する。
 * 内容フィールド（summary/start/end/recurrence）は設定しない。
 */
export function buildMarkResource(srcUid: string): CalendarEvent {
  return {
    extendedProperties: {
      private: {
        [SRC_UID_KEY]: srcUid,
        [INITIAL_MATCH_KEY]: INITIAL_MATCH_VALUE,
      },
    },
  };
}

/**
 * D6 の修復用リソースを生成する。srcUid を書き戻す。
 * linkKind が 'paired' のときだけ initialMatch も書き戻す（generated には付けない）。
 */
export function buildRepairResource(srcUid: string, linkKind: LinkKind): CalendarEvent {
  const privateProps: Record<string, string> = {
    [SRC_UID_KEY]: srcUid,
  };
  if (linkKind === 'paired') {
    privateProps[INITIAL_MATCH_KEY] = INITIAL_MATCH_VALUE;
  }
  return {
    extendedProperties: {
      private: privateProps,
    },
  };
}
