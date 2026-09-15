/**
 * 初回照合の計画（design.md §2.2「initialMatcher.ts」/ §0 D1）。
 * 純粋関数として実装し、GAS のグローバルは参照しない。
 *
 * design.md は `planInitialMatch(t, n): SyncAction[]` というシグネチャを示しているが、
 * この実装は `{ actions, ambiguousKeys }` を返す。design.md 手順 2 は「片側に 2 件以上ある
 * キーはペアにせず WARN ログを出す」と定めているが、このモジュールは副作用（ロガー呼び出し）
 * を持たない純粋関数にするため、WARN 判定に必要な情報（曖昧だったキー一覧）だけを
 * `ambiguousKeys` として返し、実際のログ出力は main.ts 側に委ねる。
 */

import { contentKeyForInitialMatch } from './eventContent';
import type { CalendarEvent, SyncAction } from './types';

export type InitialMatchResult = {
  actions: SyncAction[];
  ambiguousKeys: string[];
};

/**
 * events を contentKeyForInitialMatch(event) の値でグループ化する。
 * 入力配列は変更しない。
 */
function groupByContentKey(events: ReadonlyArray<CalendarEvent>): ReadonlyMap<string, CalendarEvent[]> {
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = contentKeyForInitialMatch(event);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [event]);
    } else {
      existing.push(event);
    }
  }
  return groups;
}

/**
 * event.iCalUID を検証して返す。非空文字列でなければ Error を throw する（フォールバックしない）。
 */
function requireICalUID(event: CalendarEvent): string {
  const iCalUID = event.iCalUID;
  if (typeof iCalUID !== 'string' || iCalUID.length === 0) {
    throw new Error('初回照合の対象予定に iCalUID がありません。');
  }
  return iCalUID;
}

/**
 * ペア (a, b) から mark アクションを2件作る。
 * a は todoist 側（T）、b は primary 側（N）。
 */
function buildMarkPair(a: CalendarEvent, b: CalendarEvent): SyncAction[] {
  const aICalUID = requireICalUID(a);
  const bICalUID = requireICalUID(b);
  return [
    { kind: 'mark', rule: 'INIT', direction: 'INIT', calendar: 'todoist', target: a, srcUid: bICalUID },
    { kind: 'mark', rule: 'INIT', direction: 'INIT', calendar: 'primary', target: b, srcUid: aICalUID },
  ];
}

/**
 * T（todoist の起点）と N（primary の起点）を照合し、初回照合の mark アクションを計画する。
 *
 * 1. T と N をそれぞれ contentKeyForInitialMatch でグループ化する。
 * 2. 同じキーが T 側 1 件・N 側 1 件だけのときにペアとみなす。
 *    どちらか一方に 2 件以上あるキー（両側に存在するもの）はペアにせず、
 *    ambiguousKeys に加える（重複なし、昇順ソート）。
 *    片側にしか無いキーは黙って無視する。
 * 3. ペアごとに mark を 2 件作る（T 入力順）。
 */
export function planInitialMatch(
  t: ReadonlyArray<CalendarEvent>,
  n: ReadonlyArray<CalendarEvent>,
): InitialMatchResult {
  const tGroups = groupByContentKey(t);
  const nGroups = groupByContentKey(n);

  const actions: SyncAction[] = [];
  const ambiguousKeySet = new Set<string>();

  for (const [key, tEvents] of tGroups) {
    const nEvents = nGroups.get(key);
    if (nEvents === undefined) {
      // N 側に存在しないキーは黙って無視する
      continue;
    }
    if (tEvents.length === 1 && nEvents.length === 1) {
      actions.push(...buildMarkPair(tEvents[0], nEvents[0]));
    } else {
      ambiguousKeySet.add(key);
    }
  }

  const ambiguousKeys = [...ambiguousKeySet].sort();

  return { actions, ambiguousKeys };
}
