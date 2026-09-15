/**
 * イベント分類ロジック（design.md §2.2 eventClassifier.ts / §0 D1-D6 / §7.1）。
 * 純関数として実装し、Google Apps Script のランタイム API は呼び出さない。
 * すべての入力は引数で受け取り、判定は event フィールドの参照だけで行う。
 * eventContent.ts には依存しない。
 */

import {
  SRC_UID_KEY,
  INITIAL_MATCH_KEY,
  INITIAL_MATCH_VALUE,
  ORIGIN_EVENT_TYPES,
} from './config';
import type { CalendarEvent, CalendarRole, ClassifiedEvents, GeneratedEvent, LinkEntry, SyncAction } from './types';

/**
 * extendedProperties.private.srcUid を読む。値がなければ null を返す。
 * 空文字はフォールバック値として補わず、そのまま「値なし」として扱う。
 */
export function getSrcUid(event: CalendarEvent): string | null {
  const value = event.extendedProperties?.private?.[SRC_UID_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * extendedProperties.private.initialMatch が INITIAL_MATCH_VALUE と等しいかを判定する（D1）。
 */
export function isInitialMatched(event: CalendarEvent): boolean {
  return event.extendedProperties?.private?.[INITIAL_MATCH_KEY] === INITIAL_MATCH_VALUE;
}

/**
 * 繰り返し予定の例外回かどうかを判定する（D2）。recurringEventId が非空文字列であれば真。
 */
export function isRecurringException(event: CalendarEvent): boolean {
  return typeof event.recurringEventId === 'string' && event.recurringEventId.length > 0;
}

/**
 * 自分（self: true の attendee）が辞退しているかどうかを判定する。
 * attendees が未定義、または self の要素が無いときは false を返す。
 */
export function isDeclinedBySelf(event: CalendarEvent): boolean {
  const attendees = event.attendees;
  if (attendees === undefined) {
    return false;
  }
  return attendees.some((attendee) => attendee.self === true && attendee.responseStatus === 'declined');
}

/**
 * event.eventType が ORIGIN_EVENT_TYPES に含まれるかどうかを判定する（D3）。
 * eventType が undefined の場合は「含まれない」扱いにする。
 */
function isOriginEventType(event: CalendarEvent): boolean {
  return typeof event.eventType === 'string' && ORIGIN_EVENT_TYPES.includes(event.eventType);
}

/**
 * links の索引キー。`${calendar}:${iCalUID}` の形式にする。
 */
function linkKey(calendar: CalendarRole, iCalUID: string): string {
  return `${calendar}:${iCalUID}`;
}

/**
 * links を `(calendar, iCalUID)` で引ける索引に変換する。
 * キーに calendar を含めるため、他カレンダーの行は自然に一致しない。
 */
function buildLinksIndex(links: ReadonlyArray<LinkEntry>): ReadonlyMap<string, LinkEntry> {
  const index = new Map<string, LinkEntry>();
  for (const link of links) {
    // srcUid が空の行で repair すると空の srcUid を書き戻してしまうため、黙って除外せず明確にエラーにする
    if (link.srcUid.length === 0) {
      throw new Error(`links の行に srcUid がありません (calendar=${link.calendar}, iCalUID=${link.iCalUID})。`);
    }
    index.set(linkKey(link.calendar, link.iCalUID), link);
  }
  return index;
}

/**
 * event.iCalUID を検証して返す。非空文字列でなければ Error を throw する（フォールバックしない）。
 */
function requireICalUID(event: CalendarEvent): string {
  const iCalUID = event.iCalUID;
  if (typeof iCalUID !== 'string' || iCalUID.length === 0) {
    throw new Error('分類対象の予定に iCalUID がありません。');
  }
  return iCalUID;
}

/**
 * repair アクション（SyncAction の kind: 'repair'）を組み立てる。
 */
function buildRepairAction(
  calendar: CalendarRole,
  target: CalendarEvent,
  srcUid: string,
  linkKind: LinkEntry['kind'],
): SyncAction {
  return {
    kind: 'repair',
    rule: 'REPAIR',
    direction: 'REPAIR',
    calendar,
    target,
    srcUid,
    linkKind,
  };
}

/**
 * イベント集合を分類する（design.md §2.2 の分類ルール表 1〜8 を上から順に評価し、最初に当てはまったもので確定する）。
 *
 * ルール:
 * 1. 繰り返し例外回（D2） → 対象外
 * 2. initialMatch あり（D1） → ペア（対象外。observedLinks に記録）
 * 3. links に (calendar, iCalUID) の paired 行あり（initialMatch だけを失った状態） → ペア + repair
 * 4. links に generated 行あり、かつ srcUid を持たない（D6） → 生成物 + repair
 * 5. srcUid あり → 生成物
 * 6. primary かつ eventType が ORIGIN_EVENT_TYPES にない（D3） → 対象外
 * 7. primary かつ自分が辞退している → 対象外
 * 8. 上記以外 → 起点
 *
 * 戻り値の各配列は入力順を保つ。引数の events / links は変更しない。
 */
export function classify(
  calendar: CalendarRole,
  events: ReadonlyArray<CalendarEvent>,
  links: ReadonlyArray<LinkEntry>,
): ClassifiedEvents {
  const linksIndex = buildLinksIndex(links);

  const origins: Array<CalendarEvent> = [];
  const generated: Array<GeneratedEvent> = [];
  const observedLinks: Array<Omit<LinkEntry, 'recordedAt'>> = [];
  const repairs: Array<SyncAction> = [];

  for (const event of events) {
    // ルール1: 繰り返し例外回は対象外（分類対象から完全に除外し、重複判定にも含めない）
    if (isRecurringException(event)) {
      continue;
    }

    // ルール2: initialMatch があればペア
    if (isInitialMatched(event)) {
      const iCalUID = requireICalUID(event);
      const srcUidFromEvent = getSrcUid(event);
      if (srcUidFromEvent !== null) {
        observedLinks.push({ calendar, iCalUID, srcUid: srcUidFromEvent, kind: 'paired' });
        continue;
      }
      const linkRow = linksIndex.get(linkKey(calendar, iCalUID));
      if (linkRow !== undefined) {
        observedLinks.push({ calendar, iCalUID, srcUid: linkRow.srcUid, kind: 'paired' });
        repairs.push(buildRepairAction(calendar, event, linkRow.srcUid, 'paired'));
        continue;
      }
      throw new Error(
        `initialMatch が付いた予定 (calendar=${calendar}, iCalUID=${iCalUID}) に srcUid がなく、links にも記録がありません。`,
      );
    }

    // ここから先（ルール3以降）に到達する予定は必ず非空の iCalUID を持つ必要がある
    const iCalUID = requireICalUID(event);
    const linkRow = linksIndex.get(linkKey(calendar, iCalUID));

    // ルール3: links に paired 行があり、initialMatch だけを失った状態
    if (linkRow !== undefined && linkRow.kind === 'paired') {
      observedLinks.push({ calendar, iCalUID, srcUid: linkRow.srcUid, kind: 'paired' });
      repairs.push(buildRepairAction(calendar, event, linkRow.srcUid, 'paired'));
      continue;
    }

    // ルール4: links に generated 行があり、srcUid を失っている状態（D6）
    if (linkRow !== undefined && linkRow.kind === 'generated' && getSrcUid(event) === null) {
      generated.push({ event, srcUid: linkRow.srcUid });
      observedLinks.push({ calendar, iCalUID, srcUid: linkRow.srcUid, kind: 'generated' });
      repairs.push(buildRepairAction(calendar, event, linkRow.srcUid, 'generated'));
      continue;
    }

    // ルール5: srcUid を持っていれば生成物（primary は M、todoist は C）
    const srcUid = getSrcUid(event);
    if (srcUid !== null) {
      generated.push({ event, srcUid });
      observedLinks.push({ calendar, iCalUID, srcUid, kind: 'generated' });
      continue;
    }

    // ルール6: primary の特殊な eventType は対象外（D3）。eventType 未定義も対象外
    if (calendar === 'primary' && !isOriginEventType(event)) {
      continue;
    }

    // ルール7: primary で自分が辞退している予定は対象外
    if (calendar === 'primary' && isDeclinedBySelf(event)) {
      continue;
    }

    // ルール8: 上記のいずれにも当てはまらなければ起点
    origins.push(event);
  }

  // 起点の iCalUID 重複チェック（D2 の除外後に残る重複は異常データ）
  const seenICalUIDs = new Set<string>();
  for (const origin of origins) {
    const iCalUID = requireICalUID(origin);
    if (seenICalUIDs.has(iCalUID)) {
      throw new Error(`起点の iCalUID が重複しています（D2 除外後に残る重複は異常データです）: ${iCalUID}`);
    }
    seenICalUIDs.add(iCalUID);
  }

  return { origins, generated, observedLinks, repairs };
}
