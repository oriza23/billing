import { useEffect, useState } from 'react'
import api from './api/axios.js'
import Swal from 'sweetalert2'
import {
  Ban,
  CalendarPlus,
  Download,
  ExternalLink,
  FileText,
  Hash,
  KeyRound,
  Menu,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash,
  UserRound,
  UserX,
  Users,
  X,
} from 'lucide-react'
import './HotspotStok.css'
import './LanggananData.css'

const API = '/api/langganan/data'
const PROFIL_API = '/api/langganan/profil'

function todayKey() {
  const date = new Date()
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function emptyForm() {
  const today = todayKey()
  return {
    nolayanan: Date.now().toString().slice(-8),
    pelanggan: '',
    ktg: 'PPP',
    media_tipe: 'Fiber Optic',
    profil_id: '',
    jns_tagihan: 'PRABAYAR',
    siklus: 'BULAN',
    tgl_aktif: today,
    tgl_isolir: '',
    username: '',
    password: '',
    ip_address: '',
    mac_address: '',
    router: '',
    server: '',
    acs: '',
    addr_list: '',
    wilayah: '',
    alamat_pasang: '',
    tgl_pasang: today,
    mitra: '',
    kode_unik: '',
    note: '',
    status: 'Aktif',
  }
}

function formFromRow(item) {
  return {
    nolayanan: item.nolayanan || '',
    pelanggan: item.pelanggan || '',
    ktg: item.ktg || 'PPP',
    media_tipe: item.media_tipe || 'Fiber Optic',
    profil_id: item.profil_id ? String(item.profil_id) : '',
    jns_tagihan: item.jns_tagihan || 'PRABAYAR',
    siklus: item.siklus || 'BULAN',
    tgl_aktif: item.tgl_aktif || '',
    tgl_isolir: item.tgl_isolir ? item.tgl_isolir.replace(' ', 'T').slice(0, 16) : '',
    username: item.username || '',
    password: item.password || '',
    ip_address: item.ip_address || '',
    mac_address: item.mac_address || '',
    router: item.router || '',
    server: item.server || '',
    acs: item.acs || '',
    addr_list: item.addr_list || '',
    wilayah: item.wilayah || '',
    alamat_pasang: item.alamat_pasang || '',
    tgl_pasang: item.tgl_pasang || '',
    mitra: item.mitra || '',
    kode_unik: item.kode_unik || '',
    note: item.note || '',
    status: item.status || 'Aktif',
  }
}

function formatRupiah(value) {
  const number = Number(value) || 0
  return `Rp${number.toLocaleString('id-ID')}`
}

function formatTanggal(value) {
  if (!value) {
    return '-'
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/)
  if (!match) {
    return String(value)
  }
  const [, year, month, day, hour, minute] = match
  return hour ? `${day}/${month}/${year} ${hour}:${minute}` : `${day}/${month}/${year}`
}

function isThisMonth(value) {
  if (!value) {
    return false
  }
  const match = String(value).match(/^(\d{4})-(\d{2})/)
  if (!match) {
    return false
  }
  const now = new Date()
  return Number(match[1]) === now.getFullYear() && Number(match[2]) === now.getMonth() + 1
}

function tampil(value) {
  const text = String(value || '').trim()
  return text || '-'
}

function ipHref(ip) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(ip || '')) ? `http://${ip}` : ''
}

function showInfo() {
  Swal.fire('Info', 'Fitur ini masuk dalam antrean pembuatan dan belum bisa digunakan.', 'info')
}

const infoButtons = [
  { label: 'IMPORT', icon: Download, tone: 'tosca' },
  { label: 'SET BILLING', icon: Receipt, tone: 'rose' },
  { label: 'SECRET', icon: KeyRound, tone: 'tosca' },
  { label: 'LAPORAN', icon: FileText, tone: 'yellow' },
  { label: 'PELANGGAN', icon: UserRound, tone: 'green' },
  { label: 'KODE UNIK', icon: Hash, tone: 'yellow' },
]

function LanggananData() {
  const [rows, setRows] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)
  const [selectedIds, setSelectedIds] = useState([])
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  async function loadData() {
    const [customerResponse, profileResponse] = await Promise.all([
      api.get(API),
      api.get(PROFIL_API),
    ])
    setRows(Array.isArray(customerResponse.data) ? customerResponse.data : [])
    setProfiles(Array.isArray(profileResponse.data) ? profileResponse.data : [])
    setError('')
  }

  useEffect(() => {
    let ignore = false

    async function load() {
      try {
        const [customerResponse, profileResponse] = await Promise.all([
          api.get(API),
          api.get(PROFIL_API),
        ])
        if (!ignore) {
          setRows(Array.isArray(customerResponse.data) ? customerResponse.data : [])
          setProfiles(Array.isArray(profileResponse.data) ? profileResponse.data : [])
          setError('')
        }
      } catch {
        if (!ignore) {
          setRows([])
          setError('Gagal memuat data langganan.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!isMenuOpen) {
      return undefined
    }
    function closeMenu(event) {
      if (!event.target.closest('.data-menu')) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [isMenuOpen])

  const keyword = searchTerm.toLowerCase()
  const filteredRows = rows.filter((item) => !keyword || [
    item.nolayanan,
    item.pelanggan,
    item.username,
    item.nama_profil,
    item.ip_address,
    item.wilayah,
    item.alamat_pasang,
    item.mitra,
    item.kode_unik,
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
  const summaries = [
    { label: 'Total', hint: 'Seluruh pelanggan', value: rows.length, icon: Users, tone: 'total' },
    { label: 'PSB Bulan Ini', hint: 'Pasang bulan ini', value: rows.filter((item) => isThisMonth(item.tgl_pasang)).length, icon: CalendarPlus, tone: 'psb' },
    { label: 'Non Aktif', hint: 'Status non aktif', value: rows.filter((item) => item.status === 'Non Aktif').length, icon: UserX, tone: 'nonaktif' },
    { label: 'Terisolir', hint: 'Status isolir', value: rows.filter((item) => item.status === 'Isolir').length, icon: Ban, tone: 'isolir' },
  ]

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
  }

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

  function openCreate() {
    setEditingId(null)
    setForm(emptyForm())
    setIsModalOpen(true)
    setIsMenuOpen(false)
  }

  function openEdit(item) {
    setEditingId(item.id)
    setForm(formFromRow(item))
    setIsModalOpen(true)
    setIsMenuOpen(false)
  }

  function closeModal() {
    if (!saving) {
      setIsModalOpen(false)
      setEditingId(null)
    }
  }

  function payloadFromForm() {
    return {
      ...form,
      pelanggan: form.pelanggan.trim(),
      username: form.username.trim(),
      profil_id: form.profil_id || null,
      tgl_isolir: form.tgl_isolir ? form.tgl_isolir.replace('T', ' ') : '',
    }
  }

  async function handleSave(event) {
    event.preventDefault()
    if (!form.pelanggan.trim() || !form.username.trim()) {
      Swal.fire('Data belum lengkap', 'Nama pelanggan dan username wajib diisi.', 'warning')
      return
    }
    setSaving(true)
    Swal.fire({
      title: 'Menyimpan...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    })
    try {
      const payload = payloadFromForm()
      if (editingId) {
        await api.put(`${API}/${encodeURIComponent(editingId)}`, payload)
      } else {
        await api.post(API, payload)
      }
      await loadData()
      setIsModalOpen(false)
      setEditingId(null)
      setSelectedIds([])
      Swal.fire({
        icon: 'success',
        title: 'Berhasil',
        text: editingId ? 'Data langganan berhasil diperbarui.' : 'Data langganan berhasil disimpan.',
        timer: 1500,
        showConfirmButton: false,
      })
    } catch (requestError) {
      Swal.fire('Gagal', requestError.response?.data?.message || 'Data langganan gagal disimpan.', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (selectedRows.length === 0) {
      Swal.fire('Pilih pelanggan', 'Pilih minimal satu data langganan.', 'warning')
      return
    }
    const confirm = await Swal.fire({
      title: selectedRows.length === 1
        ? 'Yakin menghapus data langganan ini?'
        : `Yakin menghapus ${selectedRows.length} data langganan?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, hapus',
      cancelButtonText: 'Batal',
      confirmButtonColor: '#e11d48',
    })
    if (!confirm.isConfirmed) {
      return
    }
    Swal.fire({
      title: 'Menghapus...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    })
    try {
      await Promise.all(selectedRows.map((item) => api.delete(`${API}/${encodeURIComponent(item.id)}`)))
      await loadData()
      setSelectedIds([])
      Swal.fire({
        icon: 'success',
        title: 'Terhapus',
        text: 'Data langganan berhasil dihapus.',
        timer: 1500,
        showConfirmButton: false,
      })
    } catch (requestError) {
      Swal.fire('Gagal', requestError.response?.data?.message || 'Data langganan gagal dihapus.', 'error')
    }
  }

  async function handleSetStatus(status) {
    setIsMenuOpen(false)
    if (selectedRows.length === 0) {
      Swal.fire('Pilih pelanggan', 'Pilih minimal satu data langganan.', 'warning')
      return
    }
    const confirm = await Swal.fire({
      title: `Ubah status menjadi ${status}?`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Ya, ubah',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) {
      return
    }
    try {
      await Promise.all(selectedRows.map((item) => api.put(
        `${API}/${encodeURIComponent(item.id)}`,
        { ...formFromRow(item), status, profil_id: item.profil_id || null },
      )))
      await loadData()
      setSelectedIds([])
      Swal.fire({
        icon: 'success',
        title: 'Berhasil',
        text: `Status diubah menjadi ${status}.`,
        timer: 1500,
        showConfirmButton: false,
      })
    } catch (requestError) {
      Swal.fire('Gagal', requestError.response?.data?.message || 'Status gagal diubah.', 'error')
    }
  }

  return (
    <section className="stok data-langganan">
      <div className="stok-stats">
        {summaries.map((item) => {
          const Icon = item.icon
          return (
            <article key={item.label} className={`stok-stat data-stat data-stat-${item.tone}`}>
              <div>
                <p>{item.label}</p>
                <strong>{item.value.toLocaleString('id-ID')}</strong>
                <span>{item.hint}</span>
              </div>
              <div className="stok-stat-icon" aria-hidden="true">
                <Icon size={20} strokeWidth={2.2} />
              </div>
            </article>
          )
        })}
      </div>

      <div className="data-toolbar">
        <div className="data-menu">
          <button
            type="button"
            className="stok-action stok-action-green"
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            onClick={() => setIsMenuOpen((open) => !open)}
          >
            <Menu size={16} strokeWidth={2.2} />
            <span>MENU</span>
          </button>
          {isMenuOpen && (
            <div className="stok-dropdown" role="menu">
              <button type="button" role="menuitem" onClick={() => handleSetStatus('Aktif')}>Set Aktif</button>
              <button type="button" role="menuitem" onClick={() => handleSetStatus('Non Aktif')}>Set Non Aktif</button>
              <button type="button" role="menuitem" className="is-danger" onClick={() => handleSetStatus('Isolir')}>Set Isolir</button>
            </div>
          )}
        </div>
        <button type="button" className="stok-action stok-action-red" onClick={handleDelete}>
          <Trash size={16} strokeWidth={2.2} />
          <span>HAPUS</span>
        </button>
        {infoButtons.map((item) => {
          const Icon = item.icon
          return (
            <button key={item.label} type="button" className={`stok-action data-action-${item.tone}`} onClick={showInfo}>
              <Icon size={16} strokeWidth={2.2} />
              <span>{item.label}</span>
            </button>
          )
        })}
        <button type="button" className="stok-action stok-action-blue" onClick={openCreate}>
          <Plus size={16} strokeWidth={2.2} />
          <span>TAMBAH</span>
        </button>
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
            placeholder="Cari pelanggan..."
            aria-label="Cari pelanggan"
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
            <p>Langganan</p>
            <h1>Data Langganan</h1>
          </div>
          <span>{loading ? 'Memuat...' : `${totalData} pelanggan`}</span>
        </div>
        {loading && <p className="stok-status">Memuat data langganan...</p>}
        {error && <p className="stok-status stok-error">{error}</p>}
        {!loading && !error && (
          <div className="stok-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="stok-check">
                    <input type="checkbox" aria-label="Pilih semua pelanggan" checked={allSelected} onChange={toggleAll} />
                  </th>
                  <th>INET</th>
                  <th>NOLAYANAN</th>
                  <th>PELANGGAN</th>
                  <th>KTG</th>
                  <th>MEDIA/TIPE</th>
                  <th>PROFILE</th>
                  <th>JNS TAGIHAN</th>
                  <th>SIKLUS</th>
                  <th>TGL AKTIF</th>
                  <th>TGL ISOLIR</th>
                  <th>USERNAME</th>
                  <th>PASSWORD</th>
                  <th>IP ADDRESS</th>
                  <th>MAC ADDRESS</th>
                  <th>ROUTER</th>
                  <th>SERVER</th>
                  <th>ACS</th>
                  <th>ADDR LIST</th>
                  <th>WILAYAH</th>
                  <th>ALAMAT PASANG</th>
                  <th>TGL PASANG</th>
                  <th>MITRA</th>
                  <th>KODE UNIK</th>
                  <th>NOTE</th>
                </tr>
              </thead>
              <tbody>
                {currentItems.length === 0 ? (
                  <tr>
                    <td colSpan="25" className="stok-empty">
                      {searchTerm ? 'Pelanggan tidak ditemukan.' : 'Belum ada data langganan.'}
                    </td>
                  </tr>
                ) : currentItems.map((item) => (
                  <tr key={item.id} className={selectedIds.includes(item.id) ? 'is-selected' : undefined}>
                    <td className="stok-check">
                      <input
                        type="checkbox"
                        aria-label={`Pilih ${item.pelanggan}`}
                        checked={selectedIds.includes(item.id)}
                        onChange={() => toggleRow(item.id)}
                      />
                    </td>
                    <td>
                      <span
                        className={item.status === 'Aktif' ? 'data-inet is-aktif' : 'data-inet'}
                        title={item.status}
                      />
                    </td>
                    <td>{tampil(item.nolayanan)}</td>
                    <td>{item.pelanggan}</td>
                    <td>{tampil(item.ktg)}</td>
                    <td>{tampil(item.media_tipe)}</td>
                    <td>
                      {item.nama_profil ? (
                        <span className="data-profil">
                          <span>{item.nama_profil}</span>
                          <span className="data-harga">{formatRupiah(item.harga_profil)}</span>
                        </span>
                      ) : '-'}
                    </td>
                    <td>{tampil(item.jns_tagihan)}</td>
                    <td>{tampil(item.siklus)}</td>
                    <td>{formatTanggal(item.tgl_aktif)}</td>
                    <td>{formatTanggal(item.tgl_isolir)}</td>
                    <td>{item.username}</td>
                    <td className="password-cell">
                      <span className="pwd-masked">••••••••</span>
                      <span className="pwd-revealed">{item.password || '-'}</span>
                    </td>
                    <td>
                      {ipHref(item.ip_address) ? (
                        <a className="data-ip" href={ipHref(item.ip_address)} target="_blank" rel="noreferrer">
                          {item.ip_address}
                          <ExternalLink size={14} />
                        </a>
                      ) : tampil(item.ip_address)}
                    </td>
                    <td>{tampil(item.mac_address)}</td>
                    <td>{tampil(item.router)}</td>
                    <td>{tampil(item.server)}</td>
                    <td>{tampil(item.acs)}</td>
                    <td>{tampil(item.addr_list)}</td>
                    <td>{tampil(item.wilayah)}</td>
                    <td>{tampil(item.alamat_pasang)}</td>
                    <td>{formatTanggal(item.tgl_pasang)}</td>
                    <td>{tampil(item.mitra)}</td>
                    <td>{tampil(item.kode_unik)}</td>
                    <td>
                      <button type="button" className="data-note" aria-label={`Edit ${item.pelanggan}`} onClick={() => openEdit(item)}>
                        <Pencil size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && (
          <div className="stok-foot">
            <p className="stok-info">Showing {showingStart} to {showingEnd} of {totalData} entries</p>
            <nav className="stok-pages" aria-label="Navigasi halaman data langganan">
              <button type="button" className="stok-nav" disabled={page <= 1} onClick={() => setCurrentPage(page - 1)}>Previous</button>
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
              <button type="button" className="stok-nav" disabled={page >= totalPages} onClick={() => setCurrentPage(page + 1)}>Next</button>
            </nav>
          </div>
        )}
      </div>

      {isModalOpen && (
        <div className="data-backdrop" onMouseDown={closeModal}>
          <form className="data-modal" onSubmit={handleSave} onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-modal-head">
              <div>
                <p>Langganan</p>
                <h2>{editingId ? 'Edit Data Langganan' : 'Tambah Data Langganan'}</h2>
              </div>
              <button type="button" className="data-close" onClick={closeModal} aria-label="Tutup">
                <X size={18} />
              </button>
            </header>
            <div className="data-form-grid">
              <label>No Layanan<input type="text" inputMode="numeric" pattern="[0-9]*" value={form.nolayanan} onChange={(event) => updateForm('nolayanan', event.target.value.replace(/\D/g, ''))} /></label>
              <label>Pelanggan<input value={form.pelanggan} onChange={(event) => updateForm('pelanggan', event.target.value)} required /></label>
              <label>KTG<input value={form.ktg} onChange={(event) => updateForm('ktg', event.target.value)} /></label>
              <label>
                Media/Tipe
                <select value={form.media_tipe} onChange={(event) => updateForm('media_tipe', event.target.value)}>
                  {['Fiber Optic', 'Wireless', 'LAN', 'Radio'].map((name) => <option key={name}>{name}</option>)}
                </select>
              </label>
              <label>
                Profile
                <select value={form.profil_id} onChange={(event) => updateForm('profil_id', event.target.value)}>
                  <option value="">- Pilih Profile -</option>
                  {profiles.map((item) => (
                    <option key={item.id} value={item.id}>{item.nama_profile}</option>
                  ))}
                </select>
              </label>
              <label>
                Jenis Tagihan
                <select value={form.jns_tagihan} onChange={(event) => updateForm('jns_tagihan', event.target.value)}>
                  <option>PRABAYAR</option>
                  <option>PASCABAYAR</option>
                </select>
              </label>
              <label>
                Siklus
                <select value={form.siklus} onChange={(event) => updateForm('siklus', event.target.value)}>
                  <option>BULAN</option>
                  <option>HARI</option>
                </select>
              </label>
              <label>
                Status
                <select value={form.status} onChange={(event) => updateForm('status', event.target.value)}>
                  <option>Aktif</option>
                  <option>Non Aktif</option>
                  <option>Isolir</option>
                </select>
              </label>
              <label>Tgl Aktif<input type="date" value={form.tgl_aktif} onChange={(event) => updateForm('tgl_aktif', event.target.value)} /></label>
              <label>Tgl Isolir<input type="datetime-local" value={form.tgl_isolir} onChange={(event) => updateForm('tgl_isolir', event.target.value)} /></label>
              <label>Username<input value={form.username} onChange={(event) => updateForm('username', event.target.value)} required /></label>
              <label>Password<input value={form.password} onChange={(event) => updateForm('password', event.target.value)} /></label>
              <label>IP Address<input value={form.ip_address} onChange={(event) => updateForm('ip_address', event.target.value)} placeholder="10.0.0.2" /></label>
              <label>MAC Address<input value={form.mac_address} onChange={(event) => updateForm('mac_address', event.target.value)} /></label>
              <label>Router<input value={form.router} onChange={(event) => updateForm('router', event.target.value)} /></label>
              <label>Server<input value={form.server} onChange={(event) => updateForm('server', event.target.value)} /></label>
              <label>Addr List<input value={form.addr_list} onChange={(event) => updateForm('addr_list', event.target.value)} /></label>
              <label>Wilayah<input value={form.wilayah} onChange={(event) => updateForm('wilayah', event.target.value)} /></label>
              <label>Alamat Pasang<input value={form.alamat_pasang} onChange={(event) => updateForm('alamat_pasang', event.target.value)} /></label>
              <label>Tgl Pasang<input type="date" value={form.tgl_pasang} onChange={(event) => updateForm('tgl_pasang', event.target.value)} /></label>
              <label className="data-note-field">Note<textarea value={form.note} onChange={(event) => updateForm('note', event.target.value)} rows="2" /></label>
            </div>
            <div className="data-modal-actions">
              <button type="button" className="data-btn data-btn-gray" onClick={closeModal} disabled={saving}>Batal</button>
              <button type="submit" className="data-btn data-btn-blue" disabled={saving}>Simpan</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

export default LanggananData
