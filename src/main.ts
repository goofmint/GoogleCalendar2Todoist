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
import { listFutureEvents } from './calendarGateway';
import { classify } from './eventClassifier';
import { planInitialMatch } from './initialMatcher';
import { planSync } from './syncPlanner';
import { executeActions } from './actionExecutor';
import { planLinks } from './linksPlanner';
import type { CalendarRole, LinkEntry, SyncAction } from './types';

type MarkAction = SyncAction & { kind: 'mark' };

function isMarkAction(action: SyncAction): action is MarkAction {
  return action.kind === 'mark';
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

    const todoist = classify('todoist', listFutureEvents(settings.todoistCalendarId, now), links);
    const primary = classify('primary', listFutureEvents(PRIMARY_CALENDAR_ID, now), links);
    const repairs = [...todoist.repairs, ...primary.repairs];

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
        ...planSync({ t: todoist.origins, n: primary.origins, m: primary.generated, c: todoist.generated }),
      ];
    }

    const calendarIds: Record<CalendarRole, string> = {
      primary: PRIMARY_CALENDAR_ID,
      todoist: settings.todoistCalendarId,
    };
    const result = executeActions(actions, calendarIds, logger);

    const observed = [...todoist.observedLinks, ...primary.observedLinks, ...markedLinksFromActions(actions)];

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
