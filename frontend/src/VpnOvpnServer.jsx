import { useCallback, useEffect, useState } from 'react'
import { Copy, Download, Plus, Power, RefreshCw, Save, Server, Trash2 } from 'lucide-react'
import Swal from 'sweetalert2'
import api from './api/axios.js'
import { fireError, fireSuccess } from './swals.js'

const API = '/sistem/vpn/server/ovpn'
const CARD = 'mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900'
const LABEL = 'text-xs font-bold text-slate-600 dark:text-gray-400'
const INPUT = 'h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-slate-800 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-950 dark:text-gray-100'
const BTN = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-bold shadow-sm transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50'
const BTN_PRIMARY = `${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500/40`
const BTN_SUCCESS = `${BTN} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500/40`
const BTN_DANGER = `${BTN} bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-500/40`
const BTN_AMBER = `${BTN} bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-500/40 dark:bg-amber-600 dark:hover:bg-amber-500`
const BTN_NEUTRAL = `${BTN} border border-gray-300 bg-white text-slate-700 hover:bg-gray-50 focus:ring-blue-500/30 dark:border-slate-600 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700`

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
}

function VpnOvpnServer() {
  const [data, setData] = useState(null)
  const [form, setForm] = useState({ public_endpoint: '', listen_port: '1194', network: '10.221.0.0/24' })
  const [peer, setPeer] = useState({ name: '', username: '', password: '' })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async ({ fillForm = false } = {}) => {
    try {
      const { data: body } = await api.get(API)
      setData(body)
      if (fillForm && body?.server) {
        setForm({
          public_endpoint: body.server.public_endpoint || '',
          listen_port: String(body.server.listen_port || 1194),
          network: body.server.network || '10.221.0.0/24',
        })
      }
    } catch (err) {
      fireError({ title: 'Gagal memuat OpenVPN Server', text: err.response?.data?.message || 'Server tidak menjawab.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load({ fillForm: true })
  }, [load])

  const active = data?.status?.state === 'active' || data?.status?.state === 'starting'
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => load(), 5000)
    return () => clearInterval(timer)
  }, [active, load])

  async function saveSettings(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const { data: body } = await api.post(`${API}/save`, {
        public_endpoint: form.public_endpoint.trim(),
        listen_port: Number(form.listen_port),
        network: form.network.trim(),
      })
      setData(body)
      await fireSuccess({ title: 'Tersimpan', text: body.message || 'Pengaturan OpenVPN disimpan.' })
    } catch (err) {
      fireError({ title: 'Gagal menyimpan', text: err.response?.data?.message || 'Periksa endpoint, port, dan subnet.' })
    } finally {
      setBusy(false)
    }
  }

  async function control(action) {
    const titles = {
      enable: 'Aktifkan OpenVPN Server?',
      disable: 'Matikan OpenVPN Server?',
      restart: 'Restart OpenVPN Server?',
    }
    const texts = {
      enable: 'VPN Client yang sedang tersambung akan diputus. WireGuard Server tetap boleh hidup.',
      disable: 'Port TCP dan subnet 10.221.0.0/24 ditutup di firewall. Peer MikroTik akan terputus.',
      restart: 'Tunnel OpenVPN diputus sebentar lalu dihidupkan lagi. WireGuard Server tidak dimatikan.',
    }
    const confirm = await Swal.fire({
      title: titles[action],
      text: texts[action],
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) return
    setBusy(true)
    try {
      const { data: body } = await api.post(`${API}/action`, { action })
      setData(body)
      await fireSuccess({ title: 'Selesai', text: body.message || 'OpenVPN Server diperbarui.' })
    } catch (err) {
      fireError({ title: 'Gagal', text: err.response?.data?.message || 'Aksi OpenVPN Server gagal.' })
    } finally {
      setBusy(false)
    }
  }

  async function addPeer(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const { data: body } = await api.post(`${API}/peers`, {
        name: peer.name.trim(),
        username: peer.username.trim(),
        password: peer.password,
      })
      setData(body)
      setPeer({ name: '', username: '', password: '' })
      await fireSuccess({ title: 'Peer ditambahkan', text: body.message || 'IP VPN diberikan otomatis.' })
    } catch (err) {
      fireError({ title: 'Gagal menambah peer', text: err.response?.data?.message || 'Periksa nama, username, dan password.' })
    } finally {
      setBusy(false)
    }
  }

  async function togglePeer(row) {
    setBusy(true)
    try {
      const { data: body } = await api.patch(`${API}/peers/${row.id}`, { enabled: !row.enabled })
      setData(body)
    } catch (err) {
      fireError({ title: 'Gagal mengubah peer', text: err.response?.data?.message || 'Peer tidak dapat diubah.' })
    } finally {
      setBusy(false)
    }
  }

  async function removePeer(row) {
    const confirm = await Swal.fire({
      title: `Hapus ${row.name}?`,
      text: 'Username ini tidak bisa login lagi. IP-nya bisa dipakai peer baru.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Hapus',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) return
    setBusy(true)
    try {
      const { data: body } = await api.delete(`${API}/peers/${row.id}`)
      setData(body)
      await fireSuccess({ title: 'Peer dihapus', text: body.message || 'Peer dihapus.' })
    } catch (err) {
      fireError({ title: 'Gagal menghapus', text: err.response?.data?.message || 'Peer tidak dapat dihapus.' })
    } finally {
      setBusy(false)
    }
  }

  async function copyScript(row) {
    setBusy(true)
    try {
      const { data: body } = await api.get(`${API}/peers/${row.id}/script`)
      const script = body.script || ''
      await Swal.fire({
        title: `Script ROS v6 · ${row.name}`,
        html: '<p class="text-sm">Tempel di terminal RouterOS v6. Baris RADIUS sudah aktif dan secret-nya sudah tersinkron dengan FreeRADIUS billing.</p>',
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

  async function downloadCa() {
    setBusy(true)
    try {
      const { data: body } = await api.get(`${API}/ca`)
      const blob = new Blob([body.pem || ''], { type: 'application/x-pem-file' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = body.filename || 'raniah-ovpn-ca.crt'
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      fireError({ title: 'CA belum ada', text: err.response?.data?.message || 'Simpan pengaturan OpenVPN Server dulu.' })
    } finally {
      setBusy(false)
    }
  }

  const status = data?.status
  const peers = Array.isArray(data?.peers) ? data.peers : []

  return (
    <>
      <div className={CARD} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Server size={22} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Status OpenVPN</h2>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${active ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-gray-300'}`}>
            {loading ? 'Memuat...' : active ? 'Aktif' : 'Mati'}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className={LABEL}>IP server</dt>
            <dd className="mt-1 font-mono text-slate-800 dark:text-gray-100">{data?.server?.server_ip || '10.221.0.1'}</dd>
          </div>
          <div>
            <dt className={LABEL}>Port TCP</dt>
            <dd className="mt-1 font-mono text-slate-800 dark:text-gray-100">{data?.server?.listen_port || 1194}</dd>
          </div>
          <div>
            <dt className={LABEL}>Peer online</dt>
            <dd className="mt-1 font-mono text-slate-800 dark:text-gray-100">{data?.online ?? 0}/{data?.total ?? 0}</dd>
          </div>
          <div>
            <dt className={LABEL}>RX / TX</dt>
            <dd className="mt-1 font-mono text-slate-800 dark:text-gray-100">{formatBytes(status?.rx_bytes)} / {formatBytes(status?.tx_bytes)}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={BTN_SUCCESS} onClick={() => control('enable')} disabled={loading || busy || active}>
            <Power size={16} aria-hidden="true" />
            Aktifkan
          </button>
          <button type="button" className={BTN_DANGER} onClick={() => control('disable')} disabled={loading || busy || !active}>
            Matikan
          </button>
          <button type="button" className={BTN_AMBER} onClick={() => control('restart')} disabled={loading || busy || !active}>
            <RefreshCw size={16} className={busy ? 'animate-spin' : ''} aria-hidden="true" />
            Restart
          </button>
          <button type="button" className={BTN_NEUTRAL} onClick={downloadCa} disabled={loading || busy}>
            <Download size={16} aria-hidden="true" />
            Unduh CA (.crt)
          </button>
        </div>
      </div>

      <form className={CARD} onSubmit={saveSettings}>
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Pengaturan Server</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={LABEL}>Endpoint publik</span>
            <input className={`${INPUT} mt-1 font-mono`} value={form.public_endpoint} onChange={(event) => setForm((prev) => ({ ...prev, public_endpoint: event.target.value }))} placeholder="vpn.contoh.net atau 203.0.113.10" autoComplete="off" spellCheck={false} />
          </label>
          <label className="block">
            <span className={LABEL}>Port TCP</span>
            <input className={`${INPUT} mt-1 font-mono`} inputMode="numeric" value={form.listen_port} onChange={(event) => setForm((prev) => ({ ...prev, listen_port: event.target.value }))} />
          </label>
          <label className="block">
            <span className={LABEL}>Subnet</span>
            <input className={`${INPUT} mt-1 font-mono`} value={form.network} onChange={(event) => setForm((prev) => ({ ...prev, network: event.target.value }))} placeholder="10.221.0.0/24" spellCheck={false} />
          </label>
        </div>
        <p className="mt-3 mb-0 text-xs text-slate-500 dark:text-gray-400">
          TCP, cipher AES-256-CBC, auth SHA1, supaya RouterOS v6 bisa login. Interface tun-ovpn-srv. Subnet ini terpisah dari WireGuard 10.220.0.0/24.
        </p>
        <button type="submit" className={`${BTN_PRIMARY} mt-4`} disabled={loading || busy}>
          <Save size={16} aria-hidden="true" />
          Simpan Pengaturan
        </button>
      </form>

      <form className={CARD} onSubmit={addPeer}>
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Peer ROS v6</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className={LABEL}>Nama router</span>
            <input className={`${INPUT} mt-1`} value={peer.name} onChange={(event) => setPeer((prev) => ({ ...prev, name: event.target.value }))} placeholder="NAS-Kantor" />
          </label>
          <label className="block">
            <span className={LABEL}>Username</span>
            <input className={`${INPUT} mt-1 font-mono`} value={peer.username} onChange={(event) => setPeer((prev) => ({ ...prev, username: event.target.value }))} placeholder="nas-kantor" autoComplete="off" spellCheck={false} />
          </label>
          <label className="block">
            <span className={LABEL}>Password</span>
            <input className={`${INPUT} mt-1 font-mono`} type="text" value={peer.password} onChange={(event) => setPeer((prev) => ({ ...prev, password: event.target.value }))} placeholder="kosong = dibuat otomatis" autoComplete="off" spellCheck={false} />
          </label>
        </div>
        <button type="submit" className={`${BTN_PRIMARY} mt-4`} disabled={loading || busy}>
          <Plus size={16} aria-hidden="true" />
          Tambah Peer
        </button>
      </form>

      <div className={CARD}>
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Daftar Peer</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-slate-500 dark:border-slate-700 dark:text-gray-400">
                <th className="py-2 pr-3 font-bold">Router</th>
                <th className="py-2 pr-3 font-bold">Username</th>
                <th className="py-2 pr-3 font-bold">IP VPN</th>
                <th className="py-2 pr-3 font-bold">Status</th>
                <th className="py-2 pr-3 font-bold">RX / TX</th>
                <th className="py-2 font-bold">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {peers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-slate-500 dark:text-gray-400">Belum ada peer. Tambah router ROS v6 di atas.</td>
                </tr>
              ) : peers.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 dark:border-slate-800">
                  <td className="py-3 pr-3 font-semibold text-slate-800 dark:text-gray-100">{row.name}</td>
                  <td className="py-3 pr-3 font-mono text-xs">{row.username}</td>
                  <td className="py-3 pr-3 font-mono">{row.address}</td>
                  <td className="py-3 pr-3">
                    {!row.enabled ? 'Nonaktif' : row.online ? 'Online' : 'Offline'}
                  </td>
                  <td className="py-3 pr-3 font-mono text-xs">{formatBytes(row.rx_bytes)} / {formatBytes(row.tx_bytes)}</td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={BTN_NEUTRAL} onClick={() => copyScript(row)} disabled={busy}>
                        <Copy size={14} aria-hidden="true" />
                        Salin Script ROS v6
                      </button>
                      <button type="button" className={BTN_NEUTRAL} onClick={() => navigator.clipboard.writeText(row.radius_secret || '').then(() => fireSuccess({ title: 'RADIUS secret tersalin', text: 'Tersalin ke clipboard.' })).catch(() => fireError({ title: 'Gagal menyalin', text: 'Clipboard tidak tersedia di browser ini.' }))} disabled={busy || !row.radius_secret}>
                        Salin Secret
                      </button>
                      <button type="button" className={BTN_NEUTRAL} onClick={() => togglePeer(row)} disabled={busy}>
                        {row.enabled ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button type="button" className={BTN_DANGER} onClick={() => removePeer(row)} disabled={busy}>
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
    </>
  )
}

export default VpnOvpnServer
