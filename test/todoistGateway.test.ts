import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, listTasks, removeTask, updateTask } from '../src/todoistGateway';
import { TODOIST_API_BASE_URL, TODOIST_API_TOKEN_PROPERTY_KEY, TODOIST_TASKS_LIST_LIMIT } from '../src/config';
import type { TodoistTask } from '../src/types';

/**
 * `UrlFetchApp` のうち、このモジュールが使う範囲だけを narrow に表現したフェイク型。
 */
type FakeHttpResponse = {
  getResponseCode(): number;
  getContentText(): string;
};

type FakeUrlFetchApp = {
  fetch(url: string, options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions): FakeHttpResponse;
};

type FakeScriptProperties = { getProperty(key: string): string | null };
type FakePropertiesService = { getScriptProperties(): FakeScriptProperties };

function stubUrlFetchApp(fetchImpl: FakeUrlFetchApp['fetch']): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(fetchImpl);
  const fake: FakeUrlFetchApp = { fetch };
  vi.stubGlobal('UrlFetchApp', fake);
  return fetch;
}

function stubToken(token: string | null): void {
  const properties: FakeScriptProperties = { getProperty: () => token };
  const service: FakePropertiesService = { getScriptProperties: () => properties };
  vi.stubGlobal('PropertiesService', service);
}

function jsonResponse(code: number, body: unknown): FakeHttpResponse {
  const text = JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text };
}

function fakeTask(overrides: Partial<TodoistTask> = {}): TodoistTask {
  return { id: 'task-1', content: 'Meeting', due: { date: '2026-09-16T01:00:00Z', timezone: null }, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('token handling', () => {
  it('throws without calling UrlFetchApp when the token property is missing', () => {
    stubToken(null);
    const fetch = stubUrlFetchApp(() => jsonResponse(200, { results: [], next_cursor: null }));

    expect(() => listTasks()).toThrow(new RegExp(TODOIST_API_TOKEN_PROPERTY_KEY));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws when the token property is an empty string', () => {
    stubToken('   ');
    const fetch = stubUrlFetchApp(() => jsonResponse(200, { results: [], next_cursor: null }));

    expect(() => listTasks()).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the token trimmed of surrounding whitespace/newlines as Bearer <trimmed>', () => {
    stubToken('  secret-token\n');
    const fetch = stubUrlFetchApp(() => jsonResponse(200, { results: [], next_cursor: null }));

    listTasks();

    const [, options] = fetch.mock.calls[0];
    expect(options).toMatchObject({ headers: { Authorization: 'Bearer secret-token' } });
  });
});

describe('non-2xx handling', () => {
  it('throws an Error including the status code and response body on a non-2xx response', () => {
    stubToken('secret-token');
    stubUrlFetchApp(() => jsonResponse(401, { error: 'UNAUTHORIZED' }));

    expect(() => listTasks()).toThrow(/401/);
  });
});

describe('listTasks', () => {
  it('sends Authorization: Bearer <token> and follows next_cursor until exhausted', () => {
    stubToken('secret-token');
    const page1 = [fakeTask({ id: 'a' }), fakeTask({ id: 'b' })];
    const page2 = [fakeTask({ id: 'c' })];
    const fetch = stubUrlFetchApp((url) => {
      if (url.includes('cursor=')) {
        return jsonResponse(200, { results: page2, next_cursor: null });
      }
      return jsonResponse(200, { results: page1, next_cursor: 'next-page-token' });
    });

    const tasks = listTasks();

    expect(tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [firstUrl, firstOptions] = fetch.mock.calls[0];
    expect(firstUrl).toBe(`${TODOIST_API_BASE_URL}/tasks?limit=${TODOIST_TASKS_LIST_LIMIT}`);
    expect(firstOptions).toMatchObject({
      method: 'get',
      headers: { Authorization: 'Bearer secret-token' },
      muteHttpExceptions: true,
    });
    const [secondUrl] = fetch.mock.calls[1];
    expect(secondUrl).toBe(`${TODOIST_API_BASE_URL}/tasks?limit=${TODOIST_TASKS_LIST_LIMIT}&cursor=next-page-token`);
  });

  it('returns an empty array when the single page has no results', () => {
    stubToken('secret-token');
    stubUrlFetchApp(() => jsonResponse(200, { results: [], next_cursor: null }));

    expect(listTasks()).toEqual([]);
  });
});

describe('createTask', () => {
  it('POSTs to /tasks with the JSON payload and returns the parsed task', () => {
    stubToken('secret-token');
    const created = fakeTask({ id: 'new-1' });
    const fetch = stubUrlFetchApp(() => jsonResponse(200, created));

    const result = createTask({ content: 'New task', due_date: '2026-09-20' });

    expect(result).toEqual(created);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`${TODOIST_API_BASE_URL}/tasks`);
    expect(options.method).toBe('post');
    expect(options.contentType).toBe('application/json');
    expect(options.payload).toBe(JSON.stringify({ content: 'New task', due_date: '2026-09-20' }));
  });
});

describe('updateTask', () => {
  it('POSTs to /tasks/{id} with the JSON payload and returns the parsed task', () => {
    stubToken('secret-token');
    const updated = fakeTask({ id: 'task-77' });
    const fetch = stubUrlFetchApp(() => jsonResponse(200, updated));

    const result = updateTask('task-77', { content: 'Renamed', due_datetime: '2026-09-20T01:00:00Z' });

    expect(result).toEqual(updated);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`${TODOIST_API_BASE_URL}/tasks/task-77`);
    expect(options.method).toBe('post');
    expect(options.payload).toBe(JSON.stringify({ content: 'Renamed', due_datetime: '2026-09-20T01:00:00Z' }));
  });

  it('URL-encodes the task id', () => {
    stubToken('secret-token');
    const fetch = stubUrlFetchApp(() => jsonResponse(200, fakeTask()));

    updateTask('task with space', { content: 'x' });

    const [url] = fetch.mock.calls[0];
    expect(url).toBe(`${TODOIST_API_BASE_URL}/tasks/task%20with%20space`);
  });
});

describe('removeTask', () => {
  it('DELETEs /tasks/{id} and sends no payload', () => {
    stubToken('secret-token');
    const fetch = stubUrlFetchApp(() => ({ getResponseCode: () => 204, getContentText: () => '' }));

    removeTask('task-1');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`${TODOIST_API_BASE_URL}/tasks/task-1`);
    expect(options.method).toBe('delete');
    expect(options.payload).toBeUndefined();
    expect(options.muteHttpExceptions).toBe(true);
  });
});
