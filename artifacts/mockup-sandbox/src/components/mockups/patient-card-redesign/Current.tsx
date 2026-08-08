import './_group.css';
import {
  AlertCircle, Calendar, CheckCircle2, Cloud, Clock, Info, Printer, Star, User2,
} from 'lucide-react';

const patient = {
  noRM: 'RM-240183',
  namaPasien: 'Siti Rahmawati',
  payor: 'BPJS Kesehatan',
  ward: 'Rawat Inap Lt. 3',
  bedCode: '305-B',
  roomType: 'Kelas 1',
  dpjp: 'Dr. Andi Pratama, Sp.PD',
};

export function Current() {
  return (
    <main className="min-h-screen p-5 flex items-start justify-center">
      <article
        className="relative w-full max-w-[560px] cursor-pointer overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        aria-label="Kartu pasien saat ini"
      >
        <div className="absolute left-0 top-0 h-full w-1 bg-orange-500" />
        <div className="p-5 pl-6">
          <div className="mb-1 flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="font-mono text-xs text-slate-500">{patient.noRM}</span>
              <span className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                <Cloud className="h-2.5 w-2.5" /> TC
              </span>
            </div>
            <Star className="h-4 w-4 shrink-0 fill-amber-500 text-amber-500" />
          </div>
          <h2 className="mb-1 line-clamp-2 text-base font-bold leading-snug text-slate-900">{patient.namaPasien}</h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-300 bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> {patient.payor}
          </span>
          <p className="mt-2 mb-1 line-clamp-1 text-xs text-slate-500">{patient.ward} · {patient.bedCode} · {patient.roomType}</p>
          <p className="mb-3 truncate text-xs text-slate-500">Dr. {patient.dpjp}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
              <Clock className="h-3 w-3" /> 1 Urgent
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
              <Info className="h-3 w-3" /> 2 Info
            </span>
            <button className="ml-auto inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <Printer className="h-3 w-3" /> Cetak Uraian
            </button>
            <button className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
              <Calendar className="h-3 w-3" /> Pasien Ada Tindakan
            </button>
          </div>
        </div>
      </article>
    </main>
  );
}