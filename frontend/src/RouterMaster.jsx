import { useEffect, useState } from 'react'
import api from './api/axios.js'
import Swal from 'sweetalert2'
import { fireError, fireSuccess } from './swals.js'
import './PppoeProfil.css'
import './RouterMaster.css'
import { jenisDariLayanan, layananDariJenis } from './serverJenis.js'

const API_URL = '/routers'
const SERVER_URL = '/routers/servers'
const LAYANAN_OPTIONS = [
  { key: 'hotspot', label: 'Hotspot', hint: 'IP > Hotspot > Servers' },
  { key: 'pppoe', label: 'PPPoE', hint: 'PPP > PPPoE Servers' },
]

const MODAL_OVERLAY =
  'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm'
const MODAL_CARD =
  'max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900'

const emptyServerForm = { routerId: '', hotspot: false, pppoe: false, nama: '' }

function ServerBadges({ jenis }) {
  const layanan = layananDariJenis(jenis)
  if (layanan.length === 0) {
    return <span>{jenis || '-'}</span>
  }
  return (
    <span className="server-badges">
      {layanan.includes('hotspot') && <span className="server-badge server-badge-hotspot">Hotspot</span>}
      {layanan.includes('pppoe') && <span className="server-badge server-badge-pppoe">PPPoE</span>}
    </span>
  )
}

// Checkbox Jenis Server: satu server boleh melayani Hotspot, PPPoE, atau keduanya.
function JenisServerField({ value, onChange, disabled }) {
  const noneSelected = !value.hotspot && !value.pppoe
  return (
    <fieldset className="server-jenis" disabled={disabled}>
      <legend>Jenis Server</legend>
      <div className="server-jenis-options">
        {LAYANAN_OPTIONS.map((option) => (
          <label
            key={option.key}
            className={`server-jenis-option${value[option.key] ? ' is-checked' : ''}`}
          >
            <input
              type="checkbox"
              name={`jenis_${option.key}`}
              checked={value[option.key]}
              onChange={(event) => onChange(option.key, event.target.checked)}
            />
            <span className="server-jenis-text">
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </div>
      {noneSelected && (
        <p className="server-jenis-error" role="alert">Pilih minimal satu layanan (Hotspot atau PPPoE).</p>
      )}
    </fieldset>
  )
}

// Label & placeholder kolom nama mengikuti layanan yang dipilih.
function serverNameLabels({ hotspot, pppoe }) {
  if (hotspot && pppoe) {
    return {
      label: 'Nama Server / Service Name',
      placeholder: 'Sama dengan nama server Hotspot dan Service Name PPPoE di MikroTik',
    }
  }
  if (pppoe) {
    return { label: 'Service Name', placeholder: 'Sama dengan PPP > PPPoE Servers > Service Name' }
  }
  return { label: 'Nama Server', placeholder: 'Sama dengan IP > Hotspot > Servers > Name' }
}

const emptyForm = {
  namaRouter: '',
  ipAddress: '',
  secret: '',
  deskripsi: '',
}

function RouterMaster() {
  const [routers, setRouters] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [servers, setServers] = useState([])
  const [serverForm, setServerForm] = useState(emptyServerForm)
  const [serverSaving, setServerSaving] = useState(false)
  const [deletingServerId, setDeletingServerId] = useState(null)
  const [isRouterModalOpen, setIsRouterModalOpen] = useState(false)
  const [isServerModalOpen, setIsServerModalOpen] = useState(false)
  const [isEditServerModalOpen, setIsEditServerModalOpen] = useState(false)
  const [editServerData, setEditServerData] = useState(null)

  async function fetchRouters() {
    const response = await api.get(API_URL)
    setRouters(Array.isArray(response.data) ? response.data : [])
    setError('')
  }

  async function fetchServers() {
    const response = await api.get(SERVER_URL)
    setServers(Array.isArray(response.data) ? response.data : [])
  }

  useEffect(() => {
    let ignore = false

    async function loadRouters() {
      try {
        const [response, serverResponse] = await Promise.all([
          api.get(API_URL),
          api.get(SERVER_URL),
        ])
        if (!ignore) {
          setRouters(Array.isArray(response.data) ? response.data : [])
          setServers(Array.isArray(serverResponse.data) ? serverResponse.data : [])
          setError('')
        }
      } catch {
        if (!ignore) {
          setError('Gagal memuat data router.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    loadRouters()

    return () => {
      ignore = true
    }
  }, [])

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function resetForm() {
    setEditMode(false)
    setSelectedId(null)
    setForm(emptyForm)
  }

  function closeRouterModal() {
    resetForm()
    setIsRouterModalOpen(false)
  }

  function handleEdit(item) {
    setEditMode(true)
    setSelectedId(item.id)
    setForm({
      namaRouter: item.nama_router || '',
      ipAddress: item.ip_address || '',
      secret: item.secret || '',
      deskripsi: item.deskripsi || '',
    })
    setIsRouterModalOpen(true)
  }

  function notifySuccess(text, refresh) {
    return fireSuccess({ title: 'Berhasil!', text }, refresh)
  }

  // Setelah router disimpan/dihapus, backend menyinkronkannya ke tabel `nas` FreeRADIUS.
  // FreeRADIUS baru membaca tabel itu saat start, jadi beri tahu bila perlu restart manual.
  function notifySaved(responseData, refresh) {
    const sync = responseData?.radius_sync
    if (sync && sync.ok === false) {
      return fireSuccess({
        icon: 'warning',
        title: 'Router tersimpan',
        text: 'Namun sinkronisasi ke FreeRADIUS (tabel nas) gagal. Periksa log server.',
      }, refresh)
    }
    if (sync?.reload === 'manual') {
      return fireSuccess({
        icon: 'info',
        title: 'Router tersimpan',
        text: 'Router sudah masuk tabel NAS FreeRADIUS. Restart FreeRADIUS (systemctl restart freeradius) agar router ini dikenali.',
      }, refresh)
    }
    return notifySuccess('Data sukses diperbarui', refresh)
  }

  function notifyError(errorResponse, fallback) {
    return fireError({
      title: 'Gagal',
      text: errorResponse?.response?.data?.message || fallback,
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()

    const result = await Swal.fire({
      title: 'Simpan Data?',
      text: 'Yakin ingin menyimpan data ini?',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Ya, Simpan!',
      cancelButtonText: 'Batal',
    })
    if (!result.isConfirmed) {
      return
    }

    const payload = {
      nama_router: form.namaRouter.trim(),
      ip_address: form.ipAddress.trim(),
      secret: form.secret.trim(),
      deskripsi: form.deskripsi.trim(),
    }

    setSaving(true)
    try {
      const { data: saved } = editMode
        ? await api.put(`${API_URL}/${selectedId}`, payload)
        : await api.post(API_URL, payload)
      resetForm()
      setIsRouterModalOpen(false)
      await notifySaved(saved, () => { void fetchRouters() })
    } catch (requestError) {
      notifyError(requestError, editMode ? 'Gagal menyimpan perubahan.' : 'Gagal menyimpan router.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(item) {
    const result = await Swal.fire({
      title: 'Apakah Anda yakin?',
      text: 'Data ini akan dihapus permanen!',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, Hapus!',
      cancelButtonText: 'Batal',
    })
    if (!result.isConfirmed) {
      return
    }

    setDeletingId(item.id)
    try {
      const { data: removed } = await api.delete(`${API_URL}/${item.id}`)
      if (selectedId === item.id) {
        resetForm()
        setIsRouterModalOpen(false)
      }
      await notifySaved(removed, () => { void Promise.all([fetchRouters(), fetchServers()]) })
    } catch (requestError) {
      notifyError(requestError, 'Gagal menghapus router.')
    } finally {
      setDeletingId(null)
    }
  }

  function updateServerField(key, value) {
    setServerForm((current) => ({ ...current, [key]: value }))
  }

  function updateServerLayanan(key, checked) {
    setServerForm((current) => ({ ...current, [key]: checked }))
  }

  function updateEditServerLayanan(key, checked) {
    setEditServerData((current) => (current ? { ...current, [key]: checked } : current))
  }

  function updateEditServerField(key, value) {
    setEditServerData((current) => (current ? { ...current, [key]: value } : current))
  }

  function closeEditServerModal() {
    setIsEditServerModalOpen(false)
    setEditServerData(null)
  }

  function openEditServerModal(item) {
    setEditServerData({
      id: item.id,
      routerId: String(item.router_id ?? ''),
      hotspot: layananDariJenis(item.jenis).includes('hotspot'),
      pppoe: layananDariJenis(item.jenis).includes('pppoe'),
      nama: item.nama || '',
    })
    setIsEditServerModalOpen(true)
  }

  async function handleServerSubmit(event) {
    event.preventDefault()

    const nama = serverForm.nama.trim()
    const jenis = jenisDariLayanan(serverForm)
    if (!serverForm.routerId || !jenis || !nama) {
      Swal.fire({
        icon: 'warning',
        title: 'Data belum lengkap',
        text: 'Pilih router, minimal satu jenis server, dan isi nama server.',
      })
      return
    }

    setServerSaving(true)
    try {
      await api.post(`${API_URL}/${serverForm.routerId}/servers`, {
        jenis,
        nama,
      })
      // Router dan jenis dipertahankan supaya beberapa server bisa diinput berurutan.
      setServerForm((current) => ({ ...current, nama: '' }))
      await notifySuccess('Server berhasil disimpan', () => { void fetchServers() })
    } catch (requestError) {
      notifyError(requestError, 'Gagal menyimpan server.')
    } finally {
      setServerSaving(false)
    }
  }

  async function handleEditServerSubmit(event) {
    event.preventDefault()
    if (!editServerData?.id) {
      return
    }

    const nama = String(editServerData.nama || '').trim()
    const jenis = jenisDariLayanan(editServerData)
    if (!editServerData.routerId || !jenis || !nama) {
      Swal.fire({
        icon: 'warning',
        title: 'Data belum lengkap',
        text: 'Pilih router, minimal satu jenis server, dan isi nama server.',
      })
      return
    }

    setServerSaving(true)
    try {
      await api.put(`${SERVER_URL}/${editServerData.id}`, {
        router_id: editServerData.routerId,
        jenis,
        nama,
      })
      closeEditServerModal()
      await notifySuccess('Server berhasil diperbarui', () => { void fetchServers() })
    } catch (requestError) {
      notifyError(requestError, 'Gagal menyimpan perubahan server.')
    } finally {
      setServerSaving(false)
    }
  }

  async function handleServerDelete(item) {
    const result = await Swal.fire({
      title: 'Hapus server?',
      text: `Server "${item.nama}" hilang dari pilihan Buat VC dan registrasi pelanggan. Voucher dan pelanggan yang sudah memakainya tidak berubah.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, Hapus!',
      cancelButtonText: 'Batal',
    })
    if (!result.isConfirmed) {
      return
    }

    setDeletingServerId(item.id)
    try {
      await api.delete(`${SERVER_URL}/${item.id}`)
      await notifySuccess('Server berhasil dihapus', () => { void fetchServers() })
    } catch (requestError) {
      notifyError(requestError, 'Gagal menghapus server.')
    } finally {
      setDeletingServerId(null)
    }
  }

  return (
    <section className="profil router-page">
      <header className="profil-header">
        <p>Infrastruktur</p>
        <h1>Manajemen Router</h1>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="m-0 text-xs font-bold tracking-wider text-cyan-700 uppercase">Data</p>
          <h2 className="m-0 text-xl font-bold text-slate-900 dark:text-gray-100">Router &amp; Server</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-cyan-600 bg-cyan-600 px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-cyan-700"
            onClick={() => {
              resetForm()
              setIsRouterModalOpen(true)
            }}
          >
            + Tambah Router
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-violet-600 bg-violet-600 px-4 text-sm font-bold text-white shadow-sm transition-colors hover:border-violet-700 hover:bg-violet-700 dark:border-violet-500 dark:bg-violet-600 dark:hover:bg-violet-500"
            onClick={() => setIsServerModalOpen(true)}
          >
            + Tambah Server
          </button>
        </div>
      </div>

      <h3 className="mb-4 text-lg font-bold text-slate-800 dark:text-gray-100">Tabel Data Router</h3>
      <div className="profil-card">
        {loading && <p className="profil-status">Memuat data router...</p>}
        {error && <p className="profil-status profil-error">{error}</p>}

        {!loading && !error && (
          <div className="profil-table-wrap">
            <table className="profil-table">
              <thead>
                <tr>
                  <th>No</th>
                  <th>Nama Router</th>
                  <th>IP Address</th>
                  <th>Secret</th>
                  <th>Deskripsi</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {routers.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="profil-empty">
                      Belum ada router.
                    </td>
                  </tr>
                ) : (
                  routers.map((item, index) => (
                    <tr
                      key={item.id}
                      className={selectedId === item.id ? 'is-editing' : undefined}
                    >
                      <td>{index + 1}</td>
                      <td>{item.nama_router}</td>
                      <td>{item.ip_address}</td>
                      <td className="password-cell">
                        <span className="pwd-masked">••••••••</span>
                        <span className="pwd-revealed">{item.secret}</span>
                      </td>
                      <td>{item.deskripsi || '-'}</td>
                      <td>
                        <span className="router-status">{item.status || 'Aktif'}</span>
                      </td>
                      <td>
                        <div className="profil-actions">
                          <button
                            type="button"
                            className="profil-edit"
                            onClick={() => handleEdit(item)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="profil-delete"
                            onClick={() => handleDelete(item)}
                            disabled={deletingId === item.id}
                          >
                            {deletingId === item.id ? 'Menghapus...' : 'Hapus'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h3 className="mb-4 mt-8 text-lg font-bold text-slate-800 dark:text-gray-100">Tabel Data Server</h3>
      <div className="profil-card">
        {!loading && !error && (
          <div className="profil-table-wrap">
            <table className="profil-table">
              <thead>
                <tr>
                  <th>No</th>
                  <th>Router</th>
                  <th>Jenis</th>
                  <th>Nama Server</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {servers.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="profil-empty">
                      Belum ada server.
                    </td>
                  </tr>
                ) : (
                  servers.map((item, index) => (
                    <tr key={item.id}>
                      <td>{index + 1}</td>
                      <td>{item.nama_router}</td>
                      <td><ServerBadges jenis={item.jenis} /></td>
                      <td>{item.nama}</td>
                      <td>
                        <div className="profil-actions">
                          <button
                            type="button"
                            className="profil-edit"
                            onClick={() => openEditServerModal(item)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="profil-delete"
                            onClick={() => handleServerDelete(item)}
                            disabled={deletingServerId === item.id}
                          >
                            {deletingServerId === item.id ? 'Menghapus...' : 'Hapus'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isRouterModalOpen && (
        <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-labelledby="router-modal-title">
          <div className={MODAL_CARD}>
            <form className="profil-form router-page" onSubmit={handleSubmit}>
              <div className="profil-form-heading">
                <p>{editMode ? 'Ubah data' : 'Router baru'}</p>
                <h2 id="router-modal-title">{editMode ? 'Edit Router' : 'Tambah Router'}</h2>
              </div>

              <div className="profil-form-fields">
                <label className="profil-field">
                  <span>Nama Router</span>
                  <input
                    type="text"
                    name="nama_router"
                    placeholder="Nama router"
                    value={form.namaRouter}
                    onChange={(event) => updateField('namaRouter', event.target.value)}
                    required
                  />
                </label>

                <label className="profil-field">
                  <span>IP Address</span>
                  <input
                    type="text"
                    name="ip_address"
                    placeholder="192.168.88.1"
                    value={form.ipAddress}
                    onChange={(event) => updateField('ipAddress', event.target.value)}
                    required
                  />
                </label>

                <label className="profil-field">
                  <span>Secret RADIUS</span>
                  <input
                    type="password"
                    name="secret"
                    maxLength={60}
                    placeholder="Secret RADIUS"
                    value={form.secret}
                    onChange={(event) => updateField('secret', event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>

                <label className="profil-field">
                  <span>Deskripsi</span>
                  <input
                    type="text"
                    name="deskripsi"
                    placeholder="Keterangan router"
                    value={form.deskripsi}
                    onChange={(event) => updateField('deskripsi', event.target.value)}
                  />
                </label>
              </div>

              <div className="profil-form-actions">
                <button className="profil-cancel" type="button" onClick={closeRouterModal} disabled={saving}>
                  Batal
                </button>
                <button className="profil-save" type="submit" disabled={saving}>
                  {saving ? 'Menyimpan...' : editMode ? 'Simpan Perubahan' : 'Simpan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isEditServerModalOpen && editServerData && (
        <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-labelledby="edit-server-modal-title">
          <div className={MODAL_CARD}>
            <form className="profil-form router-page" onSubmit={handleEditServerSubmit}>
              <div className="profil-form-heading">
                <p>Ubah server</p>
                <h2 id="edit-server-modal-title">Edit Server</h2>
              </div>

              <div className="profil-form-fields">
                <label className="profil-field">
                  <span>Router</span>
                  <select
                    name="router_id"
                    value={editServerData.routerId}
                    onChange={(event) => updateEditServerField('routerId', event.target.value)}
                  >
                    <option value="">-Pilih-</option>
                    {routers.map((routerItem) => (
                      <option key={routerItem.id} value={routerItem.id}>{routerItem.nama_router}</option>
                    ))}
                  </select>
                </label>

                <JenisServerField
                  value={editServerData}
                  onChange={updateEditServerLayanan}
                  disabled={serverSaving}
                />

                <label className="profil-field">
                  <span>{serverNameLabels(editServerData).label}</span>
                  <input
                    type="text"
                    name="nama"
                    maxLength="100"
                    placeholder={serverNameLabels(editServerData).placeholder}
                    value={editServerData.nama}
                    onChange={(event) => updateEditServerField('nama', event.target.value)}
                  />
                </label>
              </div>

              <p className="server-hint">
                Isi persis seperti di MikroTik (huruf besar kecil dibedakan). Hotspot: IP &gt; Hotspot &gt; Servers &gt; Name.
                PPPoE: PPP &gt; PPPoE Servers &gt; Service Name. Bila keduanya dicentang, nama di MikroTik harus sama untuk
                Hotspot dan PPPoE. Pilihan &quot;ALL SERVER&quot; selalu tersedia di form lain.
              </p>

              <div className="profil-form-actions">
                <button
                  className="profil-cancel"
                  type="button"
                  onClick={closeEditServerModal}
                  disabled={serverSaving}
                >
                  Batal
                </button>
                <button
                  className="profil-save"
                  type="submit"
                  disabled={serverSaving || !jenisDariLayanan(editServerData)}
                >
                  {serverSaving ? 'Menyimpan...' : 'Simpan Perubahan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isServerModalOpen && (
        <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-labelledby="server-modal-title">
          <div className={MODAL_CARD}>
            <form className="profil-form router-page" onSubmit={handleServerSubmit}>
              <div className="profil-form-heading">
                <p>Server per router</p>
                <h2 id="server-modal-title">Tambah Server</h2>
              </div>

              <div className="profil-form-fields">
                <label className="profil-field">
                  <span>Router</span>
                  <select
                    name="router_id"
                    value={serverForm.routerId}
                    onChange={(event) => updateServerField('routerId', event.target.value)}
                  >
                    <option value="">-Pilih-</option>
                    {routers.map((item) => (
                      <option key={item.id} value={item.id}>{item.nama_router}</option>
                    ))}
                  </select>
                </label>

                <JenisServerField
                  value={serverForm}
                  onChange={updateServerLayanan}
                  disabled={serverSaving}
                />

                <label className="profil-field">
                  <span>{serverNameLabels(serverForm).label}</span>
                  <input
                    type="text"
                    name="nama"
                    maxLength="100"
                    placeholder={serverNameLabels(serverForm).placeholder}
                    value={serverForm.nama}
                    onChange={(event) => updateServerField('nama', event.target.value)}
                  />
                </label>
              </div>

              <p className="server-hint">
                Isi persis seperti di MikroTik (huruf besar kecil dibedakan). Hotspot: IP &gt; Hotspot &gt; Servers &gt; Name.
                PPPoE: PPP &gt; PPPoE Servers &gt; Service Name. Bila keduanya dicentang, nama di MikroTik harus sama untuk
                Hotspot dan PPPoE. Pilihan &quot;ALL SERVER&quot; selalu tersedia di form lain.
              </p>

              <div className="profil-form-actions">
                <button
                  className="profil-cancel"
                  type="button"
                  onClick={() => setIsServerModalOpen(false)}
                  disabled={serverSaving}
                >
                  Batal
                </button>
                <button
                  className="profil-save"
                  type="submit"
                  disabled={serverSaving || !jenisDariLayanan(serverForm)}
                >
                  {serverSaving ? 'Menyimpan...' : 'Simpan Server'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}

export default RouterMaster
