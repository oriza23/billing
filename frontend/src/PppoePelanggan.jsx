import { useEffect, useState } from 'react'
import api from './api/axios.js'
import Swal from 'sweetalert2'
import { fireSuccess } from './swals.js'
import './PppoePelanggan.css'

function PppoePelanggan() {
  const [pelanggan, setPelanggan] = useState([])
  const [daftarProfil, setDaftarProfil] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [paket, setPaket] = useState('')
  const [daftarRouter, setDaftarRouter] = useState([])
  const [daftarServer, setDaftarServer] = useState([])
  const [routerPilih, setRouterPilih] = useState('ALL ROUTER')
  const [serverPilih, setServerPilih] = useState('ALL SERVER')
  const [saving, setSaving] = useState(false)
  const [deletingUsername, setDeletingUsername] = useState('')
  const [formError, setFormError] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [selectedUsername, setSelectedUsername] = useState('')

  async function fetchPelanggan() {
    const response = await api.get('/pppoe/pelanggan')
    setPelanggan(Array.isArray(response.data) ? response.data : [])
    setError('')
  }

  useEffect(() => {
    let ignore = false

    async function loadPelanggan() {
      try {
        const response = await api.get('/pppoe/pelanggan')
        if (!ignore) {
          setPelanggan(Array.isArray(response.data) ? response.data : [])
          setError('')
        }
      } catch {
        if (!ignore) {
          setError('Gagal memuat data pelanggan.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    loadPelanggan()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    let ignore = false

    async function loadProfil() {
      try {
        const response = await api.get('/pppoe/profil')
        if (ignore) {
          return
        }

        const rows = Array.isArray(response.data) ? response.data : []
        setDaftarProfil(rows)
        setPaket((current) => {
          if (rows.some((item) => item.groupname === current)) {
            return current
          }
          return rows[0]?.groupname || ''
        })
      } catch {
        if (!ignore) {
          setFormError('Gagal memuat daftar profil.')
        }
      }
    }

    loadProfil()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    let ignore = false
    Promise.all([api.get('/routers'), api.get('/routers/servers', { params: { jenis: 'pppoe' } })])
      .then(([routersRes, serversRes]) => {
        if (ignore) return
        setDaftarRouter(Array.isArray(routersRes.data) ? routersRes.data : [])
        setDaftarServer(Array.isArray(serversRes.data) ? serversRes.data : [])
      })
      .catch(() => {
        if (!ignore) setFormError('Gagal memuat daftar router/server.')
      })
    return () => { ignore = true }
  }, [])

  // Server yang bisa dipilih: milik router terpilih, atau semua server bila ALL ROUTER.
  const serverOptions = daftarServer
    .filter((item) => routerPilih === 'ALL ROUTER' || item.nama_router === routerPilih)
    .map((item) => item.nama)
  const serverUnik = [...new Set(serverOptions)]

  function resetForm() {
    setEditMode(false)
    setSelectedUsername('')
    setUsername('')
    setPassword('')
    setPaket(daftarProfil[0]?.groupname || '')
    setRouterPilih('ALL ROUTER')
    setServerPilih('ALL SERVER')
  }

  function handleEdit(item) {
    setEditMode(true)
    setSelectedUsername(item.username)
    setUsername(item.username)
    setPassword(item.password)
    setPaket(item.paket || daftarProfil[0]?.groupname || '')
    setRouterPilih(item.router || 'ALL ROUTER')
    setServerPilih(item.server || 'ALL SERVER')
    setFormError('')
  }

  function notifySuccess(refresh) {
    return fireSuccess({ title: 'Berhasil!', text: 'Data sukses diperbarui' }, refresh)
  }

  async function handleDelete(targetUsername) {
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

    setDeletingUsername(targetUsername)
    setFormError('')

    try {
      await api.delete(
        `/pppoe/pelanggan/${encodeURIComponent(targetUsername)}`,
      )
      if (selectedUsername === targetUsername) {
        resetForm()
      }
      await notifySuccess(() => { void fetchPelanggan() })
    } catch {
      setFormError('Gagal menghapus pelanggan.')
    } finally {
      setDeletingUsername('')
    }
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

    setSaving(true)
    setFormError('')

    try {
      if (editMode) {
        await api.put(
          `/pppoe/pelanggan/${encodeURIComponent(selectedUsername)}`,
          { password, paket, router: routerPilih, server: serverPilih },
        )
      } else {
        await api.post('/pppoe/pelanggan', {
          username,
          password,
          paket,
          router: routerPilih,
          server: serverPilih,
        })
      }
      resetForm()
      await notifySuccess(() => { void fetchPelanggan() })
    } catch (error) {
      setFormError(
        (editMode ? 'Gagal menyimpan perubahan.' : 'Gagal menyimpan pelanggan.')
        + ' ' + (error?.response?.data?.message || ''),
      ).trim()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="pelanggan">
      <header className="pelanggan-header">
        <p>Data RADIUS</p>
        <h1>Data Langganan</h1>
      </header>

      <form className="pelanggan-form" onSubmit={handleSubmit}>
        <div className="pelanggan-form-heading">
          <p>{editMode ? 'Ubah data' : 'Pelanggan baru'}</p>
          <h2>{editMode ? 'Edit Pelanggan' : 'Tambah Pelanggan'}</h2>
        </div>

        <div className="pelanggan-form-fields">
          <label className="pelanggan-field">
            <span>Username</span>
            <input
              type="text"
              name="username"
              placeholder="Username pelanggan"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={editMode}
              required
            />
          </label>

          <label className="pelanggan-field">
            <span>Password</span>
            <input
              type="text"
              name="password"
              placeholder="Password pelanggan"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <label className="pelanggan-field">
            <span>Paket Kecepatan</span>
            <select
              name="paket"
              value={paket}
              onChange={(event) => setPaket(event.target.value)}
              required
            >
              {paket && !daftarProfil.some((item) => item.groupname === paket) && (
                <option value={paket}>{paket}</option>
              )}
              {daftarProfil.map((item) => (
                <option key={item.groupname} value={item.groupname}>
                  {item.groupname}
                </option>
              ))}
            </select>
          </label>

          <label className="pelanggan-field">
            <span>Router (NAS)</span>
            <select
              name="router"
              value={routerPilih}
              onChange={(event) => {
                setRouterPilih(event.target.value)
                setServerPilih('ALL SERVER')
              }}
            >
              <option value="ALL ROUTER">ALL ROUTER (semua NAS)</option>
              {daftarRouter.map((item) => (
                <option key={item.id} value={item.nama_router}>
                  {item.nama_router}
                </option>
              ))}
            </select>
          </label>

          <label className="pelanggan-field">
            <span>Server PPPoE</span>
            <select
              name="server"
              value={serverPilih}
              onChange={(event) => setServerPilih(event.target.value)}
            >
              <option value="ALL SERVER">ALL SERVER (semua server)</option>
              {serverPilih !== 'ALL SERVER' && !serverUnik.includes(serverPilih) && (
                <option value={serverPilih}>{serverPilih}</option>
              )}
              {serverUnik.map((nama) => (
                <option key={nama} value={nama}>{nama}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="pelanggan-form-actions">
          {editMode && (
            <button className="pelanggan-cancel" type="button" onClick={resetForm} disabled={saving}>
              Batal
            </button>
          )}
          <button className="pelanggan-save" type="submit" disabled={saving}>
            {saving ? 'Menyimpan...' : editMode ? 'Simpan Perubahan' : 'Simpan Pelanggan'}
          </button>
        </div>

        {formError && <p className="pelanggan-form-error">{formError}</p>}
      </form>

      <div className="pelanggan-card">
        {loading && <p className="pelanggan-status">Memuat data pelanggan...</p>}
        {error && <p className="pelanggan-status pelanggan-error">{error}</p>}

        {!loading && !error && (
          <div className="pelanggan-table-wrap">
            <table className="pelanggan-table">
              <thead>
                <tr>
                  <th>No</th>
                  <th>Username</th>
                  <th>Password</th>
                  <th>Paket</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {pelanggan.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="pelanggan-empty">
                      Belum ada data pelanggan.
                    </td>
                  </tr>
                ) : (
                  pelanggan.map((item, index) => (
                    <tr
                      key={`${item.username}-${index}`}
                      className={selectedUsername === item.username ? 'is-editing' : undefined}
                    >
                      <td>{index + 1}</td>
                      <td>{item.username}</td>
                      <td>{item.password}</td>
                      <td>
                        <span className="pelanggan-paket">{item.paket}</span>
                      </td>
                      <td>
                        <div className="pelanggan-actions">
                          <button
                            type="button"
                            className="pelanggan-edit"
                            onClick={() => handleEdit(item)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="pelanggan-delete"
                            onClick={() => handleDelete(item.username)}
                            disabled={deletingUsername === item.username}
                          >
                            {deletingUsername === item.username ? 'Menghapus...' : 'Hapus'}
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
    </section>
  )
}

export default PppoePelanggan
