/**
 * 双方向同期計画の純粋ロジック（design.md §2.2「syncPlanner.ts」/ §0 D1）。
 * 副作用を持たず、GAS のグローバルを参照しない。
 * ペア（initialMatch）は eventClassifier.classify によって origins/generated から
 * 除外されている前提のため、この関数は特別扱いしない（D1）。
 */

import { isSameContent } from './eventContent';
import type { CalendarEvent, CalendarRole, Direction, GeneratedEvent, SyncAction } from './types';

type ReconcileRules = {
  create: 'S1' | 'S4';
  update: 'S2' | 'S5';
  delete: 'S3' | 'S6';
  duplicateDelete: 'S3D' | 'S6D';
};

/**
 * origin の iCalUID を検証して返す。非空文字列でなければ Error を throw する（フォールバックしない）。
 * classify が起点の一意性を保証するため、ここでの重複チェックは行わない。
 */
function requireICalUID(event: CalendarEvent): string {
  const iCalUID = event.iCalUID;
  if (typeof iCalUID !== 'string' || iCalUID.length === 0) {
    throw new Error('起点の予定に iCalUID がありません。');
  }
  return iCalUID;
}

/**
 * 生成物の id を検証して返す。非空文字列でなければ Error を throw する（フォールバックしない）。
 */
function requireEventId(event: CalendarEvent): string {
  const id = event.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('生成物の予定に id がありません。');
  }
  return id;
}

/**
 * origins を iCalUID でマップ化する。
 */
function buildOriginByUid(origins: ReadonlyArray<CalendarEvent>): ReadonlyMap<string, CalendarEvent> {
  const map = new Map<string, CalendarEvent>();
  for (const origin of origins) {
    map.set(requireICalUID(origin), origin);
  }
  return map;
}

type GeneratedGroups = {
  groups: ReadonlyMap<string, GeneratedEvent[]>;
  // generated の入力順で最初に現れた srcUid の順序（孤児 delete の順序決定に使う）
  firstSeenOrder: string[];
};

/**
 * generated を srcUid でグループ化し、各グループ内を id 昇順に安定ソートする
 * （最小 id を先頭= keep として保持する）。
 */
function groupGeneratedBySrcUid(generated: ReadonlyArray<GeneratedEvent>): GeneratedGroups {
  const groups = new Map<string, GeneratedEvent[]>();
  const firstSeenOrder: string[] = [];

  for (const item of generated) {
    requireEventId(item.event);
    const existing = groups.get(item.srcUid);
    if (existing === undefined) {
      groups.set(item.srcUid, [item]);
      firstSeenOrder.push(item.srcUid);
    } else {
      existing.push(item);
    }
  }

  for (const group of groups.values()) {
    group.sort((a, b) => {
      const idA = a.event.id as string;
      const idB = b.event.id as string;
      if (idA < idB) {
        return -1;
      }
      if (idA > idB) {
        return 1;
      }
      return 0;
    });
  }

  return { groups, firstSeenOrder };
}

/**
 * 方向共通の照合ロジック（design.md §2.2 の擬似コード）。
 * origins を入力順に走査して create / update / 重複 delete を決定し、
 * その後 generated を srcUid の初出順に走査して孤児 delete を決定する。
 */
function reconcile(
  origins: ReadonlyArray<CalendarEvent>,
  generated: ReadonlyArray<GeneratedEvent>,
  targetCalendar: CalendarRole,
  rules: ReconcileRules,
  direction: Direction,
): SyncAction[] {
  const originByUid = buildOriginByUid(origins);
  const { groups: generatedByUid, firstSeenOrder } = groupGeneratedBySrcUid(generated);

  const actions: SyncAction[] = [];

  for (const origin of origins) {
    const iCalUID = requireICalUID(origin);
    const group = generatedByUid.get(iCalUID);

    if (group === undefined) {
      actions.push({
        kind: 'create',
        rule: rules.create,
        direction,
        calendar: targetCalendar,
        source: origin,
      });
      continue;
    }

    const keep = group[0];
    if (!isSameContent(origin, keep.event)) {
      actions.push({
        kind: 'update',
        rule: rules.update,
        direction,
        calendar: targetCalendar,
        source: origin,
        target: keep.event,
      });
    }

    for (const duplicate of group.slice(1)) {
      actions.push({
        kind: 'delete',
        rule: rules.duplicateDelete,
        direction,
        calendar: targetCalendar,
        target: duplicate.event,
        srcUid: duplicate.srcUid,
      });
    }
  }

  for (const srcUid of firstSeenOrder) {
    if (originByUid.has(srcUid)) {
      continue;
    }
    // firstSeenOrder は groups のキーから作られているため、必ず取得できる
    const group = generatedByUid.get(srcUid) as GeneratedEvent[];
    for (const item of group) {
      actions.push({
        kind: 'delete',
        rule: rules.delete,
        direction,
        calendar: targetCalendar,
        target: item.event,
        srcUid: item.srcUid,
      });
    }
  }

  return actions;
}

/**
 * T/N/M/C から双方向の同期アクションを計画する（design.md §2.2「syncPlanner.ts」）。
 * T→P（S1/S2/S3/S3D）に続けて P→T（S4/S5/S6/S6D）のアクションを返す。
 * ペア（initialMatch）は classify によって入力から除外されている前提のため、
 * この関数内で特別扱いしない（D1）。
 */
export function planSync(input: {
  t: ReadonlyArray<CalendarEvent>;
  n: ReadonlyArray<CalendarEvent>;
  m: ReadonlyArray<GeneratedEvent>;
  c: ReadonlyArray<GeneratedEvent>;
}): SyncAction[] {
  const tToP = reconcile(
    input.t,
    input.m,
    'primary',
    { create: 'S1', update: 'S2', delete: 'S3', duplicateDelete: 'S3D' },
    'T→P',
  );
  const pToT = reconcile(
    input.n,
    input.c,
    'todoist',
    { create: 'S4', update: 'S5', delete: 'S6', duplicateDelete: 'S6D' },
    'P→T',
  );
  return [...tToP, ...pToT];
}
