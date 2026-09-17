/**
 * イベント内容の正規化・比較と、Calendar API へ渡す書き込み用リソースの生成を行うモジュール。
 * design.md §2.2「eventContent.ts」に記載されたシグネチャと振る舞い表に従う。
 * このモジュールは純粋関数のみを持ち、GAS のグローバルを参照しない。
 */

import { CalendarEvent, CalendarRole, LinkKind } from './types';
import { SRC_UID_KEY, INITIAL_MATCH_KEY, INITIAL_MATCH_VALUE } from './config';
import type { TodoistTask } from './types';
import type { TodoistTaskPayload } from './todoistGateway';

export type NormalizedContent = {
  summary: string;
  start: string; // 終日: 'D:2026-09-15' / 時刻あり: 'T:<epoch ms>'（繰り返しなら '@<timeZone>' を付ける）
  end: string;
  recurrence: string; // recurrence 配列を '\n' で連結。なければ ''
};

// P→T（Todoist タスク化）の対象外判定にも使うため export する。振る舞いは変更しない。
export function hasNonEmptyRecurrence(event: CalendarEvent): boolean {
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

/**
 * N（primary の起点）の summary を Todoist タスクの content として使うため検証して返す。
 * Todoist API は空の content を受け付けないため、フォールバックせず明確に throw する。
 */
function requireSummaryForTodoist(source: CalendarEvent): string {
  if (typeof source.summary !== 'string' || source.summary.length === 0) {
    throw new Error('Source event must have a non-empty summary to build a Todoist task payload.');
  }
  return source.summary;
}

// 'YYYY-MM-DDTHH:MM:SS.sssZ' → 'YYYY-MM-DDTHH:MM:SSZ'（Todoist の due_datetime は秒精度の
// UTC 表記を受け付ける。ミリ秒部分は落とす）。
function toTodoistUtcDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * N の start から Todoist タスクの due_date / due_datetime を組み立てる。
 * 終日（date）の場合は due_date にそのまま使う。時刻ありの場合は UTC の due_datetime に変換する
 * （Calendar API の dateTime はどのオフセットでも受け取れるが、Todoist には常に Z 付き UTC で送る）。
 */
function buildTodoistDueFields(
  source: CalendarEvent,
): Pick<TodoistTaskPayload, 'due_date' | 'due_datetime'> {
  const start = source.start;
  if (start === undefined) {
    throw new Error('Source event must have start to build a Todoist task payload.');
  }
  if (start.date) {
    return { due_date: start.date };
  }
  if (start.dateTime) {
    const epochMs = new Date(start.dateTime).getTime();
    if (Number.isNaN(epochMs)) {
      throw new Error(`Event start dateTime is not a valid date: ${start.dateTime}`);
    }
    return { due_datetime: toTodoistUtcDateTime(epochMs) };
  }
  throw new Error('Event start must have either date or dateTime.');
}

/**
 * N の CalendarEvent から Todoist タスク用ペイロードを作る（create/update 共通）。
 * `source.summary → content`、`source.start`（終日）→ `due_date`、`source.start`（時刻あり）→
 * `due_datetime` を対応付ける。Todoist タスクに `end` は無いため終了時刻は使わない。
 * 繰り返し（recurrence）を持つ N は呼び出し元（syncPlanner）で対象外にする（この関数では扱わない）。
 */
export function buildTodoistTaskPayload(source: CalendarEvent): TodoistTaskPayload {
  return {
    content: requireSummaryForTodoist(source),
    ...buildTodoistDueFields(source),
  };
}

/**
 * P→T 専用の差分判定。N の summary/start と、既存 Todoist タスクの content/due を比較する。
 * 自分たちが作成・更新するタスクの due は必ず UTC（Z 付き）の due_datetime か、日付のみの
 * due_date であるため、task.due.date を期待値と文字列比較する。
 * due が null、または期待した形式と一致しない場合は「内容が異なる」とみなし S5 update を出す
 * （不確実な場合は安全側＝更新側に倒す）。
 */
export function isSameTodoistTaskContent(source: CalendarEvent, task: TodoistTask): boolean {
  const expected = buildTodoistTaskPayload(source);
  if (task.content !== expected.content) {
    return false;
  }
  if (task.due === null) {
    return false;
  }
  if (expected.due_date !== undefined) {
    return task.due.date === expected.due_date;
  }
  if (expected.due_datetime !== undefined) {
    return task.due.date === expected.due_datetime;
  }
  return false;
}
