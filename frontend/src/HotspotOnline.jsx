import { useEffect, useState } from 'react'
import axios from 'axios'
import Swal from 'sweetalert2'
import { RefreshCw, Search, Trash, UserX } from 'lucide-react'
import './HotspotStok.css'
import './HotspotOnline.css'

const API = 'http://192.168.69.70:5000/api/hotspot'

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  const megabyte = value / (1024 * 1024)
  if (megabyte >= 1024) {
    const gigabyte = megabyte / 1024
    const rounded = gigabyte >= 10 ? Math.round(gigabyte) : Math.round(gigabyte * 10) / 10
    return `${rounded} GB`
  }
  return `${Math.round(megabyte)} MB`
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const jam = String(Math.floor(total / 3600)).padStart(2, '0')
  const menit = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const detik = String(total % 60).padStart(2, '0')
  return `${jam}:${menit}:${detik}`
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

function tampil(value) {
  const text = String(value || '').trim()
  return text || '-'
}

async function fetchOnline() {
  const response = await axios.get(`${API}/voucher-online`)
  return Array.isArray(response.data) ? response.data : []
}

function HotspotOnline() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)
  const [selectedIds, setSelectedIds] = useState([])

  useEffect(() => {
    let ignore = false

    async function loadOnline() {
      try {
        const data = await fetchOnline()
        if (!ignore) {
          setRows(data)
          setError('')
        }
      } catch {
        if (!ignore) {
          setRows([])
          setError('Gagal memuat voucher online.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    loadOnline()
    return () => {
      ignore = true
    }
  }, [])

  const keyword = searchTerm.toLowerCase()
  const filteredRows = rows.filter((item) => !keyword || [
    item.username,
    item.profile,
    item.router,
    item.interface,
    item.server,
    item.ip_address,
    item.mac_addr,
    item.mitra,
    item.outlet,
  ].some((value) => String(value || '').toLowerCase().includes(keyword)))

  const totalData = filteredRows.length
  const totalPages = Math.max(1, Math.ceil(totalData / itemsPerPage))
  const page = Math.min(currentPage, totalPages)
  const lastIndex = page * itemsPerPage
  const firstIndex = lastIndex - itemsPerPage
  const currentItems = filteredRows.slice(firstIndex, lastIndex)
  const showingStart = totalData === 0 ? 0 : firstIndex + 1
  const showingEnd = Math.min(lastIndex, totalData)
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)
  const visibleIds = currentItems.map((item) => item.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const selectedRows = rows.filter((item) => selectedIds.includes(item.id))

  function toggleRow(id) {
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }

  function toggleAll() {
    if (visibleIds.length === 0) {
      return
    }
    if (visibleIds.every((id) => selectedIds.includes(id))) {
      setSelectedIds((current) => current.filter((id) => !visibleIds.includes(id)))
      return
    }
    setSelectedIds((current) => [...new Set([...current, ...visibleIds])])
  }

  function payloadTerpilih() {
    const usernames = [...new Set(selectedRows.map((item) => item.username).filter(Boolean))]
    const routers = [...new Set(selectedRows.map((item) => item.router).filter(Boolean))]
    return {
      usernames,
      router: routers.length === 1 ? routers[0] : routers,
    }
  }

  async function handleKickUser() {
    if (selectedRows.length === 0) {
      Swal.fire('Pilih user', 'Pilih minimal satu user yang sedang online.', 'warning')
      return
    }
    const confirm = await Swal.fire({
      title: 'Yakin menendang user ini dari MikroTik?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, tendang',
      cancelButtonText: 'Batal',
      confirmButtonColor: '#64748b',
    })
    if (!confirm.isConfirmed) {
      return
    }
    try {
      const response = await axios.post(`${API}/kick-user`, payloadTerpilih())
      setSelectedIds([])
      Swal.fire({
        icon: 'success',
        title: 'Berhasil',
        text: response.data?.message || 'Permintaan kick user diterima',
        timer: 1500,
        showConfirmButton: false,
      })
    } catch {
      Swal.fire('Gagal', 'Permintaan kick user gagal dikirim.', 'error')
    }
  }

  async function handleHapusCookie() {
    if (selectedRows.length === 0) {
      Swal.fire('Pilih user', 'Pilih minimal satu user yang sedang online.', 'warning')
      return
    }
    const confirm = await Swal.fire({
      title: 'Yakin menghapus cookie user ini dari MikroTik?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, hapus',
      cancelButtonText: 'Batal',
      confirmButtonColor: '#e11d48',
    })
    if (!confirm.isConfirmed) {
      return
    }
    try {
      const response = await axios.post(`${API}/hapus-cookie`, payloadTerpilih())
      setSelectedIds([])
      Swal.fire({
        icon: 'success',
        title: 'Berhasil',
        text: response.data?.message || 'Permintaan hapus cookie diterima',
        timer: 1500,
        showConfirmButton: false,
      })
    } catch {
      Swal.fire('Gagal', 'Permintaan hapus cookie gagal dikirim.', 'error')
    }
  }

  async function handleSync() {
    setSyncing(true)
    Swal.fire({
      title: 'Menyinkronkan...',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading()
      },
    })
    try {
      await axios.post(`${API}/sync-online`)
      const data = await fetchOnline()
      setRows(data)
      setError('')
      setSelectedIds([])
      Swal.fire({
        icon: 'success',
        title: 'Selesai',
        text: 'Data online berhasil disegarkan.',
        timer: 1500,
        showConfirmButton: false,
      })
    } catch {
      Swal.fire('Gagal', 'Data online gagal disegarkan.', 'error')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className="stok online">
      <div className="stok-toolbar online-toolbar">
        <div className="online-toolbar-actions">
          <button type="button" className="stok-action stok-action-muted" onClick={handleKickUser}>
            <UserX size={16} strokeWidth={2.2} />
            <span>KICK USER</span>
          </button>
          <button type="button" className="stok-action stok-action-red" onClick={handleHapusCookie}>
            <Trash size={16} strokeWidth={2.2} />
            <span>HAPUS</span>
          </button>
          <button
            type="button"
            className="stok-action stok-action-green"
            onClick={handleSync}
            disabled={syncing}
          >
            <RefreshCw className={syncing ? 'online-spin' : undefined} size={16} strokeWidth={2.2} />
            <span>SINKRONKAN</span>
          </button>
        </div>
        <div className="online-toolbar-tools">
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
            <option value="50">50</option>
          </select>
          <label className="stok-search">
            <Search size={16} strokeWidth={2} />
            <input
              type="search"
              placeholder="Cari user online..."
              aria-label="Cari voucher online"
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value)
                setCurrentPage(1)
              }}
            />
          </label>
        </div>
      </div>

      <div className="stok-panel">
        <div className="stok-panel-head">
          <div>
            <p>Hotspot</p>
            <h1>Voucher Online</h1>
          </div>
          <span>{loading ? 'Memuat...' : `${totalData} online`}</span>
        </div>

        {loading && <p className="stok-status">Memuat data voucher online...</p>}
        {error && <p className="stok-status stok-error">{error}</p>}

        {!loading && !error && (
          <div className="stok-table-wrap">
            <table className="online-table">
              <thead>
                <tr>
                  <th className="stok-check">
                    <input
                      type="checkbox"
                      aria-label="Pilih semua voucher online"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>USERNAME</th>
                  <th>PROFILE</th>
                  <th>UPTIME</th>
                  <th>UPLOAD</th>
                  <th>DOWNLOAD</th>
                  <th>ROUTER</th>
                  <th>INTERFACE</th>
                  <th>SERVER</th>
                  <th>IP ADDRESS</th>
                  <th>MAC ADDR</th>
                  <th>MITRA</th>
                  <th>OUTLET</th>
                  <th>LAST CONNECTED</th>
                  <th>LAST UPDATED</th>
                </tr>
              </thead>
              <tbody>
                {currentItems.length === 0 ? (
                  <tr>
                    <td colSpan="15" className="stok-empty">
                      {searchTerm ? 'User tidak ditemukan.' : 'Belum ada voucher online.'}
                    </td>
                  </tr>
                ) : (
                  currentItems.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedIds.includes(item.id) ? 'is-selected' : undefined}
                    >
                      <td className="stok-check">
                        <input
                          type="checkbox"
                          aria-label={`Pilih ${item.username}`}
                          checked={selectedIds.includes(item.id)}
                          onChange={() => toggleRow(item.id)}
                        />
                      </td>
                      <td>{item.username}</td>
                      <td>
                        <span className="online-profile">
                          <span
                            className={item.terdaftar ? 'online-dot is-online' : 'online-dot'}
                            aria-hidden="true"
                          />
                          {tampil(item.profile)}
                        </span>
                      </td>
                      <td className="online-uptime">{formatUptime(item.uptime)}</td>
                      <td><span className="online-badge online-badge-upload">{formatBytes(item.upload)}</span></td>
                      <td><span className="online-badge online-badge-download">{formatBytes(item.download)}</span></td>
                      <td>{tampil(item.router)}</td>
                      <td>{tampil(item.interface)}</td>
                      <td>{tampil(item.server)}</td>
                      <td>{tampil(item.ip_address)}</td>
                      <td>{tampil(item.mac_addr)}</td>
                      <td>{tampil(item.mitra)}</td>
                      <td>{tampil(item.outlet)}</td>
                      <td>{formatTanggalWaktu(item.last_connected)}</td>
                      <td>{formatTanggalWaktu(item.last_updated)}</td>
                    </tr>
                  ))
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
            <nav className="stok-pages" aria-label="Navigasi halaman voucher online">
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

export default HotspotOnline
