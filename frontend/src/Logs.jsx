import { useEffect, useMemo, useState } from 'react'
import {
  Download, Eye, FilePlus2, LogIn, Pencil, RefreshCw, RotateCcw, ScrollText, Search, Trash2,
} from 'lucide-react'
import api from './api/axios.js'
import ServerPagination from './ServerPagination.jsx'
import useDebouncedValue from './useDebouncedValue.js'

const CARD =
  'rounded-xl border border-gray-200 bg-white shadow-sm transition-shadow dark:border-slate-700 dark:bg-slate-900'
const CONTROL =
  'h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition-colors focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 dark:border-slate-600 dark:bg-slate-950 dark:text-gray-100'

const ACTION_OPTIONS = [
  { value: 'all', label: 'Semua aktivitas' },
  { value: 'login', label: 'Login' },
  { value: 'tambah', label: 'Tambah data' },
  { value: 'edit', label: 'Edit data' },
  { value: 'hapus', label: 'Hapus data' },
]

// Ikon kecil di dalam kotak biru, mengikuti gaya tiap baris "Info Aktivitas".
const ACTION_STYLE = {
  login: { icon: LogIn, box: 'bg-sky-500/10 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400' },
  tambah: { icon: FilePlus2, box: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' },
  edit: { icon: Pencil, box: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' },
  hapus: { icon: Trash2, box: 'bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400' },
  akses: { icon: Eye, box: 'bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300' },
}

function formatTanggal(value) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })
}

// Normalisasi IPv6 loopback (::1) ke IPv4 agar kolom IP mudah dibaca.
function formatIpAddress(ip) {
  const text = String(ip || '').trim()
  if (!text || text === '-') {
    return { address: '-', local: false }
  }
  let normalized = text.replace(/^::ffff:/i, '')
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    normalized = '127.0.0.1'
  }
  const local = normalized === '127.0.0.1'
  return { address: normalized, local }
}

function currentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Awal & akhir bulan dari nilai <input type="month">.
function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { from: '', to: '' }
  }
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` }
}

function Logs() {
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState({ total: 0, login: 0, tambah: 0, edit: 0, hapus: 0 })
  const [users, setUsers] = useState([])
  const [mode, setMode] = useState('terbaru')
  const [totalData, setTotalData] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(20)
  const [searchTerm, setSearchTerm] = useState('')
  const [action, setAction] = useState('all')
  const [user, setUser] = useState('all')
  const [month, setMonth] = useState(currentMonth())
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const debouncedSearch = useDebouncedValue(searchTerm.trim())
  const range = useMemo(() => monthRange(month), [month])

  useEffect(() => {
    let ignore = false

    async function load() {
      setFetching(true)
      try {
        const response = await api.get('/logs', {
          params: {
            page: currentPage,
            limit: itemsPerPage,
            q: debouncedSearch,
            action: action === 'all' ? undefined : action,
            user: user === 'all' ? undefined : user,
            date_from: range.from || undefined,
            date_to: range.to || undefined,
          },
        })
        if (ignore) {
          return
        }
        const payload = response.data
        setRows(Array.isArray(payload?.data) ? payload.data : [])
        setSummary(payload?.summary || { total: 0, login: 0, tambah: 0, edit: 0, hapus: 0 })
        setUsers(Array.isArray(payload?.users) ? payload.users : [])
        setMode(payload?.mode || 'terbaru')
        setTotalData(Number(payload?.total) || 0)
        setTotalPages(Math.max(1, Number(payload?.total_pages) || 1))
        setError('')
        if (payload?.page && payload.page !== currentPage) {
          setCurrentPage(payload.page)
        }
      } catch (requestError) {
        if (!ignore) {
          setRows([])
          setError(requestError?.response?.data?.message || 'Gagal memuat log aplikasi.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
          setFetching(false)
        }
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [currentPage, itemsPerPage, debouncedSearch, action, user, range, reloadKey])

  const resetFilter = () => {
    setSearchTerm('')
    setAction('all')
    setUser('all')
    setMonth('')
    setCurrentPage(1)
  }

  const startIndex = (currentPage - 1) * itemsPerPage

  return (
    <section>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 mb-1.5 text-[13px] font-bold tracking-[0.12em] text-cyan-700 uppercase dark:text-cyan-300">
            Sistem
          </p>
          <h1 className="m-0 flex items-center gap-2.5 text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
            <ScrollText size={26} strokeWidth={2.1} className="shrink-0 text-gray-800 dark:text-gray-100" aria-hidden="true" />
            LOG APLIKASI
          </h1>
          <p className="m-0 mt-1.5 text-sm text-gray-500 dark:text-gray-400">
            Riwayat aktivitas: siapa yang login, menambah, mengubah, dan menghapus data — beserta IP dan aplikasinya.
          </p>
        </div>
      </header>

      {/* Kartu ringkasan per aksi */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { key: 'total', label: 'Semua', tone: 'text-slate-700 dark:text-gray-100' },
          { key: 'login', label: 'Login', tone: 'text-sky-600 dark:text-sky-400' },
          { key: 'tambah', label: 'Tambah', tone: 'text-emerald-600 dark:text-emerald-400' },
          { key: 'edit', label: 'Edit', tone: 'text-amber-600 dark:text-amber-400' },
          { key: 'hapus', label: 'Hapus', tone: 'text-rose-600 dark:text-rose-400' },
        ].map((item) => (
          <div key={item.key} className={`${CARD} px-4 py-3`}>
            <p className="m-0 text-xs font-bold tracking-wide text-gray-400 uppercase dark:text-gray-500">{item.label}</p>
            <strong className={`mt-1 block text-xl font-bold ${item.tone}`}>
              {(summary[item.key] || 0).toLocaleString('id-ID')}
            </strong>
          </div>
        ))}
      </div>

      <div className={`${CARD} overflow-hidden`}>
        {/* Toolbar: cetak, bulan, jumlah baris, cari */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 p-3 dark:border-slate-700">
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-lg border-0 bg-blue-600 px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
            onClick={() => window.print()}
          >
            <Download size={16} aria-hidden="true" />
            CETAK
          </button>

          <input
            type="month"
            className={CONTROL}
            value={month}
            onChange={(event) => {
              setMonth(event.target.value)
              setCurrentPage(1)
            }}
            aria-label="Filter bulan"
          />

          <select
            className={`${CONTROL} w-auto`}
            value={itemsPerPage}
            onChange={(event) => {
              setItemsPerPage(Number(event.target.value))
              setCurrentPage(1)
            }}
            aria-label="Jumlah baris per halaman"
          >
            {[10, 20, 25, 50, 100].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>

          <div className="relative ml-auto min-w-[13rem] flex-1 sm:flex-none">
            <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              type="search"
              className={`${CONTROL} w-full pl-9`}
              placeholder="Cari log..."
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value)
                setCurrentPage(1)
              }}
              aria-label="Cari log"
            />
          </div>
        </div>

        {/* Filter lanjutan */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50/60 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <select
            className={`${CONTROL} h-9 w-auto`}
            value={action}
            onChange={(event) => {
              setAction(event.target.value)
              setCurrentPage(1)
            }}
            aria-label="Filter aktivitas"
          >
            {ACTION_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>

          <select
            className={`${CONTROL} h-9 w-auto`}
            value={user}
            onChange={(event) => {
              setUser(event.target.value)
              setCurrentPage(1)
            }}
            aria-label="Filter pengguna"
          >
            <option value="all">Semua pengguna</option>
            {users.map((item) => (
              <option key={item.username} value={item.username}>
                {item.nama_lengkap === item.username ? item.username : `${item.nama_lengkap} (${item.username})`}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-xs font-bold text-gray-600 transition-colors hover:border-cyan-500 hover:text-cyan-700 dark:border-slate-600 dark:bg-slate-800 dark:text-gray-300"
            onClick={resetFilter}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Reset
          </button>

          <button
            type="button"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-xs font-bold text-gray-600 transition-colors hover:border-cyan-500 hover:text-cyan-700 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-gray-300"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={fetching}
          >
            <RefreshCw size={14} className={fetching ? 'animate-spin' : ''} aria-hidden="true" />
            Muat ulang
          </button>
        </div>

        {loading && <p className="m-0 p-6 text-center text-sm text-gray-500 dark:text-gray-400">Memuat log...</p>}
        {!loading && error && <p className="m-0 p-6 text-center text-sm font-semibold text-rose-600 dark:text-rose-400">{error}</p>}

        {!loading && !error && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] border-collapse text-left text-sm">
              <thead className="bg-gray-50 text-xs font-bold tracking-wider text-gray-500 uppercase dark:bg-slate-800/60 dark:text-gray-400">
                <tr>
                  <th className="w-12 px-3 py-3 text-right">#</th>
                  <th className="px-3 py-3">Nama Lengkap</th>
                  <th className="px-3 py-3">IP Address</th>
                  <th className="px-3 py-3">Info Aktivitas</th>
                  <th className="px-3 py-3 text-right">Tanggal Kejadian</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                      Belum ada aktivitas tercatat pada filter ini.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, index) => {
                    const style = ACTION_STYLE[row.action] || ACTION_STYLE.akses
                    const Icon = style.icon
                    const ipCell = formatIpAddress(row.ip)
                    return (
                      <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50/70 dark:border-slate-800 dark:hover:bg-slate-800/40">
                        <td className="px-3 py-2.5 text-right text-gray-400 dark:text-gray-500">{startIndex + index + 1}</td>
                        <td className="px-3 py-2.5">
                          <span className="block font-semibold text-gray-800 dark:text-gray-100">{row.nama_lengkap}</span>
                          <span className="block text-xs text-gray-400 dark:text-gray-500">
                            {row.username} · {row.role}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100" title={ipCell.local ? 'Koneksi langsung ke server (localhost), bukan IP publik pengguna di internet' : undefined}>
                            {ipCell.address}
                          </span>
                          {ipCell.local && (
                            <span className="mt-0.5 block text-[10px] font-medium text-amber-600 dark:text-amber-400">
                              Akses lokal server
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-start gap-2.5">
                            <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md ${style.box}`} aria-hidden="true">
                              <Icon size={15} strokeWidth={2.2} />
                            </span>
                            <div className="min-w-0">
                              <p className="m-0 text-gray-700 dark:text-gray-200">
                                {row.info_aktivitas || `${row.action_label} ${row.entity}`}
                              </p>
                              {row.path && (
                                <p className="m-0 mt-0.5 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500" title={row.path}>
                                  {row.method} {row.path}
                                  {row.status ? ` → ${row.status}` : ''}
                                  {row.duration_ms != null ? ` (${row.duration_ms} ms)` : ''}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap text-gray-600 dark:text-gray-300">{formatTanggal(row.created_at)}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && mode === 'filter' && (
          <ServerPagination
            page={currentPage}
            totalPages={totalPages}
            totalData={totalData}
            limit={itemsPerPage}
            onPageChange={setCurrentPage}
            disabled={fetching}
            label="Navigasi halaman log"
          />
        )}

        {!loading && !error && mode === 'terbaru' && (
          <p className="m-0 border-t border-gray-200 px-4 py-3 text-[13px] font-semibold text-gray-500 dark:border-slate-700 dark:text-gray-400">
            Menampilkan {rows.length.toLocaleString('id-ID')} aktivitas terakhir. Gunakan filter untuk menelusuri lebih dalam.
          </p>
        )}
      </div>
    </section>
  )
}

export default Logs
