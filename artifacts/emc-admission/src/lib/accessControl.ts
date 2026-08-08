export type AppRole = 'superuser' | 'officer';

/**
 * Least-privilege access matrix for the operational admission workspace.
 *
 * The officer role is intentionally limited to the minimum operational
 * modules needed for admission, handover, monitoring, and patient follow-up.
 * Configuration, bulk mutation, backup/restore, and audit administration stay
 * with superusers.
 */
export const OFFICER_ALLOWED_PATHS = new Set([
  '/',
  '/patients',
  '/pasien-preadmission',
  '/pasien-preadmission/masuk-hari-ini',
  '/checklist-pasien',
  '/monitoring-ktm',
  '/pasien-rencana-tindakan',
  '/pending',
  '/kasir',
  '/billing-checker',
  '/igd-ward',
  '/estimasi-biaya-tindakan',
  '/history',
  '/reports',
  '/panduan',
  '/about',
  '/settings',
]);

export function canAccessPath(role: AppRole, path: string): boolean {
  return role === 'superuser' || OFFICER_ALLOWED_PATHS.has(path);
}

export type SettingsTab =
  | 'profil'
  | 'session'
  | 'notifikasi'
  | 'users'
  | 'app'
  | 'backup'
  | 'masterTarif'
  | 'masterEstimasi'
  | 'masterChecklist'
  | 'sinkronisasi'
  | 'integrasiTrakCare'
  | 'import'
  | 'download'
  | 'templatePesan'
  | 'billingRule';

export function canAccessSettingsTab(role: AppRole, tab: SettingsTab): boolean {
  if (role === 'superuser') return true;
  return tab === 'profil' || tab === 'session' || tab === 'notifikasi';
}

export const ACCESS_POLICY = {
  officer: {
    allowed: [
      'Dashboard dan ringkasan operasional',
      'Data pasien rawat inap yang diperlukan untuk tugas admission',
      'Preadmission, rencana tindakan, In Progress, dan selesai tindakan',
      'Checklist pasien, Pending Operan, dan Pesan Kasir',
      'Monitoring KTM, IGD Ward, Billing Checker, dan estimasi biaya tindakan',
      'Riwayat pasien dan laporan operasional',
      'Profil, keamanan sesi, dan preferensi notifikasi milik sendiri',
    ],
    restricted: [
      'Manajemen user dan perubahan role',
      'Konfigurasi aplikasi, endpoint, dan integrasi TrakCare',
      'Import massal, backup/restore, dan download distribusi aplikasi',
      'Master tarif, master checklist, template pesan, dan Billing Rule',
      'Riwayat sinkronisasi teknis dan Log Aktivitas/audit trail',
    ],
  },
} as const;