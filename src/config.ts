/**
 * 同期エンジンが共有する定数モジュール。
 * design.md §2.2 の config.ts ブロックに記載された定数をそのまま定義する。
 * このモジュールは他モジュールに依存しない。副作用を持たない。GAS グローバルを参照しない。
 */

export const SRC_UID_KEY = 'srcUid';
export const INITIAL_MATCH_KEY = 'initialMatch';
export const INITIAL_MATCH_VALUE = 'true';
export const PRIMARY_CALENDAR_ID = 'primary';
export const TRIGGER_INTERVAL_MINUTES = 5;
export const LOCK_WAIT_MS = 1000;
export const LIST_PAGE_SIZE = 2500;
export const INSTANCE_LOOKUP_MAX_RESULTS = 1;
export const SEND_UPDATES = 'none' as const;
export const SHEET_SETTINGS = 'settings';
export const SHEET_LOG = 'log';
export const SHEET_LINKS = 'links';
export const SETTING_KEY_TODOIST_CALENDAR_ID = 'todoistCalendarId';
export const SETTING_KEY_INITIAL_MATCH_DONE_AT = 'initialMatchDoneAt';
export const ORIGIN_EVENT_TYPES: ReadonlyArray<string> = ['default', 'fromGmail'];
export const TRIGGER_HANDLER = 'sync';

// Todoist API v1（https://developer.todoist.com/api/v1/）関連の定数。
// トークンの値そのものはここに置かず、スクリプトプロパティのキー名だけを定数化する。
export const TODOIST_API_BASE_URL = 'https://api.todoist.com/api/v1';
export const TODOIST_API_TOKEN_PROPERTY_KEY = 'TODOIST_API_TOKEN';
// GET /tasks の 1 ページあたりの最大件数（Todoist API の上限）。
export const TODOIST_TASKS_LIST_LIMIT = 200;
