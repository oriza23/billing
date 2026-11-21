import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Check, Copy, Eye, EyeOff, KeyRound, Plug, RefreshCw, Save, ShieldCheck, Unplug, Upload,
} from 'lucide-react'
import Swal from 'sweetalert2'
import api from './api/axios.js'
import { fireError, fireSuccess } from './swals.js'

const API = '/sistem/vpn'
const AUTO_REFRESH_MS = 10000
const MAX_OVPN_BYTES = 64 * 1024

const PROTOCOLS = [
  { id: 'wireguard', label: 'WireGuard', badge: 'Disarankan', desc: 'Paling cepat dan latensi terendah (UDP, modul kernel Linux).' },
  { id: 'openvpn', label: 'OpenVPN', desc: 'Kompatibel luas, memakai file konfigurasi .ovpn.' },
  { id: 'sstp', label: 'SSTP', desc: 'Lewat TCP 443, mudah menembus firewall yang ketat.' },
]
const LABEL = { wireguard: 'WireGuard', openvpn: 'OpenVPN', sstp: 'SSTP' }

const EMPTY_FORMS = {
  wireguard: {
    endpoint: '', server_public_key: '', private_key: '', preshared_key: '', address: '', allowed_ips: '', keepalive: '25', mtu: '', clear_preshared_key: false,
  },
  openvpn: { ovpn_config: '', username: '', password: '' },
  sstp: { server: '', username: '', password: '', routes: '', ignore_cert: false },
}

const CARD = 'mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900'
const LABEL_CLASS = 'text-xs font-bold text-slate-600 dark:text-gray-400'
const INPUT_CLASS = 'h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-slate-800 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-950 dark:text-gray-100'
const MONO = ' font-mono text-[13px]'
const BTN = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-bold shadow-sm transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50'
const BTN_PRIMARY = `${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500/40`
const BTN_SUCCESS = `${BTN} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500/40`
const BTN_DANGER = `${BTN} bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-500/40`
const BTN_NEUTRAL = `${BTN} border border-gray-300 bg-white text-slate-700 hover:bg-gray-50 focus:ring-blue-500/30 dark:border-slate-600 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700`

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 100 ? 0 : 2)} ${units[index]}`
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-'
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts = []
  if (days) parts.push(`${days} hari`)
  if (hours) parts.push(`${hours} jam`)
  if (minutes) parts.push(`${minutes} mnt`)
  if (!days && !hours) parts.push(`${secs} dtk`)
  return parts.join(' ')
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return 'Belum ada handshake'
  return `${formatDuration(seconds)} lalu`
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // jatuh ke metode cadangan
  }
  // Halaman diakses lewat http://IP: navigator.clipboard tidak tersedia, pakai execCommand.
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  document.body.removeChild(area)
  return copied
}

function tooWide(allowedIps) {
  return String(allowedIps || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((item) => {
      const match = /\/(\d{1,2})$/.exec(item)
      return match ? Number(match[1]) < 8 : false
    })
}

function formsFromProfiles(profiles = {}) {
  const wg = profiles.wireguard
  const ovpn = profiles.openvpn
  const sstp = profiles.sstp
  return {
    wireguard: wg
      ? {
          ...EMPTY_FORMS.wireguard,
          endpoint: wg.endpoint || '',
          server_public_key: wg.server_public_key || '',
          address: wg.address || '',
          allowed_ips: wg.allowed_ips || '',
          keepalive: String(wg.keepalive ?? 25),
          mtu: wg.mtu ? String(wg.mtu) : '',
        }
      : { ...EMPTY_FORMS.wireguard },
    openvpn: ovpn ? { ...EMPTY_FORMS.openvpn, username: ovpn.username || '' } : { ...EMPTY_FORMS.openvpn },
    sstp: sstp
      ? {
          ...EMPTY_FORMS.sstp,
          server: sstp.server || '',
          username: sstp.username || '',
          routes: sstp.routes || '',
          ignore_cert: Boolean(sstp.ignore_cert),
        }
      : { ...EMPTY_FORMS.sstp },
  }
}

function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`grid min-w-0 content-start gap-1.5 ${className}`}>
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-500 dark:text-gray-400">{hint}</span>}
    </label>
  )
}

function StateBadge({ state }) {
  const map = {
    connected: ['Terhubung', 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300', 'bg-emerald-500'],
    connecting: ['Menghubungkan...', 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300', 'bg-amber-500'],
    disconnected: ['Terputus', 'bg-rose-50 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300', 'bg-rose-500'],
  }
  const [text, tone, dot] = map[state] || map.disconnected
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${tone}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dot} ${state === 'connecting' ? 'animate-pulse' : ''}`} aria-hidden="true" />
      {text}
    </span>
  )
}

function InfoItem({ label, value, mono = false }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-slate-500 dark:text-gray-400">{label}</dt>
      <dd className={`m-0 mt-1 truncate text-sm font-semibold text-slate-900 dark:text-gray-100${mono ? MONO : ''}`}>{value || '-'}</dd>
    </div>
  )
}

function VpnConfig() {
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [profiles, setProfiles] = useState({})
  const [forms, setForms] = useState(EMPTY_FORMS)
  const [tab, setTab] = useState('wireguard')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [publicKey, setPublicKey] = useState('')
  const [showPrivate, setShowPrivate] = useState(false)
  const [copied, setCopied] = useState(false)
  const busyRef = useRef(false)
  const fileRef = useRef(null)

  const loadStatus = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true)
    try {
      const response = await api.get(`${API}/status`)
      setStatus(response.data)
      setStatusError('')
    } catch (error) {
      setStatusError(error.response?.data?.message || 'Status VPN gagal dimuat.')
    } finally {
      if (!quiet) setRefreshing(false)
    }
  }, [])

  const applyProfiles = useCallback((nextProfiles, selected) => {
    setProfiles(nextProfiles || {})
    setForms(formsFromProfiles(nextProfiles))
    setPublicKey(nextProfiles?.wireguard?.public_key || '')
    setDirty(false)
    if (selected) setTab(selected)
  }, [])

  useEffect(() => {
    let ignore = false
    async function init() {
      try {
        const [configResult, statusResult] = await Promise.allSettled([
          api.get(`${API}/config`),
          api.get(`${API}/status`),
        ])
        if (ignore) return
        if (statusResult.status === 'fulfilled') {
          setStatus(statusResult.value.data)
          setStatusError('')
        } else {
          setStatus({ state: 'disconnected', connected: false, ip: null, protocol: null })
          setStatusError(statusResult.reason?.response?.data?.message || 'Status VPN gagal dimuat.')
        }
        if (configResult.status === 'fulfilled') {
          const selected = statusResult.status === 'fulfilled' ? statusResult.value.data.protocol : null
          applyProfiles(configResult.value.data.profiles, selected || configResult.value.data.selected)
        } else {
          setStatusError(configResult.reason?.response?.data?.message || 'Konfigurasi VPN gagal dimuat.')
        }
      } catch (error) {
        if (!ignore) {
          setStatus({ state: 'disconnected', connected: false, ip: null, protocol: null })
          setStatusError(error.response?.data?.message || 'Konfigurasi VPN gagal dimuat.')
        }
      } finally {
        if (!ignore) setLoading(false)
      }
    }
    init()
    return () => { ignore = true }
  }, [applyProfiles])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busyRef.current) {
        loadStatus({ quiet: true })
      }
    }, AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [loadStatus])

  function setField(protocol, name, value) {
    setForms((current) => ({ ...current, [protocol]: { ...current[protocol], [name]: value } }))
    setDirty(true)
  }

  async function handleKeygen() {
    const hasKey = forms.wireguard.private_key || profiles.wireguard?.private_key_set
    if (hasKey) {
      const confirm = await Swal.fire({
        title: 'Buat keypair baru?',
        html: 'Private key lama akan diganti. Public key baru <b>harus diperbarui di peer CHR</b>, kalau tidak koneksi tidak akan tersambung.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Ya, buat baru',
        cancelButtonText: 'Batal',
      })
      if (!confirm.isConfirmed) return
    }
    try {
      const response = await api.post(`${API}/wg/keygen`)
      setForms((current) => ({
        ...current,
        wireguard: { ...current.wireguard, private_key: response.data.private_key },
      }))
      setPublicKey(response.data.public_key)
      setShowPrivate(true)
      setDirty(true)
    } catch (error) {
      fireError({ title: 'Gagal', text: error.response?.data?.message || 'Keypair gagal dibuat.' })
    }
  }

  async function handleCopy() {
    if (!publicKey) return
    const ok = await copyText(publicKey)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } else {
      Swal.fire({ title: 'Salin manual', text: publicKey, icon: 'info', confirmButtonText: 'OK' })
    }
  }

  function handleFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_OVPN_BYTES) {
      fireError({ title: 'File terlalu besar', text: 'File .ovpn maksimal 64 KB.' })
      return
    }
    const reader = new FileReader()
    reader.onload = () => setField('openvpn', 'ovpn_config', String(reader.result || ''))
    reader.onerror = () => fireError({ title: 'Gagal', text: 'File tidak dapat dibaca.' })
    reader.readAsText(file)
  }

  async function handleSave(event) {
    event.preventDefault()
    setSaving(true)
    try {
      const response = await api.post(`${API}/save`, { protocol: tab, config: forms[tab] })
      const selected = tab
      await fireSuccess(
        { title: 'Berhasil', text: response.data.message, ...(response.data.needs_reconnect ? { icon: 'info' } : {}) },
        () => {
          applyProfiles(response.data.profiles, selected)
          loadStatus({ quiet: true })
        },
      )
    } catch (error) {
      fireError({ title: 'Gagal menyimpan', text: error.response?.data?.message || 'Konfigurasi gagal disimpan.' })
    } finally {
      setSaving(false)
    }
  }

  async function runAction(protocol, action) {
    busyRef.current = true
    setBusy(true)
    Swal.fire({
      title: action === 'connect' ? `Menghubungkan ${LABEL[protocol]}...` : `Memutuskan ${LABEL[protocol]}...`,
      text: action === 'connect' ? 'Menunggu CHR menjawab, bisa sampai beberapa detik.' : 'Mohon tunggu.',
      allowOutsideClick: false,
      allowEscapeKey: false,
      didOpen: () => Swal.showLoading(),
    })
    try {
      const response = await api.post(`${API}/action`, { protocol, action }, { timeout: 60000 })
      if (response.data.status) setStatus(response.data.status)
      const stillWaiting = action === 'connect' && !response.data.connected
      await fireSuccess(
        { title: stillWaiting ? 'Belum tersambung' : 'Berhasil', text: response.data.message, ...(stillWaiting ? { icon: 'warning' } : {}) },
        () => loadStatus({ quiet: true }),
      )
    } catch (error) {
      fireError({ title: 'Gagal', text: error.response?.data?.message || 'Aksi VPN gagal dijalankan.' })
      loadStatus({ quiet: true })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function handleConnect() {
    if (dirty) {
      await Swal.fire({
        title: 'Konfigurasi belum disimpan',
        text: 'Simpan konfigurasi terlebih dahulu sebelum menghubungkan.',
        icon: 'warning',
        confirmButtonText: 'OK',
      })
      return
    }
    if (!profiles[tab]) {
      await Swal.fire({
        title: 'Belum ada konfigurasi',
        text: `Isi dan simpan konfigurasi ${LABEL[tab]} terlebih dahulu.`,
        icon: 'warning',
        confirmButtonText: 'OK',
      })
      return
    }
    if (status?.protocol && status.protocol !== tab) {
      const confirm = await Swal.fire({
        title: `Ganti ke ${LABEL[tab]}?`,
        text: `${LABEL[status.protocol]} sedang aktif dan akan dimatikan lebih dulu.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Ya, ganti',
        cancelButtonText: 'Batal',
      })
      if (!confirm.isConfirmed) return
    }
    await runAction(tab, 'connect')
  }

  async function handleDisconnect() {
    const protocol = status?.protocol || tab
    const confirm = await Swal.fire({
      title: `Putuskan ${LABEL[protocol]}?`,
      text: 'Jika Anda mengakses server ini lewat tunnel VPN, akses akan terputus. NAS/router yang bergantung pada tunnel ini juga tidak bisa dijangkau.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, putuskan',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) return
    await runAction(protocol, 'disconnect')
  }

  const form = forms[tab]
  const active = status?.protocol
  const state = status?.state || 'disconnected'
  const tools = status?.tools?.[tab]
  const profile = profiles[tab]
  const toolsMissing = tools && !tools.installed
  const helperMissing = status && !status.is_root && !status.helper_installed
  const wg = status?.wireguard

  return (
    <section className="mx-auto max-w-4xl pb-8">
      <header className="mb-2">
        <p className="m-0 text-xs font-bold tracking-widest text-cyan-700 uppercase dark:text-cyan-400">Sistem</p>
        <h1 className="m-0 text-3xl font-bold tracking-tight text-slate-900 dark:text-gray-100">Koneksi VPN</h1>
        <p className="mt-1 mb-0 text-sm text-slate-500 dark:text-gray-400">
          Hubungkan server billing sebagai VPN client ke MikroTik CHR agar RADIUS dan API router dijangkau lewat tunnel.
        </p>
      </header>

      {/* Kartu status */}
      <div className={CARD} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ShieldCheck size={22} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Status Koneksi</h2>
          </div>
          {status ? <StateBadge state={state} /> : <span className="text-sm text-slate-500 dark:text-gray-400">Memuat...</span>}
        </div>

        {statusError && (
          <p className="mt-3 mb-0 text-sm font-semibold text-rose-700 dark:text-rose-400">{statusError}</p>
        )}

        {status && (
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <InfoItem label="Protokol aktif" value={active ? LABEL[active] : 'Tidak ada'} />
            <InfoItem label="IP VPN server" value={status.ip ? `${status.ip}${status.prefix ? `/${status.prefix}` : ''}` : ''} mono />
            <InfoItem label="Interface" value={status.interface || ''} mono />
            <InfoItem label="Aktif sejak" value={status.uptime_seconds !== null && active ? formatDuration(status.uptime_seconds) : ''} />
            {active === 'wireguard' && (
              <>
                <InfoItem label="Latest handshake" value={wg ? formatAge(wg.handshake_age_seconds) : 'Tidak dapat dibaca'} />
                <InfoItem label="Endpoint CHR" value={wg?.endpoint || ''} mono />
              </>
            )}
            {status.traffic && (
              <>
                <InfoItem label="Diterima (RX)" value={formatBytes(status.traffic.rx_bytes)} />
                <InfoItem label="Terkirim (TX)" value={formatBytes(status.traffic.tx_bytes)} />
              </>
            )}
          </dl>
        )}

        {status?.failed?.length > 0 && (
          <p className="mt-4 mb-0 text-sm font-semibold text-rose-700 dark:text-rose-400">
            Layanan gagal berjalan: {status.failed.map((item) => LABEL[item]).join(', ')}. Periksa konfigurasi lalu Hubungkan ulang.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className={BTN_NEUTRAL} onClick={() => loadStatus()} disabled={refreshing || busy}>
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            Refresh Status
          </button>
          <button type="button" className={BTN_SUCCESS} onClick={handleConnect} disabled={loading || busy || saving}>
            <Plug size={16} aria-hidden="true" />
            {active === tab ? 'Hubungkan Ulang' : 'Hubungkan'}
          </button>
          <button type="button" className={BTN_DANGER} onClick={handleDisconnect} disabled={loading || busy || saving || !active}>
            <Unplug size={16} aria-hidden="true" />
            Putuskan
          </button>
        </div>
      </div>

      {/* Pemilih protokol */}
      <div className={CARD}>
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Protokol VPN</h2>
        <div role="radiogroup" aria-label="Protokol VPN" className="mt-4 grid gap-3 md:grid-cols-3">
          {PROTOCOLS.map((item) => {
            const selected = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTab(item.id)}
                className={`rounded-xl border p-4 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${
                  selected
                    ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/30'
                    : 'border-gray-200 bg-white hover:border-gray-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600'
                }`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-slate-900 dark:text-gray-100">{item.label}</span>
                  {item.badge && (
                    <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[11px] font-bold text-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300">{item.badge}</span>
                  )}
                  {active === item.id && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">Aktif</span>
                  )}
                  {profiles[item.id] && active !== item.id && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600 dark:bg-slate-800 dark:text-gray-300">Tersimpan</span>
                  )}
                </span>
                <span className="mt-1 block text-xs text-slate-500 dark:text-gray-400">{item.desc}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Form per protokol */}
      <form className={CARD} onSubmit={handleSave} autoComplete="off">
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Konfigurasi {LABEL[tab]}</h2>

        {toolsMissing && (
          <div className="mt-4 flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              Paket {LABEL[tab]} belum terpasang di server ({tools.missing.join(', ')}). Pasang dengan:
              <code className="mt-1 block rounded bg-amber-100 px-2 py-1 font-mono text-xs dark:bg-amber-900/40">sudo {tools.hint}</code>
            </div>
          </div>
        )}
        {helperMissing && (
          <div className="mt-4 flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              Helper VPN belum terpasang, sehingga konfigurasi tidak bisa ditulis ke OS. Jalankan sebagai root:
              <code className="mt-1 block rounded bg-amber-100 px-2 py-1 font-mono text-xs dark:bg-amber-900/40">sudo bash deploy/install-vpn-helper.sh</code>
            </div>
          </div>
        )}

        {tab === 'wireguard' && (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="Endpoint CHR (IP/Domain:Port)" hint="Contoh: chr.contoh.net:51820">
              <input className={INPUT_CLASS} value={form.endpoint} onChange={(e) => setField('wireguard', 'endpoint', e.target.value)} placeholder="203.0.113.10:51820" required spellCheck={false} />
            </Field>
            <Field label="CHR Public Key" hint="Public key interface WireGuard di CHR.">
              <input className={INPUT_CLASS + MONO} value={form.server_public_key} onChange={(e) => setField('wireguard', 'server_public_key', e.target.value)} placeholder="44 karakter base64 berakhiran =" required spellCheck={false} />
            </Field>

            <Field label="Private Key (server ini)" className="md:col-span-2" hint={profile?.private_key_set && !form.private_key ? 'Tersimpan di server. Kosongkan untuk tetap memakainya.' : 'Tekan Generate Keypair atau tempel private key yang sudah ada.'}>
              <div className="flex gap-2">
                <input
                  className={INPUT_CLASS + MONO}
                  type={showPrivate ? 'text' : 'password'}
                  value={form.private_key}
                  onChange={(e) => {
                    setField('wireguard', 'private_key', e.target.value)
                    if (e.target.value) setPublicKey('')
                  }}
                  placeholder={profile?.private_key_set ? '(tersimpan)' : ''}
                  spellCheck={false}
                  autoComplete="new-password"
                />
                <button type="button" className={BTN_NEUTRAL} onClick={() => setShowPrivate((v) => !v)} aria-label={showPrivate ? 'Sembunyikan private key' : 'Tampilkan private key'}>
                  {showPrivate ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                </button>
                <button type="button" className={BTN_PRIMARY} onClick={handleKeygen}>
                  <KeyRound size={16} aria-hidden="true" />
                  <span className="whitespace-nowrap">Generate Keypair</span>
                </button>
              </div>
            </Field>

            <Field label="Public Key server ini (salin ke peer di CHR)" className="md:col-span-2" hint={publicKey ? 'Di CHR: /interface wireguard peers add interface=<wg-chr> public-key="<kunci di atas>" allowed-address=<IP Client>/32' : 'Akan tampil setelah keypair dibuat atau konfigurasi tersimpan.'}>
              <div className="flex gap-2">
                <input className={INPUT_CLASS + MONO} value={publicKey} readOnly placeholder="-" onFocus={(e) => e.target.select()} />
                <button type="button" className={BTN_NEUTRAL} onClick={handleCopy} disabled={!publicKey}>
                  {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  {copied ? 'Tersalin' : 'Copy'}
                </button>
              </div>
            </Field>

            <Field label="Preshared Key (opsional)" hint={profile?.preshared_key_set && !form.preshared_key ? 'Tersimpan di server. Kosongkan untuk tetap memakainya.' : 'Harus sama dengan yang ada di peer CHR.'}>
              <input className={INPUT_CLASS + MONO} type="password" value={form.preshared_key} onChange={(e) => setField('wireguard', 'preshared_key', e.target.value)} placeholder={profile?.preshared_key_set ? '(tersimpan)' : ''} spellCheck={false} autoComplete="new-password" />
              {profile?.preshared_key_set && (
                <span className="mt-1 inline-flex items-center gap-2 text-xs text-slate-600 dark:text-gray-400">
                  <input type="checkbox" checked={form.clear_preshared_key} onChange={(e) => setField('wireguard', 'clear_preshared_key', e.target.checked)} />
                  Hapus preshared key tersimpan
                </span>
              )}
            </Field>
            <Field label="IP Address Client" hint="IP server ini di tunnel. Contoh: 10.10.99.2/24">
              <input className={INPUT_CLASS} value={form.address} onChange={(e) => setField('wireguard', 'address', e.target.value)} placeholder="10.10.99.2/24" required spellCheck={false} />
            </Field>

            <Field label="Allowed IPs / Subnet NAS" className="md:col-span-2" hint="Pisahkan dengan koma. Contoh: 10.10.99.0/24, 192.168.88.0/24">
              <input className={INPUT_CLASS} value={form.allowed_ips} onChange={(e) => setField('wireguard', 'allowed_ips', e.target.value)} placeholder="10.10.99.0/24" required spellCheck={false} />
              <span className={`flex gap-2 rounded-lg border p-2.5 text-xs ${tooWide(form.allowed_ips) ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300' : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200'}`}>
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  <b>Jangan isi 0.0.0.0/0</b> (atau subnet lebih luas dari /8). Seluruh trafik server akan masuk tunnel dan akses ke VPS/SSH terputus.
                  Isi hanya subnet tunnel dan subnet NAS/router yang perlu dijangkau.
                </span>
              </span>
            </Field>

            <Field label="Persistent Keepalive (detik)" hint="Default 25. Menjaga NAT tetap terbuka dan mempercepat deteksi putus.">
              <input className={INPUT_CLASS} type="number" min="0" max="3600" value={form.keepalive} onChange={(e) => setField('wireguard', 'keepalive', e.target.value)} />
            </Field>
            <Field label="MTU (opsional)" hint="Kosongkan untuk default (1420). Turunkan ke 1380 bila koneksi lewat PPPoE/tunnel lain.">
              <input className={INPUT_CLASS} type="number" min="1280" max="1500" value={form.mtu} onChange={(e) => setField('wireguard', 'mtu', e.target.value)} placeholder="1420" />
            </Field>
          </div>
        )}

        {tab === 'openvpn' && (
          <div className="mt-5 grid gap-4">
            <Field label="File konfigurasi .ovpn" hint="Sertifikat/kunci harus inline (<ca>, <cert>, <key>, <tls-crypt>). Direktif skrip (up/down/plugin), rujukan berkas, dan redirect-gateway ditolak demi keamanan.">
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileRef} type="file" accept=".ovpn,.conf,text/plain" className="hidden" onChange={handleFile} />
                <button type="button" className={BTN_NEUTRAL} onClick={() => fileRef.current?.click()}>
                  <Upload size={16} aria-hidden="true" />
                  Upload .ovpn
                </button>
                <span className="text-xs text-slate-500 dark:text-gray-400">atau tempel isinya di bawah</span>
              </div>
              <textarea
                className={`${INPUT_CLASS}${MONO} h-56 resize-y py-2`}
                value={form.ovpn_config}
                onChange={(e) => setField('openvpn', 'ovpn_config', e.target.value)}
                placeholder={profile?.ovpn_set ? `(tersimpan: ${profile.ovpn_lines} baris, remote ${profile.ovpn_remote || '-'}) — kosongkan untuk tetap memakainya` : 'client\ndev tun\nproto tcp\nremote chr.contoh.net 1194\n...'}
                spellCheck={false}
              />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Username (opsional)" hint="Isi bila CHR memakai auth-user-pass. Kosongkan untuk menghapus kredensial tersimpan.">
                <input className={INPUT_CLASS} value={form.username} onChange={(e) => setField('openvpn', 'username', e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Password (opsional)" hint={profile?.password_set && !form.password ? 'Tersimpan di server. Kosongkan untuk tetap memakainya.' : undefined}>
                <input className={INPUT_CLASS} type="password" value={form.password} onChange={(e) => setField('openvpn', 'password', e.target.value)} placeholder={profile?.password_set ? '(tersimpan)' : ''} autoComplete="new-password" />
              </Field>
            </div>
          </div>
        )}

        {tab === 'sstp' && (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="Server CHR (IP/Domain:Port)" hint="Port default 443. Contoh: chr.contoh.net:443">
              <input className={INPUT_CLASS} value={form.server} onChange={(e) => setField('sstp', 'server', e.target.value)} placeholder="chr.contoh.net:443" required spellCheck={false} />
            </Field>
            <Field label="Subnet Route NAS (opsional)" hint="Subnet yang dijangkau lewat tunnel. Contoh: 10.10.99.0/24. Jangan 0.0.0.0/0.">
              <input className={INPUT_CLASS} value={form.routes} onChange={(e) => setField('sstp', 'routes', e.target.value)} placeholder="10.10.99.0/24" spellCheck={false} />
            </Field>
            <Field label="Username">
              <input className={INPUT_CLASS} value={form.username} onChange={(e) => setField('sstp', 'username', e.target.value)} required autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Password" hint={profile?.password_set && !form.password ? 'Tersimpan di server. Kosongkan untuk tetap memakainya.' : undefined}>
              <input className={INPUT_CLASS} type="password" value={form.password} onChange={(e) => setField('sstp', 'password', e.target.value)} placeholder={profile?.password_set ? '(tersimpan)' : ''} autoComplete="new-password" />
            </Field>
            <label className="flex items-start gap-2 text-sm text-slate-700 md:col-span-2 dark:text-gray-300">
              <input type="checkbox" className="mt-1" checked={form.ignore_cert} onChange={(e) => setField('sstp', 'ignore_cert', e.target.checked)} />
              <span>
                Abaikan validasi sertifikat (<code className="font-mono text-xs">--cert-warn</code>)
                <span className="block text-xs text-slate-500 dark:text-gray-400">Centang bila CHR memakai sertifikat self-signed. Koneksi tetap terenkripsi, tetapi identitas server tidak diverifikasi.</span>
              </span>
            </label>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" className={BTN_PRIMARY} disabled={loading || saving || busy}>
            <Save size={16} aria-hidden="true" />
            {saving ? 'Menyimpan...' : 'Simpan Konfigurasi'}
          </button>
          {dirty && <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">Ada perubahan yang belum disimpan</span>}
        </div>
      </form>
    </section>
  )
}

export default VpnConfig
