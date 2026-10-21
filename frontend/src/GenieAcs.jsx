import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Flag, X } from 'lucide-react'
import Swal from 'sweetalert2'
import {
  createAcsServer,
  deleteAcsDevices,
  deleteAcsServer,
  getAcsDeviceHosts,
  getAcsDeviceWlans,
  getAcsDevices,
  getAcsServers,
  rebootAcsDevices,
  resetAcsDevices,
  summonAcsDevices,
  syncAcs,
} from './api/acs.js'
import ServerPagination from './ServerPagination.jsx'

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
      await createAcsServer({
        nama_server: form.nama_server.trim(),
        ip_domain: form.ip_domain.trim(),
        port: form.port === '' ? undefined : Number(form.port),
      })
      setForm(EMPTY_SERVER_FORM)
      await onChanged()
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
      await onChanged(server.id)
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

// Rentang redaman fiber yang wajar (dBm). Di luar ini tetap ditampilkan apa adanya, dengan penanda.
const RX_NORMAL_MIN = -40
const RX_NORMAL_MAX = -10

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
      onClick={(event) => event.stopPropagation()}
    >
      {ip}
    </a>
  )
}

// Data ONU dari backend sudah bersih dan terstandarisasi (sn, ip_pppoe, rx_onu, ...).
// Di sini hanya ditambah status online (dari last_inform) dan kunci urut.
function toRow(item, now) {
  const lastInform = item.last_inform ? new Date(item.last_inform).getTime() : null
  let status = 'off24plus'
  if (lastInform !== null && !Number.isNaN(lastInform)) {
    const age = now - lastInform
    if (age <= ONLINE_WINDOW_MINUTES * 60 * 1000) {
      status = 'online'
    } else if (age <= 24 * 60 * 60 * 1000) {
      status = 'off24'
    }
  }
  return { ...item, tags: Array.isArray(item.tags) ? item.tags : [], status, sortKey: lastInform ?? 0 }
}

function matchesSearch(item, term) {
  return [item.username, item.pon, item.ssid, item.sn, item.manufaktur, item.tipe, item.id, item.ip_pppoe, item.ip_tr069, item.tags.join(' ')]
    .some((value) => String(value ?? '').toLowerCase().includes(term))
}

const DETAIL_TABS = ['TERHUBUNG', 'WLAN', 'LAN', 'WAN']
const HOST_COLUMNS = ['No', 'HOSTNAME', 'IP ADDRESS', 'MAC ADDRESS', 'TYPE']
const WLAN_COLUMNS = ['ID', 'SSID', 'PASSWORD', 'SECURITY', 'FREQ', 'BAND', 'CONNECTED', 'STATUS']

const STATUS_BADGE = {
  online: { label: 'ONLINE', className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  off24: { label: 'OFF < 24H', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  off24plus: { label: 'OFF > 24H', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
}

// Sandi WiFi disembunyikan secara bawaan; klik ikon mata untuk melihatnya.
function WlanPassword({ value }) {
  const [revealed, setRevealed] = useState(false)
  if (!value || value === '-') {
    return '-'
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-xs">{revealed ? value : '••••••••'}</span>
      <button
        type="button"
        className="grid h-6 w-6 cursor-pointer place-items-center rounded border-0 bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-slate-700"
        aria-label={revealed ? 'Sembunyikan sandi' : 'Tampilkan sandi'}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  )
}

function DetailRow({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-gray-100 py-2 last:border-b-0 dark:border-slate-700">
      <dt className="shrink-0 text-xs font-bold tracking-wide text-gray-500 uppercase dark:text-gray-400">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-right text-sm font-medium text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  )
}

function DetailIndicator({ label, children }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-slate-700 dark:bg-slate-900/40">
      <p className="m-0 text-xs font-bold tracking-widest text-gray-500 uppercase dark:text-gray-400">{label}</p>
      <div className="mt-2 text-lg font-bold text-gray-900 dark:text-gray-100">{children}</div>
    </div>
  )
}

// Modal detail satu ONU. Data diambil dari baris yang diklik (sudah bersih dari backend).
// Info pelanggan / host LAN belum punya sumber data, jadi memakai placeholder.
function DeviceDetailModal({
  device, activeTab, onTabChange, onClose, onSummon, summoning, hostsLoading, hostsError, wlansLoading, wlansError, renderRx, renderTemp,
}) {
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const badge = STATUS_BADGE[device.status] || STATUS_BADGE.off24plus
  const hasHosts = Boolean(device?.connected_hosts && device.connected_hosts.length > 0)
  const hasWlans = Boolean(device?.wlans && device.wlans.length > 0)

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
        className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-slate-800"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acs-detail-title"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4 dark:border-slate-700 dark:bg-slate-800">
          <h2 id="acs-detail-title" className="m-0 text-base font-bold tracking-wide text-gray-900 dark:text-gray-100">
            DETAIL PERANGKAT
          </h2>
          <button
            type="button"
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-slate-700"
            aria-label="Tutup"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-6 p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <DetailIndicator label="REDAMAN ONU">{renderRx(device.rx_onu)}</DetailIndicator>
            <DetailIndicator label="TEMPERATURE">{renderTemp(device.temp)}</DetailIndicator>
            <DetailIndicator label="UPTIME">{formatUptime(device.uptime)}</DetailIndicator>
          </div>

          <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-3">
            <dl className="m-0">
              <DetailRow label="Nama Pelanggan">{device.username ?? '-'}</DetailRow>
              <DetailRow label="No Layanan">-</DetailRow>
              <DetailRow label="Tgl Isolir">-</DetailRow>
            </dl>
            <dl className="m-0">
              <DetailRow label="Username">{device.username ?? '-'}</DetailRow>
              <DetailRow label="IP TR069"><IpLink ip={device.ip_tr069} /></DetailRow>
              <DetailRow label="SuperAdmin">-</DetailRow>
            </dl>
            <dl className="m-0">
              <DetailRow label="Status">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge.className}`}>{badge.label}</span>
              </DetailRow>
              <DetailRow label="SerialNumber">{device.sn || '-'}</DetailRow>
              <DetailRow label="Last Inform">{formatDate(device.last_inform)}</DetailRow>
            </dl>
          </div>

          <div>
            <div className="flex items-end justify-between gap-3 border-b border-gray-200 dark:border-slate-700">
              <div className="flex flex-wrap gap-1" role="tablist">
                {DETAIL_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    className={`-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-4 py-2.5 text-[13px] font-bold tracking-wide transition-colors ${activeTab === tab ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}
                    onClick={() => onTabChange(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mb-1.5 cursor-pointer rounded-md border-0 bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={summoning}
                onClick={onSummon}
              >
                {summoning ? '...' : 'Summon'}
              </button>
            </div>

            <div className="pt-4">
              {activeTab === 'TERHUBUNG' ? (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
                  <table className="w-full min-w-max border-collapse">
                    <thead>
                      <tr>
                        {HOST_COLUMNS.map((column) => (
                          <th key={column} className={thClass}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {hasHosts ? (
                        device.connected_hosts.map((host, index) => (
                          <tr key={`${host.mac}-${host.ip}-${index}`} className="border-b border-gray-100 last:border-b-0 dark:border-slate-700">
                            <td className={tdClass}>{index + 1}</td>
                            <td className={`${tdClass} font-semibold`}>{host.hostname}</td>
                            <td className={tdClass}>{host.ip}</td>
                            <td className={`${tdClass} font-mono text-xs`}>{host.mac}</td>
                            <td className={tdClass}>{host.type}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={HOST_COLUMNS.length} className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                            {hostsLoading && 'Memuat daftar perangkat terhubung...'}
                            {!hostsLoading && hostsError && <span className="font-semibold text-red-600 dark:text-red-400">{hostsError}</span>}
                            {!hostsLoading && !hostsError && 'Tidak ada perangkat yang terhubung.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : activeTab === 'WLAN' ? (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
                  <table className="w-full min-w-max border-collapse">
                    <thead>
                      <tr>
                        {WLAN_COLUMNS.map((column) => (
                          <th key={column} className={thClass}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {hasWlans ? (
                        device.wlans.map((wlan) => (
                          <tr key={wlan.id} className="border-b border-gray-100 last:border-b-0 dark:border-slate-700">
                            <td className={tdClass}>{wlan.id}</td>
                            <td className={`${tdClass} font-semibold`}>{wlan.ssid}</td>
                            <td className={tdClass}><WlanPassword value={wlan.password} /></td>
                            <td className={tdClass}>{wlan.security}</td>
                            <td className={tdClass}>{wlan.freq}</td>
                            <td className={tdClass}>{wlan.band}</td>
                            <td className={tdClass}>{wlan.connected}</td>
                            <td className={tdClass}>
                              {wlan.status ? (
                                <span className="rounded border border-blue-600 px-2 py-1 text-xs font-bold text-blue-600 dark:border-blue-400 dark:text-blue-400">ENABLED</span>
                              ) : (
                                <span className="rounded border border-orange-500 px-2 py-1 text-xs font-bold text-orange-500">DISABLED</span>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={WLAN_COLUMNS.length} className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                            {wlansLoading && 'Memuat data WLAN...'}
                            {!wlansLoading && wlansError && <span className="font-semibold text-red-600 dark:text-red-400">{wlansError}</span>}
                            {!wlansLoading && !wlansError && 'Data WLAN tidak ditemukan.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="m-0 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                  Tab {activeTab} belum tersedia.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function GenieAcs() {
  const [servers, setServers] = useState([])
  // Server wajib dipilih manual: kosong ('') = belum dipilih, data tidak dimuat.
  const [selectedServer, setSelectedServer] = useState('')
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
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [activeTab, setActiveTab] = useState('TERHUBUNG')
  const [hostsState, setHostsState] = useState({ loading: false, error: '' })
  const [hostsReloadKey, setHostsReloadKey] = useState(0)
  const [wlansState, setWlansState] = useState({ loading: false, error: '' })
  const [wlansReloadKey, setWlansReloadKey] = useState(0)

  const hasServer = selectedServer !== ''

  // RX ONU (dBm, sudah dikonversi backend): angka + dot warna + teks status. Kosong -> '-'.
  function renderRx(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '-'
    }
    const rx = Number(value)
    let label = 'Buruk'
    let warnaDot = 'bg-red-500'
    if (rx >= -20) {
      label = 'Bagus'
      warnaDot = 'bg-green-500'
    } else if (rx >= -25) {
      label = 'Sedang'
      warnaDot = 'bg-yellow-500'
    }
    // Di luar rentang wajar tetap ditampilkan apa adanya, hanya diberi tanda *.
    const abnormal = rx > RX_NORMAL_MAX || rx < RX_NORMAL_MIN
    return (
      <div
        className="flex items-center gap-1.5 whitespace-nowrap"
        title={abnormal ? `Di luar rentang wajar fiber (${RX_NORMAL_MIN} s/d ${RX_NORMAL_MAX} dBm)` : undefined}
      >
        <span>{rx.toFixed(2)}{abnormal && '*'}</span>
        <span className={`w-2.5 h-2.5 rounded-full ${warnaDot}`} />
        <span>{label}</span>
      </div>
    )
  }

  // TEMP (°C, sudah dikonversi backend). Kosong -> '-'.
  function renderTemp(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '-'
    }
    return `${Number(value).toFixed(1)} °C`
  }

  const rows = useMemo(() => {
    if (!selectedServer) {
      return []
    }
    return dataOnu
      .filter((item) => item && item.id)
      .map((item) => toRow(item, fetchedAt))
      .sort((first, second) => second.sortKey - first.sortKey)
  }, [dataOnu, fetchedAt, selectedServer])

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

  // Memuat daftar server untuk dropdown. Pilihan saat ini dipertahankan bila masih ada;
  // tidak pernah memilih server otomatis.
  const loadServers = useCallback(async (removedId = null) => {
    const list = await getAcsServers()
    const items = Array.isArray(list) ? list : []
    setServers(items)
    setSelectedServer((current) => {
      if (removedId !== null && current === String(removedId)) {
        return ''
      }
      return items.some((server) => String(server.id) === current) ? current : ''
    })
  }, [])

  useEffect(() => {
    loadServers().catch((requestError) => {
      setError(errorMessage(requestError, 'Gagal memuat daftar server ACS.'))
    })
  }, [loadServers])

  // Tarik data ONU dari GenieACS setiap server berubah (atau reload dipicu).
  useEffect(() => {
    // Guard: jangan fetch bila server belum dipilih.
    if (!selectedServer) {
      return undefined
    }
    const controller = new AbortController()

    async function load() {
      setIsLoading(true)
      setError('')
      try {
        const data = await getAcsDevices(selectedServer, { signal: controller.signal })
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
  }, [selectedServer, reloadKey])

  const reload = () => setReloadKey((key) => key + 1)

  // Daftar klien terhubung diambil per perangkat saat modal dibuka (tidak ikut daftar ONU).
  const selectedDeviceId = selectedDevice?.id ?? null
  useEffect(() => {
    if (!selectedDeviceId || !selectedServer) {
      return undefined
    }
    const controller = new AbortController()

    async function loadHosts() {
      setHostsState({ loading: true, error: '' })
      try {
        const result = await getAcsDeviceHosts(selectedServer, selectedDeviceId, { signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        const connectedHosts = Array.isArray(result?.connected_hosts) ? result.connected_hosts : []
        setSelectedDevice((current) => (current && current.id === selectedDeviceId
          ? { ...current, connected_hosts: connectedHosts }
          : current))
        setHostsState({ loading: false, error: '' })
      } catch (requestError) {
        if (controller.signal.aborted) {
          return
        }
        setHostsState({ loading: false, error: errorMessage(requestError, 'Gagal memuat perangkat terhubung.') })
      }
    }

    loadHosts()
    return () => controller.abort()
  }, [selectedDeviceId, selectedServer, hostsReloadKey])

  // Daftar WiFi diambil saat tab WLAN dibuka (data lama tetap tampil selama dimuat ulang).
  const wlanTabActive = activeTab === 'WLAN'
  useEffect(() => {
    if (!selectedDeviceId || !selectedServer || !wlanTabActive) {
      return undefined
    }
    const controller = new AbortController()

    async function loadWlans() {
      setWlansState({ loading: true, error: '' })
      try {
        const result = await getAcsDeviceWlans(selectedServer, selectedDeviceId, { signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        const wlans = Array.isArray(result?.wlans) ? result.wlans : []
        setSelectedDevice((current) => (current && current.id === selectedDeviceId ? { ...current, wlans } : current))
        setWlansState({ loading: false, error: '' })
      } catch (requestError) {
        if (controller.signal.aborted) {
          return
        }
        setWlansState({ loading: false, error: errorMessage(requestError, 'Gagal memuat data WLAN.') })
      }
    }

    loadWlans()
    return () => controller.abort()
  }, [selectedDeviceId, selectedServer, wlanTabActive, wlansReloadKey])

  function resetView() {
    setPage(1)
    setSelected(new Set())
  }

  function handleTabChange(tab) {
    if (tab === 'WLAN') {
      setWlansState({ loading: true, error: '' })
    }
    setActiveTab(tab)
  }

  function openDevice(item) {
    setActiveTab('TERHUBUNG')
    setWlansState({ loading: false, error: '' })
    setHostsState({ loading: true, error: '' })
    setSelectedDevice(item)
  }

  function handleServerChange(event) {
    const value = event.target.value
    setSelectedServer(value)
    setSelectedDevice(null)
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

  // Summon satu ONU dari modal detail (memakai endpoint /api/acs/summon yang sama dengan tombol SUMMON).
  async function handleSummonDevice(device) {
    if (!requireServer()) {
      return
    }
    setBusy('summon-device')
    try {
      const result = await summonAcsDevices(selectedServer, [device.id])
      if (result.success) {
        setHostsReloadKey((key) => key + 1)
        setWlansReloadKey((key) => key + 1)
      }
      Swal.fire({
        icon: result.success ? 'success' : 'warning',
        title: 'Summon',
        text: result.message,
        timer: result.success ? 2000 : undefined,
        showConfirmButton: !result.success,
      })
    } catch (requestError) {
      Swal.fire({ icon: 'error', title: 'Gagal', text: errorMessage(requestError, 'Gagal menjalankan Summon.') })
    } finally {
      setBusy('')
    }
  }

  async function handleSync() {
    if (!requireServer()) {
      return
    }
    setBusy('sync')
    try {
      const result = await syncAcs(selectedServer)
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
      const result = await action.run(selectedServer, ids)
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

  async function handleServersChanged(removedId = null) {
    await loadServers(removedId)
    if (removedId !== null && String(removedId) === selectedServer) {
      // Server yang sedang dipilih dihapus: bersihkan data dan error miliknya.
      setDataOnu([])
      setError('')
    }
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
            value={selectedServer}
            onChange={handleServerChange}
          >
            <option value="" disabled hidden>--- Pilih Server ACS ---</option>
            {servers.map((server) => (
              <option key={server.id} value={String(server.id)}>{server.nama_server}</option>
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
                    {hasServer && isLoading && 'Loading data dari server...'}
                    {!(hasServer && isLoading) && error && <span className="font-semibold text-red-600 dark:text-red-400">{error}</span>}
                    {!error && !hasServer && 'Silakan pilih Server ACS terlebih dahulu untuk menampilkan data perangkat.'}
                    {!isLoading && !error && hasServer && rows.length === 0 && 'Server GenieACS ini belum memiliki perangkat.'}
                    {!isLoading && !error && hasServer && rows.length > 0 && 'Tidak ada ONU yang cocok dengan filter/pencarian.'}
                  </td>
                </tr>
              ) : (
                pageRows.map((item) => {
                  const flag = FLAG_STYLE[item.status] || FLAG_STYLE.off24plus
                  const isSelected = selected.has(item.id)
                  return (
                    <tr
                      key={item.id}
                      className={`cursor-pointer border-b border-gray-100 last:border-b-0 dark:border-gray-700 ${isSelected ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                      onClick={() => openDevice(item)}
                    >
                      <td className={tdClass} onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-blue-600"
                          aria-label={`Pilih ${item.sn || item.id}`}
                          checked={isSelected}
                          onChange={() => toggleOne(item.id)}
                        />
                      </td>
                      <td className={tdClass}>
                        <span title={flag.title} className="inline-flex">
                          <Flag size={16} className={flag.className} fill="currentColor" aria-label={flag.title} />
                        </span>
                      </td>
                      <td className={`${tdClass} font-semibold`}>{item.username ?? '-'}</td>
                      <td className={tdClass}><IpLink ip={item.ip_pppoe} /></td>
                      <td className={tdClass}><IpLink ip={item.ip_tr069} /></td>
                      <td className={tdClass}>{item.sn || '-'}</td>
                      <td className={tdClass}>{item.pon ?? '-'}</td>
                      <td className={tdClass}>{item.manufaktur || '-'}</td>
                      <td className={tdClass}>{item.tipe || '-'}</td>
                      <td className={tdClass}>{item.ssid ?? '-'}</td>
                      <td className={tdClass}>{item.user ?? '-'}</td>
                      <td className={tdClass}>{renderRx(item.rx_onu)}</td>
                      <td className={tdClass}>{renderTemp(item.temp)}</td>
                      <td className={tdClass}>{formatUptime(item.uptime)}</td>
                      <td className={tdClass}>{formatDate(item.last_inform)}</td>
                      <td className={tdClass}>{formatDate(item.registered)}</td>
                      <td className={`${tdClass} max-w-64 truncate font-mono text-xs`} title={item.id}>
                        {item.id}
                      </td>
                      <td className={tdClass}>
                        {item.tags.length > 0 ? (
                          <div className="flex gap-1">
                            {item.tags.map((tag) => (
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

      {selectedDevice && (
        <DeviceDetailModal
          device={selectedDevice}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onClose={() => setSelectedDevice(null)}
          onSummon={() => handleSummonDevice(selectedDevice)}
          summoning={busy === 'summon-device'}
          hostsLoading={hostsState.loading}
          hostsError={hostsState.error}
          wlansLoading={wlansState.loading}
          wlansError={wlansState.error}
          renderRx={renderRx}
          renderTemp={renderTemp}
        />
      )}

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
