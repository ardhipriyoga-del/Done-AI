import {
  getDB,
  type SyncOutboxAction,
  type SyncOutboxEntry,
  type RestorePoint,
  type OperatingTheatreCache,
  type OperatingTheatrePatient,
  type OperatingTheatrePreadmissionCache,
} from './db';
import { activateOfflineBridge, apiUrl, hasApiProxy } from './apiConfig';
import {
  DEFAULT_ADMIN_PASSWORD_HASH,
  DEFAULT_ADMIN_USERNAME,
  initDefaultSettingsAndAdmin,
} from './auth';

// ── Constants ──────────────────────────────────────────────────────────────────

// URL default Google Apps Script — dapat diubah via Pengaturan > Backup & Restore
export const DEFAULT_CLOUD_API =
  'https://script.google.com/macros/s/AKfycbzAnMrxuit5itGRjFMuHy94pEGFBnA_RVKowtQCRJX_OotdaKBwayy5Tuq8-s-K94QUdA/exec';

const LEGACY_CLOUD_APIS = new Set([
  'https://script.google.com/macros/s/AKfycbyuJjKjo6_MOyW8z2Yk56yh4Zm_6wzGgm_f2dlNqzSiWzi5cax5L2QoMYYURqU0qWfk/exec',
  'https://script.google.com/macros/s/AKfycbyQtf5jYxJGHPcbHTCw2MYTYw50dsI0jg42l95fDNhYXOmaoGIgYIayXp-DdGPXa9OF5w/exec',
  'https://script.google.com/macros/s/AKfycbw4yrZkPdpzO14Y0tcuOdLnXU-tztRnNYclUDPTsk3Vw2FDAznuKsKvYwIxVTrEJ7P9nQ/exec',
  'https://script.google.com/macros/s/AKfycbzaZQohZ2CobI1auBmKWNF4bvONWM4WU1RHurPeWtm1jN-pHepS8Y8dAkO1eMv_eB-JeA/exec',
]);

// Alias untuk backward compat (komponen lain mengimpor CLOUD_API)
export const CLOUD_API = DEFAULT_CLOUD_API;

const API_KEY = 'IPAW-EMC';
const LOCAL_STORAGE_BACKUP_STORE = '__localStorage';
const LOCAL_CLOUD_CHANGE_REVISION_KEY = 'localCloudChangeRevision';
const NON_RESTORABLE_LOCAL_STORAGE_KEYS = new Set([
  // Authentication/session and device identity must never move between
  // browsers or users through a shared cloud backup.
  'emc_session',
  'ipaw_operating_theatre_client_id',
]);
const CLOUD_BACKUP_ENTRY_CHUNK_SIZE = 30_000;
const CLOUD_BACKUP_REQUEST_TARGET = 300_000;
const CLOUD_BACKUP_CHUNK_TIMEOUT = 30_000;
const BACKGROUND_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const CLOUD_BACKED_OPERATING_THEATRE_STORES = [
  'operatingTheatreCache',
  'operatingTheatrePreadmissionCache',
] as const;

function mergeUsersRestore(localUsers: any[], incomingUsers: any[]): any[] {
  const localSeedAdmin = localUsers.find(user =>
    typeof user?.username === 'string' &&
    user.username.trim().toLowerCase() === DEFAULT_ADMIN_USERNAME &&
    user.passwordHash === DEFAULT_ADMIN_PASSWORD_HASH,
  );
  const incomingAdmin = incomingUsers.find(user =>
    typeof user?.username === 'string' &&
    user.username.trim().toLowerCase() === DEFAULT_ADMIN_USERNAME,
  );

  // A fresh downloaded app creates the hardcoded admin locally before the
  // background restore starts. Keep that seed credential if an older Cloud
  // snapshot has a different admin hash, so first login remains possible.
  // Once the local admin password is changed, the local hash no longer matches
  // the seed and Cloud restore is allowed to replace it normally.
  if (localSeedAdmin && (!incomingAdmin || incomingAdmin.passwordHash !== DEFAULT_ADMIN_PASSWORD_HASH)) {
    return [
      ...incomingUsers.filter(user =>
        typeof user?.username !== 'string' ||
        user.username.trim().toLowerCase() !== DEFAULT_ADMIN_USERNAME,
      ),
      localSeedAdmin,
    ];
  }
  return incomingUsers;
}

export type CloudBackupProgressStatus =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'committing'
  | 'success'
  | 'error';

export interface CloudBackupProgress {
  status: CloudBackupProgressStatus;
  percent: number;
  message: string;
  currentChunk: number;
  totalChunks: number;
  updatedAt: number;
  error?: string;
}

const CLOUD_BACKUP_PROGRESS_EVENT = 'ipaw:cloud-backup-progress';
const INITIAL_CLOUD_BACKUP_PROGRESS: CloudBackupProgress = {
  status: 'idle',
  percent: 0,
  message: '',
  currentChunk: 0,
  totalChunks: 0,
  updatedAt: 0,
};
let currentCloudBackupProgress = INITIAL_CLOUD_BACKUP_PROGRESS;

export function getCloudBackupProgress(): CloudBackupProgress {
  return currentCloudBackupProgress;
}

export function subscribeToCloudBackupProgress(
  listener: (progress: CloudBackupProgress) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handleProgress = (event: Event) => {
    const progress = (event as CustomEvent<CloudBackupProgress>).detail;
    if (progress) listener(progress);
  };
  window.addEventListener(CLOUD_BACKUP_PROGRESS_EVENT, handleProgress);
  return () => window.removeEventListener(CLOUD_BACKUP_PROGRESS_EVENT, handleProgress);
}

function publishCloudBackupProgress(
  progress: Omit<CloudBackupProgress, 'updatedAt'>,
): void {
  currentCloudBackupProgress = { ...progress, updatedAt: Date.now() };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<CloudBackupProgress>(CLOUD_BACKUP_PROGRESS_EVENT, {
      detail: currentCloudBackupProgress,
    }));
  }
}

/** Deteksi mode offline: app dibuka sebagai file lokal (file:// protocol). */
export function isOfflineMode(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}

let activeBackup: Promise<void> | null = null;
let backupRequested = false;
let backgroundBackupStarted = false;
let backgroundBackupTimer: number | null = null;
let outboxSyncInFlight: Promise<void> | null = null;

function isBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

async function markCloudSyncPending(pending = true): Promise<void> {
  try {
    const db = await getDB();
    if (pending) {
      const previous = await db.get('settings', LOCAL_CLOUD_CHANGE_REVISION_KEY);
      const previousRevision = Number(previous?.value) || 0;
      await db.put('settings', {
        key: LOCAL_CLOUD_CHANGE_REVISION_KEY,
        value: Math.max(Date.now(), previousRevision + 1),
      });
    }
    await db.put('settings', {
      key: 'pendingCloudSync',
      value: pending,
    });
  } catch (error) {
    logError('pending-sync-marker', error);
  }
}

export async function getPendingSyncCount(): Promise<number> {
  try {
    const db = await getDB();
    const [outbox, pending] = await Promise.all([
      db.getAll('syncOutbox'),
      db.get('settings', 'pendingCloudSync'),
    ]);
    return outbox.length + (pending?.value ? 1 : 0);
  } catch {
    return 0;
  }
}

/**
 * Add a row-level change to the durable offline outbox.
 *
 * Modules can call this after updating their local IndexedDB replica. The
 * operation is retained until GAS acknowledges it, so closing ipaw.html or
 * losing the network cannot silently discard the change.
 */
export async function enqueueCloudRecordMutation(
  action: SyncOutboxAction,
  store: string,
  keyField: string,
  payload: { record?: any; key?: string | number },
): Promise<void> {
  const db = await getDB();
  const entry: SyncOutboxEntry = {
    action,
    store,
    keyField,
    ...(action === 'upsertRecord' ? { record: payload.record } : { key: payload.key }),
    createdAt: Date.now(),
    attempts: 0,
  };
  await db.add('syncOutbox', entry);
  await markCloudSyncPending(true);
  if (isBrowserOnline() && !isOfflineMode()) {
    void flushSyncOutbox();
  }
}

async function sendOutboxEntry(entry: SyncOutboxEntry): Promise<void> {
  const cloudUrl = await getCloudApiUrl();
  const requestUrl = hasApiProxy()
    ? apiUrl(`/api/cloud/record?url=${encodeURIComponent(cloudUrl)}`)
    : cloudUrl;
  const response = await fetchWithTimeout(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': hasApiProxy() ? 'application/json' : 'text/plain;charset=utf-8',
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      action: entry.action,
      apiKey: API_KEY,
      store: entry.store,
      keyField: entry.keyField,
      ...(entry.action === 'upsertRecord'
        ? { record: entry.record }
        : { key: String(entry.key) }),
    }),
  }, 30_000);
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    // parse below as a normal HTTP failure
  }
  if (!response.ok || json?.success === false) {
    throw new Error(json?.error || `GAS merespons HTTP ${response.status}`);
  }
}

/**
 * Flush acknowledged row-level changes in insertion order.
 */
export async function flushSyncOutbox(): Promise<void> {
  if (outboxSyncInFlight) return outboxSyncInFlight;
  if (!isBrowserOnline()) return;

  outboxSyncInFlight = (async () => {
    const db = await getDB();
    const entries = (await db.getAll('syncOutbox')).sort(
      (a, b) => (a.id ?? 0) - (b.id ?? 0),
    );
    for (const entry of entries) {
      try {
        await sendOutboxEntry(entry);
        if (entry.id !== undefined) await db.delete('syncOutbox', entry.id);
      } catch (error) {
        const updated: SyncOutboxEntry = {
          ...entry,
          attempts: (entry.attempts ?? 0) + 1,
          lastAttemptAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
        };
        if (entry.id !== undefined) await db.put('syncOutbox', updated);
        logError(`outbox/${entry.store}`, error);
        // Preserve ordering. A later mutation may depend on this one.
        break;
      }
    }
    // Do not clear pendingCloudSync here. The marker can represent a full
    // snapshot that still needs to be uploaded after the row-level outbox is
    // empty. Only a successfully committed full backup may clear it.
  })().finally(() => {
    outboxSyncInFlight = null;
  });
  return outboxSyncInFlight;
}

// ── Baca URL GAS dari settings (dengan fallback ke DEFAULT) ───────────────────

export const getCloudApiUrl = async (): Promise<string> => {
  // If the Windows bridge is already running, prefer it even when the user
  // opened ipaw.html directly instead of using the launcher URL override.
  // This avoids browser CORS/file-origin restrictions on hospital networks.
  await activateOfflineBridge();
  try {
    const db = await getDB();
    const entry = await db.get('settings', 'cloudApiUrl');
    const url: string = entry?.value?.trim();
    if (url && url.startsWith('https://script.google.com/')) {
      // Migrate devices that still have the previous deployment URL saved.
      if (LEGACY_CLOUD_APIS.has(url)) {
        await db.put('settings', { key: 'cloudApiUrl', value: DEFAULT_CLOUD_API });
        return DEFAULT_CLOUD_API;
      }
      return url;
    }
  } catch {
    // fallback
  }
  return DEFAULT_CLOUD_API;
};

// ── Logging helper ─────────────────────────────────────────────────────────────

function logRequest(tag: string, url: string): void {
  console.log(`[CloudSync][${tag}] → ${url}`);
}

function logResponse(tag: string, status: number, ok: boolean): void {
  const icon = ok ? '✓' : '✗';
  console.log(`[CloudSync][${tag}] ${icon} HTTP ${status}`);
}

function logError(tag: string, err: unknown): void {
  console.error(`[CloudSync][${tag}] ✗ Error:`, err);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 60_000,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// ── Export semua stores ke plain object ────────────────────────────────────────

export const exportAllStores = async (): Promise<Record<string, any[]>> => {
  // Pastikan proses inisialisasi akun sudah selesai sebelum membaca store.
  // Ini juga memulihkan akun admin default bila database browser masih kosong
  // setelah instalasi baru atau migrasi IndexedDB.
  await initDefaultSettingsAndAdmin();
  const db = await getDB();
  const result: Record<string, any[]> = {};
  const internalStores = new Set(['restorePoints', 'syncOutbox']);
  // Read every object store that exists in the current browser database. This
  // automatically includes new feature stores added in future schema versions.
  for (const store of Array.from(db.objectStoreNames)) {
    if (internalStores.has(store)) continue;
    result[store] = await db.getAll(store as any);
  }
  // Keep these two operational snapshots explicit in the cloud contract.
  // They are normally returned by objectStoreNames, but an older browser
  // database/migration can expose the stores late during startup. A backup
  // must never silently omit the planned and preadmission queues.
  for (const store of CLOUD_BACKED_OPERATING_THEATRE_STORES) {
    if (!Array.isArray(result[store])) {
      result[store] = await db.getAll(store as any);
    }
  }
  if (typeof window !== 'undefined') {
    result[LOCAL_STORAGE_BACKUP_STORE] = Object.keys(window.localStorage)
      .map(key => ({ key, value: window.localStorage.getItem(key) ?? '' }));
  }
  // This is a device-local control flag, not application data. Never copy a
  // transient "pending" state into the shared Cloud snapshot.
  if (Array.isArray(result.settings)) {
    result.settings = result.settings.filter(row => row?.key !== 'pendingCloudSync');
  }
  if (!Array.isArray(result.users) || result.users.length === 0) {
    throw new Error(
      'Master User belum tersedia di perangkat ini. Buka ulang aplikasi atau login kembali, lalu ulangi backup.',
    );
  }
  return result;
};

export const createRestorePoint = async (label = 'Auto Backup Before Restore'): Promise<RestorePoint> => {
  const database = await exportAllStores();
  const point: RestorePoint = {
    key: 'latest',
    createdAt: Date.now(),
    label,
    database,
  };
  const db = await getDB();
  await db.put('restorePoints', point);
  return point;
};

export const restoreLatestRestorePoint = async (): Promise<void> => {
  const db = await getDB();
  const point = await db.get('restorePoints', 'latest');
  if (!point?.database) throw new Error('Restore point belum tersedia.');

  const protectedStores = new Set(['restorePoints']);
  for (const store of Array.from(db.objectStoreNames)) {
    if (protectedStores.has(store)) continue;
    const rows = Array.isArray(point.database[store]) ? point.database[store] : [];
    const tx = db.transaction(store as any, 'readwrite');
    await tx.objectStore(store as any).clear();
    for (const row of rows) await (tx.objectStore(store as any) as any).put(row);
    await tx.done;
  }
};

interface CloudBackupEntry {
  store: string;
  recordIndex: number;
  chunkIndex: number;
  chunkTotal: number;
  jsonChunk: string;
}

function createCloudBackupId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ipaw-${Date.now()}-${random}`;
}

function buildCloudBackupChunks(database: Record<string, any[]>): CloudBackupEntry[][] {
  const entries: CloudBackupEntry[] = [];
  for (const store of Object.keys(database).sort()) {
    const records = Array.isArray(database[store]) ? database[store] : [];
    records.forEach((record, recordIndex) => {
      const serialized = JSON.stringify(record);
      const chunks: string[] = [];
      for (let start = 0; start < serialized.length; start += CLOUD_BACKUP_ENTRY_CHUNK_SIZE) {
        chunks.push(serialized.slice(start, start + CLOUD_BACKUP_ENTRY_CHUNK_SIZE));
      }
      if (!chunks.length) chunks.push('');
      chunks.forEach((jsonChunk, chunkIndex) => {
        entries.push({ store, recordIndex, chunkIndex, chunkTotal: chunks.length, jsonChunk });
      });
    });
  }

  const batches: CloudBackupEntry[][] = [];
  let batch: CloudBackupEntry[] = [];
  let batchBytes = 0;
  for (const entry of entries) {
    const entryBytes = JSON.stringify(entry).length + 32;
    if (batch.length && batchBytes + entryBytes > CLOUD_BACKUP_REQUEST_TARGET) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(entry);
    batchBytes += entryBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function sendCloudBackupOperation(
  cloudUrl: string,
  payload: Record<string, unknown>,
  timeoutMs = CLOUD_BACKUP_CHUNK_TIMEOUT,
): Promise<any> {
  const body = JSON.stringify(payload);
  const requestUrl = hasApiProxy()
    ? apiUrl(`/api/cloud/backup?url=${encodeURIComponent(cloudUrl)}`)
    : cloudUrl;
  logRequest(`backup/${String(payload.action)}`, requestUrl);
  const response = await fetchWithTimeout(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': hasApiProxy() ? 'application/json' : 'text/plain;charset=utf-8',
    },
    body,
  }, timeoutMs);
  logResponse(`backup/${String(payload.action)}`, response.status, response.ok);
  let json: any = null;
  try { json = await response.json(); } catch { /* handled below */ }
  if (!response.ok || json?.success === false) {
    throw new Error(json?.error || `Server merespons HTTP ${response.status}`);
  }
  return json;
}

function preadmissionPatientKey(patient: OperatingTheatrePatient): string {
  const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const noRM = normalize(patient.noRM);
  const episodeNo = normalize(patient.episodeNo);
  const name = normalize(patient.namaPasien);
  if (noRM && episodeNo) return `rm-episode:${noRM}:${episodeNo}`;
  if (noRM && name) return `rm-name:${noRM}:${name}`;
  if (episodeNo && name) return `episode-name:${episodeNo}:${name}`;
  return `id:${patient.id}`;
}

function preadmissionDateKey(value: string): string {
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dmy) {
    const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

function isExpiredPreadmission(patient: OperatingTheatrePatient): boolean {
  const operationKey = preadmissionDateKey(patient.tanggalOperasi);
  if (!operationKey) return false;
  const [year, month, day] = operationKey.split('-').map(Number);
  const expiry = new Date(year, month - 1, day + 1);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const expiryKey = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`;
  return todayKey >= expiryKey;
}

function isExpiredOperatingTheatrePatient(patient: OperatingTheatrePatient): boolean {
  const operationKey = preadmissionDateKey(patient.tanggalOperasi);
  if (!operationKey) return false;
  const [year, month, day] = operationKey.split('-').map(Number);
  const expiry = new Date(year, month - 1, day + 1);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const expiryKey = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`;
  return todayKey >= expiryKey;
}

function mergePreadmissionRestore(
  localRows: unknown[],
  cloudRows: unknown[],
): OperatingTheatrePreadmissionCache[] {
  const local = localRows.find(row => row && typeof row === 'object') as OperatingTheatrePreadmissionCache | undefined;
  const cloud = cloudRows.find(row => row && typeof row === 'object') as OperatingTheatrePreadmissionCache | undefined;
  if (!local && !cloud) return [];
  const patients = new Map<string, OperatingTheatrePatient>();
  for (const patient of [...(local?.patients ?? []), ...(cloud?.patients ?? [])]) {
    if (!patient || isExpiredPreadmission(patient)) continue;
    patients.set(preadmissionPatientKey(patient), patient);
  }
  return [{
    key: 'latest',
    patients: [...patients.values()],
    fetchedAt: Math.max(local?.fetchedAt ?? 0, cloud?.fetchedAt ?? 0, Date.now()),
    source: 'cache',
    endpoint: cloud?.endpoint || local?.endpoint || '',
  }];
}

function mergeOperatingTheatreRestore(
  localRows: unknown[],
  cloudRows: unknown[],
): OperatingTheatreCache[] {
  const local = localRows.find(row => row && typeof row === 'object') as OperatingTheatreCache | undefined;
  const cloud = cloudRows.find(row => row && typeof row === 'object') as OperatingTheatreCache | undefined;
  if (!local && !cloud) return [];
  const patients = new Map<string, OperatingTheatrePatient>();
  const sources = local && cloud && local.fetchedAt > cloud.fetchedAt
    ? [cloud, local]
    : [local, cloud];
  for (const source of sources) {
    for (const patient of source?.patients ?? []) {
      if (patient && !isExpiredOperatingTheatrePatient(patient)) {
        patients.set(preadmissionPatientKey(patient), patient);
      }
    }
  }
  return [{
    key: 'latest',
    patients: [...patients.values()],
    fetchedAt: Math.max(local?.fetchedAt ?? 0, cloud?.fetchedAt ?? 0),
    source: 'cache',
    endpoint: cloud?.endpoint || local?.endpoint || '',
  }];
}

function ensureMasterTarifParents(
  incomingRows: any[],
  incomingItems: any[],
  localRows: any[],
): any[] {
  const parents = Array.isArray(incomingRows) ? [...incomingRows] : [];
  const parentIds = new Set(
    parents
      .map(row => Number(row?.id))
      .filter(id => Number.isFinite(id)),
  );
  const localById = new Map(
    localRows
      .filter(row => Number.isFinite(Number(row?.id)))
      .map(row => [Number(row.id), row]),
  );
  const grouped = new Map<number, any[]>();

  for (const item of incomingItems) {
    const masterTarifId = Number(item?.masterTarifId);
    if (!Number.isFinite(masterTarifId)) continue;
    const rows = grouped.get(masterTarifId) ?? [];
    rows.push(item);
    grouped.set(masterTarifId, rows);
  }

  for (const [masterTarifId, items] of grouped) {
    if (parentIds.has(masterTarifId)) continue;
    const first = items[0] ?? {};
    const local = localById.get(masterTarifId);
    parents.push(local ?? {
      id: masterTarifId,
      nama: `Master Tarif ${String(first.jenisTarif ?? '')} ${String(first.fromDateTarif ?? '')}`.trim(),
      rumahSakit: String(first.hospitals ?? ''),
      jenisTarif: String(first.jenisTarif ?? ''),
      tanggalBerlaku: String(first.fromDateTarif ?? ''),
      tanggalImport: new Date().toISOString(),
      jumlahItem: items.length,
      status: 'aktif',
      importedBy: 'Cloud restore',
      createdAt: Date.now(),
    });
  }

  return parents;
}

// ── Import semua stores dari plain object ─────────────────────────────────────

export const importAllStores = async (data: Record<string, any[]>): Promise<void> => {
  if (!Array.isArray(data.users) || data.users.length === 0) {
    throw new Error('Data Cloud tidak memiliki Master User. Restore dibatalkan agar akun lokal tidak terhapus.');
  }

  const localStorageRows = data[LOCAL_STORAGE_BACKUP_STORE];
  if (typeof window !== 'undefined' && Array.isArray(localStorageRows)) {
    const incomingKeys = new Set<string>();
    for (const row of localStorageRows) {
      const key = typeof row?.key === 'string' ? row.key : '';
      if (!key || NON_RESTORABLE_LOCAL_STORAGE_KEYS.has(key)) continue;
      incomingKeys.add(key);
    }
    // Restore the browser-local app cache as a complete snapshot, but never
    // move authentication/session or device identity between browsers.
    for (const key of Object.keys(window.localStorage)) {
      if (!NON_RESTORABLE_LOCAL_STORAGE_KEYS.has(key) && !incomingKeys.has(key)) {
        window.localStorage.removeItem(key);
      }
    }
    for (const row of localStorageRows) {
      const key = typeof row?.key === 'string' ? row.key : '';
      if (key && !NON_RESTORABLE_LOCAL_STORAGE_KEYS.has(key)) {
        window.localStorage.setItem(key, String(row.value ?? ''));
      }
    }
  }

  const db = await getDB();
  const restoreData = { ...data };
  const incomingTarifItems = Array.isArray(data.masterTarifItems)
    ? data.masterTarifItems
    : [];
  const incomingTarifParents = Array.isArray(data.masterTarifs)
    ? data.masterTarifs
    : [];
  if (incomingTarifItems.length > 0) {
    // Older Cloud snapshots may contain the 54k+ tariff detail rows but omit
    // the masterTarifs parent records. Recreate those parents so the Master
    // Tarif page can display and activate the restored tariff set.
    restoreData.masterTarifs = ensureMasterTarifParents(
      incomingTarifParents,
      incomingTarifItems,
      await db.getAll('masterTarifs'),
    );
  }

  for (const store of Object.keys(restoreData)) {
    if (!Array.isArray(restoreData[store])) continue;
    if (store === LOCAL_STORAGE_BACKUP_STORE) continue;
    // Never allow a cloud payload to address an arbitrary IndexedDB store.
    if (!(db.objectStoreNames as DOMStringList).contains(store)) continue;
    const rows = store === 'settings'
      ? restoreData[store].filter((row: any) => row?.key !== 'pendingCloudSync')
      : store === 'users'
      ? mergeUsersRestore(await db.getAll('users'), restoreData[store])
      : store === 'operatingTheatreCache'
      ? mergeOperatingTheatreRestore(
        await db.getAll('operatingTheatreCache'),
        restoreData[store],
      )
      : store === 'operatingTheatrePreadmissionCache'
      ? mergePreadmissionRestore(
        await db.getAll('operatingTheatrePreadmissionCache'),
        restoreData[store],
      )
      : restoreData[store];
    const tx = db.transaction(store as any, 'readwrite');
    await tx.objectStore(store as any).clear();
    for (const row of rows) {
      await (tx.objectStore(store as any) as any).put(row);
    }
    await tx.done;
  }
};

// ── Cek status koneksi ke cloud ───────────────────────────────────────────────

export const checkCloudStatus = async (): Promise<'online' | 'offline'> => {
  if (!navigator.onLine) return 'offline';

  try {
    const cloudUrl = await getCloudApiUrl();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 12_000);

    let res: Response;

    if (!hasApiProxy()) {
      // Static hosting without a proxy: call GAS directly
      const targetUrl = `${cloudUrl}?action=status&apiKey=${encodeURIComponent(API_KEY)}`;
      logRequest('status/direct', targetUrl);
      try {
        res = await fetch(targetUrl, { signal: ctrl.signal });
        clearTimeout(timeout);
        logResponse('status/direct', res.status, res.ok);
      } catch (err) {
        clearTimeout(timeout);
        logError('status/direct', err);
        return 'offline';
      }
      if (!res.ok) return 'offline';
      try {
        const json = await res.json();
        // GAS mengembalikan { status: 'ok' }.
        // A reachable GAS endpoint with an application-level error is still
        // online; the backup action will report the real error separately.
        return json.status === 'ok' || json.success === true ? 'online' : 'offline';
      } catch {
        return 'offline';
      }
    } else {
      // Mode online lewat proxy API server
      const proxyUrl = apiUrl(`/api/cloud/status?url=${encodeURIComponent(cloudUrl)}`);
      logRequest('status/proxy', proxyUrl);
      try {
        res = await fetch(proxyUrl, { signal: ctrl.signal });
        clearTimeout(timeout);
        logResponse('status/proxy', res.status, res.ok);
      } catch (err) {
        clearTimeout(timeout);
        logError('status/proxy', err);
        return 'offline';
      }
      if (!res.ok) {
        console.warn(
          `[CloudSync][status/proxy] HTTP ${res.status} — endpoint tidak tersedia. ` +
          'Periksa apakah API server berjalan dan VITE_API_BASE_URL sudah dikonfigurasi dengan benar.',
        );
        return 'offline';
      }
      const json = await res.json();
      return json.online ? 'online' : 'offline';
    }
  } catch (err) {
    logError('status', err);
    return 'offline';
  }
};

// ── Sync status lengkap ────────────────────────────────────────────────────────

export interface SyncStatusResult {
  status: 'online' | 'offline';
  lastBackup: number | null;
  autoBackupEnabled: boolean;
}

export const syncStatus = async (): Promise<SyncStatusResult> => {
  const [status, db] = await Promise.all([checkCloudStatus(), getDB()]);
  const [lastBackupEntry, autoEntry] = await Promise.all([
    db.get('settings', 'lastCloudBackup'),
    db.get('settings', 'autoCloudBackup'),
  ]);
  return {
    status,
    lastBackup: lastBackupEntry?.value ?? null,
    autoBackupEnabled: autoEntry?.value ?? false,
  };
};

// ── Backup ke Cloud ───────────────────────────────────────────────────────────

const performBackupCloud = async (): Promise<void> => {
  publishCloudBackupProgress({
    status: 'preparing',
    percent: 3,
    message: 'Menyiapkan data backup...',
    currentChunk: 0,
    totalChunks: 0,
  });
  const cloudUrl = await getCloudApiUrl();
  const database = await exportAllStores();
  // Make the contract visible and fail loudly if a cache store is missing.
  // This prevents a successful-looking backup that only contains ordinary
  // patient data while losing the two Operating Theatre queues.
  for (const store of CLOUD_BACKED_OPERATING_THEATRE_STORES) {
    if (!Array.isArray(database[store])) {
      throw new Error(`Store Cloud ${store} tidak tersedia. Backup dibatalkan.`);
    }
  }

  const backupId = createCloudBackupId();
  const batches = buildCloudBackupChunks(database);
  const totalEntries = batches.reduce((total, batch) => total + batch.length, 0);
  publishCloudBackupProgress({
    status: 'uploading',
    percent: 8,
    message: 'Memulai pengiriman data...',
    currentChunk: 0,
    totalChunks: batches.length,
  });
  await sendCloudBackupOperation(cloudUrl, {
    action: 'saveStart',
    apiKey: API_KEY,
    backupId,
    totalChunks: batches.length,
    totalEntries,
    stores: Object.keys(database),
  });
  for (let index = 0; index < batches.length; index += 1) {
    await sendCloudBackupOperation(cloudUrl, {
      action: 'saveChunk',
      apiKey: API_KEY,
      backupId,
      chunkIndex: index,
      totalChunks: batches.length,
      entries: batches[index],
    });
    const uploadedChunks = index + 1;
    console.info(`[CloudSync][backup] chunk ${index + 1}/${batches.length}`);
    publishCloudBackupProgress({
      status: 'uploading',
      percent: 8 + Math.round((uploadedChunks / batches.length) * 82),
      message: `Mengirim bagian ${uploadedChunks} dari ${batches.length}...`,
      currentChunk: uploadedChunks,
      totalChunks: batches.length,
    });
  }
  publishCloudBackupProgress({
    status: 'committing',
    percent: 93,
    message: 'Menyelesaikan backup...',
    currentChunk: batches.length,
    totalChunks: batches.length,
  });
  await sendCloudBackupOperation(cloudUrl, {
    action: 'saveCommit',
    apiKey: API_KEY,
    backupId,
    totalChunks: batches.length,
    totalEntries,
    stores: Object.keys(database),
  }, 120_000);

  const db = await getDB();
  await db.put('settings', { key: 'lastCloudBackup', value: Date.now() });
  const remainingOutbox = await db.count('syncOutbox');
  await markCloudSyncPending(remainingOutbox > 0);
  publishCloudBackupProgress({
    status: 'success',
    percent: 100,
    message: 'Backup Cloud selesai.',
    currentChunk: batches.length,
    totalChunks: batches.length,
  });
};

/**
 * Serialize full-browser backups. Every call gets its own snapshot after
 * previous requests finish, so logout always sends the newest local browser
 * state even when an automatic backup was already in progress.
 */
export const backupCloud = async (): Promise<void> => {
  // Coalesce triggers while a large snapshot is in flight. A second complete
  // snapshot is only started after the current one finishes, so logout,
  // autosave, and manual clicks cannot create a queue of 27 MB uploads.
  backupRequested = true;
  if (!activeBackup) {
    activeBackup = (async () => {
      try {
        while (backupRequested) {
          backupRequested = false;
          await performBackupCloud();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publishCloudBackupProgress({
          status: 'error',
          percent: 0,
          message: 'Backup Cloud gagal.',
          currentChunk: 0,
          totalChunks: 0,
          error: message,
        });
        throw error;
      }
    })();
  }
  const current = activeBackup;
  try {
    await current;
  } finally {
    if (activeBackup === current) activeBackup = null;
  }
};

async function backgroundBackupTick(reason: string): Promise<void> {
  if (!isBrowserOnline()) return;
  if (isOfflineMode() && reason === 'startup') {
    const db = await getDB();
    const [pending, outboxCount] = await Promise.all([
      db.get('settings', 'pendingCloudSync'),
      db.count('syncOutbox'),
    ]);
    if (!pending?.value && outboxCount === 0) return;
  }
  try {
    await syncPendingCloudChanges();
    const db = await getDB();
    const lastBackup = await db.get('settings', 'lastCloudBackup');
    const stale = !lastBackup?.value ||
      Date.now() - Number(lastBackup.value) >= BACKGROUND_BACKUP_INTERVAL_MS;
    if (stale || reason !== 'interval') {
      await backupCloud();
      console.info(`[CloudSync][background] Backup selesai (${reason})`);
    }
  } catch (error) {
    // Keep the worker alive. The next interval or online event retries without
    // blocking login, navigation, or logout.
    logError(`background/${reason}`, error);
  }
}

/**
 * Reconcile changes made while disconnected. Row-level mutations are sent
 * first; the legacy full snapshot follows only when no outbox item remains.
 */
export async function syncPendingCloudChanges(): Promise<void> {
  if (!isBrowserOnline()) return;
  await flushSyncOutbox();
  const db = await getDB();
  const pendingSnapshot = await db.get('settings', 'pendingCloudSync');
  const remaining = await db.count('syncOutbox');
  if (remaining > 0) return;
  if (pendingSnapshot?.value) {
    await backupCloud();
  }
}

/**
 * Keep cloud backup independent from the current authenticated route. This
 * worker lives for as long as the app tab is open, including after logout.
 */
export const startBackgroundBackupSync = (): (() => void) => {
  if (typeof window === 'undefined' || backgroundBackupStarted) return () => {};
  backgroundBackupStarted = true;

  void backgroundBackupTick('startup');
  backgroundBackupTimer = window.setInterval(() => {
    void backgroundBackupTick('interval');
  }, BACKGROUND_BACKUP_INTERVAL_MS);

  const retry = () => {
    void syncPendingCloudChanges().catch(error => {
      logError('connection-restored', error);
    });
  };
  window.addEventListener('online', retry);
  const stop = () => {
    if (backgroundBackupTimer !== null) {
      window.clearInterval(backgroundBackupTimer);
      backgroundBackupTimer = null;
    }
    window.removeEventListener('online', retry);
    backgroundBackupStarted = false;
  };
  return stop;
};

// ── Restore dari Cloud ────────────────────────────────────────────────────────
// KEAMANAN: data lokal TIDAK akan dihapus jika download gagal

export const restoreCloud = async (options: { timeoutMs?: number } = {}): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Perangkat sedang offline; data lokal digunakan.');
  }
  const cloudUrl = await getCloudApiUrl();

  // Never overwrite a local replica that still contains unsynced work.
  // Row-level changes get one chance to flush first; legacy snapshot changes
  // must remain local until an explicit backup succeeds.
  const db = await getDB();
  const [outboxCount, pendingSnapshot] = await Promise.all([
    db.count('syncOutbox'),
    db.get('settings', 'pendingCloudSync'),
  ]);
  const restoreStartRevision = Number(
    (await db.get('settings', LOCAL_CLOUD_CHANGE_REVISION_KEY))?.value,
  ) || 0;
  if (outboxCount > 0) {
    await flushSyncOutbox();
    const remainingOutbox = await db.count('syncOutbox');
    if (remainingOutbox > 0) {
      throw new Error('Masih ada perubahan lokal yang belum tersinkron. Data lokal dipertahankan.');
    }
  }
  if (pendingSnapshot?.value) {
    throw new Error('Ada perubahan lokal yang belum diunggah. Backup dahulu sebelum restore Cloud.');
  }

  // GAS doGet dengan action=restore mengembalikan data yang tersimpan
  const restoreUrl = `${cloudUrl}?action=restore&apiKey=${API_KEY}`;

  let res: Response;

  if (!hasApiProxy()) {
    // Static hosting without a proxy: GET directly from GAS
    logRequest('restore/direct', restoreUrl);
    try {
       res = await fetchWithTimeout(
         restoreUrl,
         { method: 'GET' },
         timeoutMs,
       );
      logResponse('restore/direct', res.status, res.ok);
    } catch (err) {
      logError('restore/direct', err);
      throw err;
    }
  } else {
    // Mode online: lewat proxy API server
    const proxyUrl = apiUrl(`/api/cloud/restore?url=${encodeURIComponent(restoreUrl)}`);
    logRequest('restore/proxy', proxyUrl);
    try {
       res = await fetchWithTimeout(proxyUrl, {
        method: 'GET',
       }, timeoutMs);
      logResponse('restore/proxy', res.status, res.ok);
    } catch (err) {
      logError('restore/proxy', err);
      throw err;
    }
  }

  if (!res.ok) {
    let errMsg = `Server merespons HTTP ${res.status} — data lokal tidak diubah`;
    if (res.status === 404) {
      errMsg =
        `HTTP 404 — endpoint restore tidak ditemukan. ` +
        `Pastikan API server berjalan dan VITE_API_BASE_URL dikonfigurasi. ` +
        `URL yang dipanggil: ${res.url} — data lokal tidak diubah`;
    } else {
      try {
        const j = await res.json();
        if (j?.error) errMsg = j.error + ' — data lokal tidak diubah';
      } catch { /* ignore */ }
    }
    throw new Error(errMsg);
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error('Respons dari Cloud bukan JSON yang valid — data lokal tidak diubah');
  }

  if (!json?.success) {
    throw new Error(json?.error || 'Download gagal — data lokal tidak diubah');
  }

  // Proxy mengembalikan { success, data } — GAS langsung: { success, database }
  const data: Record<string, any[]> = json.data ?? json.database;
  if (!data || typeof data !== 'object') {
    throw new Error('Format data dari Cloud tidak valid — data lokal tidak diubah');
  }
  if (!Array.isArray(data.users) || data.users.length === 0) {
    throw new Error('Data Cloud tidak memiliki Master User — data lokal tidak diubah');
  }

  // A local mutation may have happened while the Cloud response was loading.
  // Never apply that stale response over a newly added/edited Master User.
  const latestDb = await getDB();
  const latestRevision = Number(
    (await latestDb.get('settings', LOCAL_CLOUD_CHANGE_REVISION_KEY))?.value,
  ) || 0;
  if (latestRevision !== restoreStartRevision) {
    throw new Error(
      'Ada perubahan lokal baru saat restore berlangsung. Restore dibatalkan; backup lokal akan diproses.',
    );
  }

  // 2. Restore — hanya dijalankan jika download berhasil
  await importAllStores(data);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('ipaw:notification-restore'));
  }

  const restoreDb = await getDB();
  await restoreDb.put('settings', { key: 'lastCloudBackup', value: Date.now() });
};

// ── Sync users dari cloud ke IndexedDB lokal (silent, hanya users) ────────────
// Dipakai saat startup agar user yang dibuat di perangkat lain langsung tersedia.

export const syncUsersFromCloud = async (): Promise<void> => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  try {
    const cloudUrl = await getCloudApiUrl();
    const restoreUrl = `${cloudUrl}?action=restore&apiKey=${API_KEY}`;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);

    let res: Response;
    if (!hasApiProxy()) {
      logRequest('syncUsers/direct', restoreUrl);
      res = await fetch(restoreUrl, { signal: ctrl.signal });
      clearTimeout(timeout);
      logResponse('syncUsers/direct', res.status, res.ok);
    } else {
      const proxyUrl = apiUrl(`/api/cloud/restore?url=${encodeURIComponent(restoreUrl)}`);
      logRequest('syncUsers/proxy', proxyUrl);
      res = await fetch(proxyUrl, { signal: ctrl.signal });
      clearTimeout(timeout);
      logResponse('syncUsers/proxy', res.status, res.ok);
    }

    if (!res.ok) {
      console.warn(`[CloudSync][syncUsers] HTTP ${res.status} — sync user dibatalkan`);
      return;
    }
    const json = await res.json();
    if (!json?.success) return;

    const data: Record<string, any[]> = json.data ?? json.database;
    if (!Array.isArray(data?.users) || data.users.length === 0) return;

    // Upsert users saja — jangan clear, agar user lokal yang belum ter-backup tetap ada
    const db = await getDB();
    const tx = db.transaction('users', 'readwrite');
    for (const u of data.users) {
      await (tx.objectStore('users') as any).put(u);
    }
    await tx.done;
  } catch (err) {
    // Silent fail — jangan pernah memblokir startup app
    logError('syncUsers', err);
  }
};

// ── Auto Backup (panggil setelah perubahan data penting) ──────────────────────

export const triggerAutoBackup = async (): Promise<'synced' | 'pending'> => {
  // Set the marker before any network work. This also protects a concurrent
  // startup restore from importing an older Cloud snapshot over local edits.
  await markCloudSyncPending(true);
  if (!isBrowserOnline() || isOfflineMode()) {
    return 'pending';
  }
  try {
    // Existing modules still write to IndexedDB directly. Until each module
    // uses row-level mutations, retain a durable pending marker and upload the
    // complete local snapshot after any queued row changes are acknowledged.
    await flushSyncOutbox();
    await backupCloud();
    return 'synced';
  } catch (err) {
    await markCloudSyncPending(true);
    logError('autoBackup', err);
    return 'pending';
  }
};
