/**
 * Todoist API v1（https://developer.todoist.com/api/v1/、ベース URL:
 * https://api.todoist.com/api/v1）を `UrlFetchApp` で呼び出す薄いラッパーモジュール。
 * `calendarGateway.ts` と同じパターン（1 関数 1 API 呼び出し、try/catch なし、例外は
 * 呼び出し元へ伝播させる）を踏襲する。
 *
 * 認証: スクリプトプロパティ TODOIST_API_TOKEN_PROPERTY_KEY に保存された API トークンを
 * `Authorization: Bearer <token>` ヘッダーに付ける。未設定・空文字なら明確に throw する
 * （フォールバックしない）。
 */
import { TODOIST_API_BASE_URL, TODOIST_API_TOKEN_PROPERTY_KEY, TODOIST_TASKS_LIST_LIMIT } from './config';
import type { TodoistTask } from './types';

// GET /tasks のレスポンス形式（カーソルベースのページング）。
type TodoistTasksListResponse = { results: TodoistTask[]; next_cursor: string | null };

// POST /tasks・POST /tasks/{id} に送るペイロード。
// due_date（終日: 'YYYY-MM-DD'）と due_datetime（時刻あり: UTC の 'YYYY-MM-DDTHH:MM:SSZ'）は
// どちらか一方だけを含める。
export type TodoistTaskPayload = {
  content: string;
  due_date?: string;
  due_datetime?: string;
};

/**
 * スクリプトプロパティから Todoist API トークンを読む。未設定・空文字なら明確に throw する。
 */
function getApiToken(): string {
  const token = PropertiesService.getScriptProperties().getProperty(TODOIST_API_TOKEN_PROPERTY_KEY);
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(
      `スクリプトプロパティ "${TODOIST_API_TOKEN_PROPERTY_KEY}" に Todoist API トークンが設定されていません。`,
    );
  }
  return token;
}

/**
 * 共通呼び出しヘルパー。`Authorization: Bearer <token>` を付け、`muteHttpExceptions: true` を使う。
 * `getResponseCode()` が 2xx 以外なら、本文を含む Error を throw する
 * （`UrlFetchApp` は既定で HTTP エラーを throw しないため、明示的に判定する）。
 */
function fetchTodoist(
  method: GoogleAppsScript.URL_Fetch.HttpMethod,
  path: string,
  payload?: TodoistTaskPayload,
): GoogleAppsScript.URL_Fetch.HTTPResponse {
  const token = getApiToken();
  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  };
  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(`${TODOIST_API_BASE_URL}${path}`, options);
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      `Todoist API request failed (${method.toUpperCase()} ${path}): ${code} ${response.getContentText()}`,
    );
  }
  return response;
}

/**
 * アクティブなタスクを全件取得する（完了済みタスクは含まれない）。
 * `results` / `next_cursor` によるカーソルベースのページングを、`next_cursor` が null に
 * なるまで繰り返す。
 */
export function listTasks(): TodoistTask[] {
  const tasks: TodoistTask[] = [];
  let cursor: string | undefined;

  do {
    const query =
      cursor === undefined
        ? `?limit=${TODOIST_TASKS_LIST_LIMIT}`
        : `?limit=${TODOIST_TASKS_LIST_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
    const response = fetchTodoist('get', `/tasks${query}`);
    const body = JSON.parse(response.getContentText()) as TodoistTasksListResponse;
    tasks.push(...body.results);
    cursor = body.next_cursor === null ? undefined : body.next_cursor;
  } while (cursor !== undefined);

  return tasks;
}

/**
 * タスクを新規作成する（POST /tasks）。プロジェクトを指定しないため Inbox に作られる。
 */
export function createTask(payload: TodoistTaskPayload): TodoistTask {
  const response = fetchTodoist('post', '/tasks', payload);
  return JSON.parse(response.getContentText()) as TodoistTask;
}

/**
 * タスクを更新する（POST /tasks/{id}）。
 */
export function updateTask(taskId: string, payload: TodoistTaskPayload): TodoistTask {
  const response = fetchTodoist('post', `/tasks/${encodeURIComponent(taskId)}`, payload);
  return JSON.parse(response.getContentText()) as TodoistTask;
}

/**
 * タスクを削除する（DELETE /tasks/{id}）。完了ではなく削除を基本とする（S6/S6D）。
 */
export function removeTask(taskId: string): void {
  fetchTodoist('delete', `/tasks/${encodeURIComponent(taskId)}`);
}
