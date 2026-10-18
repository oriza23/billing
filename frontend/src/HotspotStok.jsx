import { useEffect, useState } from 'react'
import axios from 'axios'
import Swal from 'sweetalert2'
import {
  Banknote,
  Calendar,
  FileClock,
  HandCoins,
  Menu,
  Package,
  Printer,
  Search,
  Settings,
  Store,
  TicketPlus,
  Trash,
  UserPlus,
  Wallet,
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
  const [vouchers, setVouchers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mikrotikGroup, setMikrotikGroup] = useState('')
  const [jumlah, setJumlah] = useState(10)
  const [prefix, setPrefix] = useState('')
  const [panjang, setPanjang] = useState(6)
  const [jenisVoucher, setJenisVoucher] = useState('username=password')
  const [kodeKombinasi, setKodeKombinasi] = useState('huruf-kecil')
  const [saving, setSaving] = useState(false)
  const [selectedVouchers, setSelectedVouchers] = useState([])
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isModalBuatVcOpen, setIsModalBuatVcOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)

  async function fetchVouchers() {
    const response = await axios.get('http://192.168.69.70:5000/api/hotspot/voucher')
    setVouchers(Array.isArray(response.data) ? response.data : [])
    setError('')
  }

  useEffect(() => {
    let ignore = false

    async function loadData() {
      try {
        const [profilResponse, voucherResponse] = await Promise.all([
          axios.get('http://192.168.69.70:5000/api/hotspot/profil'),
          axios.get('http://192.168.69.70:5000/api/hotspot/voucher'),
        ])
        if (ignore) {
          return
        }

        const profiles = Array.isArray(profilResponse.data) ? profilResponse.data : []
        setDaftarProfil(profiles)
        setMikrotikGroup((current) => current || profiles[0]?.mikrotik_group || '')
        setVouchers(Array.isArray(voucherResponse.data) ? voucherResponse.data : [])
        setError('')
      } catch {
        if (!ignore) {
          setError('Gagal memuat data voucher.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    loadData()

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

  const searchLower = searchTerm.toLowerCase()
  const filteredVouchers = vouchers.filter((voucher) => (
    (voucher.kode_batch || '').toLowerCase().includes(searchLower)
    || (voucher.username || '').toLowerCase().includes(searchLower)
    || (voucher.profile || '').toLowerCase().includes(searchLower)
    || (voucher.router || '').toLowerCase().includes(searchLower)
    || (voucher.server || '').toLowerCase().includes(searchLower)
    || (voucher.mitra || '').toLowerCase().includes(searchLower)
    || (voucher.outlet || '').toLowerCase().includes(searchLower)
  ))
  const totalData = filteredVouchers.length
  const totalPages = Math.max(1, Math.ceil(totalData / itemsPerPage))
  const page = Math.min(currentPage, totalPages)
  const indexOfLastItem = page * itemsPerPage
  const indexOfFirstItem = indexOfLastItem - itemsPerPage
  const currentItems = filteredVouchers.slice(indexOfFirstItem, indexOfLastItem)
  const showingStart = totalData === 0 ? 0 : indexOfFirstItem + 1
  const showingEnd = Math.min(indexOfLastItem, totalData)
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)
  const allSelected = currentItems.length > 0
    && currentItems.every((item) => selectedVouchers.includes(item.username))

  function toggleRow(username) {
    setSelectedVouchers((current) => (
      current.includes(username)
        ? current.filter((item) => item !== username)
        : [...current, username]
    ))
  }

  function toggleAll() {
    const visibleUsernames = currentItems.map((item) => item.username)
    if (visibleUsernames.length === 0) {
      return
    }
    if (visibleUsernames.every((username) => selectedVouchers.includes(username))) {
      setSelectedVouchers((current) => current.filter((username) => !visibleUsernames.includes(username)))
      return
    }
    setSelectedVouchers((current) => [...new Set([...current, ...visibleUsernames])])
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
    const dataPrint = vouchers
      .filter((item) => selectedVouchers.includes(item.username))
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

    const selectedRows = vouchers.filter((item) => selectedVouchers.includes(item.username))
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
      await axios.post('http://192.168.69.70:5000/api/hotspot/voucher/delete-massal', {
        usernames: selectedVouchers,
      })
      setIsMenuOpen(false)
      setSelectedVouchers([])
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

    const adminName = localStorage.getItem('admin_user') || 'System'
    const payload = {
      router: 'ALL ROUTER',
      server: 'ALL SERVER',
      jenis_voucher: jenisVoucher,
      kode_kombinasi: kodeKombinasi,
      prefix: prefix.trim(),
      outlet: '-Pilih-',
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

    setIsModalBuatVcOpen(false)
    Swal.fire({
      title: 'Membuat voucher...',
      text: 'Mohon tunggu sebentar.',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading()
      },
    })

    setSaving(true)
    try {
      await axios.post('http://192.168.69.70:5000/api/hotspot/voucher/generate', payload)
      await fetchVouchers()
      notifySuccess('Voucher berhasil dibuat')
    } catch (requestError) {
      Swal.fire({
        icon: 'error',
        title: 'Gagal',
        text: requestError.response?.data?.message || 'Gagal membuat voucher.',
      })
    } finally {
      setSaving(false)
    }
  }

  const selectedProfile = daftarProfil.find((item) => item.mikrotik_group === mikrotikGroup)
  const hargaJual = Number(selectedProfile?.harga_jual) || 0
  const komisi = Number(selectedProfile?.komisi_reseller) || 0
  const hargaPokok = Number.isFinite(Number(selectedProfile?.hpp))
    ? Number(selectedProfile.hpp)
    : hargaJual - komisi
  const jumlahVoucher = Math.max(0, Number(jumlah) || 0)
  const totalStok = filteredVouchers.length
  const totalHpp = sumColumn(filteredVouchers, 'hpp')
  const totalKomisi = sumColumn(filteredVouchers, 'komisi')
  const totalHarga = sumColumn(filteredVouchers, 'harga')
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
          <span>{loading ? 'Memuat...' : `${filteredVouchers.length} voucher`}</span>
        </div>

        {loading && <p className="stok-status">Memuat data voucher...</p>}
        {error && <p className="stok-status stok-error">{error}</p>}

        {!loading && !error && (
          <div className="stok-table-wrap">
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
                  currentItems.map((item, index) => (
                    <tr
                      key={`${item.username}-${index}`}
                      className={selectedVouchers.includes(item.username) ? 'is-selected' : undefined}
                    >
                      <td className="stok-check">
                        <input
                          type="checkbox"
                          aria-label={`Pilih ${item.username}`}
                          checked={selectedVouchers.includes(item.username)}
                          onChange={() => toggleRow(item.username)}
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
          <div className="stok-foot">
            <p className="stok-info">
              Showing {showingStart} to {showingEnd} of {totalData} entries
            </p>
            <nav className="stok-pages" aria-label="Navigasi halaman">
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

      {isModalBuatVcOpen && (
        <div className="stok-backdrop" onMouseDown={() => { if (!saving) setIsModalBuatVcOpen(false) }}>
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
                    <input type="text" value="ALL ROUTER" readOnly />
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
                    <select defaultValue="">
                      <option value="">-Pilih-</option>
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
                      max="500"
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
                  onClick={() => setIsModalBuatVcOpen(false)}
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
    </section>
  )
}

export default HotspotStok
