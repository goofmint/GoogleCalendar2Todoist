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
  iCalUID: string;
  srcUid: string;
  kind: LinkKind;
  recordedAt: Date;
};

export type GeneratedEvent = { event: CalendarEvent; srcUid: string };

export type ClassifiedEvents = {
  origins: ReadonlyArray<CalendarEvent>; // T または N
  generated: ReadonlyArray<GeneratedEvent>; // M または C（srcUid を失い、links から復元したものも含む）
  observedLinks: ReadonlyArray<Omit<LinkEntry, 'recordedAt'>>; // 取得範囲内で確認できた生成物・ペア
  repairs: ReadonlyArray<SyncAction>; // kind: 'repair'
};

export type SyncAction =
  | { kind: 'create'; rule: 'S1' | 'S4'; direction: Direction; calendar: CalendarRole; source: CalendarEvent }
  | {
      kind: 'update';
      rule: 'S2' | 'S5';
      direction: Direction;
      calendar: CalendarRole;
      source: CalendarEvent;
      target: CalendarEvent;
    }
  | {
      kind: 'delete';
      rule: 'S3' | 'S6' | 'S3D' | 'S6D';
      direction: Direction;
      calendar: CalendarRole;
      target: CalendarEvent;
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

export type Settings = {
  todoistCalendarId: string;
  initialMatchDoneAt: string | null; // 空欄なら未実施。値の有無で判定するだけで、代わりの値で補うことはしない
};

export type LogLevel = 'INFO' | 'WARN';
