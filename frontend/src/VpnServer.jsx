import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus, Power, RefreshCw, Save, Server, Trash2 } from 'lucide-react'
import Swal from 'sweetalert2'
import api from './api/axios.js'
import { fireError, fireSuccess } from './swals.js'
import VpnOvpnServer from './VpnOvpnServer.jsx'

const API = '/sistem/vpn/server'
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

function ageLabel(seconds) {
  if (seconds === null || seconds === undefined) return 'belum pernah'
  if (seconds < 60) return `${seconds} dtk`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt`
  return `${Math.floor(seconds / 3600)} jam`
}

async function copyText(value, title) {
  try {
    await navigator.clipboard.writeText(value)
    await fireSuccess({ title, text: 'Tersalin ke clipboard.' })
  } catch {
    fireError({ title: 'Gagal menyalin', text: 'Clipboard tidak tersedia di browser ini.' })
  }
}

function VpnServer() {
  const [kind, setKind] = useState(() => (sessionStorage.getItem('vpn-server-kind') === 'ovpn' ? 'ovpn' : 'wireguard'))
  const [data, setData] = useState(null)
  const [form, setForm] = useState({ public_endpoint: '', listen_port: '51820', address: '10.220.0.1/24' })
  const [peerForm, setPeerForm] = useState({ name: '', public_key: '', generate_psk: true })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async ({ fillForm = false } = {}) => {
    try {
      const response = await api.get(API)
      const body = response.data || {}
      setData(body)
      if (fillForm) {
        setForm({
          public_endpoint: body.server?.public_endpoint || '',
          listen_port: String(body.server?.listen_port || 51820),
          address: body.server?.address || '10.220.0.1/24',
        })
      }
      setError('')
    } catch (err) {
      setError(err.response?.data?.message || 'Gagal memuat VPN Server.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load({ fillForm: true })
  }, [load])

  useEffect(() => {
    if (data?.status?.state !== 'active' && data?.status?.state !== 'starting') return undefined
    const timer = setInterval(() => { load() }, 5000)
    return () => clearInterval(timer)
  }, [data?.status?.state, load])

  async function run(task, failTitle) {
    setBusy(true)
    try {
      const response = await task()
      if (response?.data) setData(response.data)
      await fireSuccess({ title: 'Berhasil', text: response?.data?.message || 'Selesai.' }, () => load())
    } catch (err) {
      fireError({ title: failTitle, text: err.response?.data?.message || 'Permintaan gagal.' })
      load()
    } finally {
      setBusy(false)
    }
  }

  async function saveSettings(event) {
    event.preventDefault()
    await run(
      () => api.post(`${API}/save`, {
        public_endpoint: form.public_endpoint,
        listen_port: Number(form.listen_port),
        address: form.address,
      }),
      'Gagal menyimpan',
    )
  }

  async function control(action) {
    if (action === 'enable') {
      const confirm = await Swal.fire({
        title: 'Aktifkan VPN Server?',
        text: 'WireGuard, OpenVPN, SSTP, dan L2TP client akan diputuskan. Port UDP server dibuka di UFW.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Ya, aktifkan',
        cancelButtonText: 'Batal',
      })
      if (!confirm.isConfirmed) return
    }
    if (action === 'disable') {
      const confirm = await Swal.fire({
        title: 'Matikan VPN Server?',
        text: 'Router NAS yang terhubung ke hub ini akan terputus, dan port UDP ditutup di UFW.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Ya, matikan',
        cancelButtonText: 'Batal',
      })
      if (!confirm.isConfirmed) return
    }
    await run(() => api.post(`${API}/action`, { action }), 'Gagal')
  }

  async function addPeer(event) {
    event.preventDefault()
    await run(
      () => api.post(`${API}/peers`, {
        name: peerForm.name,
        public_key: peerForm.public_key,
        generate_psk: peerForm.generate_psk,
      }),
      'Gagal menambah peer',
    )
    setPeerForm({ name: '', public_key: '', generate_psk: peerForm.generate_psk })
  }

  async function removePeer(peer) {
    const confirm = await Swal.fire({
      title: `Hapus ${peer.name}?`,
      text: 'Router ini tidak bisa lagi terhubung sampai peer dibuat ulang.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Hapus',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) return
    await run(() => api.delete(`${API}/peers/${peer.id}`), 'Gagal menghapus')
  }

  async function togglePeer(peer) {
    await run(() => api.patch(`${API}/peers/${peer.id}`, { enabled: !peer.enabled }), 'Gagal mengubah peer')
  }

  async function copyScript(peer) {
    setBusy(true)
    try {
      const response = await api.get(`${API}/peers/${peer.id}/script`)
      const script = response.data?.script || ''
      await Swal.fire({
        title: `Script ${peer.name}`,
        html: '<p class="text-sm">Tempel di terminal RouterOS v7. Baris RADIUS sudah aktif dan secret-nya sudah tersinkron dengan FreeRADIUS billing. Jika public key diisi manual, ganti ISI_PRIVATE_KEY_ROUTER dengan private key router.</p>',
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

  const status = data?.status
  const active = status?.state === 'active' || status?.state === 'starting'
  const peers = Array.isArray(data?.peers) ? data.peers : []

  function selectKind(next) {
    sessionStorage.setItem('vpn-server-kind', next)
    setKind(next)
  }

  const kindTab = (id, label) => (
    <button
      type="button"
      role="tab"
      aria-selected={kind === id}
      className={`h-10 rounded-lg px-4 text-sm font-bold transition-colors ${kind === id ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-gray-100' : 'text-slate-500 hover:text-slate-800 dark:text-gray-400 dark:hover:text-gray-100'}`}
      onClick={() => selectKind(id)}
    >
      {label}
    </button>
  )

  return (
    <>
      <div className="mt-6 inline-flex rounded-xl border border-gray-200 bg-slate-100 p-1 dark:border-slate-700 dark:bg-slate-800" role="tablist" aria-label="Jenis VPN Server">
        {kindTab('wireguard', 'WireGuard Server (ROS v7)')}
        {kindTab('ovpn', 'OpenVPN Server (ROS v6)')}
      </div>
      {kind === 'ovpn' ? <VpnOvpnServer /> : (
      <>
      <div className={CARD} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Server size={22} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Status Server</h2>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${active ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-gray-300'}`}>
            {loading ? 'Memuat...' : active ? 'Aktif' : 'Mati'}
          </span>
        </div>
        {error && <p className="mt-3 mb-0 text-sm font-semibold text-rose-700 dark:text-rose-300">{error}</p>}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className={LABEL}>IP server</dt>
            <dd className="m-0 font-mono text-sm text-slate-800 dark:text-gray-100">{status?.ip || data?.server?.address || '-'}</dd>
          </div>
          <div>
            <dt className={LABEL}>Port</dt>
            <dd className="m-0 font-mono text-sm text-slate-800 dark:text-gray-100">{data?.server?.listen_port || '-'}/udp</dd>
          </div>
          <div>
            <dt className={LABEL}>Peer online</dt>
            <dd className="m-0 text-sm font-bold text-slate-800 dark:text-gray-100">{data?.online ?? 0} / {data?.total ?? peers.length}</dd>
          </div>
          <div>
            <dt className={LABEL}>RX / TX</dt>
            <dd className="m-0 text-sm text-slate-800 dark:text-gray-100">{formatBytes(status?.rx_bytes)} / {formatBytes(status?.tx_bytes)}</dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
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
            <span className={LABEL}>Listen port</span>
            <input className={`${INPUT} mt-1 font-mono`} inputMode="numeric" value={form.listen_port} onChange={(event) => setForm((prev) => ({ ...prev, listen_port: event.target.value }))} />
          </label>
          <label className="block">
            <span className={LABEL}>Alamat server / subnet</span>
            <input className={`${INPUT} mt-1 font-mono`} value={form.address} onChange={(event) => setForm((prev) => ({ ...prev, address: event.target.value }))} placeholder="10.220.0.1/24" spellCheck={false} />
          </label>
          <label className="block sm:col-span-2">
            <span className={LABEL}>Public key server</span>
            <span className="mt-1 flex gap-2">
              <input className={`${INPUT} font-mono`} readOnly value={data?.server?.public_key || ''} />
              <button type="button" className={BTN_NEUTRAL} disabled={!data?.server?.public_key} onClick={() => copyText(data.server.public_key, 'Public key tersalin')}>
                <Copy size={16} aria-hidden="true" />
              </button>
            </span>
          </label>
        </div>
        <p className="mt-3 mb-0 text-xs text-slate-500 dark:text-gray-400">MTU 1380. Private key dibuat otomatis dan tidak ditampilkan. Interface layanan: wg-server.</p>
        <button type="submit" className={`${BTN_PRIMARY} mt-4`} disabled={loading || busy}>
          <Save size={16} aria-hidden="true" />
          Simpan Pengaturan
        </button>
      </form>

      <div className={CARD}>
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Peer MikroTik NAS</h2>
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={addPeer}>
          <label className="block">
            <span className={LABEL}>Nama router</span>
            <input className={`${INPUT} mt-1`} value={peerForm.name} onChange={(event) => setPeerForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="NAS Pusat" required />
          </label>
          <label className="block">
            <span className={LABEL}>Public key peer (opsional)</span>
            <input className={`${INPUT} mt-1 font-mono`} value={peerForm.public_key} onChange={(event) => setPeerForm((prev) => ({ ...prev, public_key: event.target.value }))} placeholder="Kosongkan agar keypair dibuat di sini" spellCheck={false} />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2 dark:text-gray-200">
            <input type="checkbox" checked={peerForm.generate_psk} onChange={(event) => setPeerForm((prev) => ({ ...prev, generate_psk: event.target.checked }))} />
            Buat Preshared Key
          </label>
          <button type="submit" className={BTN_PRIMARY} disabled={loading || busy}>
            <Plus size={16} aria-hidden="true" />
            Tambah Peer
          </button>
        </form>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs tracking-wide text-slate-500 uppercase dark:border-slate-700 dark:text-gray-400">
                <th className="px-2 py-2 font-bold">Router</th>
                <th className="px-2 py-2 font-bold">IP VPN</th>
                <th className="px-2 py-2 font-bold">Status</th>
                <th className="px-2 py-2 font-bold">Handshake</th>
                <th className="px-2 py-2 font-bold">RX/TX</th>
                <th className="px-2 py-2 font-bold">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {peers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-slate-500 dark:text-gray-400">Belum ada peer.</td>
                </tr>
              )}
              {peers.map((peer) => (
                <tr key={peer.id} className="border-b border-gray-100 dark:border-slate-800">
                  <td className="px-2 py-3">
                    <div className="font-bold text-slate-800 dark:text-gray-100">{peer.name}</div>
                    <div className="max-w-[16rem] truncate font-mono text-xs text-slate-500 dark:text-gray-400" title={peer.public_key}>{peer.public_key}</div>
                  </td>
                  <td className="px-2 py-3 font-mono text-slate-800 dark:text-gray-100">{peer.address}</td>
                  <td className="px-2 py-3">
                    <span className={peer.online ? 'font-bold text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-gray-400'}>
                      {peer.enabled ? (peer.online ? 'Online' : 'Offline') : 'Nonaktif'}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-slate-600 dark:text-gray-300">{ageLabel(peer.handshake_age_seconds)}</td>
                  <td className="px-2 py-3 text-slate-600 dark:text-gray-300">{formatBytes(peer.rx_bytes)} / {formatBytes(peer.tx_bytes)}</td>
                  <td className="px-2 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={BTN_NEUTRAL} onClick={() => copyScript(peer)} disabled={busy}>
                        <Copy size={14} aria-hidden="true" />
                        Salin Script
                      </button>
                      <button type="button" className={BTN_NEUTRAL} onClick={() => copyText(peer.radius_secret, 'RADIUS secret tersalin')} disabled={busy || !peer.radius_secret}>
                        Salin Secret
                      </button>
                      <button type="button" className={BTN_NEUTRAL} onClick={() => togglePeer(peer)} disabled={busy}>
                        {peer.enabled ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button type="button" className={BTN_DANGER} onClick={() => removePeer(peer)} disabled={busy}>
                        <Trash2 size={14} aria-hidden="true" />
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
      )}
    </>
  )
}

export default VpnServer
