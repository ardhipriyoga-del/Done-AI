import * as XLSX from 'xlsx';
import { getDB } from './db';
import { createRestorePoint, exportAllStores, importAllStores } from './cloudSync';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Safely parse a field that should be an array.
 *  Excel flattens arrays to JSON strings; empty arrays become undefined cells. */
const parseArr = (val: any): any[] => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try { return JSON.parse(val); } catch (_) {}
  }
  return [];
};

/** Safely parse a field that should be an object/array (stored as JSON string). */
const parseJson = (val: any, fallback: any = null): any => {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch (_) {}
  }
  return fallback;
};

// ── Hasil Restore ─────────────────────────────────────────────────────────────

export interface RestoreResult {
  masterTarifMissing: boolean;
  masterItemMissing: boolean;
}

export type RestoreClassification = 'new' | 'updated' | 'same' | 'conflict' | 'invalid';

export interface RestoreStoreSummary {
  store: string;
  incoming: number;
  new: number;
  updated: number;
  same: number;
  conflict: number;
  invalid: number;
}

export interface SmartRestorePlan {
  sourceName: string;
  backupDate: string | null;
  backupVersion: string | null;
  warnings: string[];
  summary: Omit<RestoreStoreSummary, 'store' | 'incoming'> & { incoming: number };
  stores: RestoreStoreSummary[];
  safeUpdates: Record<string, any[]>;
}

export interface SmartRestoreResult {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  invalid: number;
  duration: number;
}

const RESTORE_KEY_PATHS: Record<string, string> = {
  users: 'id',
  patients: 'noRM',
  episodes: 'id',
  pendings: 'id',
  justInfos: 'id',
  operanShifts: 'id',
  importLogs: 'id',
  activityLogs: 'id',
  settings: 'key',
  masterTarifs: 'id',
  masterTarifItems: 'id',
  estimasiBiaya: 'id',
  syncLogs: 'id',
  billingRules: 'id',
  billingChecks: 'id',
  notifikasiBilling: 'id',
  kasirTemplates: 'id',
  uraianKonfirmasi: 'recordKey',
  uraianKonfirmasiEpisodes: 'recordKey',
  masterTemplateTindakan: 'id',
  estimasiTindakan: 'id',
  masterEstimasiTindakan: 'id',
  masterEstimasiTarif: 'id',
  masterEstimasiKategori: 'id',
  masterEstimasiMappings: 'id',
  masterEstimasiMeta: 'key',
  operatingTheatreCache: 'key',
  operatingTheatreCompletedCache: 'key',
  operatingTheatrePreadmissionCache: 'key',
  operatingTheatreInProgressCache: 'key',
  checklistMasters: 'id',
  checklistEpisodes: 'episodeNo',
  checklistHistory: 'id',
};

const stableValue = (value: any): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
};

const restoreKey = (store: string, row: any): string => {
  const path = RESTORE_KEY_PATHS[store] ?? 'id';
  const value = row?.[path] ?? (
    path === 'recordKey' ? `${row?.noRM ?? ''}::${row?.episodeNo ?? ''}` : undefined
  );
  return value === undefined || value === null || String(value).trim() === '' ? '' : String(value);
};

const requiredFieldMissing = (store: string, row: any): boolean => {
  if (!row || typeof row !== 'object') return true;
  if (store === 'users') return !String(row.username ?? '').trim() || !String(row.passwordHash ?? '').trim();
  if (store === 'patients') return !String(row.noRM ?? '').trim();
  if (store === 'masterTarifItems') return !String(row.masterTarifId ?? '').trim();
  return false;
};

const emptyRestoreSummary = (): SmartRestorePlan['summary'] => ({
  incoming: 0,
  new: 0,
  updated: 0,
  same: 0,
  conflict: 0,
  invalid: 0,
});

const parseBackupJsonFile = async (file: File): Promise<{
  database: Record<string, any[]>;
  backupDate: string | null;
  backupVersion: string | null;
  warnings: string[];
}> => {
  let payload: any;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error('File bukan JSON yang valid.');
  }
  if (payload.checksum !== 'IPAW_VALID' && payload.checksum !== 'EMC_VALID') {
    throw new Error('File backup tidak valid: checksum tidak cocok.');
  }
  if (!payload.database || typeof payload.database !== 'object') {
    throw new Error('Format file backup tidak valid: field "database" tidak ditemukan.');
  }
  return {
    database: payload.database,
    backupDate: payload.backupDate ?? null,
    backupVersion: payload.version ?? null,
    warnings: Array.isArray(payload.database.__localStorage)
      ? ['Data localStorage tidak di-merge untuk menjaga session dan identitas perangkat.']
      : [],
  };
};

const parseBackupExcelFile = async (file: File): Promise<{
  database: Record<string, any[]>;
  backupDate: string | null;
  backupVersion: string | null;
  warnings: string[];
}> => {
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
  if (!workbook.SheetNames.includes('AppInfo')) {
    throw new Error('File backup tidak valid: sheet AppInfo tidak ditemukan.');
  }
  const appInfo = XLSX.utils.sheet_to_json<any>(workbook.Sheets.AppInfo);
  const valueOf = (key: string) => appInfo.find(row => row.key === key)?.value ?? null;
  const checksum = valueOf('Checksum');
  if (checksum !== 'IPAW_VALID' && checksum !== 'EMC_VALID') {
    throw new Error('File backup tidak valid: checksum tidak cocok.');
  }
  const database: Record<string, any[]> = {};
  const read = (sheet: string, store: string, transform?: (row: any) => any) => {
    if (!workbook.SheetNames.includes(sheet)) return;
    database[store] = XLSX.utils.sheet_to_json<any>(workbook.Sheets[sheet])
      .map(row => transform ? transform(row) : row);
  };
  read('Settings', 'settings');
  read('Users', 'users');
  database.patients = [];
  for (const sheet of ['PatientsAktif', 'PatientsPulang', 'PatientsPulangPending']) {
    if (workbook.SheetNames.includes(sheet)) {
      database.patients.push(...XLSX.utils.sheet_to_json<any>(workbook.Sheets[sheet]));
    }
  }
  read('Episodes', 'episodes');
  read('Pendings', 'pendings', row => ({ ...row, komentar: parseArr(row.komentar), auditLog: parseArr(row.auditLog) }));
  read('JustInfos', 'justInfos');
  read('OperanShifts', 'operanShifts', row => ({ ...row, ringkasanPending: parseArr(row.ringkasanPending) }));
  read('ImportLogs', 'importLogs', row => ({ ...row, errors: parseArr(row.errors) }));
  read('ActivityLogs', 'activityLogs');
  read('EstimasiBiaya', 'estimasiBiaya', row => ({ ...row, items: parseJson(row.items, []), obatDetailItems: parseJson(row.obatDetailItems, []) }));
  read('MasterTemplateTindakan', 'masterTemplateTindakan', row => ({ ...row, items: parseJson(row.items, []) }));
  read('EstimasiTindakan', 'estimasiTindakan', row => ({ ...row, items: parseJson(row.items, []) }));
  read('SyncLogs', 'syncLogs');
  read('ChecklistMasters', 'checklistMasters', row => ({ ...row, pilihan: parseArr(row.pilihan), kondisi: parseJson(row.kondisi, undefined) }));
  read('ChecklistEpisodes', 'checklistEpisodes', row => ({ ...row, answers: parseJson(row.answers, {}) }));
  read('ChecklistHistory', 'checklistHistory', row => ({ ...row, answers: parseJson(row.answers, {}) }));
  read('MasterEstimasiTindakan', 'masterEstimasiTindakan');
  read('MasterEstimasiTarif', 'masterEstimasiTarif', row => ({ ...row, harga: parseJson(row.harga, {}) }));
  read('MasterEstimasiKategori', 'masterEstimasiKategori');
  read('MasterEstimasiMappings', 'masterEstimasiMappings');
  read('MasterEstimasiMeta', 'masterEstimasiMeta');
  const warnings: string[] = [];
  if (!workbook.SheetNames.includes('MasterTarifs')) {
    warnings.push('Sheet MasterTarifs tidak ada; Master Tarif tidak dianalisis dari file ini.');
  }
  if (!workbook.SheetNames.includes('PatientsAktif') && !workbook.SheetNames.includes('PatientsPulang')) {
    warnings.push('Sheet pasien tidak ditemukan.');
  }
  return {
    database,
    backupDate: valueOf('BackupDate'),
    backupVersion: valueOf('Version'),
    warnings,
  };
};

export const analyzeRestoreFile = async (file: File): Promise<SmartRestorePlan> => {
  const parsed = file.name.toLowerCase().endsWith('.json')
    ? await parseBackupJsonFile(file)
    : await parseBackupExcelFile(file);
  const db = await getDB();
  const plan: SmartRestorePlan = {
    sourceName: file.name,
    backupDate: parsed.backupDate,
    backupVersion: parsed.backupVersion,
    warnings: [...parsed.warnings],
    summary: emptyRestoreSummary(),
    stores: [],
    safeUpdates: {},
  };

  for (const [store, incomingRows] of Object.entries(parsed.database)) {
    if (store === '__localStorage' || store === 'restorePoints') continue;
    if (!Array.isArray(incomingRows)) {
      plan.warnings.push(`Store ${store} tidak berbentuk daftar data.`);
      continue;
    }
    if (!(db.objectStoreNames as DOMStringList).contains(store)) {
      plan.warnings.push(`Store ${store} tidak tersedia pada versi aplikasi ini.`);
      continue;
    }
    const localRows = await db.getAll(store as any);
    const localByKey = new Map(localRows.map(row => [restoreKey(store, row), row]));
    const seen = new Set<string>();
    const summary: RestoreStoreSummary = {
      store,
      incoming: incomingRows.length,
      new: 0,
      updated: 0,
      same: 0,
      conflict: 0,
      invalid: 0,
    };
    for (const row of incomingRows) {
      const key = restoreKey(store, row);
      if (!key || requiredFieldMissing(store, row) || seen.has(key)) {
        summary.invalid += 1;
        seen.add(key);
        continue;
      }
      seen.add(key);
      const local = localByKey.get(key);
      let classification: RestoreClassification;
      if (!local) {
        classification = 'new';
      } else if (stableValue(local) === stableValue(row)) {
        classification = 'same';
      } else if (Number.isFinite(Number(row?.updatedAt)) && Number.isFinite(Number(local?.updatedAt))) {
        classification = Number(row.updatedAt) > Number(local.updatedAt) ? 'updated' : 'conflict';
      } else {
        classification = 'conflict';
      }
      summary[classification] += 1;
      if (classification === 'new' || classification === 'updated') {
        (plan.safeUpdates[store] ??= []).push(row);
      }
    }
    plan.stores.push(summary);
    for (const field of ['incoming', 'new', 'updated', 'same', 'conflict', 'invalid'] as const) {
      plan.summary[field] += summary[field];
    }
  }
  if (!Array.isArray(parsed.database.users) || parsed.database.users.length === 0) {
    plan.warnings.push('Master User tidak ditemukan dalam backup.');
  }
  return plan;
};

export const applySmartRestore = async (plan: SmartRestorePlan): Promise<SmartRestoreResult> => {
  const startedAt = Date.now();
  await createRestorePoint('Auto Backup Before Restore');
  let created = 0;
  let updated = 0;
  for (const [store, rows] of Object.entries(plan.safeUpdates)) {
    if (!rows.length) continue;
    const db = await getDB();
    const existing = new Map((await db.getAll(store as any)).map(row => [restoreKey(store, row), row]));
    const tx = db.transaction(store as any, 'readwrite');
    for (const row of rows) {
      if (existing.has(restoreKey(store, row))) updated += 1;
      else created += 1;
      await (tx.objectStore(store as any) as any).put(row);
      if ((created + updated) % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    await tx.done;
  }
  return {
    created,
    updated,
    skipped: plan.summary.same,
    conflicts: plan.summary.conflict,
    invalid: plan.summary.invalid,
    duration: Date.now() - startedAt,
  };
};

// ── Backup (Excel / .xlsx) ─────────────────────────────────────────────────────
// Master Tarif dan Master Item TIDAK disertakan untuk menjaga ukuran file kecil.

export const backupData = async () => {
  const db = await getDB();

  // Ambil semua store yang dibackup secara paralel (tanpa masterTarifs & masterTarifItems)
  const [
    users, patients, episodes, pendings,
    justInfos, operanShifts, importLogs, activityLogs,
    settings, estimasiBiaya, masterTemplateTindakan, estimasiTindakan, syncLogs,
    checklistMasters, checklistEpisodes, checklistHistory,
    masterEstimasiTindakan, masterEstimasiTarif, masterEstimasiKategori,
    masterEstimasiMappings, masterEstimasiMeta,
  ] = await Promise.all([
    db.getAll('users'),
    db.getAll('patients'),
    db.getAll('episodes'),
    db.getAll('pendings'),
    db.getAll('justInfos'),
    db.getAll('operanShifts'),
    db.getAll('importLogs'),
    db.getAll('activityLogs'),
    db.getAll('settings'),
    db.getAll('estimasiBiaya'),
    db.getAll('masterTemplateTindakan'),
    db.getAll('estimasiTindakan'),
    db.getAll('syncLogs'),
    db.getAll('checklistMasters'),
    db.getAll('checklistEpisodes'),
    db.getAll('checklistHistory'),
    db.getAll('masterEstimasiTindakan'),
    db.getAll('masterEstimasiTarif'),
    db.getAll('masterEstimasiKategori'),
    db.getAll('masterEstimasiMappings'),
    db.getAll('masterEstimasiMeta'),
  ]);

  const workbook = XLSX.utils.book_new();

  // ── AppInfo sheet (checksum + metadata) ────────────────────────────────────
  const appInfo = [
    { key: 'AppName',    value: 'IP Admission Workspace' },
    { key: 'Version',    value: '5.0.0' },
    { key: 'BackupDate', value: new Date().toISOString() },
    { key: 'Checksum',   value: 'IPAW_VALID' },
    { key: 'Note',       value: 'MasterTarif dan MasterItem tidak disertakan untuk menjaga ukuran file kecil' },
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(appInfo), 'AppInfo');

  // ── Core stores ────────────────────────────────────────────────────────────
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(settings),     'Settings');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(users),         'Users');

  // Patients split by status
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(
    patients.filter(p => p.status === 'aktif')),          'PatientsAktif');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(
    patients.filter(p => p.status === 'pulang')),         'PatientsPulang');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(
    patients.filter(p => p.status === 'pulang_pending')), 'PatientsPulangPending');

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(episodes),      'Episodes');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(pendings.map(p => ({
    ...p,
    komentar:         JSON.stringify(p.komentar         ?? []),
    auditLog:         JSON.stringify(p.auditLog         ?? []),
  }))),                                                                            'Pendings');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(justInfos),     'JustInfos');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(operanShifts.map(o => ({
    ...o,
    ringkasanPending: JSON.stringify(o.ringkasanPending ?? []),
  }))),                                                                            'OperanShifts');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(importLogs.map(l => ({
    ...l,
    errors: JSON.stringify(l.errors ?? []),
  }))),                                                                            'ImportLogs');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(activityLogs),  'ActivityLogs');

  // ── Estimasi Biaya ─────────────────────────────────────────────────────────
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(estimasiBiaya.map(e => ({
    ...e,
    items:           JSON.stringify(e.items ?? []),
    obatDetailItems: JSON.stringify(e.obatDetailItems ?? []),
  }))),                                                                            'EstimasiBiaya');

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(masterTemplateTindakan.map(t => ({
    ...t,
    items: JSON.stringify(t.items ?? []),
  }))),                                                                            'MasterTemplateTindakan');

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(estimasiTindakan.map(e => ({
    ...e,
    items: JSON.stringify(e.items ?? []),
  }))),                                                                            'EstimasiTindakan');

  // ── Sync Logs ──────────────────────────────────────────────────────────────
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(syncLogs),      'SyncLogs');

  // ── Checklist Pasien ───────────────────────────────────────────────────────
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(checklistMasters.map(item => ({
    ...item,
    pilihan: JSON.stringify(item.pilihan ?? []),
    kondisi: JSON.stringify(item.kondisi ?? null),
  }))), 'ChecklistMasters');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(checklistEpisodes.map(item => ({
    ...item,
    answers: JSON.stringify(item.answers ?? {}),
  }))), 'ChecklistEpisodes');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(checklistHistory.map(item => ({
    ...item,
    answers: JSON.stringify(item.answers ?? {}),
  }))), 'ChecklistHistory');

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(masterEstimasiTindakan), 'MasterEstimasiTindakan');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(masterEstimasiTarif.map(item => ({
    ...item,
    harga: JSON.stringify(item.harga ?? {}),
  }))), 'MasterEstimasiTarif');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(masterEstimasiKategori), 'MasterEstimasiKategori');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(masterEstimasiMappings), 'MasterEstimasiMappings');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(masterEstimasiMeta), 'MasterEstimasiMeta');

  // Master Tarif TIDAK disertakan (MasterTarifs & MasterTarifItems dikecualikan)

  const filename = `IPAW_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
  XLSX.writeFile(workbook, filename);
};

// ── Backup (JSON) ──────────────────────────────────────────────────────────────

export const backupDataJSON = async (): Promise<void> => {
  const database = await exportAllStores();
  const payload = JSON.stringify({
    appName: 'IP Admission Workspace',
    version: '5.0.0',
    backupDate: new Date().toISOString(),
    checksum: 'IPAW_VALID',
    database,
  }, null, 2);

  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `IPAW_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // Catat waktu backup lokal
  const db = await getDB();
  await db.put('settings', { key: 'lastLocalBackup', value: Date.now() });
};

// ── Restore (JSON) ─────────────────────────────────────────────────────────────

export const restoreDataJSON = async (file: File): Promise<void> => {
  const text = await file.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('File bukan JSON yang valid.');
  }

  if (payload.checksum !== 'IPAW_VALID' && payload.checksum !== 'EMC_VALID') {
    throw new Error('File backup tidak valid: checksum tidak cocok.');
  }
  if (!payload.database || typeof payload.database !== 'object') {
    throw new Error('Format file backup tidak valid: field "database" tidak ditemukan.');
  }

  await importAllStores(payload.database);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('ipaw:notification-restore'));
  }
};

// ── Restore (Excel / .xlsx) ────────────────────────────────────────────────────

export const restoreData = async (file: File): Promise<RestoreResult> => {
  await new Promise<void>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        // ── Validasi ─────────────────────────────────────────────────────────
        if (!workbook.SheetNames.includes('AppInfo')) {
          throw new Error('File backup tidak valid: sheet AppInfo tidak ditemukan.');
        }
        const appInfoSheet = XLSX.utils.sheet_to_json<any>(workbook.Sheets['AppInfo']);
        const checksum = appInfoSheet.find((r: any) => r.key === 'Checksum')?.value;
        if (checksum !== 'IPAW_VALID' && checksum !== 'EMC_VALID') {
          throw new Error('File backup tidak valid: checksum tidak cocok.');
        }

        const db = await getDB();

        // Deteksi versi backup
        const hasV2MasterTarif = workbook.SheetNames.includes('MasterTarifs');
        const hasV3            = workbook.SheetNames.includes('EstimasiBiaya');
        const hasV4            = workbook.SheetNames.includes('SyncLogs');
        const hasV11           = workbook.SheetNames.includes('MasterTemplateTindakan') || workbook.SheetNames.includes('EstimasiTindakan');
        const hasChecklist     = workbook.SheetNames.includes('ChecklistMasters') || workbook.SheetNames.includes('ChecklistEpisodes') || workbook.SheetNames.includes('ChecklistHistory');
        const hasMasterEstimasi = workbook.SheetNames.includes('MasterEstimasiTindakan')
          || workbook.SheetNames.includes('MasterEstimasiTarif')
          || workbook.SheetNames.includes('MasterEstimasiKategori')
          || workbook.SheetNames.includes('MasterEstimasiMappings')
          || workbook.SheetNames.includes('MasterEstimasiMeta');

        const storeNames: string[] = [
          'users', 'patients', 'episodes', 'pendings',
          'justInfos', 'operanShifts', 'importLogs', 'activityLogs', 'settings',
          // Master Tarif hanya di-restore jika ada di file lama (backward compat)
          ...(hasV2MasterTarif ? ['masterTarifs', 'masterTarifItems'] : []),
          ...(hasV3 ? ['estimasiBiaya'] : []),
          ...(hasV11 ? ['masterTemplateTindakan', 'estimasiTindakan'] : []),
          ...(hasV4 ? ['syncLogs'] : []),
          ...(hasChecklist ? ['checklistMasters', 'checklistEpisodes', 'checklistHistory'] : []),
          ...(hasMasterEstimasi ? [
            'masterEstimasiTindakan',
            'masterEstimasiTarif',
            'masterEstimasiKategori',
            'masterEstimasiMappings',
            'masterEstimasiMeta',
          ] : []),
        ];

        const tx = db.transaction(storeNames as any, 'readwrite');

        // ── Helper restorer per sheet ──────────────────────────────────────────
        const restoreSheet = async (
          sheetName: string,
          storeName: any,
          transform?: (row: any) => any,
        ) => {
          if (!workbook.SheetNames.includes(sheetName)) return;
          const items = XLSX.utils.sheet_to_json<any>(workbook.Sheets[sheetName]);
          await tx.objectStore(storeName).clear();
          for (const raw of items) {
            const row = transform ? transform(raw) : raw;
            await tx.objectStore(storeName).put(row);
          }
        };

        // ── Core stores ───────────────────────────────────────────────────────
        await restoreSheet('Settings',     'settings');
        await restoreSheet('Users',        'users');

        // Patients — gabungkan semua sheet status
        await tx.objectStore('patients').clear();
        for (const sheet of ['PatientsAktif', 'PatientsPulang', 'PatientsPulangPending']) {
          if (workbook.SheetNames.includes(sheet)) {
            const rows = XLSX.utils.sheet_to_json<any>(workbook.Sheets[sheet]);
            for (const p of rows) await tx.objectStore('patients').put(p);
          }
        }

        await restoreSheet('Episodes',     'episodes');
        await restoreSheet('Pendings',     'pendings', row => ({
          ...row,
          komentar:         parseArr(row.komentar),
          auditLog:         parseArr(row.auditLog),
        }));
        await restoreSheet('JustInfos',    'justInfos');
        await restoreSheet('OperanShifts', 'operanShifts', row => ({
          ...row,
          ringkasanPending: parseArr(row.ringkasanPending),
        }));
        await restoreSheet('ImportLogs',   'importLogs', row => ({
          ...row,
          errors: parseArr(row.errors),
        }));
        await restoreSheet('ActivityLogs', 'activityLogs');

        // ── v2 backward compat: Master Tarif dari file lama ───────────────────
        if (hasV2MasterTarif) {
          await restoreSheet('MasterTarifs',     'masterTarifs');
          await restoreSheet('MasterTarifItems', 'masterTarifItems');
        }
        // Master Tarif dari file baru (v5+): TIDAK di-restore — dibiarkan apa adanya

        // ── v3: Estimasi Biaya ─────────────────────────────────────────────────
        if (hasV3) {
          await restoreSheet('EstimasiBiaya', 'estimasiBiaya', row => ({
            ...row,
            items:           parseJson(row.items, []),
            obatDetailItems: parseJson(row.obatDetailItems, []),
          }));
        }

        if (hasV11) {
          await restoreSheet('MasterTemplateTindakan', 'masterTemplateTindakan', row => ({
            ...row,
            items: parseJson(row.items, []),
          }));
          await restoreSheet('EstimasiTindakan', 'estimasiTindakan', row => ({
            ...row,
            items: parseJson(row.items, []),
          }));
        }

        // ── v4: Sync Logs ──────────────────────────────────────────────────────
        if (hasV4) {
          await restoreSheet('SyncLogs', 'syncLogs');
        }

        if (hasChecklist) {
          await restoreSheet('ChecklistMasters', 'checklistMasters', row => ({
            ...row,
            pilihan: parseArr(row.pilihan),
            kondisi: parseJson(row.kondisi, undefined),
          }));
          await restoreSheet('ChecklistEpisodes', 'checklistEpisodes', row => ({
            ...row,
            answers: parseJson(row.answers, {}),
          }));
          await restoreSheet('ChecklistHistory', 'checklistHistory', row => ({
            ...row,
            answers: parseJson(row.answers, {}),
          }));
        }

        if (hasMasterEstimasi) {
          await restoreSheet('MasterEstimasiTindakan', 'masterEstimasiTindakan');
          await restoreSheet('MasterEstimasiTarif', 'masterEstimasiTarif', row => ({
            ...row,
            harga: parseJson(row.harga, {}),
          }));
          await restoreSheet('MasterEstimasiKategori', 'masterEstimasiKategori');
          await restoreSheet('MasterEstimasiMappings', 'masterEstimasiMappings');
          await restoreSheet('MasterEstimasiMeta', 'masterEstimasiMeta');
        }

        await tx.done;
        resolve();
      } catch (err: any) {
        reject(err);
      }
    };
    reader.onerror = (e) => reject(e);
    reader.readAsArrayBuffer(file);
  });

  // Setelah restore, cek ketersediaan Master Tarif & Master Item
  const db = await getDB();
  const tarifCount = await db.count('masterTarifs');
  const itemCount  = await db.count('masterTarifItems');

  return {
    masterTarifMissing: tarifCount === 0,
    masterItemMissing:  itemCount  === 0,
  };
};
