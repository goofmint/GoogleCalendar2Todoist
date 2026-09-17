/**
 * 双方向同期計画の純粋ロジック（design.md §2.2「syncPlanner.ts」/ §0 D1）。
 * 副作用を持たず、GAS のグローバルを参照しない。
 * ペア（initialMatch）は eventClassifier.classify によって origins/generated から
 * 除外されている前提のため、この関数は特別扱いしない（D1）。
 */

import { contentKeyForInitialMatch, hasNonEmptyRecurrence, isSameContent, isSameTodoistTaskContent } from './eventContent';
import type {
  CalendarEvent,
  Direction,
  GeneratedEvent,
  GeneratedTodoistTask,
  LinkEntry,
  SyncAction,
  TodoistTask,
} from './types';

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
 * T→P（S1/S2/S3/S3D）の照合ロジック（design.md §2.2 の擬似コード）。
 * origins を入力順に走査して create / update / 重複 delete を決定し、
 * その後 generated を srcUid の初出順に走査して孤児 delete を決定する。
 * P→T（Todoist タスク）は対象の表現が異なるため、reconcileTodoistTasks に分離した。
 */
function reconcile(
  origins: ReadonlyArray<CalendarEvent>,
  generated: ReadonlyArray<GeneratedEvent>,
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
        rule: 'S1',
        direction,
        calendar: 'primary',
        source: origin,
      });
      continue;
    }

    const keep = group[0];
    if (!isSameContent(origin, keep.event)) {
      actions.push({
        kind: 'update',
        rule: 'S2',
        direction,
        calendar: 'primary',
        source: origin,
        target: keep.event,
      });
    }

    for (const duplicate of group.slice(1)) {
      actions.push({
        kind: 'delete',
        rule: 'S3D',
        direction,
        calendar: 'primary',
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
        rule: 'S3',
        direction,
        calendar: 'primary',
        target: item.event,
        srcUid: item.srcUid,
      });
    }
  }

  return actions;
}

type GeneratedTodoistGroups = {
  groups: ReadonlyMap<string, GeneratedTodoistTask[]>;
  firstSeenOrder: string[];
};

/**
 * Todoist タスクの生成物を srcUid でグループ化し、各グループ内を id 昇順に安定ソートする
 * （最小 id を先頭 = keep として保持する）。groupGeneratedBySrcUid の Todoist タスク版。
 */
function groupGeneratedTodoistTasksBySrcUid(generated: ReadonlyArray<GeneratedTodoistTask>): GeneratedTodoistGroups {
  const groups = new Map<string, GeneratedTodoistTask[]>();
  const firstSeenOrder: string[] = [];

  for (const item of generated) {
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
      if (a.task.id < b.task.id) {
        return -1;
      }
      if (a.task.id > b.task.id) {
        return 1;
      }
      return 0;
    });
  }

  return { groups, firstSeenOrder };
}

/**
 * P→T（S4/S5/S6/S6D）の照合ロジック。N（origins）と Todoist タスクの生成物を srcUid で突き合わせる。
 * 繰り返し（recurrence）を持つ N は、当面 P→T タスク化の対象外とする（要件の制約。RRULE →
 * due_string の無損失変換が困難なため）。対象外化はこの関数の入り口で行う。
 */
function reconcileTodoistTasks(
  n: ReadonlyArray<CalendarEvent>,
  generated: ReadonlyArray<GeneratedTodoistTask>,
): SyncAction[] {
  const eligibleOrigins = n.filter((event) => !hasNonEmptyRecurrence(event));
  const originByUid = buildOriginByUid(eligibleOrigins);
  const { groups: generatedByUid, firstSeenOrder } = groupGeneratedTodoistTasksBySrcUid(generated);

  const actions: SyncAction[] = [];

  for (const origin of eligibleOrigins) {
    const iCalUID = requireICalUID(origin);
    const group = generatedByUid.get(iCalUID);

    if (group === undefined) {
      actions.push({ kind: 'create', rule: 'S4', direction: 'P→T', calendar: 'todoist', source: origin });
      continue;
    }

    const keep = group[0];
    if (!isSameTodoistTaskContent(origin, keep.task)) {
      actions.push({
        kind: 'update',
        rule: 'S5',
        direction: 'P→T',
        calendar: 'todoist',
        source: origin,
        todoistTaskId: keep.task.id,
      });
    }

    for (const duplicate of group.slice(1)) {
      actions.push({
        kind: 'delete',
        rule: 'S6D',
        direction: 'P→T',
        calendar: 'todoist',
        todoistTaskId: duplicate.task.id,
        srcUid: duplicate.srcUid,
      });
    }
  }

  for (const srcUid of firstSeenOrder) {
    if (originByUid.has(srcUid)) {
      continue;
    }
    const group = generatedByUid.get(srcUid) as GeneratedTodoistTask[];
    for (const item of group) {
      actions.push({
        kind: 'delete',
        rule: 'S6',
        direction: 'P→T',
        calendar: 'todoist',
        todoistTaskId: item.task.id,
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
 * `c` は「Todoist」カレンダーの C イベントではなく、Todoist API のタスク（GeneratedTodoistTask）を
 * 渡す（本チケットでの変更点）。
 */
export function planSync(input: {
  t: ReadonlyArray<CalendarEvent>;
  n: ReadonlyArray<CalendarEvent>;
  m: ReadonlyArray<GeneratedEvent>;
  c: ReadonlyArray<GeneratedTodoistTask>;
}): SyncAction[] {
  const tToP = reconcile(input.t, input.m, 'T→P');
  const pToT = reconcileTodoistTasks(input.n, input.c);
  return [...tToP, ...pToT];
}

export type InactiveTodoistLink = { srcUid: string; observedRow: Omit<LinkEntry, 'recordedAt'> };

/**
 * links の「todoist / generated」行を、現在アクティブな Todoist タスク一覧と突き合わせる。
 * - リンク先のタスクがアクティブ一覧にあれば、P→T の生成物として reconcileTodoistTasks に渡す
 *   （`generated`/`observed`）。N が既に削除されていれば、reconcileTodoistTasks の孤児削除
 *   （S6）が自動的に処理する。
 * - リンク先のタスクがアクティブ一覧に無ければ、ユーザーが Todoist 側でタスクを完了・削除した
 *   とみなす。この場合、S4 で再作成してはいけない（要件）。ただし、その判断のためには
 *   「links に対応行がある」という事実そのものを次回以降も残す必要があるため、この関数では
 *   generated/observed に含めず、`inactiveLinks` として返すだけにとどめる。
 *   実際に links 行を残す（observed に含める）か、削除する（含めない）かは、
 *   対応する N がまだ存在するかどうかで呼び出し元（main.ts）が決める。
 *     - N がまだ存在する: links 行を残す（S4 を再発生させないため）
 *     - N も無くなっている: links 行を削除する（掃除。要件どおり）
 */
export function resolveTodoistTaskLinks(input: {
  links: ReadonlyArray<LinkEntry>;
  activeTasks: ReadonlyArray<TodoistTask>;
}): {
  generated: GeneratedTodoistTask[];
  observed: Array<Omit<LinkEntry, 'recordedAt'>>;
  inactiveLinks: InactiveTodoistLink[];
} {
  const activeTaskById = new Map(input.activeTasks.map((task) => [task.id, task] as const));

  const generated: GeneratedTodoistTask[] = [];
  const observed: Array<Omit<LinkEntry, 'recordedAt'>> = [];
  const inactiveLinks: InactiveTodoistLink[] = [];

  for (const link of input.links) {
    if (link.calendar !== 'todoist' || link.kind !== 'generated' || link.todoistTaskId === undefined) {
      continue;
    }
    const observedRow: Omit<LinkEntry, 'recordedAt'> = {
      calendar: 'todoist',
      iCalUID: '',
      srcUid: link.srcUid,
      kind: 'generated',
      todoistTaskId: link.todoistTaskId,
    };
    const task = activeTaskById.get(link.todoistTaskId);
    if (task === undefined) {
      inactiveLinks.push({ srcUid: link.srcUid, observedRow });
      continue;
    }
    generated.push({ task, srcUid: link.srcUid });
    observed.push(observedRow);
  }

  return { generated, observed, inactiveLinks };
}

/**
 * S1 の二重ミラー除外（Assumption 3）。
 * 日時付きタスクは公式連携が「Todoist」カレンダーにイベントとして表示するため、これが T として
 * 分類され S1 で primary にミラーを作ってしまう。コンテンツキー（start + '|' + summary）で、
 * 既に有効な Todoist タスクを持つ N と一致する T 候補を、自作タスク由来として除外する。
 * 曖昧一致（同一キーが複数）は安全側（除外しない）にし、呼び出し元で WARN を出せるよう
 * ambiguousKeys として返す。
 */
export function excludeOwnTaskMirrors(
  todoistOrigins: ReadonlyArray<CalendarEvent>,
  nEventsWithGeneratedTask: ReadonlyArray<CalendarEvent>,
): { origins: CalendarEvent[]; ambiguousKeys: string[] } {
  if (nEventsWithGeneratedTask.length === 0) {
    return { origins: [...todoistOrigins], ambiguousKeys: [] };
  }

  const nGroups = new Map<string, CalendarEvent[]>();
  for (const event of nEventsWithGeneratedTask) {
    const key = contentKeyForInitialMatch(event);
    const existing = nGroups.get(key);
    if (existing === undefined) {
      nGroups.set(key, [event]);
    } else {
      existing.push(event);
    }
  }

  const tGroups = new Map<string, CalendarEvent[]>();
  for (const event of todoistOrigins) {
    const key = contentKeyForInitialMatch(event);
    const existing = tGroups.get(key);
    if (existing === undefined) {
      tGroups.set(key, [event]);
    } else {
      existing.push(event);
    }
  }

  const excluded = new Set<CalendarEvent>();
  const ambiguousKeySet = new Set<string>();

  for (const [key, tEvents] of tGroups) {
    const nEvents = nGroups.get(key);
    if (nEvents === undefined) {
      continue;
    }
    if (tEvents.length === 1 && nEvents.length === 1) {
      excluded.add(tEvents[0]);
    } else {
      ambiguousKeySet.add(key);
    }
  }

  return {
    origins: todoistOrigins.filter((event) => !excluded.has(event)),
    ambiguousKeys: [...ambiguousKeySet].sort(),
  };
}
