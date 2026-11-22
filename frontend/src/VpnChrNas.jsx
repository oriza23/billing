import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus, Trash2 } from 'lucide-react'
import Swal from 'sweetalert2'
import api from './api/axios.js'
import { fireError, fireSuccess } from './swals.js'

const API = '/sistem/vpn/chr-nas'
const CARD = 'mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900'
const LABEL = 'text-xs font-bold text-slate-600 dark:text-gray-400'
const INPUT = 'h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-slate-800 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-950 dark:text-gray-100'
const BTN = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-bold shadow-sm transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50'
const BTN_PRIMARY = `${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500/40`
const BTN_DANGER = `${BTN} bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-500/40`
const BTN_NEUTRAL = `${BTN} border border-gray-300 bg-white text-slate-700 hover:bg-gray-50 focus:ring-blue-500/30 dark:border-slate-600 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700`

function VpnChrNas({ radiusAddress }) {
  const [items, setItems] = useState([])
  const [serverAddress, setServerAddress] = useState(radiusAddress || '10.210.0.2')
  const [form, setForm] = useState({ nama_router: '', ip_vpn_nas: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(API)
      setItems(Array.isArray(data?.items) ? data.items : [])
      if (data?.radius_address) setServerAddress(data.radius_address)
    } catch (err) {
      fireError({ title: 'Gagal memuat NAS CHR', text: err.response?.data?.message || 'Server tidak menjawab.' })
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (radiusAddress) setServerAddress(radiusAddress)
  }, [radiusAddress])

  async function addNas(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const { data } = await api.post(API, {
        nama_router: form.nama_router.trim(),
        ip_vpn_nas: form.ip_vpn_nas.trim(),
      })
      setItems(Array.isArray(data?.items) ? data.items : [])
      if (data?.radius_address) setServerAddress(data.radius_address)
      setForm({ nama_router: '', ip_vpn_nas: '' })
      await fireSuccess({ title: 'NAS ditambahkan', text: data.message || 'Secret RADIUS dibuat otomatis.' })
    } catch (err) {
      fireError({ title: 'Gagal menambah NAS', text: err.response?.data?.message || 'Periksa nama dan IP.' })
    } finally {
      setBusy(false)
    }
  }

  async function removeNas(row) {
    const confirm = await Swal.fire({
      title: `Hapus ${row.nama_router}?`,
      text: 'Entri di FreeRADIUS ikut dihapus.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Hapus',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) return
    setBusy(true)
    try {
      const { data } = await api.delete(`${API}/${row.id}`)
      setItems(Array.isArray(data?.items) ? data.items : [])
      await fireSuccess({ title: 'NAS dihapus', text: data.message || 'NAS dihapus.' })
    } catch (err) {
      fireError({ title: 'Gagal menghapus', text: err.response?.data?.message || 'NAS tidak dapat dihapus.' })
    } finally {
      setBusy(false)
    }
  }

  async function copySecret(row) {
    try {
      await navigator.clipboard.writeText(row.radius_secret || '')
      await fireSuccess({ title: 'RADIUS secret tersalin', text: 'Tersalin ke clipboard.' })
    } catch {
      fireError({ title: 'Gagal menyalin', text: 'Clipboard tidak tersedia di browser ini.' })
    }
  }

  async function copyScript(row) {
    setBusy(true)
    try {
      const { data } = await api.get(`${API}/${row.id}/script`)
      const script = data.script || ''
      await Swal.fire({
        title: `Script ${row.nama_router}`,
        html: `<p class="text-sm">Tempel di terminal RouterOS v6 atau v7. Baris RADIUS sudah aktif ke ${data.radius_address || serverAddress} dan secret-nya sudah tersinkron dengan FreeRADIUS billing.</p>`,
        input: 'textarea',
        inputValue: script,
        width: 720,
        confirmButtonText: 'Salin dan tutup',
      })
      await navigator.clipboard.writeText(script)
    } catch (err) {
      fireError({ title: 'Gagal membuat script', text: err.response?.data?.message || 'Script tidak tersedia.' })
    } finally {
      setBusy(false)
    }
  }

  const shownAddress = radiusAddress || serverAddress || '10.210.0.2'

  return (
    <div className={CARD}>
      <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Daftar MikroTik NAS (via Hub CHR)</h2>
      <p className="mt-2 mb-0 text-sm text-slate-500 dark:text-gray-400">
        Alamat RADIUS di script adalah <span className="font-mono font-semibold text-slate-800 dark:text-gray-100">{shownAddress}</span>, IP VPN billing dari CHR. Default-nya 10.210.0.2 bila tunnel belum tersambung.
      </p>

      <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={addNas}>
        <label className="block">
          <span className={LABEL}>Nama router</span>
          <input className={`${INPUT} mt-1`} value={form.nama_router} onChange={(event) => setForm((prev) => ({ ...prev, nama_router: event.target.value }))} placeholder="RB KONTE" required />
        </label>
        <label className="block">
          <span className={LABEL}>IP VPN NAS di CHR</span>
          <input className={`${INPUT} mt-1 font-mono`} value={form.ip_vpn_nas} onChange={(event) => setForm((prev) => ({ ...prev, ip_vpn_nas: event.target.value }))} placeholder="10.210.0.3" spellCheck={false} />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className={BTN_PRIMARY} disabled={busy}>
            <Plus size={16} aria-hidden="true" />
            Tambah NAS
          </button>
        </div>
      </form>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-slate-500 dark:border-slate-700 dark:text-gray-400">
              <th className="py-2 pr-3 font-bold">Nama</th>
              <th className="py-2 pr-3 font-bold">IP VPN</th>
              <th className="py-2 pr-3 font-bold">RADIUS Secret</th>
              <th className="py-2 font-bold">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-slate-500 dark:text-gray-400">Belum ada NAS. Tambah router yang lewat CHR di atas.</td>
              </tr>
            ) : items.map((row) => (
              <tr key={row.id} className="border-b border-gray-100 dark:border-slate-800">
                <td className="py-3 pr-3 font-semibold text-slate-800 dark:text-gray-100">{row.nama_router}</td>
                <td className="py-3 pr-3 font-mono">{row.ip_vpn_nas || '—'}</td>
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{row.radius_secret}</span>
                    <button type="button" className={BTN_NEUTRAL} onClick={() => copySecret(row)} disabled={!row.radius_secret}>
                      <Copy size={14} aria-hidden="true" />
                      Salin
                    </button>
                  </div>
                </td>
                <td className="py-3">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={BTN_NEUTRAL} onClick={() => copyScript(row)} disabled={busy}>
                      <Copy size={14} aria-hidden="true" />
                      Salin Script
                    </button>
                    <button type="button" className={BTN_DANGER} onClick={() => removeNas(row)} disabled={busy}>
                      <Trash2 size={14} aria-hidden="true" />
                      Hapus
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default VpnChrNas
