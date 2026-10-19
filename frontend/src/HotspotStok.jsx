import { useEffect, useRef, useState } from 'react'
import api from './api/axios.js'
import ServerPagination from './ServerPagination.jsx'
import useDebouncedValue from './useDebouncedValue.js'
import Swal from 'sweetalert2'
import {
  Banknote,
  Calendar,
  Check,
  FileClock,
  HandCoins,
  Menu,
  Package,
  Plus,
  Printer,
  Search,
  Settings,
  Store,
  TicketPlus,
  Trash,
  UserPlus,
  Wallet,
  X,
} from 'lucide-react'
import './HotspotStok.css'

function formatRupiah(value) {
  const number = Number(value) || 0
  return `Rp${number.toLocaleString('id-ID')}`
}

function formatTanggal(value) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  const pad = (part) => String(part).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatTanggalGabung(value) {
  if (!value) {
    return '-'
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-')
    return `${day}/${month}/${year}`
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  const pad = (part) => String(part).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

function emptyFormOutlet() {
  return {
    nama_outlet: '',
    pemilik: '',
    phone: '',
    alamat: '',
    tgl_gabung: new Date().toISOString().split('T')[0],
  }
}

function sumColumn(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0)
}

const summaryCards = [
  { label: 'Total Stok', hint: 'Voucher tersedia', icon: Package, tone: 'blue', key: 'stok' },
  { label: 'Total HPP', hint: 'Harga pokok', icon: Wallet, tone: 'teal', key: 'hpp' },
  { label: 'Total Komisi', hint: 'Bagian mitra', icon: HandCoins, tone: 'amber', key: 'komisi' },
  { label: 'Total Harga', hint: 'Nilai jual', icon: Banknote, tone: 'indigo', key: 'harga' },
]

const toolbar = [
  { label: 'PRINT', icon: Printer, tone: 'red' },
  { label: 'BUAT USER', icon: UserPlus, tone: 'green' },
  { label: 'BUAT VC', icon: TicketPlus, tone: 'navy' },
  { label: 'OUTLET', icon: Store, tone: 'ink' },
  { label: 'SETTING', icon: Settings, tone: 'rose' },
  { label: 'RIWAYAT', icon: FileClock, tone: 'orange' },
]

function HotspotStok() {
  const [daftarProfil, setDaftarProfil] = useState([])
  const [daftarRouter, setDaftarRouter] = useState([])
  const [daftarOutletAktif, setDaftarOutletAktif] = useState([])
  const [selectedOutlet, setSelectedOutlet] = useState('')
  const [selectedRouter, setSelectedRouter] = useState('ALL ROUTER')
  const [vouchers, setVouchers] = useState([])
  const [totalData, setTotalData] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [voucherSummary, setVoucherSummary] = useState({
    total_stok: 0, total_hpp: 0, total_komisi: 0, total_harga: 0,
  })
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [mikrotikGroup, setMikrotikGroup] = useState('')
  const [jumlah, setJumlah] = useState(10)
  const [prefix, setPrefix] = useState('')
  const [panjang, setPanjang] = useState(6)
  const [jenisVoucher, setJenisVoucher] = useState('username=password')
  const [kodeKombinasi, setKodeKombinasi] = useState('huruf-kecil')
  const [saving, setSaving] = useState(false)
  // Kunci sinkron anti klik ganda (state React baru update setelah render).
  const generatingRef = useRef(false)
  // Voucher terpilih disimpan lengkap (username -> baris) agar tetap bisa
  // di-print/dihapus walau admin berpindah halaman.
  const [selectedMap, setSelectedMap] = useState({})
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isModalBuatVcOpen, setIsModalBuatVcOpen] = useState(false)
  const [isModalOutletOpen, setIsModalOutletOpen] = useState(false)
  const [daftarOutlet, setDaftarOutlet] = useState([])
  const [isOutletMenuOpen, setIsOutletMenuOpen] = useState(false)
  const [searchOutlet, setSearchOutlet] = useState('')
  const [isModalTambahOutletOpen, setIsModalTambahOutletOpen] = useState(false)
  const [formOutlet, setFormOutlet] = useState(emptyFormOutlet)
  const [outletPage, setOutletPage] = useState(1)
  const [outletPerPage, setOutletPerPage] = useState(10)
  const [selectedOutlets, setSelectedOutlets] = useState([])
  const [outletLoading, setOutletLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)

  const debouncedSearch = useDebouncedValue(searchTerm.trim())

  function applyVoucherResponse(payload) {
    setVouchers(Array.isArray(payload?.data) ? payload.data : [])
    setTotalData(Number(payload?.total) || 0)
    setTotalPages(Math.max(1, Number(payload?.total_pages) || 1))
    if (payload?.summary) {
      setVoucherSummary(payload.summary)
    }
    setError('')
  }

  // Muat ulang halaman tertentu (mis. halaman 1 setelah generate) dengan filter aktif.
  async function fetchVouchers(targetPage = currentPage) {
    const response = await api.get('/api/hotspot/voucher', {
      params: { page: targetPage, limit: itemsPerPage, q: searchTerm.trim() },
    })
    applyVoucherResponse(response.data)
    setCurrentPage(response.data.page)
  }

  // Server-side pagination: hanya satu halaman data yang diminta dari backend.
  useEffect(() => {
    let ignore = false

    async function loadPage() {
      setFetching(true)
      try {
        const response = await api.get('/api/hotspot/voucher', {
          params: { page: currentPage, limit: itemsPerPage, q: debouncedSearch },
        })
        if (ignore) {
          return
        }
        applyVoucherResponse(response.data)
        if (response.data.page !== currentPage) {
          setCurrentPage(response.data.page)
        }
      } catch {
        if (!ignore) {
          setError('Gagal memuat data voucher.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
          setFetching(false)
        }
      }
    }

    loadPage()
    return () => {
      ignore = true
    }
  }, [currentPage, itemsPerPage, debouncedSearch])

  useEffect(() => {
    let ignore = false

    async function loadData() {
      try {
        const [profilResponse, outletResponse] = await Promise.all([
          api.get('/api/hotspot/profil'),
          api.get('/api/outlets').catch(() => ({ data: [] })),
        ])
        if (ignore) {
          return
        }

        const profiles = Array.isArray(profilResponse.data) ? profilResponse.data : []
        const outlets = Array.isArray(outletResponse.data) ? outletResponse.data : []
        setDaftarProfil(profiles)
        setMikrotikGroup((current) => current || profiles[0]?.mikrotik_group || '')
        setDaftarOutletAktif(outlets.filter((item) => item.status === 'Aktif'))
        setError('')
      } catch {
        if (!ignore) {
          setError('Gagal memuat data profil.')
        }
      }
    }

    loadData()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    let ignore = false

    async function loadRouters() {
      try {
        const response = await api.get('/api/routers')
        if (!ignore) {
          setDaftarRouter(Array.isArray(response.data) ? response.data : [])
        }
      } catch {
        if (!ignore) {
          setDaftarRouter([])
        }
      }
    }

    loadRouters()

    return () => {
      ignore = true
    }
  }, [])

  function notifySuccess(text) {
    Swal.fire({
      icon: 'success',
      title: 'Berhasil!',
      text,
      timer: 1500,
      showConfirmButton: false,
    })
  }

  useEffect(() => {
    if (!isMenuOpen) {
      return undefined
    }

    function closeMenu(event) {
      if (!event.target.closest('.stok-menu')) {
        setIsMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [isMenuOpen])

  useEffect(() => {
    if (!isModalOutletOpen) {
      return undefined
    }

    let ignore = false

    async function loadOutlets() {
      setOutletLoading(true)
      try {
        const response = await api.get('/api/outlets')
        if (!ignore) {
          setDaftarOutlet(Array.isArray(response.data) ? response.data : [])
        }
      } catch {
        if (!ignore) {
          setDaftarOutlet([])
        }
      } finally {
        if (!ignore) {
          setOutletLoading(false)
        }
      }
    }

    loadOutlets()

    return () => {
      ignore = true
    }
  }, [isModalOutletOpen])

  useEffect(() => {
    if (!isOutletMenuOpen) {
      return undefined
    }

    function closeOutletMenu(event) {
      if (!event.target.closest('.outlet-menu')) {
        setIsOutletMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', closeOutletMenu)
    return () => document.removeEventListener('mousedown', closeOutletMenu)
  }, [isOutletMenuOpen])

  const currentItems = vouchers
  const page = currentPage
  const allSelected = currentItems.length > 0
    && currentItems.every((item) => selectedMap[item.username])
  const selectedVouchers = Object.keys(selectedMap)

  function toggleRow(item) {
    setSelectedMap((current) => {
      const next = { ...current }
      if (next[item.username]) {
        delete next[item.username]
      } else {
        next[item.username] = item
      }
      return next
    })
  }

  function toggleAll() {
    if (currentItems.length === 0) {
      return
    }
    setSelectedMap((current) => {
      const next = { ...current }
      if (currentItems.every((item) => next[item.username])) {
        currentItems.forEach((item) => delete next[item.username])
      } else {
        currentItems.forEach((item) => { next[item.username] = item })
      }
      return next
    })
  }

  function showUnderDevelopment() {
    Swal.fire(
      'Tahap Pengembangan',
      'Fitur ini masuk dalam antrean pembuatan dan belum bisa digunakan.',
      'warning',
    )
  }

  function handlePrintSelected() {
    setIsMenuOpen(false)
    const dataPrint = Object.values(selectedMap)
      .map((item) => {
        const profil = daftarProfil.find((profile) => profile.nama_profile === item.profile)
        return {
          ...item,
          masa_aktif: profil?.masa_aktif || '',
          masa_aktif_satuan: profil?.masa_aktif_satuan || '',
        }
      })

    if (dataPrint.length === 0) {
      Swal.fire({
        icon: 'warning',
        title: 'Pilih minimal satu voucher',
      })
      return
    }

    localStorage.setItem('print_vouchers', JSON.stringify(dataPrint))
    window.open('/print', '_blank')
  }

  async function handleDeleteSelected() {
    if (selectedVouchers.length === 0) {
      Swal.fire({
        icon: 'warning',
        title: 'Pilih minimal satu voucher',
      })
      return
    }

    const selectedRows = Object.values(selectedMap)
    const batchIds = new Set(selectedRows.map((item) => item.kode_batch ?? null))
    if (batchIds.size > 1) {
      Swal.fire(
        'Ditolak!',
        'Tidak bisa menghapus voucher dengan Kode Grup (Batch) yang berbeda. Harap pilih voucher dalam satu grup yang sama.',
        'error',
      )
      return
    }

    const result = await Swal.fire({
      title: 'Yakin ingin menghapus voucher ini?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, Hapus!',
      cancelButtonText: 'Batal',
    })
    if (!result.isConfirmed) {
      return
    }

    try {
      await api.post('/api/hotspot/voucher/delete-massal', {
        usernames: selectedVouchers,
      })
      setIsMenuOpen(false)
      setSelectedMap({})
      await fetchVouchers()
      notifySuccess('Data sukses diperbarui')
    } catch (requestError) {
      Swal.fire({
        icon: 'error',
        title: 'Gagal',
        text: requestError.response?.data?.message || 'Gagal menghapus voucher.',
      })
    }
  }

  async function handleGenerate(event) {
    event.preventDefault()

    if (generatingRef.current) {
      return
    }

    const adminName = localStorage.getItem('admin_user') || 'System'
    const payload = {
      router: selectedRouter,
      server: 'ALL SERVER',
      jenis_voucher: jenisVoucher,
      kode_kombinasi: kodeKombinasi,
      prefix: prefix.trim(),
      outlet: selectedOutlet.trim() || 'PUSAT',
      mikrotik_group: mikrotikGroup,
      admin: adminName,
      mitra: '',
      jumlah: Number(jumlah),
      panjang: Number(panjang),
    }

    if (!payload.mikrotik_group) {
      Swal.fire({
        icon: 'warning',
        title: 'Pilih profile',
      })
      return
    }

    generatingRef.current = true
    setSaving(true)
    setIsModalBuatVcOpen(false)

    Swal.fire({
      title: 'Sedang Memproses...',
      text: 'Mencetak ribuan voucher, harap tunggu.',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading()
      },
    })

    try {
      await api.post('/api/hotspot/voucher/generate', payload)
    } catch {
      Swal.close()
      Swal.fire('Gagal!', 'Terjadi kesalahan saat generate voucher. Silakan coba lagi.', 'error')
      generatingRef.current = false
      setSaving(false)
      return
    }

    // Generate sukses: kosongkan form, lalu muat ulang tabel agar voucher baru tampil.
    resetVoucherForm()
    try {
      await fetchVouchers(1)
    } catch {
      setError('Voucher berhasil dibuat, tetapi tabel gagal dimuat ulang. Muat ulang halaman.')
    }

    Swal.close()
    Swal.fire('Berhasil!', 'Voucher sukses dibuat dan dimasukkan ke database.', 'success')
    generatingRef.current = false
    setSaving(false)
  }

  const selectedProfile = daftarProfil.find((item) => item.mikrotik_group === mikrotikGroup)
  const hargaJual = Number(selectedProfile?.harga_jual) || 0
  const komisi = Number(selectedProfile?.komisi_reseller) || 0
  const hargaPokok = Number.isFinite(Number(selectedProfile?.hpp))
    ? Number(selectedProfile.hpp)
    : hargaJual - komisi
  const jumlahVoucher = Math.max(0, Number(jumlah) || 0)
  const totalStok = voucherSummary.total_stok
  const totalHpp = voucherSummary.total_hpp
  const totalKomisi = voucherSummary.total_komisi
  const totalHarga = voucherSummary.total_harga
  const summaries = summaryCards.map((card) => {
    if (card.key === 'stok') {
      return { ...card, value: totalStok.toLocaleString('id-ID') }
    }
    if (card.key === 'hpp') {
      return { ...card, value: formatRupiah(totalHpp) }
    }
    if (card.key === 'komisi') {
      return { ...card, value: formatRupiah(totalKomisi) }
    }
    return { ...card, value: formatRupiah(totalHarga) }
  })
  const searchOutletLower = searchOutlet.toLowerCase()
  const filteredOutlets = daftarOutlet.filter((item) => (
    (item.nama_outlet || '').toLowerCase().includes(searchOutletLower)
    || (item.pemilik || '').toLowerCase().includes(searchOutletLower)
    || (item.phone || '').toLowerCase().includes(searchOutletLower)
    || (item.alamat || '').toLowerCase().includes(searchOutletLower)
  ))
  const outletTotal = filteredOutlets.length
  const outletTotalPages = Math.max(1, Math.ceil(outletTotal / outletPerPage))
  const outletSafePage = Math.min(outletPage, outletTotalPages)
  const outletLastIndex = outletSafePage * outletPerPage
  const outletFirstIndex = outletLastIndex - outletPerPage
  const outletItems = filteredOutlets.slice(outletFirstIndex, outletLastIndex)
  const outletPageNumbers = Array.from({ length: outletTotalPages }, (_, index) => index + 1)
  const allOutletsSelected = outletItems.length > 0
    && outletItems.every((item) => selectedOutlets.includes(item.id))

  function toggleOutlet(id) {
    setSelectedOutlets((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }

  function toggleAllOutlets() {
    const visibleIds = outletItems.map((item) => item.id)
    if (visibleIds.length === 0) {
      return
    }
    if (visibleIds.every((id) => selectedOutlets.includes(id))) {
      setSelectedOutlets((current) => current.filter((id) => !visibleIds.includes(id)))
      return
    }
    setSelectedOutlets((current) => [...new Set([...current, ...visibleIds])])
  }

  // Kembalikan form Buat Voucher ke nilai awal (prefix dan outlet dikosongkan,
  // sisanya kembali ke pilihan bawaan).
  function resetVoucherForm() {
    setSelectedRouter('ALL ROUTER')
    setJenisVoucher('username=password')
    setKodeKombinasi('huruf-kecil')
    setPrefix('')
    setSelectedOutlet('')
    setMikrotikGroup(daftarProfil[0]?.mikrotik_group || '')
    setJumlah(10)
    setPanjang(6)
  }

  function closeVoucherModal() {
    if (saving) {
      return
    }
    setIsModalBuatVcOpen(false)
    resetVoucherForm()
  }

  function closeOutletModal() {
    setIsModalOutletOpen(false)
    setIsOutletMenuOpen(false)
    setIsModalTambahOutletOpen(false)
  }

  function openTambahOutlet() {
    setFormOutlet(emptyFormOutlet())
    setIsModalTambahOutletOpen(true)
  }

  function closeTambahOutlet() {
    setIsModalTambahOutletOpen(false)
    setFormOutlet(emptyFormOutlet())
  }

  function updateFormOutlet(event) {
    const { name, value } = event.target
    setFormOutlet((current) => ({ ...current, [name]: value }))
  }

  async function fetchOutlets() {
    const response = await api.get('/api/outlets')
    setDaftarOutlet(Array.isArray(response.data) ? response.data : [])
  }

  async function handleAksiOutletMassal(aksi) {
    if (selectedOutlets.length === 0) {
      Swal.fire({
        icon: 'warning',
        title: 'Pilih minimal satu outlet',
      })
      return
    }

    const isDelete = aksi === 'Hapus Terpilih'
    const status = aksi === 'Set Aktif' ? 'Aktif' : 'Tidak Aktif'
    const result = await Swal.fire({
      title: isDelete
        ? 'Yakin menghapus data outlet secara permanen?'
        : `Set outlet terpilih menjadi ${status}?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: isDelete ? 'Ya, Hapus!' : 'Ya, Simpan!',
      cancelButtonText: 'Batal',
      confirmButtonColor: isDelete ? '#e11d48' : '#059669',
    })
    if (!result.isConfirmed) {
      return
    }

    try {
      if (isDelete) {
        await api.post('/api/outlets/delete-massal', {
          ids: selectedOutlets,
        })
      } else {
        await api.post('/api/outlets/set-status-massal', {
          ids: selectedOutlets,
          status,
        })
      }
      setIsOutletMenuOpen(false)
      setSelectedOutlets([])
      await fetchOutlets()
      notifySuccess(isDelete ? 'Outlet terpilih berhasil dihapus' : 'Status outlet berhasil diperbarui')
    } catch (requestError) {
      Swal.fire({
        icon: 'error',
        title: 'Gagal',
        text: requestError.response?.data?.message || 'Gagal memproses outlet terpilih.',
      })
    }
  }

  async function handleSaveOutlet(event) {
    event.preventDefault()
    if (!formOutlet.nama_outlet.trim()) {
      Swal.fire({
        icon: 'warning',
        title: 'Nama outlet wajib diisi',
      })
      return
    }

    Swal.fire({
      title: 'Menyimpan outlet...',
      text: 'Mohon tunggu sebentar.',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading()
      },
    })

    try {
      await api.post('/api/outlets', {
        nama_outlet: formOutlet.nama_outlet.trim(),
        pemilik: formOutlet.pemilik.trim(),
        phone: formOutlet.phone.trim(),
        alamat: formOutlet.alamat.trim(),
        tgl_gabung: formOutlet.tgl_gabung,
      })
      setIsModalTambahOutletOpen(false)
      setFormOutlet(emptyFormOutlet())
      setOutletPage(1)
      await fetchOutlets()
      notifySuccess('Outlet berhasil disimpan')
    } catch (requestError) {
      Swal.fire({
        icon: 'error',
        title: 'Gagal',
        text: requestError.response?.data?.message || 'Gagal menyimpan outlet.',
      })
    }
  }
  return (
    <section className="stok">
      <div className="stok-stats">
        {summaries.map((item) => {
          const Icon = item.icon
          return (
            <article key={item.label} className={`stok-stat stok-stat-${item.tone}`}>
              <div>
                <p>{item.label}</p>
                <strong>{item.value}</strong>
                <span>{item.hint}</span>
              </div>
              <span className="stok-stat-icon" aria-hidden="true">
                <Icon size={22} strokeWidth={2} />
              </span>
            </article>
          )
        })}
      </div>

      <div className="stok-toolbar" role="toolbar" aria-label="Aksi stok voucher">
        <div className="stok-menu">
          <button
            type="button"
            className="stok-action stok-action-blue"
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            onClick={() => setIsMenuOpen((open) => !open)}
          >
            <Menu size={16} strokeWidth={2.2} />
            <span>MENU</span>
          </button>

          {isMenuOpen && (
            <div className="stok-dropdown" role="menu">
              <button type="button" role="menuitem" onClick={handlePrintSelected}>
                <Printer size={16} strokeWidth={2.2} />
                <span>Print Terpilih</span>
              </button>
              <button type="button" role="menuitem" className="is-danger" onClick={handleDeleteSelected}>
                <Trash size={16} strokeWidth={2.2} />
                <span>Hapus Terpilih</span>
              </button>
            </div>
          )}
        </div>

        {toolbar.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.label}
              type="button"
              className={`stok-action stok-action-${item.tone}`}
              onClick={
                item.label === 'BUAT VC'
                  ? () => setIsModalBuatVcOpen(true)
                  : item.label === 'OUTLET'
                    ? () => setIsModalOutletOpen(true)
                    : showUnderDevelopment
              }
            >
              <Icon size={16} strokeWidth={2.2} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </div>

      <div className="stok-filters">
        <label className="stok-filter stok-filter-date">
          <Calendar size={16} strokeWidth={2} />
          <input type="date" name="tanggal" aria-label="Tanggal" />
        </label>

        <select name="profile" aria-label="All Profile" defaultValue="all">
          <option value="all">All Profile</option>
        </select>

        <select name="router" aria-label="All Router" defaultValue="all">
          <option value="all">All Router</option>
        </select>

        <select name="mitra" aria-label="Pilih Mitra" defaultValue="">
          <option value="">Pilih Mitra</option>
        </select>

        <select name="outlet" aria-label="Semua Outlet" defaultValue="all">
          <option value="all">Semua Outlet</option>
        </select>

        <select
          name="limit"
          aria-label="Jumlah baris"
          value={itemsPerPage}
          onChange={(event) => {
            setItemsPerPage(Number(event.target.value))
            setCurrentPage(1)
          }}
        >
          <option value="10">10</option>
          <option value="20">20</option>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="500">500</option>
        </select>

        <label className="stok-search">
          <Search size={16} strokeWidth={2} />
          <input
            type="search"
            name="q"
            placeholder="Cari voucher..."
            aria-label="Cari voucher"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value)
              setCurrentPage(1)
            }}
          />
        </label>
      </div>

      <div className="stok-panel">
        <div className="stok-panel-head">
          <div>
            <p>Data Radius</p>
            <h1>Daftar Voucher</h1>
          </div>
          <span>{loading ? 'Memuat...' : `${totalData.toLocaleString('id-ID')} voucher`}</span>
        </div>

        {loading && <p className="stok-status">Memuat data voucher...</p>}
        {error && <p className="stok-status stok-error">{error}</p>}

        {!loading && !error && (
          <div className={fetching ? 'stok-table-wrap is-fetching' : 'stok-table-wrap'}>
            <table className="stok-table">
              <thead>
                <tr>
                  <th className="stok-check">
                    <input
                      type="checkbox"
                      aria-label="Pilih semua voucher"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>KODE</th>
                  <th>USERNAME</th>
                  <th>PASSWORD</th>
                  <th>PROFILE</th>
                  <th>ROUTER</th>
                  <th>SERVER</th>
                  <th>MITRA</th>
                  <th>OUTLET</th>
                  <th>HPP</th>
                  <th>KOMISI</th>
                  <th>HARGA</th>
                  <th>SALDO/STATUS</th>
                  <th>ADMIN</th>
                  <th>TGL PEMBUATAN</th>
                </tr>
              </thead>
              <tbody>
                {currentItems.length === 0 ? (
                  <tr>
                    <td colSpan="15" className="stok-empty">
                      {searchTerm ? 'Voucher tidak ditemukan.' : 'Belum ada voucher.'}
                    </td>
                  </tr>
                ) : (
                  currentItems.map((item) => (
                    <tr
                      key={item.id ?? item.username}
                      className={selectedMap[item.username] ? 'is-selected' : undefined}
                    >
                      <td className="stok-check">
                        <input
                          type="checkbox"
                          aria-label={`Pilih ${item.username}`}
                          checked={Boolean(selectedMap[item.username])}
                          onChange={() => toggleRow(item)}
                        />
                      </td>
                      <td>
                        <span className="stok-code">{item.kode_batch || '-'}</span>
                      </td>
                      <td>{item.username}</td>
                      <td className="password-cell">
                        <span className="pwd-masked">••••••••</span>
                        <span className="pwd-revealed">{item.password}</span>
                      </td>
                      <td>
                        <span className="stok-profil">{item.profile || '-'}</span>
                      </td>
                      <td>{item.router || '-'}</td>
                      <td>{item.server || '-'}</td>
                      <td>{item.mitra || '-'}</td>
                      <td>{item.outlet || '-'}</td>
                      <td>{formatRupiah(item.hpp)}</td>
                      <td>{formatRupiah(item.komisi)}</td>
                      <td>{formatRupiah(item.harga)}</td>
                      <td>{item.status || '-'}</td>
                      <td>{item.admin || '-'}</td>
                      <td>{formatTanggal(item.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && (
          <ServerPagination
            page={page}
            totalPages={totalPages}
            totalData={totalData}
            limit={itemsPerPage}
            onPageChange={setCurrentPage}
            label="Navigasi halaman"
            disabled={fetching}
          />
        )}
      </div>

      {isModalBuatVcOpen && (
        <div className="stok-backdrop" onMouseDown={closeVoucherModal}>
          <div
            className="stok-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stok-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="stok-modal-head">
              <h2 id="stok-modal-title">Buat Voucher</h2>
              <p>Kode dibuat dari prefix dan huruf serta angka acak.</p>
            </header>
            <form className="stok-modal-form" onSubmit={handleGenerate}>
              <div className="stok-modal-grid">
                <div className="stok-modal-fields">
                  <label className="stok-field">
                    <span>Router</span>
                    <select value={selectedRouter} onChange={(event) => setSelectedRouter(event.target.value)}>
                      <option value="ALL ROUTER">ALL ROUTER</option>
                      {daftarRouter.map((item) => (
                        <option key={item.id || item.nama_router} value={item.nama_router}>
                          {item.nama_router}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="stok-field">
                    <span>Server</span>
                    <input type="text" value="ALL SERVER" readOnly />
                  </label>
                  <label className="stok-field">
                    <span>Jenis Voucher</span>
                    <select value={jenisVoucher} onChange={(event) => setJenisVoucher(event.target.value)}>
                      <option value="username=password">username=password</option>
                      <option value="username+password">username+password</option>
                    </select>
                  </label>
                  <label className="stok-field">
                    <span>Kode Kombinasi</span>
                    <select value={kodeKombinasi} onChange={(event) => setKodeKombinasi(event.target.value)}>
                      <option value="huruf-kecil">Huruf Kecil</option>
                      <option value="huruf-besar">Huruf Besar</option>
                      <option value="huruf-campuran">Huruf Besar &amp; Kecil</option>
                      <option value="angka-huruf">Angka &amp; Huruf</option>
                    </select>
                  </label>
                  <label className="stok-field">
                    <span>Prefix</span>
                    <input
                      type="text"
                      maxLength="3"
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                    />
                  </label>
                  <label className="stok-field">
                    <span>Outlet</span>
                    <select value={selectedOutlet} onChange={(event) => setSelectedOutlet(event.target.value)}>
                      <option value="">-Pilih Outlet-</option>
                      {daftarOutletAktif.map((outlet) => (
                        <option key={outlet.id || outlet.nama_outlet} value={outlet.nama_outlet}>
                          {outlet.nama_outlet}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="stok-field">
                    <span>Profile</span>
                    <select
                      value={mikrotikGroup}
                      onChange={(event) => setMikrotikGroup(event.target.value)}
                      required
                    >
                      <option value="">Pilih profile</option>
                      {daftarProfil.map((item) => (
                        <option key={item.id || item.mikrotik_group} value={item.mikrotik_group}>
                          {item.nama_profile}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="stok-field">
                    <span>Jumlah</span>
                    <input
                      type="number"
                      min="1"
                      max="5000"
                      value={jumlah}
                      onChange={(event) => setJumlah(event.target.value)}
                      required
                    />
                  </label>
                  <label className="stok-field">
                    <span>Panjang Karakter</span>
                    <input
                      type="number"
                      min="6"
                      max="32"
                      value={panjang}
                      onChange={(event) => setPanjang(event.target.value)}
                      required
                    />
                  </label>
                </div>

                <aside className="stok-summary" aria-label="Ringkasan harga">
                  <h3>Ringkasan Harga</h3>
                  <p>{selectedProfile?.nama_profile || 'Pilih profile'}</p>
                  <dl>
                    <div>
                      <dt>Harga Pokok</dt>
                      <dd>{formatRupiah(hargaPokok)}</dd>
                    </div>
                    <div>
                      <dt>Harga Jual</dt>
                      <dd>{formatRupiah(hargaJual)}</dd>
                    </div>
                    <div>
                      <dt>Komisi</dt>
                      <dd>{formatRupiah(komisi)}</dd>
                    </div>
                    <div>
                      <dt>Total Komisi</dt>
                      <dd>{formatRupiah(komisi * jumlahVoucher)}</dd>
                    </div>
                    <div>
                      <dt>Total Harga Pokok</dt>
                      <dd>{formatRupiah(hargaPokok * jumlahVoucher)}</dd>
                    </div>
                  </dl>
                </aside>
              </div>
              <div className="stok-modal-actions">
                <button
                  type="button"
                  className="stok-modal-btn stok-modal-btn-gray"
                  onClick={closeVoucherModal}
                  disabled={saving}
                >
                  Batal
                </button>
                <button type="submit" className="stok-modal-btn stok-modal-btn-blue" disabled={saving}>
                  Generate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isModalOutletOpen && (
        <div className="stok-backdrop" onMouseDown={closeOutletModal}>
          <div
            className="stok-modal outlet-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="outlet-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="outlet-head">
              <div>
                <p>Hotspot</p>
                <h2 id="outlet-modal-title">Data Outlet</h2>
              </div>
              <button type="button" className="outlet-close" onClick={closeOutletModal} aria-label="Tutup">
                <X size={18} />
              </button>
            </header>

            <div className="outlet-note">
              Outlet adalah toko, warung atau individu yang menjual voucher langsung ke konsumen dan posisi outlet berada dibawah kontrol mitra reseller
            </div>

            <div className="outlet-toolbar">
              <div className="stok-menu outlet-menu">
                <button
                  type="button"
                  className="outlet-btn outlet-btn-green"
                  aria-expanded={isOutletMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setIsOutletMenuOpen((open) => !open)}
                >
                  <Menu size={16} />
                  <span>MENU</span>
                </button>
                {isOutletMenuOpen && (
                  <div className="stok-dropdown" role="menu">
                    <button type="button" role="menuitem" onClick={() => handleAksiOutletMassal('Set Aktif')}>
                      <Check size={16} />
                      <span>Set Aktif</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => handleAksiOutletMassal('Set Tidak Aktif')}>
                      <X size={16} />
                      <span>Set Tidak Aktif</span>
                    </button>
                    <button type="button" role="menuitem" className="is-danger" onClick={() => handleAksiOutletMassal('Hapus Terpilih')}>
                      <Trash size={16} />
                      <span>Hapus Terpilih</span>
                    </button>
                  </div>
                )}
              </div>
              <button type="button" className="outlet-btn outlet-btn-blue" onClick={openTambahOutlet}>
                <Plus size={16} />
                <span>TAMBAH</span>
              </button>
              <select
                aria-label="Jumlah baris outlet"
                value={outletPerPage}
                onChange={(event) => {
                  setOutletPerPage(Number(event.target.value))
                  setOutletPage(1)
                }}
              >
                <option value="10">10</option>
                <option value="20">20</option>
              </select>
              <label className="outlet-search">
                <Search size={16} />
                <input
                  type="search"
                  placeholder="Cari outlet..."
                  aria-label="Cari outlet"
                  value={searchOutlet}
                  onChange={(event) => {
                    setSearchOutlet(event.target.value)
                    setOutletPage(1)
                  }}
                />
              </label>
            </div>

            <div className="outlet-table-wrap">
              {outletLoading ? (
                <p className="outlet-loading">Memuat data outlet...</p>
              ) : (
                <table className="outlet-table">
                  <thead>
                    <tr>
                      <th className="stok-check">
                        <input
                          type="checkbox"
                          aria-label="Pilih semua outlet"
                          checked={allOutletsSelected}
                          onChange={toggleAllOutlets}
                        />
                      </th>
                      <th>OUTLET</th>
                      <th>PEMILIK</th>
                      <th>PHONE</th>
                      <th>STOK VC</th>
                      <th>MITRA</th>
                      <th>STATUS</th>
                      <th>TGL GABUNG</th>
                      <th>ALAMAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outletItems.length === 0 ? (
                      <tr>
                        <td colSpan="9" className="outlet-empty">
                          {searchOutlet ? 'Outlet tidak ditemukan.' : 'Belum ada outlet.'}
                        </td>
                      </tr>
                    ) : (
                      outletItems.map((item) => (
                        <tr key={item.id} className={selectedOutlets.includes(item.id) ? 'is-selected' : undefined}>
                          <td className="stok-check">
                            <input
                              type="checkbox"
                              aria-label={`Pilih ${item.nama_outlet}`}
                              checked={selectedOutlets.includes(item.id)}
                              onChange={() => toggleOutlet(item.id)}
                            />
                          </td>
                          <td>{item.nama_outlet}</td>
                          <td>{item.pemilik || '-'}</td>
                          <td>{item.phone || '-'}</td>
                          <td className="outlet-stock">{item.stok_vc ?? 0}</td>
                          <td>{item.mitra || '-'}</td>
                          <td>
                            <span className={item.status === 'Tidak Aktif' ? 'outlet-status is-inactive' : 'outlet-status is-active'}>
                              {item.status || 'Aktif'}
                            </span>
                          </td>
                          <td>{item.tgl_gabung ? formatTanggalGabung(item.tgl_gabung) : formatTanggal(item.created_at)}</td>
                          <td>{item.alamat || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>

            <div className="stok-foot outlet-foot">
              <p className="stok-info">
                Showing {outletTotal === 0 ? 0 : outletFirstIndex + 1} to {Math.min(outletLastIndex, outletTotal)} of {outletTotal} entries
              </p>
              <nav className="stok-pages" aria-label="Navigasi halaman outlet">
                <button
                  type="button"
                  className="stok-nav"
                  disabled={outletSafePage <= 1}
                  onClick={() => setOutletPage(outletSafePage - 1)}
                >
                  Prev
                </button>
                {outletPageNumbers.map((pageNumber) => (
                  <button
                    key={pageNumber}
                    type="button"
                    className={pageNumber === outletSafePage ? 'stok-page is-active' : 'stok-page'}
                    aria-current={pageNumber === outletSafePage ? 'page' : undefined}
                    onClick={() => setOutletPage(pageNumber)}
                  >
                    {pageNumber}
                  </button>
                ))}
                <button
                  type="button"
                  className="stok-nav"
                  disabled={outletSafePage >= outletTotalPages}
                  onClick={() => setOutletPage(outletSafePage + 1)}
                >
                  Next
                </button>
              </nav>
            </div>
          </div>
        </div>
      )}

      {isModalTambahOutletOpen && (
        <div className="stok-backdrop outlet-form-backdrop" onMouseDown={closeTambahOutlet}>
          <div
            className="stok-modal outlet-form-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tambah-outlet-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="outlet-head">
              <h2 id="tambah-outlet-title">OUTLET VOUCHER</h2>
            </header>
            <form className="outlet-form" onSubmit={handleSaveOutlet}>
              <label className="stok-field">
                <span>Outlet</span>
                <input
                  type="text"
                  name="nama_outlet"
                  value={formOutlet.nama_outlet}
                  onChange={updateFormOutlet}
                  maxLength={100}
                  required
                />
              </label>
              <label className="stok-field">
                <span>Pemilik</span>
                <input
                  type="text"
                  name="pemilik"
                  value={formOutlet.pemilik}
                  onChange={updateFormOutlet}
                  maxLength={100}
                />
              </label>
              <label className="stok-field">
                <span>Phone</span>
                <input
                  type="text"
                  name="phone"
                  value={formOutlet.phone}
                  onChange={updateFormOutlet}
                  maxLength={50}
                />
              </label>
              <label className="stok-field">
                <span>Alamat</span>
                <input
                  type="text"
                  name="alamat"
                  value={formOutlet.alamat}
                  onChange={updateFormOutlet}
                />
              </label>
              <label className="stok-field">
                <span>Tgl Gabung</span>
                <input
                  type="date"
                  name="tgl_gabung"
                  value={formOutlet.tgl_gabung}
                  onChange={updateFormOutlet}
                />
              </label>
              <div className="stok-modal-actions">
                <button type="button" className="stok-modal-btn stok-modal-btn-gray" onClick={closeTambahOutlet}>
                  Close
                </button>
                <button type="submit" className="stok-modal-btn stok-modal-btn-blue">
                  Simpan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}

export default HotspotStok
