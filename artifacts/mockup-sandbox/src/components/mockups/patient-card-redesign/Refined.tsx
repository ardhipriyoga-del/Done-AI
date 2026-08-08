import './_group.css';
import {
  AlertCircle, BedDouble, Calendar, CheckCircle2, ChevronRight, Clock3, Cloud,
  FileText, MapPin, Printer, ShieldCheck, Star, Stethoscope, User2,
} from 'lucide-react';

const patient = {
  noRM: 'RM-240183',
  episodeNo: 'EP-20260801-0042',
  namaPasien: 'Siti Rahmawati',
  payor: 'BPJS Kesehatan',
  ward: 'Rawat Inap Lt. 3',
  bedCode: '305-B',
  roomType: 'Kelas 1',
  dpjp: 'Dr. Andi Pratama, Sp.PD',
  admissionDate: '01 Agu 2026',
  daysInCare: 3,
};

function ActionButton({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'orange' }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition-colors ${
        tone === 'orange'
          ? 'border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100'
          : 'border-slate-200 bg-white text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700'
      }`}
    >
      {children}
    </button>
  );
}

export function Refined() {
  return (
    <main className="min-h-screen bg-[#eef9fa] p-5">
      <article className="mx-auto w-full max-w-[560px] overflow-hidden rounded-2xl border border-cyan-100 bg-white shadow-[0_10px_30px_rgba(8,115,128,0.10)]">
        <div className="h-1.5 bg-gradient-to-r from-orange-400 via-orange-400 to-amber-300" />
        <div className="p-5">
          <header className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700">
                <User2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] font-semibold tracking-wide text-slate-500">{patient.noRM}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                    <Cloud className="h-3 w-3" /> TrakCare
                  </span>
                </div>
                <h2 className="mt-1 text-lg font-bold leading-tight text-slate-900">{patient.namaPasien}</h2>
                <p className="mt-1 text-[11px] text-slate-500">Episode {patient.episodeNo}</p>
              </div>
            </div>
            <button type="button" aria-label="Tandai pasien" className="rounded-lg p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-500">
              <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
            </button>
          </header>

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="rounded-xl bg-cyan-50/80 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-cyan-700"><MapPin className="h-3 w-3" /> Lokasi</div>
              <p className="truncate text-xs font-bold text-slate-800">{patient.ward}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{patient.bedCode} · {patient.roomType}</p>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500"><Stethoscope className="h-3 w-3" /> DPJP</div>
              <p className="truncate text-xs font-bold text-slate-800">Dr. Andi Pratama</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-500">Spesialis Penyakit Dalam</p>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500"><Calendar className="h-3 w-3" /> Masuk</div>
              <p className="text-xs font-bold text-slate-800">{patient.admissionDate}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">Hari ke-{patient.daysInCare}</p>
            </div>
            <div className="rounded-xl bg-blue-50 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-700"><ShieldCheck className="h-3 w-3" /> Penjamin</div>
              <p className="truncate text-xs font-bold text-blue-800">BPJS</p>
              <p className="mt-0.5 text-[11px] text-blue-700/70">Aktif diverifikasi</p>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-orange-100 bg-orange-50/70 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600"><AlertCircle className="h-4 w-4" /></div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-orange-800">Perlu perhatian</p>
                <p className="truncate text-[11px] text-orange-700">1 pending urgent · 2 just info</p>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-orange-500 px-2 py-1 text-[10px] font-bold text-white">URGENT</span>
          </div>

          <footer className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row">
            <ActionButton><FileText className="h-3.5 w-3.5" /> Buka Detail <ChevronRight className="h-3 w-3" /></ActionButton>
            <ActionButton><Printer className="h-3.5 w-3.5" /> Cetak Uraian</ActionButton>
            <ActionButton tone="orange"><Calendar className="h-3.5 w-3.5" /> Rencana Tindakan</ActionButton>
          </footer>
        </div>
      </article>
    </main>
  );
}