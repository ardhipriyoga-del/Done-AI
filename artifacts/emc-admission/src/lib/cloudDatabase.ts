import { apiUrl, getApiBaseUrl, hasApiProxy } from './apiConfig';
import { getCloudApiUrl } from './cloudSync';

const API_KEY = 'IPAW-EMC';

export interface CloudStoreResponse<T = any> {
  success: boolean;
  store: string;
  records: T[];
  metadata?: {
    savedAt?: string | null;
  };
}

export interface CloudRecordMutationResponse<T = any> {
  success: boolean;
  action: 'upsertRecord' | 'deleteRecord';
  store: string;
  record?: T;
  created?: boolean;
  deleted?: boolean;
}

function withQuery(url: string, values: Record<string, string>): string {
  const parsed = new URL(url);
  Object.entries(values).forEach(([key, value]) => parsed.searchParams.set(key, value));
  return parsed.toString();
}

async function parseResponse(response: Response): Promise<any> {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    // The status and text below produce a useful error for non-JSON GAS pages.
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(
      payload?.error ||
      `Cloud merespons HTTP ${response.status}.`,
    );
  }
  return payload;
}

/**
 * Read a logical object store from the GAS-backed database.
 *
 * This is deliberately separate from cloudSync's full snapshot restore:
 * database-first screens can refresh only the store they use, while the
 * existing snapshot remains available for bootstrap, backup, and recovery.
 */
export async function readCloudStore<T = any>(store: string): Promise<CloudStoreResponse<T>> {
  const cloudUrl = await getCloudApiUrl();
  const directUrl = withQuery(cloudUrl, {
    action: 'readStore',
    apiKey: API_KEY,
    store,
  });
  const requestUrl = hasApiProxy()
    ? apiUrl(`/api/cloud/store?url=${encodeURIComponent(cloudUrl)}&store=${encodeURIComponent(store)}`)
    : directUrl;

  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain, */*' },
    cache: 'no-store',
  });
  return parseResponse(response);
}

export async function upsertCloudRecord<T = any>(
  store: string,
  keyField: string,
  record: T,
): Promise<CloudRecordMutationResponse<T>> {
  const cloudUrl = await getCloudApiUrl();
  const requestUrl = hasApiProxy()
    ? apiUrl(`/api/cloud/record?url=${encodeURIComponent(cloudUrl)}`)
    : cloudUrl;
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': hasApiProxy() ? 'application/json' : 'text/plain;charset=utf-8',
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      action: 'upsertRecord',
      apiKey: API_KEY,
      store,
      keyField,
      record,
    }),
  });
  return parseResponse(response);
}

export async function deleteCloudRecord(
  store: string,
  keyField: string,
  key: string | number,
): Promise<CloudRecordMutationResponse> {
  const cloudUrl = await getCloudApiUrl();
  const requestUrl = hasApiProxy()
    ? apiUrl(`/api/cloud/record?url=${encodeURIComponent(cloudUrl)}`)
    : cloudUrl;
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': hasApiProxy() ? 'application/json' : 'text/plain;charset=utf-8',
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      action: 'deleteRecord',
      apiKey: API_KEY,
      store,
      keyField,
      key: String(key),
    }),
  });
  return parseResponse(response);
}

export function isCloudDatabaseConfigured(): boolean {
  return Boolean(getApiBaseUrl()) || typeof window !== 'undefined';
}