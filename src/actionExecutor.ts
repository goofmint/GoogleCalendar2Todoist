/**
 * `SyncAction` の配列を受け取り、`kind` ごとに `calendarGateway` を呼び出し、ログを出力し、
 * `ExecutionResult` を返すモジュール。design.md §2.2「actionExecutor.ts」に記載された表のとおりに
 * ディスパッチする。パッチ用リソースの構築は `eventContent.ts` の `build*Resource` に委譲する。
 * このモジュールは GAS のグローバルを直接参照しない（`calendarGateway` 経由でのみ呼び出す）。
 * API 呼び出しの例外はキャッチしない（呼び出し元の main.ts の finally でログが flush される）。
 */

import { insertEvent, patchEvent, removeEvent } from './calendarGateway';
import { createTask, removeTask, updateTask } from './todoistGateway';
import {
  buildInsertResource,
  buildUpdateResource,
  buildMarkResource,
  buildRepairResource,
  buildTodoistTaskPayload,
} from './eventContent';
import { linkKey } from './linksPlanner';
import type { Logger } from './logger';
import type { CalendarEvent, CalendarRole, ExecutionResult, LinkEntry, SyncAction } from './types';

/**
 * ログメッセージ用に、イベントの人が読める要約を作る。
 * ここでの `??` は、ログ本文（人が読むだけの文字列）を組み立てるためだけに使う。
 * API へ送るデータの補完には使わない。
 */
function describeEvent(event: CalendarEvent): string {
  const summary = event.summary ?? '';
  const start = event.start;
  const startText = start ? start.dateTime ?? start.date ?? '' : '';
  return `${summary} ${startText}`.trim();
}

function requireId(event: CalendarEvent, context: string): string {
  if (!event.id) {
    throw new Error(`Target event is missing id (${context}).`);
  }
  return event.id;
}

function requireICalUID(event: CalendarEvent, context: string): string {
  if (!event.iCalUID) {
    throw new Error(`Event is missing iCalUID (${context}).`);
  }
  return event.iCalUID;
}

export function executeActions(
  actions: ReadonlyArray<SyncAction>,
  calendarIds: Record<CalendarRole, string>,
  logger: Logger,
): ExecutionResult {
  const createdLinks: Omit<LinkEntry, 'recordedAt'>[] = [];
  const deletedKeys: string[] = [];

  for (const action of actions) {
    const calendarId = calendarIds[action.calendar];

    switch (action.kind) {
      case 'create': {
        const sourceUid = requireICalUID(action.source, `create ${action.rule}`);
        if (action.calendar === 'todoist') {
          const payload = buildTodoistTaskPayload(action.source);
          const response = createTask(payload);
          createdLinks.push({
            calendar: 'todoist',
            iCalUID: '',
            srcUid: sourceUid,
            kind: 'generated',
            todoistTaskId: response.id,
          });
          logger.info(action.direction, sourceUid, `${action.rule} create todoist task ${response.content}`);
          break;
        }
        const resource = buildInsertResource(action.calendar, action.source);
        const response = insertEvent(calendarId, resource);
        const createdUid = requireICalUID(response, `create ${action.rule} response`);
        createdLinks.push({
          calendar: action.calendar,
          iCalUID: createdUid,
          srcUid: sourceUid,
          kind: 'generated',
        });
        logger.info(action.direction, sourceUid, `${action.rule} create ${describeEvent(action.source)}`);
        break;
      }
      case 'update': {
        const sourceUid = requireICalUID(action.source, `update ${action.rule}`);
        if (action.calendar === 'todoist') {
          const payload = buildTodoistTaskPayload(action.source);
          updateTask(action.todoistTaskId, payload);
          logger.info(action.direction, sourceUid, `${action.rule} update todoist task ${action.todoistTaskId}`);
          break;
        }
        const targetId = requireId(action.target, `update ${action.rule}`);
        const resource = buildUpdateResource(action.calendar, action.source);
        patchEvent(calendarId, targetId, resource);
        logger.info(action.direction, sourceUid, `${action.rule} update ${describeEvent(action.source)}`);
        break;
      }
      case 'delete': {
        if (action.calendar === 'todoist') {
          removeTask(action.todoistTaskId);
          deletedKeys.push(linkKey({ calendar: 'todoist', iCalUID: '', todoistTaskId: action.todoistTaskId }));
          logger.info(action.direction, action.srcUid, `${action.rule} delete todoist task ${action.todoistTaskId}`);
          break;
        }
        const targetId = requireId(action.target, `delete ${action.rule}`);
        const targetUid = requireICalUID(action.target, `delete ${action.rule}`);
        removeEvent(calendarId, targetId);
        deletedKeys.push(linkKey({ calendar: action.calendar, iCalUID: targetUid }));
        logger.info(action.direction, action.srcUid, `${action.rule} delete ${describeEvent(action.target)}`);
        break;
      }
      case 'mark': {
        const targetId = requireId(action.target, `mark ${action.rule}`);
        const targetUid = requireICalUID(action.target, `mark ${action.rule}`);
        const resource = buildMarkResource(action.srcUid);
        patchEvent(calendarId, targetId, resource);
        logger.info(action.direction, targetUid, `${action.rule} mark ${describeEvent(action.target)}`);
        break;
      }
      case 'repair': {
        const targetId = requireId(action.target, `repair ${action.rule}`);
        const targetUid = requireICalUID(action.target, `repair ${action.rule}`);
        const resource = buildRepairResource(action.srcUid, action.linkKind);
        patchEvent(calendarId, targetId, resource);
        logger.warn(
          action.direction,
          targetUid,
          `${action.rule} repair(${action.linkKind}) ${describeEvent(action.target)}`,
        );
        break;
      }
    }
  }

  return { createdLinks, deletedKeys };
}
