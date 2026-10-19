import { useEffect, useState } from 'react'
import api from './api/axios.js'
import Swal from 'sweetalert2'
import * as XLSX from 'xlsx'
import {
  AlertTriangle,
  Banknote,
  Calendar,
  Download,
  FileText,
  Menu,
  PieChart,
  Search,
  Ticket,
  Trash,
} from 'lucide-react'
import './HotspotStok.css'
import './HotspotTerjual.css'

function formatRupiah(value) {
  const number = Number(value) || 0
  return `Rp${number.toLocaleString('id-ID')}`
}

function formatTanggalWaktu(value) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  const pad = (part) => String(part).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateKey(value) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isThisMonth(value) {
  if (!value) {
    return false
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return false
  }
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
}

function uniqueValues(rows, key) {
  return [...new Set(rows.map((row) => String(row[key] || '').trim()).filter(Boolean))]
}

const toolbar = [
  { label: 'MENU', icon: Menu, tone: 'blue' },
  { label: 'EXPORT', icon: Download, tone: 'tosca' },
  { label: 'REKAP', icon: PieChart, tone: 'green' },
  { label: 'LAPORAN', icon: FileText, tone: 'orange' },
  { label: 'HAPUS', icon: Trash, tone: 'red' },
]

function HotspotTerjual() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [filterDate, setFilterDate] = useState('')
  const [filterProfile, setFilterProfile] = useState('all')
  const [filterRouter, setFilterRouter] = useState('all')
  const [filterMitra, setFilterMitra] = useState('')
  const [filterOutlet, setFilterOutlet] = useState('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)
  const [selectedRows, setSelectedRows] = useState([])

  useEffect(() => {
    let ignore = false

    async function loadSold() {
      try {
        const response = await api.get('/api/hotspot/voucher-terjual')
        if (!ignore) {
          setRows(Array.isArray(response.data) ? response.data : [])
          setError('')
        }
      } catch {
        if (!ignore) {
          setRows([])
          setError('Gagal memuat voucher terjual.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    loadSold()
    return () => {
      ignore = true
    }
  }, [])

  function showInfo() {
    Swal.fire('Info', 'Fitur ini masuk dalam antrean pembuatan dan belum bisa digunakan.', 'info')
  }

  const keyword = searchTerm.toLowerCase()
  const filteredRows = rows.filter((item) => {
    const matchesSearch = !keyword || [
      item.username,
      item.profile,
      item.router,
      item.server,
      item.mitra,
      item.outlet,
      item.admin,
      item.kode_batch,
    ].some((value) => String(value || '').toLowerCase().includes(keyword))
    const matchesDate = !filterDate || dateKey(item.tgl_aktif) === filterDate
    const matchesProfile = filterProfile === 'all' || item.profile === filterProfile
    const matchesRouter = filterRouter === 'all' || item.router === filterRouter
    const matchesMitra = !filterMitra || item.mitra === filterMitra
    const matchesOutlet = filterOutlet === 'all' || item.outlet === filterOutlet
    return matchesSearch && matchesDate && matchesProfile && matchesRouter && matchesMitra && matchesOutlet
  })

  const totalData = filteredRows.length
  const totalPages = Math.max(1, Math.ceil(totalData / itemsPerPage))
  const page = Math.min(currentPage, totalPages)
  const lastIndex = page * itemsPerPage
  const firstIndex = lastIndex - itemsPerPage
  const currentItems = filteredRows.slice(firstIndex, lastIndex)
  const showingStart = totalData === 0 ? 0 : firstIndex + 1
  const showingEnd = Math.min(lastIndex, totalData)
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)
  const visibleUsernames = currentItems.map((item) => item.username)
  const allSelected = visibleUsernames.length > 0
    && visibleUsernames.every((username) => selectedRows.includes(username))
  const totalPenjualan = filteredRows.reduce((total, item) => total + (Number(item.harga) || 0), 0)
  const penjualanBulanIni = filteredRows.reduce((total, item) => (
    isThisMonth(item.tgl_aktif) ? total + (Number(item.harga) || 0) : total
  ), 0)
  const jumlahExpired = filteredRows.filter((item) => (
    item.tgl_expired && new Date() > new Date(item.tgl_expired)
  )).length
  const namaBulan = new Date().toLocaleDateString('id-ID', { month: 'long' })
  const profileOptions = uniqueValues(rows, 'profile')
  const routerOptions = uniqueValues(rows, 'router')
  const mitraOptions = uniqueValues(rows, 'mitra')
  const outletOptions = uniqueValues(rows, 'outlet')

  const summaries = [
    { label: 'Jumlah', hint: 'Voucher terjual', value: totalData.toLocaleString('id-ID'), icon: Ticket, tone: 'blue' },
    { label: 'Total Penjualan', hint: 'Nilai jual', value: formatRupiah(totalPenjualan), icon: Banknote, tone: 'teal' },
    { label: `Total ${namaBulan}`, hint: 'Penjualan bulan ini', value: formatRupiah(penjualanBulanIni), icon: Calendar, tone: 'amber' },
    { label: 'Jumlah Expired', hint: 'Kuota waktu habis', value: jumlahExpired.toLocaleString('id-ID'), icon: AlertTriangle, tone: 'expired' },
  ]

  function handleExportExcel() {
    const filteredVouchers = filteredRows
    if (filteredVouchers.length === 0) {
      Swal.fire('Kosong', 'Tidak ada data untuk diexport', 'warning')
      return
    }

    const dataUntukExcel = filteredVouchers.map((voucher) => ({
      Username: voucher.username,
      Profile: voucher.profile,
      'Harga Jual': voucher.harga,
      HPP: voucher.hpp,
      Komisi: voucher.komisi,
      Router: voucher.router,
      Outlet: voucher.outlet,
      'Durasi Terpakai': voucher.durasi,
      'Kuota Terpakai': voucher.kuota,
      'Tgl Aktif': voucher.tgl_aktif ? formatTanggalWaktu(voucher.tgl_aktif) : '-',
      'Tgl Expired': voucher.tgl_expired ? formatTanggalWaktu(voucher.tgl_expired) : 'UNLIMITED',
    }))
    const worksheet = XLSX.utils.json_to_sheet(dataUntukExcel)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data Penjualan')
    XLSX.writeFile(workbook, 'Laporan_Voucher_Terjual.xlsx')
  }

  function toggleRow(username) {
    setSelectedRows((current) => (
      current.includes(username)
        ? current.filter((item) => item !== username)
        : [...current, username]
    ))
  }

  function toggleAll() {
    if (visibleUsernames.length === 0) {
      return
    }
    if (visibleUsernames.every((username) => selectedRows.includes(username))) {
      setSelectedRows((current) => current.filter((username) => !visibleUsernames.includes(username)))
      return
    }
    setSelectedRows((current) => [...new Set([...current, ...visibleUsernames])])
  }

  return (
    <section className="stok terjual">
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
              <div className="stok-stat-icon" aria-hidden="true">
                <Icon size={20} strokeWidth={2.2} />
              </div>
            </article>
          )
        })}
      </div>

      <div className="stok-toolbar">
        {toolbar.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.label}
              type="button"
              className={`stok-action stok-action-${item.tone}`}
              onClick={item.label === 'EXPORT' ? handleExportExcel : showInfo}
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
          <input
            type="date"
            aria-label="Tanggal"
            value={filterDate}
            onChange={(event) => {
              setFilterDate(event.target.value)
              setCurrentPage(1)
            }}
          />
        </label>
        <select
          aria-label="All Profile"
          value={filterProfile}
          onChange={(event) => {
            setFilterProfile(event.target.value)
            setCurrentPage(1)
          }}
        >
          <option value="all">All Profile</option>
          {profileOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="All Router"
          value={filterRouter}
          onChange={(event) => {
            setFilterRouter(event.target.value)
            setCurrentPage(1)
          }}
        >
          <option value="all">All Router</option>
          {routerOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Pilih Mitra"
          value={filterMitra}
          onChange={(event) => {
            setFilterMitra(event.target.value)
            setCurrentPage(1)
          }}
        >
          <option value="">Pilih Mitra</option>
          {mitraOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Outlet"
          value={filterOutlet}
          onChange={(event) => {
            setFilterOutlet(event.target.value)
            setCurrentPage(1)
          }}
        >
          <option value="all">Semua Outlet</option>
          {outletOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Jumlah baris"
          value={itemsPerPage}
          onChange={(event) => {
            setItemsPerPage(Number(event.target.value))
            setCurrentPage(1)
          }}
        >
          <option value="10">10</option>
          <option value="20">20</option>
        </select>
        <label className="stok-search">
          <Search size={16} strokeWidth={2} />
          <input
            type="search"
            placeholder="Cari voucher..."
            aria-label="Cari voucher terjual"
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
            <p>Hotspot</p>
            <h1>Voucher Terjual</h1>
          </div>
          <span>{loading ? 'Memuat...' : `${totalData} voucher`}</span>
        </div>

        {loading && <p className="stok-status">Memuat data voucher...</p>}
        {error && <p className="stok-status stok-error">{error}</p>}

        {!loading && !error && (
          <div className="stok-table-wrap">
            <table className="terjual-table">
              <thead>
                <tr>
                  <th className="stok-check">
                    <input
                      type="checkbox"
                      aria-label="Pilih semua voucher terjual"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
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
                  <th>SALDO</th>
                  <th>ADMIN</th>
                  <th>KODE</th>
                  <th>DURASI</th>
                  <th>KUOTA</th>
                  <th>TGL AKTIF</th>
                  <th>TGL EXPIRED</th>
                </tr>
              </thead>
              <tbody>
                {currentItems.length === 0 ? (
                  <tr>
                    <td colSpan="18" className="stok-empty">
                      {searchTerm || filterDate || filterProfile !== 'all' || filterRouter !== 'all' || filterMitra || filterOutlet !== 'all'
                        ? 'Voucher tidak ditemukan.'
                        : 'Belum ada voucher terjual.'}
                    </td>
                  </tr>
                ) : (
                  currentItems.map((item) => {
                    const isExpired = item.tgl_expired && new Date() > new Date(item.tgl_expired)
                    return (
                    <tr
                      key={item.id || item.username}
                      className={[
                        selectedRows.includes(item.username) ? 'is-selected' : '',
                        isExpired ? 'terjual-expired' : '',
                      ].filter(Boolean).join(' ') || undefined}
                    >
                      <td className="stok-check">
                        <input
                          type="checkbox"
                          aria-label={`Pilih ${item.username}`}
                          checked={selectedRows.includes(item.username)}
                          onChange={() => toggleRow(item.username)}
                        />
                      </td>
                      <td>{item.username}</td>
                      <td className="password-cell">
                        <span className="pwd-masked">••••••••</span>
                        <span className="pwd-revealed">{item.password}</span>
                      </td>
                      <td><span className="stok-profil">{item.profile || '-'}</span></td>
                      <td>{item.router || '-'}</td>
                      <td>{item.server || '-'}</td>
                      <td>{item.mitra || '-'}</td>
                      <td>{item.outlet || '-'}</td>
                      <td>{formatRupiah(item.hpp)}</td>
                      <td>{formatRupiah(item.komisi)}</td>
                      <td>{formatRupiah(item.harga)}</td>
                      <td>{item.saldo == null ? '-' : formatRupiah(item.saldo)}</td>
                      <td>{item.admin || '-'}</td>
                      <td><span className="stok-code">{item.kode_batch || '-'}</span></td>
                      <td>{item.durasi}</td>
                      <td>{item.kuota}</td>
                      <td>{item.tgl_aktif ? formatTanggalWaktu(item.tgl_aktif) : '-'}</td>
                      <td>{item.tgl_expired ? formatTanggalWaktu(item.tgl_expired) : 'UNLIMITED'}</td>
                    </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && (
          <div className="stok-foot">
            <p className="stok-info">
              Showing {showingStart} to {showingEnd} of {totalData} entries
            </p>
            <nav className="stok-pages" aria-label="Navigasi halaman voucher terjual">
              <button
                type="button"
                className="stok-nav"
                disabled={page <= 1}
                onClick={() => setCurrentPage(page - 1)}
              >
                Previous
              </button>
              {pageNumbers.map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  className={pageNumber === page ? 'stok-page is-active' : 'stok-page'}
                  aria-current={pageNumber === page ? 'page' : undefined}
                  onClick={() => setCurrentPage(pageNumber)}
                >
                  {pageNumber}
                </button>
              ))}
              <button
                type="button"
                className="stok-nav"
                disabled={page >= totalPages}
                onClick={() => setCurrentPage(page + 1)}
              >
                Next
              </button>
            </nav>
          </div>
        )}
      </div>
    </section>
  )
}

export default HotspotTerjual
