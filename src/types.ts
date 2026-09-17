/**
 * 同期エンジンが共有する型モジュール。
 * design.md §2.2 の types.ts ブロックに記載された型をそのまま定義する。
 * このモジュールはランタイムの import を持たない（`export type` のみ）。
 */

export type CalendarEvent = GoogleAppsScript.Calendar.Schema.Event;
export type CalendarRole = 'primary' | 'todoist';
export type Direction = 'T→P' | 'P→T' | 'INIT' | 'REPAIR';

export type LinkKind = 'generated' | 'paired';
export type LinkEntry = {
  calendar: CalendarRole;
  iCalUID: string; // todoist の generated 行（Todoist タスク由来）では空文字を許容する
  srcUid: string;
  kind: LinkKind;
  recordedAt: Date;
  // todoist の generated 行でのみ設定する（Todoist タスクの id）。他の行では設定しない（undefined のまま）。
  todoistTaskId?: string;
};

export type GeneratedEvent = { event: CalendarEvent; srcUid: string };

// Todoist API v1 のタスクの最小表現。実際のレスポンスにはこれ以外のフィールドも含まれるが、
// このプロジェクトが使うのはこれらのフィールドだけである。
export type TodoistTaskDue = {
  // 'YYYY-MM-DD'（終日）/ 'YYYY-MM-DDTHH:MM:SS'（timezone 付き floating）/ 'YYYY-MM-DDTHH:MM:SSZ'（UTC）
  date: string;
  timezone: string | null;
};

export type TodoistTask = {
  id: string;
  content: string;
  due: TodoistTaskDue | null;
};

// P→T（S4/S5/S6/S6D）における生成物（Todoist タスク）。GeneratedEvent の Todoist タスク版。
export type GeneratedTodoistTask = { task: TodoistTask; srcUid: string };

export type ClassifiedEvents = {
  origins: ReadonlyArray<CalendarEvent>; // T または N
  generated: ReadonlyArray<GeneratedEvent>; // M または C（srcUid を失い、links から復元したものも含む）
  observedLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>; // 取得範囲内で確認できた生成物・ペア
  repairs: ReadonlyArray<SyncAction>; // kind: 'repair'
};

export type SyncAction =
  | { kind: 'create'; rule: 'S1'; direction: Direction; calendar: 'primary'; source: CalendarEvent }
  | { kind: 'create'; rule: 'S4'; direction: Direction; calendar: 'todoist'; source: CalendarEvent }
  | {
      kind: 'update';
      rule: 'S2';
      direction: Direction;
      calendar: 'primary';
      source: CalendarEvent;
      target: CalendarEvent;
    }
  | {
      // Todoist タスクの更新（S5）。対象は CalendarEvent ではなく、links 由来の todoistTaskId で識別する。
      kind: 'update';
      rule: 'S5';
      direction: Direction;
      calendar: 'todoist';
      source: CalendarEvent;
      todoistTaskId: string;
    }
  | {
      kind: 'delete';
      rule: 'S3' | 'S3D';
      direction: Direction;
      calendar: 'primary';
      target: CalendarEvent;
      srcUid: string;
    }
  | {
      // Todoist タスクの削除（S6/S6D）。対象は CalendarEvent ではなく、links 由来の todoistTaskId で識別する。
      kind: 'delete';
      rule: 'S6' | 'S6D';
      direction: Direction;
      calendar: 'todoist';
      todoistTaskId: string;
      srcUid: string;
    }
  | { kind: 'mark'; rule: 'INIT'; direction: 'INIT'; calendar: CalendarRole; target: CalendarEvent; srcUid: string }
  | {
      kind: 'repair';
      rule: 'REPAIR';
      direction: 'REPAIR';
      calendar: CalendarRole;
      target: CalendarEvent;
      srcUid: string;
      linkKind: LinkKind;
    };

export type ExecutionResult = {
  createdLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>;
  deletedKeys: ReadonlyArray<string>; // `${calendar}:${iCalUID}`
};

// executeActions が action を実行するたびに書き込む可変な入れ物。呼び出し元（main.ts の sync）が
// 事前に生成して渡し、途中で例外が発生してもそこまでの進捗を読み取れるようにする（本改訂で追加）。
export type ExecutionResultAccumulator = {
  createdLinks: Omit<LinkEntry, 'recordedAt'>[];
  deletedKeys: string[];
};

export type Settings = {
  todoistCalendarId: string;
  initialMatchDoneAt: string | null; // 空欄なら未実施。値の有無で判定するだけで、代わりの値で補うことはしない
};

export type LogLevel = 'INFO' | 'WARN';
