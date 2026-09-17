/**
 * Apps Script の公開関数（design.md §2.2「main.ts（公開関数）」）。
 * `sync`: ロック取得 → 設定/links の読み込み → 取得・分類 → 初回照合/通常同期の分岐 → 実行 →
 *         links の条件付き更新 → `finally` での flush/release。
 * `setup`: シートの初期化と、重複しないトリガー登録。
 * `catch` は置かず、例外はそのまま伝播させる（design.md §5.1・§5.3）。
 * `esbuild.config.mjs` の footer がトップレベル関数 `sync`/`setup` から `G2T.sync()`/`G2T.setup()`
 * を呼ぶため、この 2 つの名前で export する。
 */
import { LOCK_WAIT_MS, PRIMARY_CALENDAR_ID, TRIGGER_HANDLER, TRIGGER_INTERVAL_MINUTES } from './config';
import { ensureSheets, markInitialMatchDone, readSettings } from './settingsRepository';
import { readLinks, writeLinks } from './linksRepository';
import { createLogger } from './logger';
import { hasFutureInstance, listFutureEvents, removeEvent } from './calendarGateway';
import { listTasks } from './todoistGateway';
import { classify, getSrcUid, isInitialMatched } from './eventClassifier';
import { planInitialMatch } from './initialMatcher';
import { excludeOwnTaskMirrors, planSync, resolveTodoistTaskLinks } from './syncPlanner';
import { executeActions } from './actionExecutor';
import { planLinks } from './linksPlanner';
import type { CalendarEvent, CalendarRole, LinkEntry, SyncAction } from './types';

type MarkAction = SyncAction & { kind: 'mark' };

function isMarkAction(action: SyncAction): action is MarkAction {
  return action.kind === 'mark';
}

/**
 * event.id を検証して返す。非空文字列でなければ throw する（フォールバックしない）。
 * hasFutureInstance の呼び出しに使う。
 */
function requireEventId(event: CalendarEvent): string {
  const id = event.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('未来回判定の対象の予定に id がありません。');
  }
  return id;
}

/**
 * mark アクションの target から iCalUID を取り出す。無ければ throw する（フォールバックしない）。
 */
function requireMarkTargetICalUID(action: MarkAction): string {
  const iCalUID = action.target.iCalUID;
  if (typeof iCalUID !== 'string' || iCalUID.length === 0) {
    throw new Error('mark アクションの target に iCalUID がありません。');
  }
  return iCalUID;
}

/**
 * actions のうち kind === 'mark' の行を、links の paired 行に変換する。
 * mark は executeActions が observed には含めないため、main 側で observed に足す必要がある。
 */
function markedLinksFromActions(actions: ReadonlyArray<SyncAction>): Array<Omit<LinkEntry, 'recordedAt'>> {
  return actions.filter(isMarkAction).map((action) => ({
    calendar: action.calendar,
    iCalUID: requireMarkTargetICalUID(action),
    srcUid: action.srcUid,
    kind: 'paired',
  }));
}

/**
 * 時間トリガーから呼ばれる。ロックを取れなければ何もせず return し、次回の実行に委ねる。
 */
export function sync(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.log('skip: lock busy');
    return;
  }

  const logger = createLogger();
  try {
    const settings = readSettings();
    const links = readLinks();
    const isInitialRun = settings.initialMatchDoneAt === null;
    const now = new Date();

    const todoist = classify(
      'todoist',
      listFutureEvents(settings.todoistCalendarId, now),
      links,
      (event) => hasFutureInstance(settings.todoistCalendarId, requireEventId(event), now),
    );
    const primary = classify(
      'primary',
      listFutureEvents(PRIMARY_CALENDAR_ID, now),
      links,
      (event) => hasFutureInstance(PRIMARY_CALENDAR_ID, requireEventId(event), now),
    );
    const repairs = [...todoist.repairs, ...primary.repairs];

    // P→T（S4/S5/S6/S6D）は「Todoist」カレンダーの C イベントではなく Todoist API のタスクを対象にする。
    // links の todoist/generated 行を、現在アクティブなタスク一覧と突き合わせる。
    const activeTasks = listTasks();
    const resolved = resolveTodoistTaskLinks({ links, activeTasks });

    // links に対応行があるが、そのタスクが既にユーザーによって完了・削除された（アクティブ一覧に
    // 無い）場合、対応する N がまだ存在するかどうかで扱いを分ける（要件: 完了・削除したタスクは
    // 再作成しない。N 自体が消えていれば links 行も掃除する）。
    //   - N がまだ存在する → S4 を再発生させないため、この N を起点集合から除外し、links 行は残す
    //   - N も無くなっている → タスクは既に無いので削除アクションは出さず、links 行も残さない（掃除）
    const nOriginICalUIDs = new Set(
      primary.origins.map((event) => event.iCalUID).filter((iCalUID): iCalUID is string => typeof iCalUID === 'string'),
    );
    const completedTaskSrcUidsWithExistingN = new Set<string>();
    const keptInactiveLinkObserved: Array<Omit<LinkEntry, 'recordedAt'>> = [];
    for (const inactive of resolved.inactiveLinks) {
      if (nOriginICalUIDs.has(inactive.srcUid)) {
        completedTaskSrcUidsWithExistingN.add(inactive.srcUid);
        keptInactiveLinkObserved.push(inactive.observedRow);
      }
      // else: N も既に無い。observed に含めないことで、この links 行は掃除される。
    }

    const todoistTaskOrigins = primary.origins.filter((event) => {
      const iCalUID = event.iCalUID;
      return !(typeof iCalUID === 'string' && completedTaskSrcUidsWithExistingN.has(iCalUID));
    });

    // S1 の二重ミラー除外（Assumption 3）: 有効な Todoist タスクを持つ N と同じコンテンツキーの
    // T 候補は、公式連携による自作タスクの echo とみなして除外する。
    const activeGeneratedSrcUids = new Set(resolved.generated.map((item) => item.srcUid));
    const nEventsWithGeneratedTask = todoistTaskOrigins.filter((event) => {
      const iCalUID = event.iCalUID;
      return typeof iCalUID === 'string' && activeGeneratedSrcUids.has(iCalUID);
    });
    const mirrorExclusion = excludeOwnTaskMirrors(todoist.origins, nEventsWithGeneratedTask);
    for (const key of mirrorExclusion.ambiguousKeys) {
      logger.warn('P→T', key, 'todoist mirror exclusion skipped: multiple events share this start/title');
    }

    let actions: SyncAction[];
    if (isInitialRun) {
      const match = planInitialMatch(todoist.origins, primary.origins);
      for (const key of match.ambiguousKeys) {
        logger.warn('INIT', key, 'initial match skipped: multiple events share this start/title');
      }
      actions = [...repairs, ...match.actions];
    } else {
      actions = [
        ...repairs,
        ...planSync({
          t: mirrorExclusion.origins,
          n: todoistTaskOrigins,
          m: primary.generated,
          c: resolved.generated,
        }),
      ];
    }

    const calendarIds: Record<CalendarRole, string> = {
      primary: PRIMARY_CALENDAR_ID,
      todoist: settings.todoistCalendarId,
    };
    const result = executeActions(actions, calendarIds, logger);

    const observed = [
      ...todoist.observedLinks,
      ...primary.observedLinks,
      ...resolved.observed,
      ...keptInactiveLinkObserved,
      ...markedLinksFromActions(actions),
    ];

    const { entries, changed } = planLinks({ current: links, observed, result, now });
    if (changed) {
      writeLinks(entries);
    }

    if (isInitialRun) {
      markInitialMatchDone(now);
    }
  } finally {
    logger.flush();
    lock.releaseLock();
  }
}

/**
 * 手動で 1 回実行する。シートの作成（ensureSheets）と、トリガーの重複しない登録を行う。
 * 何度実行しても `sync` のトリガーは 1 本のままになる（idempotent）。
 */
export function setup(): void {
  // sync と同じロックで直列化し、シート作成中の同期や、setup の同時実行によるトリガーの重複を防ぐ。
  // 手動実行なので、ロックが取れない場合は黙って終わらず明確にエラーにする。
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw new Error('setup: 同期処理の実行中のためロックを取得できませんでした。しばらくしてから再実行してください。');
  }

  try {
    ensureSheets();

    const existingTriggers = ScriptApp.getProjectTriggers();
    const hasSyncTrigger = existingTriggers.some((trigger) => trigger.getHandlerFunction() === TRIGGER_HANDLER);
    if (!hasSyncTrigger) {
      ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(TRIGGER_INTERVAL_MINUTES).create();
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * 旧経路（P→T が「Todoist」カレンダーへの C 複製だった頃）の残骸を削除する使い捨て関数。
 * 通常の `sync` からは呼ばれない。明示的に手動で 1 回実行する（README 参照）。
 *
 * 削除するのは、次の条件をすべて満たすイベントだけである。
 *   - srcUid を持つ（`getSrcUid` が null を返さない）
 *   - initialMatch を持たない（`isInitialMatched` が false）
 *   - links に対応する行（calendar: 'todoist', kind: 'generated', iCalUID 一致）がある
 * これ以外（initialMatch が付いたペア、srcUid を持たない本物の Todoist タスクのイベントなど）は
 * 絶対に削除しない。削除したイベントに対応する links の行も取り除く。
 *
 * 対象は listFutureEvents と同じ「現在時刻以降」の範囲に限る（過去の C は放置してよい。
 * 既に終わった予定であり busy 判定にも影響しない）。
 */
export function cleanupLegacyTodoistCopies(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw new Error(
      'cleanupLegacyTodoistCopies: 同期処理の実行中のためロックを取得できませんでした。しばらくしてから再実行してください。',
    );
  }

  const logger = createLogger();
  try {
    const settings = readSettings();
    const links = readLinks();
    const now = new Date();
    const events = listFutureEvents(settings.todoistCalendarId, now);

    const generatedICalUIDs = new Set(
      links.filter((link) => link.calendar === 'todoist' && link.kind === 'generated').map((link) => link.iCalUID),
    );

    const deletedKeys = new Set<string>();
    for (const event of events) {
      const srcUid = getSrcUid(event);
      if (srcUid === null) {
        continue; // 本物の Todoist タスクのイベント（srcUid を持たない）は絶対に削除しない
      }
      if (isInitialMatched(event)) {
        continue; // 初回照合ペアは絶対に削除しない
      }
      const iCalUID = event.iCalUID;
      if (typeof iCalUID !== 'string' || iCalUID.length === 0 || !generatedICalUIDs.has(iCalUID)) {
        continue; // links に対応する generated 行が無いものは安全側で削除しない
      }
      const eventId = event.id;
      if (typeof eventId !== 'string' || eventId.length === 0) {
        throw new Error(`削除対象の旧経路の複製に id がありません (iCalUID=${iCalUID})。`);
      }
      removeEvent(settings.todoistCalendarId, eventId);
      deletedKeys.add(`todoist:${iCalUID}`);
      logger.info('P→T', srcUid, `cleanup: deleted legacy todoist copy (iCalUID=${iCalUID})`);
    }

    if (deletedKeys.size > 0) {
      const remainingLinks = links.filter((link) => !deletedKeys.has(`${link.calendar}:${link.iCalUID}`));
      writeLinks(remainingLinks);
    }
  } finally {
    logger.flush();
    lock.releaseLock();
  }
}
