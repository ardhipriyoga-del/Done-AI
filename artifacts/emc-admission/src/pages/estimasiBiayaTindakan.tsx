import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  getDB, EstimasiTindakan, EstimasiTindakanItem,
  Patient, MasterEstimasiTindakan, MasterEstimasiTarif,
  MasterEstimasiKategori, MasterEstimasiMapping, EstimasiTindakanKelas,
} from '../lib/db';
import { useAuth } from '../context/AuthContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { 
  Search, Plus, Trash2, Eye, Copy, RefreshCw, ChevronLeft,
  Save, FileSignature, AlertCircle, Edit, FileCheck, Printer, FileDown
} from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { fmtRp } from '../lib/estimasi';
import { writeLog } from '../lib/writeLog';
import { formatDate } from '../lib/utils';
import {
  componentKey,
  ESTIMASI_KELAS,
  ESTIMASI_KELAS_LABELS,
  loadEstimasiMasterData,
  normalizeEstimasiClass,
} from '../lib/estimasiTindakanMaster';

function generateId() { return Math.random().toString(36).substring(2, 9); }

export default function EstimasiBiayaTindakanPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('list');
  const [estimasiList, setEstimasiList] = useState<EstimasiTindakan[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [masterActions, setMasterActions] = useState<MasterEstimasiTindakan[]>([]);
  const [masterEstimasiTarifs, setMasterEstimasiTarifs] = useState<MasterEstimasiTarif[]>([]);
  const [masterCategories, setMasterCategories] = useState<MasterEstimasiKategori[]>([]);
  const [masterMappings, setMasterMappings] = useState<MasterEstimasiMapping[]>([]);
  
  const [loading, setLoading] = useState(true);
  
  // List Filters
  const [listSearch, setListSearch] = useState('');
  const [listStatus, setListStatus] = useState('All');

  // Form State
  const [formMode, setFormMode] = useState<'create'|'edit'|'view'>('create');
  const [formData, setFormData] = useState<Partial<EstimasiTindakan>>({});
  
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDB();
      const es = await db.getAll('estimasiTindakan');
      setEstimasiList(es.sort((a,b) => b.updatedAt - a.updatedAt));
      
      const pts = await db.getAll('patients');
      setPatients(pts);
      const master = await loadEstimasiMasterData();
      setMasterActions(master.actions.filter(item => item.aktif));
      setMasterEstimasiTarifs(master.tariffs);
      setMasterCategories(master.categories);
      setMasterMappings(master.mappings);
    } catch (err) {
      console.error(err);
      toast.error('Gagal memuat data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const refresh = () => void loadData();
    window.addEventListener('ipaw:master-estimasi-changed', refresh);
    return () => window.removeEventListener('ipaw:master-estimasi-changed', refresh);
  }, [loadData]);

  // --- List View ---
  const filteredList = useMemo(() => {
    return estimasiList.filter(e => {
      const matchSearch = !listSearch || 
        e.nomorEstimasi.toLowerCase().includes(listSearch.toLowerCase()) || 
        e.namaPasien.toLowerCase().includes(listSearch.toLowerCase()) || 
        e.noRM.includes(listSearch);
      const matchStatus = listStatus === 'All' || e.status === listStatus;
      return matchSearch && matchStatus;
    });
  }, [estimasiList, listSearch, listStatus]);

  async function handleCreateNew() {
    const db = await getDB();
    const all = await db.getAll('estimasiTindakan');
    const today = new Date();
    const dateStr = today.getFullYear().toString() + 
      String(today.getMonth() + 1).padStart(2, '0') + 
      String(today.getDate()).padStart(2, '0');
    const prefix = `EST-${dateStr}-`;
    const todayEstimates = all.filter(e => e.nomorEstimasi.startsWith(prefix));
    let maxSeq = 0;
    for (const e of todayEstimates) {
      const seq = parseInt(e.nomorEstimasi.split('-')[2], 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
    const newNum = prefix + String(maxSeq + 1).padStart(4, '0');

    setFormData({
      id: 'EST-' + generateId(),
      nomorEstimasi: newNum,
      status: 'Draft',
      noRM: '',
      episodeNo: '',
      namaPasien: '',
      tanggalLahir: '',
      umur: 0,
      jenisKelamin: '',
      dokterOperator: '',
      tindakan: '',
      jenisOperasi: '',
      penjamin: '',
      kelas: '',
      kelasTarif: '',
      diagnosis: '',
      items: [],
      grandTotal: 0,
      createdBy: user?.namaLengkap || user?.username || 'System',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    setFormMode('create');
    setActiveTab('form');
  }

  function handleEdit(item: EstimasiTindakan, mode: 'edit'|'view') {
    setFormData({...item});
    setFormMode(mode);
    setActiveTab('form');
  }

  async function handleDuplicate(item: EstimasiTindakan) {
    const db = await getDB();
    const all = await db.getAll('estimasiTindakan');
    const today = new Date();
    const dateStr = today.getFullYear().toString() + 
      String(today.getMonth() + 1).padStart(2, '0') + 
      String(today.getDate()).padStart(2, '0');
    const prefix = `EST-${dateStr}-`;
    const todayEstimates = all.filter(e => e.nomorEstimasi.startsWith(prefix));
    let maxSeq = 0;
    for (const e of todayEstimates) {
      const seq = parseInt(e.nomorEstimasi.split('-')[2], 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
    const newNum = prefix + String(maxSeq + 1).padStart(4, '0');
    
    const duplicate: Partial<EstimasiTindakan> = {
      ...item,
      id: 'EST-' + generateId(),
      nomorEstimasi: newNum,
      status: 'Draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finalizedAt: undefined,
      finalizedBy: undefined
    };
    
    setFormData(duplicate);
    setFormMode('create');
    setActiveTab('form');
    toast.success('Estimasi diduplikasi. Silakan simpan sebagai Draft baru.');
  }

  function duplicateItem(idx: number) {
    setFormData(prev => {
      const items = [...(prev.items || [])];
      const source = items[idx];
      if (!source) return prev;
      items.splice(idx + 1, 0, { ...source, id: generateId() });
      return { ...prev, items };
    });
  }

  async function handleDelete(id: string) {
    if(!confirm('Hapus estimasi ini?')) return;
    try {
      const db = await getDB();
      const est = await db.get('estimasiTindakan', id);
      await db.delete('estimasiTindakan', id);
      if(est) {
        await writeLog({
          modul: 'Estimasi Tindakan',
          aktivitas: 'Hapus Estimasi',
          noRM: est.noRM,
          namaPasien: est.namaPasien,
          detail: `Hapus estimasi ${est.nomorEstimasi}`
        });
      }
      toast.success('Estimasi dihapus');
      loadData();
    } catch(err) {
      toast.error('Gagal menghapus');
    }
  }

  // --- Form Logic ---
  function updateForm(field: keyof EstimasiTindakan, value: any) {
    setFormData(prev => ({...prev, [field]: value}));
  }

  function handlePatientSelect(noRM: string) {
    const p = patients.find(x => x.noRM === noRM);
    if (!p) return;
    
    const dob = p.dob ? new Date(p.dob) : new Date();
    let age = new Date().getFullYear() - dob.getFullYear();
    if (new Date().getMonth() < dob.getMonth()) age--;

    const mappedTarif = normalizeEstimasiClass(p.roomType) || '';

    setFormData(prev => ({
      ...prev,
      noRM: p.noRM,
      episodeNo: p.episodeNo || '',
      namaPasien: p.namaPasien,
      tanggalLahir: p.dob || '',
      umur: age,
      jenisKelamin: p.sexDesc || '',
      penjamin: p.payor || '',
      kelas: p.roomType || '',
      kelasTarif: mappedTarif,
      diagnosis: p.diagnosakUtama || p.diagnosaMasuk || ''
    }));

    const selectedAction = masterActions.find(item =>
      item.namaTindakan.toLowerCase() === formData.tindakan?.trim().toLowerCase(),
    );
    if (selectedAction) {
      const items = buildMasterItems(selectedAction.golongan, mappedTarif);
      setFormData(prev => ({ ...prev, jenisOperasi: selectedAction.golongan, items }));
      if (!mappedTarif) {
        toast.warning('Kelas pasien belum dapat dipetakan ke Kelas III, II, I, Deluxe, atau Suite.');
      }
    }
  }

  function buildMasterItems(golongan: string, kelas: EstimasiTindakanKelas | ''): EstimasiTindakanItem[] {
    return masterEstimasiTarifs
      .filter(tarif => tarif.golongan.trim().toLowerCase() === golongan.trim().toLowerCase())
      .map((tarif, index) => {
        const mapping = masterMappings.find(item => item.komponenKey === componentKey(tarif.komponen));
        const category = masterCategories.find(item => item.id === mapping?.kategoriId && item.aktif);
        const price = kelas ? tarif.harga[kelas] || 0 : 0;
        return {
          id: `${tarif.id}-${index}`,
          kategori: category?.nama || 'Belum dipetakan',
          namaItem: tarif.komponen,
          qty: 1,
          satuan: 'Tindakan',
          harga: price,
          hargaMaster: price,
          hargaOverride: false,
          matchStatus: category ? 'exact' : 'unmapped',
          matchedName: tarif.komponen,
        };
      });
  }

  function handleActionSelect(namaTindakan: string) {
    const action = masterActions.find(item =>
      item.namaTindakan.toLowerCase() === namaTindakan.trim().toLowerCase(),
    );
    if (!action) {
      setFormData(prev => ({ ...prev, tindakan: namaTindakan, jenisOperasi: '', items: [] }));
      return;
    }
    const kelas = normalizeEstimasiClass(formData.kelasTarif || '');
    const items = buildMasterItems(action.golongan, kelas);
    setFormData(prev => ({
      ...prev,
      tindakan: action.namaTindakan,
      jenisOperasi: action.golongan,
      kelasTarif: kelas || prev.kelasTarif || '',
      items,
    }));
    if (!masterCategories.some(category => category.aktif)) {
      toast.warning('Master Kategori Item belum dibuat oleh Superuser.');
    }
    if (items.some(item => item.matchStatus === 'unmapped')) {
      toast.warning('Ada komponen tarif yang belum dipetakan ke kategori.');
    }
    if (!items.length) {
      toast.warning(`Golongan ${action.golongan} belum memiliki data tarif pada Master Tarif Tindakan.`);
    }
    if (items.some(item => item.harga <= 0) && kelas) {
      toast.warning(`Sebagian komponen Golongan ${action.golongan} belum memiliki tarif untuk ${kelas}.`);
    }
    if (!kelas) {
      toast.warning('Pilih pasien dengan kelas perawatan yang sesuai sebelum menghitung tarif.');
    }
  }

  function handleTarifClassChange(kelasTarif: EstimasiTindakanKelas) {
    const selectedAction = masterActions.find(item =>
      item.namaTindakan.toLowerCase() === formData.tindakan?.trim().toLowerCase(),
    );
    setFormData(prev => ({
      ...prev,
      kelasTarif,
      items: selectedAction ? buildMasterItems(selectedAction.golongan, kelasTarif) : prev.items || [],
    }));
    if (selectedAction) {
      const items = buildMasterItems(selectedAction.golongan, kelasTarif);
      if (items.some(item => item.harga <= 0)) {
        toast.warning(`Sebagian komponen Golongan ${selectedAction.golongan} belum memiliki tarif untuk ${kelasTarif}.`);
      }
      if (items.some(item => item.matchStatus === 'unmapped')) {
        toast.warning('Ada komponen tarif yang belum dipetakan ke kategori.');
      }
    }
  }

  function updateItem(idx: number, field: keyof EstimasiTindakanItem, value: any) {
    setFormData(prev => {
      const arr = [...(prev.items || [])];
      arr[idx] = { ...arr[idx], [field]: value };
      return { ...prev, items: arr };
    });
  }

  function removeItem(idx: number) {
    setFormData(prev => {
      const arr = [...(prev.items || [])];
      arr.splice(idx, 1);
      return { ...prev, items: arr };
    });
  }

  function moveItem(idx: number, dir: 1 | -1) {
    setFormData(prev => {
      const arr = [...(prev.items || [])];
      if(idx + dir < 0 || idx + dir >= arr.length) return prev;
      const tmp = arr[idx];
      arr[idx] = arr[idx + dir];
      arr[idx + dir] = tmp;
      return { ...prev, items: arr };
    });
  }

  async function handleSave(status: 'Draft'|'Final') {
    if (!formData.noRM || !formData.tindakan) {
      toast.error('Data pasien dan tindakan wajib diisi.');
      return;
    }
    const selectedAction = masterActions.find(item =>
      item.namaTindakan.toLowerCase() === formData.tindakan?.trim().toLowerCase(),
    );
    if (!selectedAction) {
      toast.error('Pilih tindakan dari Master Penggolongan Tindakan.');
      return;
    }
    if (!masterEstimasiTarifs.length) {
      toast.error('Master Tarif Estimasi belum tersedia. Minta Superuser mengunggah master terlebih dahulu.');
      return;
    }
    if (status === 'Final' && (!formData.items || formData.items.length === 0)) {
      toast.error('Estimasi final harus memiliki minimal 1 item.');
      return;
    }

    const items = formData.items || [];
    const grandTotal = items.reduce((acc, it) => acc + (it.harga * it.qty), 0);

    const doc: EstimasiTindakan = {
      ...formData as EstimasiTindakan,
      status,
      grandTotal,
      updatedAt: Date.now()
    };

    if (status === 'Final') {
      doc.finalizedAt = Date.now();
      doc.finalizedBy = user?.namaLengkap || user?.username;
    }

    try {
      const db = await getDB();
      const existing = await db.get('estimasiTindakan', doc.id);
      if (existing) {
        await db.put('estimasiTindakan', doc);
      } else {
        await db.add('estimasiTindakan', doc);
      }
      
      await writeLog({
        modul: 'Estimasi Tindakan',
        aktivitas: status === 'Draft' ? 'Simpan Draft' : 'Finalisasi Estimasi',
        noRM: doc.noRM,
        namaPasien: doc.namaPasien,
        detail: `Estimasi ${doc.nomorEstimasi} total ${fmtRp(doc.grandTotal)}`,
        status: 'Success'
      });
      
      toast.success(status === 'Draft' ? 'Draft disimpan.' : 'Estimasi difinalisasi.');
      loadData();
      setActiveTab('list');
    } catch(err) {
      toast.error('Gagal menyimpan.');
    }
  }

  // --- PDF Export ---
  function generatePDF(item: EstimasiTindakan, action: 'print'|'download') {
    const doc = new jsPDF({ format: 'a4' });
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('RUMAH SAKIT EMC', 14, 20);
    doc.setFontSize(12);
    doc.text('ESTIMASI BIAYA TINDAKAN', 14, 28);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    
    const lCol = 14;
    const rCol = 110;
    doc.text(`No. Estimasi: ${item.nomorEstimasi}`, lCol, 40);
    doc.text(`Tanggal: ${formatDate(item.updatedAt)}`, lCol, 46);
    doc.text(`Status: ${item.status}`, lCol, 52);
    doc.text(`No RM: ${item.noRM}`, rCol, 40);
    doc.text(`Nama Pasien: ${item.namaPasien}`, rCol, 46);
    doc.text(`Tindakan: ${item.tindakan}`, rCol, 52);
    doc.text(`Dokter: ${item.dokterOperator}`, rCol, 58);
    
    let y = 65;
    const grouped = (item.items || []).reduce((acc, curr) => {
      const k = curr.kategori || 'Lainnya';
      if (!acc[k]) acc[k] = [];
      acc[k].push(curr);
      return acc;
    }, {} as Record<string, EstimasiTindakanItem[]>);

    const body: any[] = [];
    Object.keys(grouped).forEach(k => {
      body.push([{ content: k, colSpan: 4, styles: { fontStyle: 'bold', fillColor: [240, 250, 250] } }]);
      grouped[k].forEach(it => {
        body.push([
          it.namaItem,
          it.qty.toString(),
          fmtRp(it.harga),
          fmtRp(it.qty * it.harga)
        ]);
      });
      const sub = grouped[k].reduce((acc, it) => acc + (it.qty * it.harga), 0);
      body.push([{ content: `Subtotal ${k}`, colSpan: 3, styles: { halign: 'right', fontStyle: 'bold' } }, { content: fmtRp(sub), styles: { fontStyle: 'bold' } }]);
    });
    
    autoTable(doc, {
      startY: y,
      head: [['Nama Item', 'Qty', 'Harga', 'Total']],
      body: body,
      theme: 'grid',
      headStyles: { fillColor: [0, 181, 200] },
      styles: { fontSize: 8 },
      margin: { top: y },
    });
    
    const finalY = (doc as any).lastAutoTable.finalY + 10;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`Grand Total: ${fmtRp(item.grandTotal)}`, 14, finalY);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('Estimasi ini bukan merupakan tagihan akhir.', 14, finalY + 10);
    doc.text('Biaya aktual dapat berubah sesuai dengan kondisi medis selama perawatan.', 14, finalY + 15);
    doc.text(`Dibuat oleh: ${item.createdBy}`, 14, finalY + 35);
    
    if (action === 'print') {
      doc.autoPrint();
      window.open(doc.output('bloburl'), '_blank');
    } else {
      doc.save(`Estimasi_${item.nomorEstimasi}.pdf`);
    }
  }

  const canEdit = formMode !== 'view' && formData.status !== 'Final';
  const categoryTotals = (formData.items || []).reduce<Record<string, number>>((result, item) => {
    result[item.kategori || 'Belum dipetakan'] = (result[item.kategori || 'Belum dipetakan'] || 0) + item.qty * item.harga;
    return result;
  }, {});
  const hasUnmappedComponents = (formData.items || []).some(item => item.matchStatus === 'unmapped');

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary">Estimasi Biaya Tindakan</h1>
        <p className="text-muted-foreground mt-1">Manajemen estimasi pra-tindakan medis berdasarkan Master Tarif</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="list">Daftar Estimasi</TabsTrigger>
          <TabsTrigger value="form" disabled={!formData.id}>Form Estimasi</TabsTrigger>
        </TabsList>
        
        <TabsContent value="list" className="mt-6 space-y-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <div className="space-y-1">
                <CardTitle>Daftar Estimasi</CardTitle>
                <CardDescription>Cari dan kelola estimasi yang telah dibuat</CardDescription>
              </div>
              <Button onClick={handleCreateNew} className="gap-2">
                <Plus className="w-4 h-4"/> Buat Baru
              </Button>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4 mb-4">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Cari no RM, pasien, atau no estimasi..." value={listSearch} onChange={e => setListSearch(e.target.value)} className="pl-10" />
                </div>
                <select className="flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" value={listStatus} onChange={e => setListStatus(e.target.value)}>
                  <option value="All">Semua Status</option>
                  <option value="Draft">Draft</option>
                  <option value="Final">Final</option>
                </select>
                <Button variant="outline" size="icon" onClick={loadData} title="Refresh"><RefreshCw className="w-4 h-4"/></Button>
              </div>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">No. Estimasi</th>
                      <th className="px-4 py-3 text-left font-medium">Tanggal</th>
                      <th className="px-4 py-3 text-left font-medium">Pasien / RM</th>
                      <th className="px-4 py-3 text-left font-medium">Tindakan</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                      <th className="px-4 py-3 text-center font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredList.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Tidak ada data estimasi ditemukan.</td></tr>
                    ) : filteredList.map(item => (
                      <tr key={item.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium">{item.nomorEstimasi}</td>
                        <td className="px-4 py-3">{formatDate(item.updatedAt)}</td>
                        <td className="px-4 py-3">
                          <div>{item.namaPasien}</div>
                          <div className="text-xs text-muted-foreground">{item.noRM} • {item.kelas}</div>
                        </td>
                        <td className="px-4 py-3">{item.tindakan}</td>
                        <td className="px-4 py-3 text-right font-medium">{fmtRp(item.grandTotal)}</td>
                        <td className="px-4 py-3 text-center">
                          <Badge variant={item.status === 'Draft' ? 'outline' : 'default'} className={item.status === 'Final' ? 'bg-primary/10 text-primary border-primary/20' : ''}>
                            {item.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="icon" onClick={() => handleEdit(item, 'view')} title="Lihat"><Eye className="w-4 h-4"/></Button>
                            {item.status === 'Draft' && <Button variant="ghost" size="icon" onClick={() => handleEdit(item, 'edit')} title="Edit"><Edit className="w-4 h-4"/></Button>}
                            <Button variant="ghost" size="icon" onClick={() => handleDuplicate(item)} title="Duplikasi"><Copy className="w-4 h-4"/></Button>
                            <Button variant="ghost" size="icon" onClick={() => generatePDF(item, 'print')} title="Cetak"><Printer className="w-4 h-4"/></Button>
                             <Button variant="ghost" size="icon" onClick={() => generatePDF(item, 'download')} title="Unduh PDF"><FileDown className="w-4 h-4"/></Button>
                            <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => handleDelete(item.id)} title="Hapus"><Trash2 className="w-4 h-4"/></Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="form" className="mt-6 space-y-6">
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => setActiveTab('list')} className="gap-2"><ChevronLeft className="w-4 h-4"/> Kembali</Button>
            <div className="flex gap-2 items-center">
              <span className="text-sm text-muted-foreground font-mono">{formData.nomorEstimasi}</span>
              <Badge variant={formData.status === 'Final' ? 'default' : 'secondary'}>{formData.status}</Badge>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2 shadow-sm border-t-4 border-t-primary">
              <CardHeader className="pb-3 border-b bg-muted/10">
                <CardTitle className="text-lg">Informasi Pasien & Tindakan</CardTitle>
              </CardHeader>
              <CardContent className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-sm font-semibold">Pilih Pasien <span className="text-destructive">*</span></label>
                  {canEdit ? (
                    <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                      value={formData.noRM || ''} onChange={e => handlePatientSelect(e.target.value)}>
                      <option value="" disabled>-- Cari/Pilih Pasien Aktif --</option>
                      {patients.map(p => (
                        <option key={p.noRM} value={p.noRM}>{p.noRM} - {p.namaPasien} ({p.roomType || p.ward})</option>
                      ))}
                    </select>
                  ) : <Input readOnly value={`${formData.noRM} - ${formData.namaPasien}`} />}
                </div>
                
                <div className="space-y-1.5"><label className="text-sm font-semibold text-muted-foreground">Episode No</label><Input readOnly value={formData.episodeNo || '-'} className="bg-muted/30" /></div>
                <div className="space-y-1.5"><label className="text-sm font-semibold text-muted-foreground">Kelas Pasien</label><Input readOnly value={formData.kelas || '-'} className="bg-muted/30" /></div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Kelas Tarif Estimasi <span className="text-destructive">*</span></label>
                  {canEdit ? (
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                      value={formData.kelasTarif || ''}
                      onChange={e => handleTarifClassChange(e.target.value as EstimasiTindakanKelas)}
                    >
                      <option value="" disabled>-- Pilih Kelas Tarif --</option>
                      {ESTIMASI_KELAS.map(kelas => (
                        <option key={kelas} value={kelas}>{ESTIMASI_KELAS_LABELS[kelas]}</option>
                      ))}
                    </select>
                  ) : <Input readOnly value={ESTIMASI_KELAS_LABELS[formData.kelasTarif as EstimasiTindakanKelas] || formData.kelasTarif || '-'} />}
                </div>
                <div className="space-y-1.5"><label className="text-sm font-semibold text-muted-foreground">Penjamin</label><Input readOnly value={formData.penjamin || '-'} className="bg-muted/30" /></div>
                <div className="space-y-1.5"><label className="text-sm font-semibold text-muted-foreground">Diagnosis</label><Input readOnly value={formData.diagnosis || '-'} className="bg-muted/30" /></div>

                <div className="space-y-1.5 sm:col-span-2 pt-4 border-t">
                  <label className="text-sm font-semibold">Nama Tindakan <span className="text-destructive">*</span></label>
                  {canEdit ? (
                    <>
                      <Input
                        list="master-estimasi-tindakan-options"
                        value={formData.tindakan || ''}
                        onChange={e => handleActionSelect(e.target.value)}
                        placeholder={masterActions.length ? 'Cari tindakan dari Master Penggolongan...' : 'Master Penggolongan belum diunggah'}
                        disabled={!masterActions.length}
                      />
                      <datalist id="master-estimasi-tindakan-options">
                        {masterActions.map(action => (
                          <option key={action.id} value={action.namaTindakan}>{`Golongan ${action.golongan}`}</option>
                        ))}
                      </datalist>
                    </>
                  ) : <Input readOnly value={formData.tindakan || '-'} />}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold text-muted-foreground">Golongan Tindakan</label>
                  <Input readOnly value={formData.jenisOperasi || '-'} className="bg-muted/30" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Dokter Operator</label>
                  <Input readOnly={!canEdit} value={formData.dokterOperator || ''} onChange={e => updateForm('dokterOperator', e.target.value)} />
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardHeader className="pb-3 border-b bg-muted/10">
                <CardTitle className="text-lg flex items-center gap-2"><FileCheck className="w-4 h-4 text-primary"/> Master Estimasi</CardTitle>
                <CardDescription>Tarif dihitung otomatis dari Master Tarif Tindakan.</CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Tindakan tersedia</span><strong>{masterActions.length}</strong></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Baris tarif</span><strong>{masterEstimasiTarifs.length}</strong></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Kategori aktif</span><strong>{masterCategories.filter(category => category.aktif).length}</strong></div>
                {!masterActions.length && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">Superuser perlu mengunggah Master Penggolongan.</div>}
                {masterActions.length > 0 && !masterCategories.some(category => category.aktif) && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">Belum ada Master Kategori Item aktif.</div>}
              </CardContent>
            </Card>
          </div>

          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b flex flex-row items-center justify-between bg-muted/10">
              <div>
                <CardTitle className="text-lg flex items-center gap-2"><FileCheck className="w-5 h-5 text-primary"/> Rincian Biaya</CardTitle>
                <CardDescription>Harga disesuaikan dengan Master Tarif ({formData.kelasTarif || 'Pilih pasien untuk load harga'})</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {hasUnmappedComponents && (
                <div className="m-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  Ada komponen tarif yang belum dipetakan ke Master Kategori Item. Subtotal kategori tersebut ditampilkan sebagai “Belum dipetakan”.
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted border-b">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium w-48">Kategori</th>
                      <th className="px-4 py-3 text-left font-medium">Nama Item</th>
                      <th className="px-4 py-3 text-right font-medium w-24">Qty</th>
                      <th className="px-4 py-3 text-right font-medium w-40">Harga / Unit</th>
                      <th className="px-4 py-3 text-right font-medium w-40">Subtotal</th>
                      {canEdit && <th className="px-4 py-3 text-center w-20">Aksi</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(!formData.items || formData.items.length === 0) ? (
                      <tr><td colSpan={6} className="px-4 py-16 text-center text-muted-foreground bg-muted/5 border-dashed border-2 border-muted m-4 rounded-xl">Belum ada item estimasi.<br/>Pilih tindakan dari Master Penggolongan.</td></tr>
                    ) : (
                      formData.items.map((it, idx) => (
                        <tr key={it.id} className="border-b last:border-0 hover:bg-muted/10">
                          <td className="px-4 py-2 align-top pt-3">{it.kategori}</td>
                          <td className="px-4 py-2 align-top pt-3">
                            <div className="space-y-1">
                                <span className="font-medium">{it.namaItem}</span>
                              {it.matchStatus && it.matchStatus !== 'manual' && it.matchStatus !== 'exact' && (
                                <div className="text-[10px] text-amber-600 flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Mirip dengan Master: {it.matchedName}</div>
                              )}
                              {it.matchStatus === 'unmapped' && (
                                <div className="text-[10px] text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Harga tidak ditemukan di Master (Manual)</div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2 align-top pt-3">
                            {canEdit ? <Input type="number" min="1" className="h-8 text-right shadow-none" value={it.qty} onChange={e => updateItem(idx, 'qty', parseInt(e.target.value)||0)} /> : <div className="text-right">{it.qty}</div>}
                          </td>
                          <td className="px-4 py-2 align-top pt-3">
                            <div className="text-right tabular-nums text-muted-foreground">{fmtRp(it.harga)}</div>
                          </td>
                          <td className="px-4 py-2 align-top pt-3 text-right font-semibold tabular-nums text-foreground">
                            {fmtRp((it.qty||0) * (it.harga||0))}
                          </td>
                          {canEdit && (
                            <td className="px-4 py-2 align-top pt-3 text-center">
                              <div className="flex flex-col items-center justify-center gap-1">
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:bg-muted" onClick={() => moveItem(idx, -1)} disabled={idx===0}>↑</Button>
                                 <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:bg-muted" onClick={() => duplicateItem(idx)} title="Duplikat item"><Copy className="w-3 h-3"/></Button>
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:bg-destructive/10" onClick={() => removeItem(idx)}><Trash2 className="w-3 h-3"/></Button>
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:bg-muted" onClick={() => moveItem(idx, 1)} disabled={idx===formData.items!.length-1}>↓</Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot className="bg-primary/5">
                    {Object.entries(categoryTotals).map(([category, total]) => (
                      <tr key={category} className="border-t border-primary/10">
                        <td colSpan={4} className="px-4 py-2 text-right text-sm font-semibold text-muted-foreground">Subtotal {category}</td>
                        <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{fmtRp(total)}</td>
                        {canEdit && <td />}
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={4} className="px-4 py-4 text-right font-bold text-primary">GRAND TOTAL ESTIMASI</td>
                      <td className="px-4 py-4 text-right font-bold text-lg text-primary tabular-nums">
                        {fmtRp((formData.items||[]).reduce((a,c) => a + (c.harga*c.qty), 0))}
                      </td>
                      {canEdit && <td></td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
            {canEdit && (
              <CardFooter className="bg-muted/10 p-4 border-t flex justify-end gap-3">
                <Button variant="outline" className="gap-2 shadow-xs" onClick={() => handleSave('Draft')}><Save className="w-4 h-4"/> Simpan Draft</Button>
                <Button className="gap-2 bg-primary hover:bg-primary/90 shadow-sm" onClick={() => handleSave('Final')}><FileSignature className="w-4 h-4"/> Finalisasi Estimasi</Button>
              </CardFooter>
            )}
            {formMode === 'view' && (
               <CardFooter className="bg-muted/10 p-4 border-t flex justify-end gap-3">
                 <Button variant="outline" className="gap-2 shadow-xs" onClick={() => generatePDF(formData as EstimasiTindakan, 'print')}><Printer className="w-4 h-4"/> Print</Button>
                 <Button className="gap-2 shadow-sm" onClick={() => generatePDF(formData as EstimasiTindakan, 'download')}><FileDown className="w-4 h-4"/> Unduh PDF</Button>
               </CardFooter>
            )}
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  );
}
