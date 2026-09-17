/**
 * design.md §2.2 の linksPlanner.ts ブロックに記載された仕様どおりに実装する。
 * 実行結果（ExecutionResult）と observed（生成物・ペアの観測結果）から、
 * links シートに書き戻すべき行を再計算する副作用のない純粋関数群。
 * `src/types.ts` の型のみに依存し、GAS のグローバルは参照しない。
 */

import type { CalendarRole, ExecutionResult, LinkEntry } from './types';

type LinkKeyInput = { calendar: CalendarRole; iCalUID: string; todoistTaskId?: string };
type ObservedRow = Omit<LinkEntry, 'recordedAt'>;

/**
 * links の索引キーを組み立てる。
 * `todoist` の generated 行（Todoist タスク由来。todoistTaskId を持つ）は `todoist:${todoistTaskId}`、
 * それ以外（primary/todoist の calendar イベント由来）は従来どおり `${calendar}:${iCalUID}` を使う。
 * `ExecutionResult.deletedKeys` もこの形式のキーを使う。
 */
export function linkKey(entry: LinkKeyInput): string {
  if (entry.calendar === 'todoist' && entry.todoistTaskId !== undefined && entry.todoistTaskId.length > 0) {
    return `todoist:${entry.todoistTaskId}`;
  }
  return `${entry.calendar}:${entry.iCalUID}`;
}

function compareByKey(a: LinkKeyInput, b: LinkKeyInput): number {
  return linkKey(a).localeCompare(linkKey(b));
}

export function planLinks(input: {
  current: ReadonlyArray<LinkEntry>;
  observed: ReadonlyArray<ObservedRow>;
  result: ExecutionResult;
  now: Date;
}): { entries: LinkEntry[]; changed: boolean } {
  const { current, observed, result, now } = input;

  // 1. observed ∪ result.createdLinks をキーで統合する。同一キーは createdLinks が勝つ。
  const candidates = new Map<string, ObservedRow>();
  for (const row of observed) {
    candidates.set(linkKey(row), row);
  }
  for (const row of result.createdLinks) {
    candidates.set(linkKey(row), row);
  }

  // 2. result.deletedKeys に含まれるキーを除外する。
  for (const key of result.deletedKeys) {
    candidates.delete(key);
  }

  // current をキーで引けるようにしておく（recordedAt の引き継ぎ用）。
  const currentByKey = new Map<string, LinkEntry>();
  for (const row of current) {
    currentByKey.set(linkKey(row), row);
  }

  // 3, 4. 統合結果の各行に recordedAt を付与する。current に無いキー（範囲外・削除済み）は
  //       candidates に含まれないため、この時点で自然に除外される。
  const entries: LinkEntry[] = [];
  for (const row of candidates.values()) {
    const existing = currentByKey.get(linkKey(row));
    const recordedAt = existing ? new Date(existing.recordedAt.getTime()) : new Date(now.getTime());
    entries.push({
      calendar: row.calendar,
      iCalUID: row.iCalUID,
      srcUid: row.srcUid,
      kind: row.kind,
      recordedAt,
      todoistTaskId: row.todoistTaskId,
    });
  }

  // 5. キー昇順に安定ソートする。
  const sortedEntries = [...entries].sort(compareByKey);

  // 6. current もキー昇順に揃えて比較し、changed を判定する（並び替えだけなら changed にしない）。
  const sortedCurrent = [...current].sort(compareByKey);

  const changed =
    sortedEntries.length !== sortedCurrent.length ||
    sortedEntries.some((entry, index) => {
      const other = sortedCurrent[index];
      return (
        linkKey(entry) !== linkKey(other) ||
        entry.srcUid !== other.srcUid ||
        entry.kind !== other.kind ||
        entry.recordedAt.getTime() !== other.recordedAt.getTime()
      );
    });

  return { entries: sortedEntries, changed };
}
