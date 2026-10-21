import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Flag, X } from 'lucide-react'
import Swal from 'sweetalert2'
import {
  createAcsServer,
  deleteAcsDevices,
  deleteAcsServer,
  getAcsDevices,
  getAcsServers,
  rebootAcsDevices,
  resetAcsDevices,
  summonAcsDevices,
  syncAcs,
} from './api/acs.js'
import ServerPagination from './ServerPagination.jsx'

const SERVER_STORAGE_KEY = 'acs_server_id'
const LIMIT_OPTIONS = [10, 50, 100]
const FILTER_OPTIONS = [
  { value: 'all', label: 'Semua ONU' },
  { value: 'online', label: 'Online' },
  { value: 'off24', label: 'Off < 24 Jam' },
  { value: 'off24plus', label: 'Off > 24 Jam' },
]
const EMPTY_STATS = { total: 0, online: 0, off24: 0, off24plus: 0 }
// ONU dianggap online bila inform terakhirnya tidak lebih lama dari ini.
const ONLINE_WINDOW_MINUTES = 30
const EMPTY_SERVER_FORM = { nama_server: '', ip_domain: '', port: '7557' }

const COLUMNS = [
  'FLAG', 'USERNAME', 'IP PPPOE', 'IP TR069', 'SN ONU', 'PON', 'MANUFAKTUR', 'TYPE', 'SSID',
  'USER', 'RX ONU', 'TEMP', 'UPTIME', 'LAST INFORM', 'REGISTERED', 'DEVICE ID', 'TAGS',
]

const STAT_CARDS = [
  { key: 'total', label: 'TOTAL ONU', className: 'bg-blue-600 shadow-blue-600/30' },
  { key: 'online', label: 'ONLINE', className: 'bg-green-600 shadow-green-600/30' },
  { key: 'off24', label: 'OFF < 24H', className: 'bg-orange-500 shadow-orange-500/30' },
  { key: 'off24plus', label: 'OFF > 24H', className: 'bg-red-600 shadow-red-600/30' },
]

const FLAG_STYLE = {
  online: { className: 'text-green-500', title: 'Online' },
  off24: { className: 'text-orange-500', title: 'Off kurang dari 24 jam' },
  off24plus: { className: 'text-red-500', title: 'Off lebih dari 24 jam' },
}

const btnBase =
  'inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border-0 px-5 text-[13px] font-bold tracking-wide text-white shadow-sm transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50'
const inputBase =
  'h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
const thClass =
  'whitespace-nowrap border-b border-gray-200 bg-gray-50 px-3 py-3 text-left text-[11px] font-bold tracking-wider text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
const tdClass = 'whitespace-nowrap px-3 py-2.5 text-[13px] text-gray-700 dark:text-gray-200'

// Tombol aksi multi-select. `run` menerima (serverId, ids) dan mengembalikan hasil backend.
const BULK_ACTIONS = [
  {
    key: 'summon',
    label: 'SUMMON',
    className: 'bg-cyan-600 hover:bg-cyan-700',
    run: summonAcsDevices,
    confirm: { title: 'Summon ONU?', text: (n) => `${n} ONU akan dipaksa inform/refresh.`, button: 'Ya, Summon' },
  },
  {
    key: 'reboot',
    label: 'REBOOT',
    className: 'bg-amber-500 hover:bg-amber-600',
    run: rebootAcsDevices,
    confirm: { title: 'Reboot ONU?', text: (n) => `${n} ONU akan di-reboot.`, button: 'Ya, Reboot' },
  },
  {
    key: 'delete',
    label: 'DELETE',
    className: 'bg-red-600 hover:bg-red-700',
    run: deleteAcsDevices,
    clearsSelection: true,
    reloads: true,
    confirm: {
      title: 'Hapus ONU?',
      text: (n) => `${n} ONU akan dihapus dari GenieACS dan dari database web. Tindakan ini tidak dapat dibatalkan.`,
      button: 'Ya, Hapus',
      danger: true,
    },
  },
  {
    key: 'reset',
    label: 'RESET',
    className: 'bg-purple-600 hover:bg-purple-700',
    run: resetAcsDevices,
    confirm: {
      title: 'Factory Reset ONU?',
      text: (n) => `${n} ONU akan di-reset ke pengaturan pabrik. Semua konfigurasi ONU akan hilang!`,
      button: 'Ya, Reset',
      danger: true,
    },
  },
]

function errorMessage(error, fallback) {
  return error?.response?.data?.message || fallback
}

function formatDate(value) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' })
}

function readStoredServerId() {
  const stored = Number(localStorage.getItem(SERVER_STORAGE_KEY))
  return Number.isInteger(stored) && stored > 0 ? stored : null
}

function ServerModal({ servers, onClose, onChanged }) {
  const [form, setForm] = useState(EMPTY_SERVER_FORM)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    try {
      const result = await createAcsServer({
        nama_server: form.nama_server.trim(),
        ip_domain: form.ip_domain.trim(),
        port: form.port === '' ? undefined : Number(form.port),
      })
      setForm(EMPTY_SERVER_FORM)
      await onChanged(result.id)
      Swal.fire({ icon: 'success', title: 'Berhasil!', text: 'Server ACS disimpan', timer: 1500, showConfirmButton: false })
    } catch (error) {
      Swal.fire({ icon: 'error', title: 'Gagal', text: errorMessage(error, 'Gagal menyimpan server ACS.') })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(server) {
    const confirm = await Swal.fire({
      title: `Hapus server "${server.nama_server}"?`,
      text: 'Data ONU server ini di database web ikut dihapus (data di GenieACS tidak berubah).',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, Hapus!',
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) {
      return
    }
    setDeletingId(server.id)
    try {
      await deleteAcsServer(server.id)
      await onChanged(null, server.id)
    } catch (error) {
      Swal.fire({ icon: 'error', title: 'Gagal', text: errorMessage(error, 'Gagal menghapus server ACS.') })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        className="max-h-[90svh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-800"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acs-server-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="acs-server-title" className="m-0 text-lg font-bold text-gray-900 dark:text-gray-100">Server ACS</h2>
          <button
            type="button"
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            aria-label="Tutup"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <form className="grid gap-3" onSubmit={handleSubmit}>
          <label className="grid gap-1 text-[13px] font-semibold text-gray-700 dark:text-gray-200">
            Nama Server
            <input
              className={inputBase}
              type="text"
              maxLength={100}
              placeholder="ACS Pusat"
              value={form.nama_server}
              onChange={(event) => updateField('nama_server', event.target.value)}
              required
            />
          </label>
          <label className="grid gap-1 text-[13px] font-semibold text-gray-700 dark:text-gray-200">
            IP / Domain (Publik atau Lokal)
            <input
              className={inputBase}
              type="text"
              placeholder="192.168.1.10 atau acs.contoh.com"
              value={form.ip_domain}
              onChange={(event) => updateField('ip_domain', event.target.value)}
              required
            />
          </label>
          <label className="grid gap-1 text-[13px] font-semibold text-gray-700 dark:text-gray-200">
            Port NBI
            <input
              className={inputBase}
              type="number"
              min={1}
              max={65535}
              placeholder="7557"
              value={form.port}
              onChange={(event) => updateField('port', event.target.value)}
            />
          </label>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className={`${btnBase} bg-gray-500 hover:bg-gray-600`} onClick={onClose}>
              BATAL
            </button>
            <button type="submit" className={`${btnBase} bg-blue-600 hover:bg-blue-700`} disabled={saving}>
              {saving ? 'MENYIMPAN...' : 'SIMPAN'}
            </button>
          </div>
        </form>

        <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
          <h3 className="m-0 mb-2 text-[13px] font-bold tracking-wider text-gray-500 uppercase dark:text-gray-400">
            Server tersimpan
          </h3>
          {servers.length === 0 ? (
            <p className="m-0 text-sm text-gray-500 dark:text-gray-400">Belum ada server ACS.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {servers.map((server) => (
                <li
                  key={server.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
                >
                  <div className="min-w-0">
                    <p className="m-0 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{server.nama_server}</p>
                    <p className="m-0 truncate text-xs text-gray-500 dark:text-gray-400">{server.ip_domain}:{server.port}</p>
                  </div>
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border-0 bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
                    onClick={() => handleDelete(server)}
                    disabled={deletingId === server.id}
                  >
                    {deletingId === server.id ? '...' : 'HAPUS'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

const IPV4_PATTERN = /(\d{1,3}(?:\.\d{1,3}){3})/
const IPV4_EXACT = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

// Nilai dipakai sebagai href, jadi hanya IPv4 valid yang lolos (bukan 0.0.0.0 / loopback).
function cleanIp(value) {
  const ip = typeof value === 'string' ? value.trim() : ''
  return IPV4_EXACT.test(ip) && ip !== '0.0.0.0' && !ip.startsWith('127.') ? ip : null
}

// Anak (instance) sebuah node parameter: "1", "2", ... (kunci berawalan "_" adalah metadata).
function instancesOf(node) {
  return node && typeof node === 'object'
    ? Object.keys(node).filter((key) => !key.startsWith('_')).map((key) => node[key])
    : []
}

// IP TR069: _ip di root, atau IP dalam _connectionRequestURL / ManagementServer.ConnectionRequestURL.
function extractIpTr069(doc) {
  const rawUrl = doc._connectionRequestURL
    ?? doc.InternetGatewayDevice?.ManagementServer?.ConnectionRequestURL?._value
    ?? doc.Device?.ManagementServer?.ConnectionRequestURL?._value
  const fromUrl = typeof rawUrl === 'string' ? rawUrl.match(IPV4_PATTERN)?.[1] : null
  return cleanIp(typeof doc._ip === 'string' ? doc._ip : doc._ip?._value) ?? cleanIp(fromUrl) ?? '-'
}

// IP PPPoE: WANPPPConnection.*.ExternalIPAddress (TR-098), lalu Device.IP.Interface.*.IPv4Address.*.IPAddress (TR-181).
function extractIpPppoe(doc) {
  const wan = doc.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice
  const tr098 = instancesOf(wan).flatMap((connection) => instancesOf(connection?.WANPPPConnection))
    .map((ppp) => cleanIp(ppp?.ExternalIPAddress?._value))
  const tr181 = instancesOf(doc.Device?.IP?.Interface)
    .flatMap((iface) => instancesOf(iface?.IPv4Address))
    .map((address) => cleanIp(address?.IPAddress?._value))
  return [...tr098, ...tr181].find(Boolean) ?? '-'
}

// Username PPPoE: WANPPPConnection.*.Username (TR-098), lalu Device.PPP.Interface.*.Username (TR-181).
// Instance pertama yang terisi dipakai; kosong/tidak ada -> '-'.
function extractUsername(doc) {
  const tr098 = instancesOf(doc.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice)
    .flatMap((connection) => instancesOf(connection?.WANPPPConnection))
    .map((ppp) => ppp?.Username?._value)
  const tr181 = instancesOf(doc.Device?.PPP?.Interface).map((ppp) => ppp?.Username?._value)
  const found = [...tr098, ...tr181]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean)
  return found ?? '-'
}

// Klasifikasi PON dari teks model ONU. EPON dicek lebih dulu, lalu GPON; selain itu '-'.
// ProductClass sering hanya berisi kode model (mis. "HG8245H"), jadi parameter lain
// yang relevan dipakai sebagai cadangan: ModelName, Description, dan WANAccessType.
function detectPon(doc) {
  const sources = [
    doc._deviceId?._ProductClass,
    doc.InternetGatewayDevice?.DeviceInfo?.ModelName?._value,
    doc.Device?.DeviceInfo?.ModelName?._value,
    doc.InternetGatewayDevice?.DeviceInfo?.Description?._value,
    doc.Device?.DeviceInfo?.Description?._value,
    doc.InternetGatewayDevice?.WANDevice?.[1]?.WANCommonInterfaceConfig?.WANAccessType?._value,
  ]
  for (const source of sources) {
    const text = typeof source === 'string' ? source.toUpperCase() : ''
    if (text.includes('EPON')) {
      return 'EPON'
    }
    if (text.includes('GPON')) {
      return 'GPON'
    }
  }
  return '-'
}

// Detik -> "2d 5h 30m". Hari/jam dihilangkan bila 0; tidak valid -> '-'.
function formatUptime(seconds) {
  const total = Number(seconds)
  if (seconds === null || seconds === undefined || seconds === '' || !Number.isFinite(total) || total < 0) {
    return '-'
  }
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return [days > 0 && `${days}d`, (days > 0 || hours > 0) && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ')
}

// Nilai parameter pertama yang ada (bukan undefined/null/kosong).
function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
}

function extractSsid(doc) {
  const value = firstValue(
    doc.InternetGatewayDevice?.LANDevice?.[1]?.WLANConfiguration?.[1]?.SSID?._value,
    doc.Device?.WiFi?.SSID?.[1]?.SSID?._value,
  )
  return value === undefined ? '-' : String(value).trim()
}

// Jumlah host di LAN (HostNumberOfEntries). Catatan: standar TR-069 menghitung semua host
// yang pernah tercatat, bukan hanya yang sedang aktif. Nilai 0 tetap ditampilkan.
function extractClients(doc) {
  const value = firstValue(
    doc.InternetGatewayDevice?.LANDevice?.[1]?.Hosts?.HostNumberOfEntries?._value,
    doc.Device?.Hosts?.HostNumberOfEntries?._value,
  )
  return value === undefined ? '-' : String(value).trim()
}

// RX ONU dalam dBm. TR-181 OpticalSignalLevel berunit 0.001 dBm (dibagi 1000);
// path TR-098 (standar maupun Huawei/ZTE) dipakai apa adanya.
function extractRx(doc) {
  const wan = doc.InternetGatewayDevice?.WANDevice?.[1]
  const direct = firstValue(
    wan?.WANPONInterfaceConfig?.RXPower?._value,
    wan?.X_GponInterafceConfig?.RXPower?._value,
    wan?.['X_ZTE-COM_WANPONInterfaceConfig']?.RXPower?._value,
  )
  const optical = firstValue(doc.Device?.Optical?.Interface?.[1]?.OpticalSignalLevel?._value)
  let power = NaN
  if (direct !== undefined) {
    power = Number(direct)
  } else if (optical !== undefined) {
    power = Number(optical) / 1000
  }
  return Number.isFinite(power) ? `${Number(power.toFixed(2))} dBm` : '-'
}

// Suhu: sensor standar TR-098, lalu parameter transceiver umum (Huawei, ZTE, TR-181 Optical).
function extractTemp(doc) {
  const wan = doc.InternetGatewayDevice?.WANDevice?.[1]
  const value = firstValue(
    doc.InternetGatewayDevice?.DeviceInfo?.TemperatureStatus?.TemperatureSensor?.[1]?.Value?._value,
    wan?.X_GponInterafceConfig?.TransceiverTemperature?._value,
    wan?.['X_ZTE-COM_WANPONInterfaceConfig']?.TransceiverTemperature?._value,
    doc.Device?.Optical?.Interface?.[1]?.TransceiverTemperature?._value,
  )
  const temperature = Number(value)
  return value !== undefined && Number.isFinite(temperature) ? `${temperature} °C` : '-'
}

function extractUptime(doc) {
  return firstValue(
    doc.InternetGatewayDevice?.DeviceInfo?.UpTime?._value,
    doc.Device?.DeviceInfo?.UpTime?._value,
  )
}

function IpLink({ ip }) {
  if (!ip || ip === '-') {
    return '-'
  }
  return (
    <a
      href={'http://' + ip}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
    >
      {ip}
    </a>
  )
}

// Baris tabel dari satu dokumen perangkat GenieACS (NBI). Kolom yang butuh parameter
// TR-069 lebih dalam (RX ONU, dst) belum diisi dan tampil sebagai '-'.
function toRow(doc, now) {
  const lastInform = doc._lastInform ? new Date(doc._lastInform).getTime() : null
  let status = 'off24plus'
  if (lastInform !== null && !Number.isNaN(lastInform)) {
    const age = now - lastInform
    if (age <= ONLINE_WINDOW_MINUTES * 60 * 1000) {
      status = 'online'
    } else if (age <= 24 * 60 * 60 * 1000) {
      status = 'off24'
    }
  }
  return {
    id: String(doc._id),
    ssid: extractSsid(doc),
    clients: extractClients(doc),
    rx: extractRx(doc),
    temp: extractTemp(doc),
    uptime: formatUptime(extractUptime(doc)),
    username: extractUsername(doc),
    pon: detectPon(doc),
    ipPppoe: extractIpPppoe(doc),
    ipTr069: extractIpTr069(doc),
    sn: doc._deviceId?._SerialNumber,
    manufacturer: doc._deviceId?._Manufacturer,
    tipe: doc._deviceId?._ProductClass,
    lastInform: doc._lastInform,
    registered: doc._registered,
    tags: Array.isArray(doc._tags) ? doc._tags : [],
    status,
    sortKey: lastInform ?? 0,
  }
}

function matchesSearch(row, term) {
  return [row.username, row.pon, row.ssid, row.sn, row.manufacturer, row.tipe, row.id, row.ipPppoe, row.ipTr069, row.tags.join(' ')]
    .some((value) => String(value ?? '').toLowerCase().includes(term))
}

function GenieAcs() {
  const [servers, setServers] = useState([])
  const [serverId, setServerId] = useState(null)
  // Pilihan server terakhir dibaca sekali saat mount, sebelum daftar server dimuat.
  const storedServerId = useRef(readStoredServerId())
  const [serverModalOpen, setServerModalOpen] = useState(false)
  const [dataOnu, setDataOnu] = useState([])
  const [fetchedAt, setFetchedAt] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(10)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const hasServer = serverId !== null

  const rows = useMemo(() => {
    if (serverId === null) {
      return []
    }
    return dataOnu
      .filter((doc) => doc && doc._id)
      .map((doc) => toRow(doc, fetchedAt))
      .sort((first, second) => second.sortKey - first.sortKey)
  }, [dataOnu, fetchedAt, serverId])

  // Statistik untuk seluruh ONU di server terpilih (tidak ikut filter/pencarian).
  const stats = useMemo(() => {
    const result = { ...EMPTY_STATS, total: rows.length }
    rows.forEach((row) => {
      result[row.status] += 1
    })
    return result
  }, [rows])

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter((row) => (filter === 'all' || row.status === filter) && (!term || matchesSearch(row, term)))
  }, [rows, filter, search])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / limit))
  const currentPage = Math.min(page, totalPages)
  const pageRows = filteredRows.slice((currentPage - 1) * limit, currentPage * limit)
  const allSelected = pageRows.length > 0 && pageRows.every((row) => selected.has(row.id))

  const loadServers = useCallback(async (preferId = null, removedId = null) => {
    const list = await getAcsServers()
    const items = Array.isArray(list) ? list : []
    setServers(items)
    setServerId((current) => {
      let next = preferId ?? current ?? storedServerId.current
      if (removedId !== null && next === removedId) {
        next = null
      }
      if (!items.some((server) => server.id === next)) {
        next = items[0]?.id ?? null
      }
      return next
    })
  }, [])

  useEffect(() => {
    loadServers().catch((requestError) => {
      setError(errorMessage(requestError, 'Gagal memuat daftar server ACS.'))
    })
  }, [loadServers])

  useEffect(() => {
    if (serverId === null) {
      localStorage.removeItem(SERVER_STORAGE_KEY)
    } else {
      localStorage.setItem(SERVER_STORAGE_KEY, String(serverId))
    }
  }, [serverId])

  // Tarik data ONU dari GenieACS setiap server berubah (atau reload dipicu). Tidak jalan bila belum ada server.
  useEffect(() => {
    if (serverId === null) {
      return undefined
    }
    const controller = new AbortController()

    async function load() {
      setIsLoading(true)
      setError('')
      try {
        const data = await getAcsDevices(serverId, { signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        setDataOnu(Array.isArray(data) ? data : [])
        setFetchedAt(Date.now())
      } catch (requestError) {
        if (controller.signal.aborted) {
          return
        }
        setDataOnu([])
        setError(errorMessage(requestError, 'Gagal terhubung ke server GenieACS'))
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    }

    load()
    return () => controller.abort()
  }, [serverId, reloadKey])

  const reload = () => setReloadKey((key) => key + 1)

  function resetView() {
    setPage(1)
    setSelected(new Set())
  }

  function handleServerChange(event) {
    const value = event.target.value
    setServerId(value ? Number(value) : null)
    setDataOnu([])
    setError('')
    resetView()
  }

  function toggleOne(id) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current)
      pageRows.forEach((row) => (allSelected ? next.delete(row.id) : next.add(row.id)))
      return next
    })
  }

  function requireServer() {
    if (hasServer) {
      return true
    }
    Swal.fire({ icon: 'warning', title: 'Pilih server', text: 'Pilih server ACS terlebih dahulu.' })
    return false
  }

  async function handleSync() {
    if (!requireServer()) {
      return
    }
    setBusy('sync')
    try {
      const result = await syncAcs(serverId)
      await Swal.fire({ icon: 'success', title: 'Sinkron selesai', text: result.message, timer: 2500, showConfirmButton: false })
      resetView()
      reload()
    } catch (requestError) {
      Swal.fire({ icon: 'error', title: 'Sinkron gagal', text: errorMessage(requestError, 'Gagal sinkron dengan GenieACS.') })
    } finally {
      setBusy('')
    }
  }

  async function handleBulkAction(action) {
    if (!requireServer()) {
      return
    }
    if (selected.size === 0) {
      Swal.fire({ icon: 'warning', title: 'Belum ada ONU dipilih', text: 'Centang minimal satu ONU di tabel.' })
      return
    }

    const ids = [...selected]
    const confirm = await Swal.fire({
      title: action.confirm.title,
      text: action.confirm.text(ids.length),
      icon: action.confirm.danger ? 'warning' : 'question',
      showCancelButton: true,
      confirmButtonText: action.confirm.button,
      confirmButtonColor: action.confirm.danger ? '#dc2626' : undefined,
      cancelButtonText: 'Batal',
    })
    if (!confirm.isConfirmed) {
      return
    }

    setBusy(action.key)
    try {
      const result = await action.run(serverId, ids)
      let icon = 'warning'
      if (result.success) {
        icon = 'success'
      } else if (result.berhasil === 0) {
        icon = 'error'
      }
      await Swal.fire({ icon, title: action.label, text: result.message })
      if (action.clearsSelection) {
        setSelected(new Set())
      }
      if (action.reloads) {
        reload()
      }
    } catch (requestError) {
      Swal.fire({ icon: 'error', title: 'Gagal', text: errorMessage(requestError, `Gagal menjalankan ${action.label}.`) })
    } finally {
      setBusy('')
    }
  }

  async function handleServersChanged(preferId, removedId) {
    await loadServers(preferId, removedId)
    resetView()
  }

  const actionsDisabled = Boolean(busy)

  return (
    <section className="grid gap-5">
      <header>
        <p className="m-0 mb-1.5 text-[13px] font-bold tracking-[0.12em] text-cyan-700 uppercase dark:text-cyan-300">
          Manajemen Perangkat
        </p>
        <h1 className="m-0 text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">GenieACS</h1>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STAT_CARDS.map((card) => (
          <div key={card.key} className={`rounded-2xl p-5 text-white shadow-lg ${card.className}`}>
            <p className="m-0 text-xs font-bold tracking-widest opacity-90">{card.label}</p>
            <p className="m-0 mt-2 text-3xl font-extrabold">{(stats[card.key] ?? 0).toLocaleString('id-ID')}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center gap-2">
          {BULK_ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              className={`${btnBase} ${action.className}`}
              disabled={actionsDisabled}
              onClick={() => handleBulkAction(action)}
            >
              {busy === action.key ? '...' : action.label}
            </button>
          ))}
          <button
            type="button"
            className={`${btnBase} bg-emerald-600 hover:bg-emerald-700`}
            disabled={actionsDisabled}
            onClick={handleSync}
          >
            {busy === 'sync' ? 'MENYINKRON...' : 'SINKRON'}
          </button>
          <button
            type="button"
            className={`${btnBase} bg-indigo-600 hover:bg-indigo-700`}
            onClick={() => setServerModalOpen(true)}
          >
            SERVER
          </button>
          {selected.size > 0 && (
            <span className="ml-auto text-[13px] font-semibold text-gray-600 dark:text-gray-300">
              {selected.size} ONU dipilih
            </span>
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_7rem_minmax(0,1.5fr)]">
          <select
            className={inputBase}
            aria-label="Pilih server"
            value={serverId ?? ''}
            onChange={handleServerChange}
          >
            <option value="">PILIH SERVER</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>{server.nama_server} ({server.ip_domain}:{server.port})</option>
            ))}
          </select>
          <select
            className={inputBase}
            aria-label="Filter status ONU"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              resetView()
            }}
          >
            {FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            className={inputBase}
            aria-label="Jumlah data per halaman"
            value={limit}
            onChange={(event) => {
              setLimit(Number(event.target.value))
              resetView()
            }}
          >
            {LIMIT_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <input
            className={inputBase}
            type="search"
            placeholder="Cari username, SN, IP, SSID..."
            aria-label="Pencarian"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse">
            <thead>
              <tr>
                <th className={`${thClass} w-10`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-blue-600"
                    aria-label="Pilih semua di halaman ini"
                    checked={allSelected}
                    disabled={pageRows.length === 0 || isLoading}
                    onChange={toggleAll}
                  />
                </th>
                {COLUMNS.map((column) => (
                  <th key={column} className={thClass}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading || pageRows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                    {isLoading && 'Loading data dari server...'}
                    {!isLoading && error && <span className="font-semibold text-red-600 dark:text-red-400">{error}</span>}
                    {!isLoading && !error && !hasServer && 'Pilih atau tambahkan server ACS terlebih dahulu (tombol SERVER).'}
                    {!isLoading && !error && hasServer && rows.length === 0 && 'Server GenieACS ini belum memiliki perangkat.'}
                    {!isLoading && !error && hasServer && rows.length > 0 && 'Tidak ada ONU yang cocok dengan filter/pencarian.'}
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => {
                  const flag = FLAG_STYLE[row.status] || FLAG_STYLE.off24plus
                  const isSelected = selected.has(row.id)
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-gray-100 last:border-b-0 dark:border-gray-700 ${isSelected ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-gray-50 dark:hover:bg-gray-700/40'}`}
                    >
                      <td className={tdClass}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-blue-600"
                          aria-label={`Pilih ${row.sn || row.id}`}
                          checked={isSelected}
                          onChange={() => toggleOne(row.id)}
                        />
                      </td>
                      <td className={tdClass}>
                        <span title={flag.title} className="inline-flex">
                          <Flag size={16} className={flag.className} fill="currentColor" aria-label={flag.title} />
                        </span>
                      </td>
                      <td className={`${tdClass} font-semibold`}>{row.username}</td>
                      <td className={tdClass}><IpLink ip={row.ipPppoe} /></td>
                      <td className={tdClass}><IpLink ip={row.ipTr069} /></td>
                      <td className={tdClass}>{row.sn || '-'}</td>
                      <td className={tdClass}>{row.pon}</td>
                      <td className={tdClass}>{row.manufacturer || '-'}</td>
                      <td className={tdClass}>{row.tipe || '-'}</td>
                      <td className={tdClass}>{row.ssid}</td>
                      <td className={tdClass}>{row.clients}</td>
                      <td className={tdClass}>{row.rx}</td>
                      <td className={tdClass}>{row.temp}</td>
                      <td className={tdClass}>{row.uptime}</td>
                      <td className={tdClass}>{formatDate(row.lastInform)}</td>
                      <td className={tdClass}>{formatDate(row.registered)}</td>
                      <td className={`${tdClass} max-w-64 truncate font-mono text-xs`} title={row.id}>
                        {row.id}
                      </td>
                      <td className={tdClass}>
                        {row.tags.length > 0 ? (
                          <div className="flex gap-1">
                            {row.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-900/50 dark:text-sky-200"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : '-'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        <ServerPagination
          page={currentPage}
          totalPages={totalPages}
          totalData={filteredRows.length}
          limit={limit}
          disabled={isLoading}
          label="Navigasi halaman ONU"
          onPageChange={setPage}
        />
      </div>

      {serverModalOpen && (
        <ServerModal
          servers={servers}
          onClose={() => setServerModalOpen(false)}
          onChanged={handleServersChanged}
        />
      )}
    </section>
  )
}

export default GenieAcs
