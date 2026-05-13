export type PushType = 'INITIAL' | 'OVERRIDE' | 'SYNC_DELTA' | 'SYNC_FRESH';
export type PushStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';
export type SyncStatus = 'IDLE' | 'RUNNING' | 'FAILED' | 'COMPLETED';
export type SyncMode = 'RESYNC_SAME' | 'EXTEND_TO_TODAY' | 'CUSTOM';

export interface PushLog {
  id: string;
  integrationId: string;
  clientId: string;
  projectKey: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  sharepointListId: string;
  sharepointSiteId: string;
  pushedAt: string;
  pushedBy: string;
  recordCount: number;
  pushType: PushType;
  jqlUsed: string | null;
  status: PushStatus;
  errorMessage: string | null;
}

export interface SyncState {
  id: string;
  integrationId: string;
  lastSyncedAt: string | null;
  lastJiraUpdatedAt: string | null;
  lastPushLogId: string | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JiraItemCacheRow {
  integrationId: string;
  jiraKey: string;
  spItemId: string;
  jiraStatus: string | null;
  spStatus: string | null;
  isTerminal: boolean;
  updatedAt: string;
}

export interface SyncTriggerPayload {
  mode: SyncMode;
  customStart?: string;
  customEnd?: string;
  skipCompleted: boolean;
  deltaOnly: boolean;
}

export interface PushLogInsert {
  integrationId: string;
  clientId: string;
  projectKey: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  sharepointListId: string;
  sharepointSiteId: string;
  pushedBy: string;
  recordCount: number;
  pushType: PushType;
  jqlUsed?: string;
  errorMessage?: string;
  status?: PushStatus;
}
