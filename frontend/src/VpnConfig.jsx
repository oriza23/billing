import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Check, Copy, Eye, EyeOff, KeyRound, Plug, RefreshCw, Save, ShieldCheck, Unplug, Upload,
} from 'lucide-react'
import Swal from 'sweetalert2'
import api from './api/axios.js'
import { fireError, fireSuccess } from './swals.js'

const API = '/sistem/vpn'
const LIVE_POLL_MS = 2000
const MAX_OVPN_BYTES = 64 * 1024

const PROTOCOLS = [
  { id: 'wireguard', label: 'WireGuard', badge: 'Disarankan', desc: 'Paling cepat dan latensi terendah (UDP, modul kernel Linux).' },
  { id: 'openvpn', label: 'OpenVPN', desc: 'Kompatibel luas, memakai file konfigurasi .ovpn.' },
  { id: 'sstp', label: 'SSTP', desc: 'Lewat TCP 443, mudah menembus firewall yang ketat.' },
  { id: 'l2tp', label: 'L2TP', desc: 'Kompatibel luas dengan MikroTik, mendukung L2TP murni atau L2TP/IPsec.' },
]
const LABEL = { wireguard: 'WireGuard', openvpn: 'OpenVPN', sstp: 'SSTP', l2tp: 'L2TP' }

const EMPTY_FORMS = {
  wireguard: {
    endpoint: '', server_public_key: '', private_key: '', preshared_key: '', address: '', allowed_ips: '', keepalive: '15', mtu: '', clear_preshared_key: false,
  },
  openvpn: { ovpn_config: '', username: '', password: '' },
  sstp: { server: '', username: '', password: '', routes: '', ignore_cert: true },
  l2tp: { server: '', username: '', password: '', routes: '', ipsec_secret: '', clear_ipsec_secret: false },
}

const CARD = 'mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900'
const LABEL_CLASS = 'text-xs font-bold text-slate-600 dark:text-gray-400'
const INPUT_CLASS = 'h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-slate-800 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-950 dark:text-gray-100'
const MONO = ' font-mono text-[13px]'
const BTN = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-bold shadow-sm transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50'
const BTN_PRIMARY = `${BTN} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500/40`
const BTN_SUCCESS = `${BTN} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500/40`
const BTN_DANGER = `${BTN} bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-500/40`
const BTN_AMBER = `${BTN} bg-amber-500 text-white shadow-sm hover:bg-amber-600 focus:ring-amber-500/40 dark:bg-amber-600 dark:hover:bg-amber-500`
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function logHtml(message, lines) {
  const body = lines.map(escapeHtml).join('\n')
  return `<div style="text-align:left"><p style="margin:0 0 8px">${escapeHtml(message)}</p>`
    + `<p style="margin:0 0 4px;font-size:12px;font-weight:700">Log layanan (${lines.length} baris terakhir):</p>`
    + `<pre style="margin:0;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px;font-size:11px;line-height:1.45">${body}</pre></div>`
}

function formatRate(deltaBytes, elapsedMs) {
  if (!Number.isFinite(deltaBytes) || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || deltaBytes < 0) return null
  const kbps = (deltaBytes * 8) / elapsedMs
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`
  return `${(kbps >= 10 ? kbps.toFixed(0) : kbps.toFixed(1))} Kbps`
}

function formatMs(ping) {
  if (!ping || ping.status !== 'ok' || ping.ms == null || !Number.isFinite(Number(ping.ms))) return 'Timeout'
  const ms = Math.round(Number(ping.ms) * 10) / 10
  return `${Number.isInteger(ms) ? ms.toFixed(0) : ms.toFixed(1)} ms`
}

function latencyClass(ping) {
  if (!ping || ping.status !== 'ok' || ping.ms == null || !Number.isFinite(Number(ping.ms))) {
    return 'text-rose-600 dark:text-rose-400'
  }
  const ms = Number(ping.ms)
  if (ms < 50) return 'text-emerald-600 dark:text-emerald-400'
  if (ms <= 150) return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
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
  const l2tp = profiles.l2tp
  return {
    wireguard: wg
      ? {
          ...EMPTY_FORMS.wireguard,
          endpoint: wg.endpoint || '',
          server_public_key: wg.server_public_key || '',
          address: wg.address || '',
          allowed_ips: wg.allowed_ips || '',
          keepalive: String(wg.keepalive ?? 15),
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
    l2tp: l2tp
      ? {
          ...EMPTY_FORMS.l2tp,
          server: l2tp.server || '',
          username: l2tp.username || '',
          routes: l2tp.routes || '',
        }
      : { ...EMPTY_FORMS.l2tp },
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

function PingPublic({ ping }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-slate-500 dark:text-gray-400">Ping Public CHR</dt>
      <dd className="m-0 mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        <span className={`truncate text-slate-900 dark:text-gray-100${MONO}`}>{ping?.target || '-'}</span>
        <span className={latencyClass(ping)}>{ping?.target ? formatMs(ping) : '-'}</span>
      </dd>
    </div>
  )
}

function PingTunnel({ ping }) {
  const ok = ping?.status === 'ok'
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-slate-500 dark:text-gray-400">Ping Tunnel VPN</dt>
      <dd className="m-0 mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
        <span className={`truncate text-slate-900 dark:text-gray-100${MONO}`}>{ping?.target || '-'}</span>
        {ping?.target && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${ok ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300'}`}>
            {ok ? 'Terhubung' : 'Timeout'}
          </span>
        )}
        <span className={latencyClass(ping)}>{ping?.target ? formatMs(ping) : '-'}</span>
      </dd>
    </div>
  )
}

function trafficLabel(traffic, direction, rate) {
  if (!traffic) return ''
  const bytes = direction === 'rx' ? traffic.rx_bytes : traffic.tx_bytes
  const text = traffic[direction] || formatBytes(bytes)
  return rate ? `${text} · ${rate}` : text
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
  const sampleRef = useRef(null)
  const inflightRef = useRef(false)
  const [rates, setRates] = useState({ rx: null, tx: null })
  const [connectLog, setConnectLog] = useState({ protocol: '', lines: [] })

  const rememberStatus = useCallback((data) => {
    setStatus(data)
    const traffic = data?.traffic
    const live = data?.state === 'connected' && traffic && Number.isFinite(Number(traffic.rx_bytes)) && Number.isFinite(Number(traffic.tx_bytes))
    if (!live) {
      sampleRef.current = null
      setRates({ rx: null, tx: null })
      return
    }
    const rx = Number(traffic.rx_bytes)
    const tx = Number(traffic.tx_bytes)
    const now = Date.now()
    const prev = sampleRef.current
    if (prev && prev.iface === data.interface && now > prev.at) {
      setRates({
        rx: formatRate(rx - prev.rx, now - prev.at),
        tx: formatRate(tx - prev.tx, now - prev.at),
      })
    } else if (prev && prev.iface !== data.interface) {
      setRates({ rx: null, tx: null })
    }
    sampleRef.current = { rx, tx, at: now, iface: data.interface }
  }, [])

  const loadStatus = useCallback(async ({ quiet = false } = {}) => {
    if (inflightRef.current) return
    inflightRef.current = true
    if (!quiet) setRefreshing(true)
    try {
      const response = await api.get(`${API}/status`)
      rememberStatus(response.data)
      setStatusError('')
    } catch (error) {
      setStatusError(error.response?.data?.message || 'Status VPN gagal dimuat.')
    } finally {
      inflightRef.current = false
      if (!quiet) setRefreshing(false)
    }
  }, [rememberStatus])

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
          rememberStatus(statusResult.value.data)
          setStatusError('')
        } else {
          rememberStatus({ state: 'disconnected', connected: false, ip: null, protocol: null })
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
          rememberStatus({ state: 'disconnected', connected: false, ip: null, protocol: null })
          setStatusError(error.response?.data?.message || 'Konfigurasi VPN gagal dimuat.')
        }
      } finally {
        if (!ignore) setLoading(false)
      }
    }
    init()
    return () => { ignore = true }
  }, [applyProfiles, rememberStatus])

  useEffect(() => {
    if (status?.state !== 'connected') return undefined
    let timer = null
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const tick = () => {
      if (document.hidden || busyRef.current) return
      loadStatus({ quiet: true })
    }
    const start = () => {
      stop()
      timer = setInterval(tick, LIVE_POLL_MS)
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
        return
      }
      tick()
      start()
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [status?.state, loadStatus])

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

  async function runRestart(protocol) {
    busyRef.current = true
    setBusy(true)
    Swal.fire({
      title: `Me-restart ${LABEL[protocol]}...`,
      text: 'Layanan VPN di-restart, tunggu sampai IP/handshake kembali.',
      allowOutsideClick: false,
      allowEscapeKey: false,
      didOpen: () => Swal.showLoading(),
    })
    try {
      const response = await api.post(`${API}/restart`, { protocol }, { timeout: 60000 })
      if (response.data.status) rememberStatus(response.data.status)
      const connected = Boolean(response.data.connected)
      const lines = Array.isArray(response.data.log) ? response.data.log : []
      setConnectLog(!connected && lines.length ? { protocol, lines } : { protocol: '', lines: [] })
      const popup = !connected && lines.length
        ? { title: 'Restart gagal', html: logHtml(response.data.message, lines), icon: 'error', width: 640 }
        : { title: 'Restart berhasil', text: response.data.message, icon: 'success' }
      await fireSuccess(popup, () => loadStatus({ quiet: true }))
    } catch (error) {
      const lines = error.response?.data?.log
      if (Array.isArray(lines) && lines.length) {
        await Swal.fire({ title: 'Restart gagal', html: logHtml(error.response?.data?.message || 'Restart VPN gagal.', lines), icon: 'error', width: 640 })
      } else {
        fireError({ title: 'Restart gagal', text: error.response?.data?.message || 'Restart VPN gagal dijalankan.' })
      }
      loadStatus({ quiet: true })
    } finally {
      busyRef.current = false
      setBusy(false)
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
      if (response.data.status) rememberStatus(response.data.status)
      const stillWaiting = action === 'connect' && !response.data.connected
      const lines = Array.isArray(response.data.log) ? response.data.log : []
      setConnectLog(stillWaiting && lines.length ? { protocol, lines } : { protocol: '', lines: [] })
      const popup = stillWaiting && lines.length
        ? { title: 'Belum tersambung', html: logHtml(response.data.message, lines), icon: 'warning', width: 640 }
        : { title: stillWaiting ? 'Belum tersambung' : 'Berhasil', text: response.data.message, ...(stillWaiting ? { icon: 'warning' } : {}) }
      await fireSuccess(popup, () => loadStatus({ quiet: true }))
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

  async function handleRestartVpn() {
    const units = status?.units || {}
    const foreignActive = PROTOCOLS.some(
      (item) => item.id !== tab && ['active', 'activating', 'reloading'].includes(units[item.id]),
    )
    const protocol =
      status?.protocol ||
      (units[tab] === 'failed' && !foreignActive ? tab : null)
    if (!protocol) {
      await Swal.fire({
        title: 'Tidak ada VPN untuk di-restart',
        text: 'Hubungkan VPN terlebih dahulu, atau pilih protokol yang status unit-nya failed.',
        icon: 'info',
        confirmButtonText: 'OK',
      })
      return
    }
    if (dirty && tab === protocol) {
      await Swal.fire({
        title: 'Konfigurasi belum disimpan',
        text: 'Simpan konfigurasi terlebih dahulu sebelum me-restart VPN.',
        icon: 'warning',
        confirmButtonText: 'OK',
      })
      return
    }
    if (!profiles?.[protocol]) {
      await Swal.fire({
        title: 'Belum ada konfigurasi',
        text: `Simpan konfigurasi ${LABEL[protocol]} terlebih dahulu.`,
        icon: 'warning',
        confirmButtonText: 'OK',
      })
      return
    }
    const confirm = await Swal.fire({
      title: `Restart ${LABEL[protocol]}?`,
      text: 'Koneksi VPN akan terputus sebentar lalu disambung ulang dengan konfigurasi yang sama. Trafik RADIUS mungkin terhambat beberapa detik.',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Ya, restart',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) return
    await runRestart(protocol)
  }

  const form = forms?.[tab] || EMPTY_FORMS[tab] || {}
  const active = status?.protocol
  const state = status?.state || 'disconnected'
  const tools = status?.tools?.[tab]
  const profile = profiles?.[tab]
  const toolsMissing = tools && !tools.installed
  const helperMissing = status && !status.is_root && !status.helper_installed
  const wg = status?.wireguard
  // Semua nilai dibaca setelah deklarasi di atas (const tidak di-hoist) dan aman saat status/profil
  // belum dimuat dari API (status null, units/profiles undefined).
  const unitStates = status?.units || {}
  const otherVpnRunning = PROTOCOLS.some(
    (item) => item.id !== tab && ['active', 'activating', 'reloading'].includes(unitStates[item.id]),
  )
  const restartProtocol =
    active || (unitStates[tab] === 'failed' && !otherVpnRunning ? tab : null)
  const canRestartVpn = Boolean(
    restartProtocol &&
      profiles?.[restartProtocol] &&
      !loading &&
      !(dirty && tab === restartProtocol) &&
      (active === restartProtocol || (unitStates[restartProtocol] === 'failed' && !otherVpnRunning)),
  )

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
            {(status.traffic || state === 'connected') && (
              <>
                <InfoItem label="Diterima (RX)" value={trafficLabel(status.traffic, 'rx', rates.rx)} />
                <InfoItem label="Terkirim (TX)" value={trafficLabel(status.traffic, 'tx', rates.tx)} />
              </>
            )}
            {state === 'connected' && (
              <>
                <PingPublic ping={status.ping?.public} />
                <PingTunnel ping={status.ping?.tunnel} />
              </>
            )}
          </dl>
        )}

        {status?.failed?.length > 0 && state !== 'connected' && !status.connected && (
          <p className="mt-4 mb-0 text-sm font-semibold text-rose-700 dark:text-rose-400">
            Layanan gagal berjalan: {status.failed.map((item) => LABEL[item]).join(', ')}. Periksa konfigurasi lalu Hubungkan ulang.
          </p>
        )}

        {connectLog.lines.length > 0 && state !== 'connected' && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <p className="m-0 text-xs font-bold text-slate-600 dark:text-gray-400">Log {LABEL[connectLog.protocol]} ({connectLog.lines.length} baris terakhir)</p>
              <button type="button" className="text-xs font-bold text-blue-600 hover:underline dark:text-blue-400" onClick={() => setConnectLog({ protocol: '', lines: [] })}>Tutup</button>
            </div>
            <pre className="mt-1 mb-0 max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-slate-200">{connectLog.lines.join('\n')}</pre>
          </div>
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
          <button
            type="button"
            className={BTN_AMBER}
            onClick={handleRestartVpn}
            disabled={loading || saving || busy || !canRestartVpn}
            title={
              canRestartVpn
                ? `Restart layanan ${LABEL[restartProtocol] || 'VPN'} yang sedang aktif`
                : 'Tersedia bila ada VPN terhubung atau protokol terpilih dalam status failed (dengan konfigurasi tersimpan)'
            }
          >
            <RefreshCw size={16} className={busy || loading ? 'animate-spin' : ''} aria-hidden="true" />
            Restart VPN
          </button>
        </div>
      </div>

      {/* Pemilih protokol */}
      <div className={CARD}>
        <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Protokol VPN</h2>
        <div role="radiogroup" aria-label="Protokol VPN" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        {tools?.device_missing && (
          <div className="mt-4 flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200" role="alert">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              Device <code className="font-mono text-xs">{tools.device_missing}</code> tidak ada di server, sehingga {LABEL[tab]} tidak akan bisa berjalan.
              <span className="mt-1 block text-xs">{tools.device_hint}</span>
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

            <Field label="Persistent Keepalive (detik)" hint="Default 15. Menjaga NAT tetap terbuka dan mempercepat deteksi putus.">
              <input className={INPUT_CLASS} type="number" min="0" max="3600" value={form.keepalive} onChange={(e) => setField('wireguard', 'keepalive', e.target.value)} />
            </Field>
            <Field label="MTU (opsional)" hint="Kosongkan untuk default (1380, aman melewati jalur PPPoE tanpa fragmentasi). Isi manual bila perlu nilai lain.">
              <input className={INPUT_CLASS} type="number" min="1280" max="1500" value={form.mtu} onChange={(e) => setField('wireguard', 'mtu', e.target.value)} placeholder="1380" />
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
                <span className="block text-xs text-slate-500 dark:text-gray-400">Aktif secara default karena sertifikat bawaan CHR umumnya self-signed. Koneksi tetap terenkripsi, tetapi identitas server tidak diverifikasi. Hilangkan centang bila CHR memakai sertifikat dari CA tepercaya.</span>
              </span>
            </label>
          </div>
        )}

        {tab === 'l2tp' && (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="Server CHR (IP/Domain:Port)" hint="Port default UDP 1701. Contoh: chr.contoh.net atau 203.0.113.10:1701">
              <input className={INPUT_CLASS} value={form.server} onChange={(e) => setField('l2tp', 'server', e.target.value)} placeholder="chr.contoh.net" required spellCheck={false} />
            </Field>
            <Field label="Subnet Route NAS (opsional)" hint="Subnet yang dijangkau lewat tunnel. Contoh: 10.210.0.0/24. Jangan 0.0.0.0/0.">
              <input className={INPUT_CLASS} value={form.routes} onChange={(e) => setField('l2tp', 'routes', e.target.value)} placeholder="10.210.0.0/24" spellCheck={false} />
            </Field>
            <Field label="Username" hint="PPP secret di CHR.">
              <input className={INPUT_CLASS} value={form.username} onChange={(e) => setField('l2tp', 'username', e.target.value)} required autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Password" hint={profile?.password_set && !form.password ? 'Tersimpan di server. Kosongkan untuk tetap memakainya.' : undefined}>
              <input className={INPUT_CLASS} type="password" value={form.password} onChange={(e) => setField('l2tp', 'password', e.target.value)} placeholder={profile?.password_set ? '(tersimpan)' : ''} autoComplete="new-password" />
            </Field>
            <Field
              label="IPsec Pre-Shared Key (opsional)"
              className="md:col-span-2"
              hint={profile?.ipsec_secret_set && !form.ipsec_secret
                ? 'Tersimpan di server (mode L2TP/IPsec). Kosongkan untuk tetap memakainya.'
                : 'Kosongkan untuk L2TP murni tanpa IPsec. Isi sama dengan IPsec Secret di L2TP server CHR untuk L2TP/IPsec.'}
            >
              <input className={INPUT_CLASS + MONO} type="password" value={form.ipsec_secret} onChange={(e) => setField('l2tp', 'ipsec_secret', e.target.value)} placeholder={profile?.ipsec_secret_set ? '(tersimpan)' : ''} spellCheck={false} autoComplete="new-password" />
              {profile?.ipsec_secret_set && (
                <span className="mt-1 inline-flex items-center gap-2 text-xs text-slate-600 dark:text-gray-400">
                  <input type="checkbox" checked={form.clear_ipsec_secret} onChange={(e) => setField('l2tp', 'clear_ipsec_secret', e.target.checked)} />
                  Hapus IPsec key tersimpan (pindah ke L2TP murni)
                </span>
              )}
              {tools && tools.installed && tools.ipsec_installed === false && (form.ipsec_secret || (profile?.ipsec_secret_set && !form.clear_ipsec_secret)) && (
                <span className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    Paket IPsec (swanctl) belum terpasang di server, Hubungkan akan ditolak selama PSK terisi. Pasang dengan:
                    <code className="mt-1 block rounded bg-amber-100 px-2 py-1 font-mono text-xs dark:bg-amber-900/40">sudo {tools.ipsec_hint}</code>
                  </span>
                </span>
              )}
            </Field>
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
