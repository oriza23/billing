import { useEffect, useRef, useState } from 'react'
import { Database, Globe, RefreshCw, ShieldCheck } from 'lucide-react'
import Swal from 'sweetalert2'
import api from './api/axios.js'
import { fireError, fireSuccess } from './swals.js'

const REFRESH_MS = 10000

const SERVICES = [
  { key: 'web', service: 'web', name: 'Sistem Web', icon: Globe, recheckMs: 3000 },
  { key: 'database', service: 'postgresql', name: 'Database PostgreSQL', icon: Database, recheckMs: 2500 },
  { key: 'radius', service: 'freeradius', name: 'Radius Server', icon: ShieldCheck, recheckMs: 2500 },
]

const SETTING_CARD =
  'mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md dark:border-slate-700 dark:bg-slate-900'

function formatJam(isoText) {
  if (!isoText) {
    return '-'
  }
  return new Date(isoText).toLocaleTimeString('en-GB', { hour12: false })
}

function cardShellClass(state) {
  if (state === 'online') {
    return 'border-emerald-200/80 bg-emerald-50/30 dark:border-emerald-900/50 dark:bg-emerald-950/20'
  }
  if (state === 'offline') {
    return 'border-red-200/80 bg-red-50/40 dark:border-red-900/50 dark:bg-red-950/20'
  }
  return 'border-gray-200 bg-gray-50/50 dark:border-slate-700 dark:bg-slate-800/40'
}

function iconShellClass(state) {
  if (state === 'online') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
  }
  if (state === 'offline') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
  }
  return 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
}

function badgeClass(state) {
  if (state === 'online') {
    return 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
  }
  if (state === 'offline') {
    return 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-bold text-red-700 dark:bg-red-500/15 dark:text-red-400'
  }
  return 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-slate-500/10 px-2.5 py-1 text-xs font-bold text-slate-600 dark:bg-slate-500/15 dark:text-slate-400'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ServiceHealth() {
  const [health, setHealth] = useState(null)
  const [unreachable, setUnreachable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [restarting, setRestarting] = useState('')
  const holdRef = useRef(false)

  useEffect(() => {
    let ignore = false

    async function check() {
      setChecking(true)
      try {
        const response = await api.get('/system/health')
        if (!ignore) {
          setHealth(response.data)
          setUnreachable(false)
        }
      } catch (error) {
        // Saat web baru di-restart, gagal sesaat tidak ditampilkan sebagai offline.
        if (!ignore && !holdRef.current && error.response?.status !== 401) {
          setUnreachable(true)
        }
      } finally {
        if (!ignore) {
          setChecking(false)
        }
      }
    }

    check()
    const timer = setInterval(check, REFRESH_MS)
    return () => {
      ignore = true
      clearInterval(timer)
    }
  }, [])

  async function recheckAfter(ms) {
    await sleep(ms)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await api.get('/system/health')
        setHealth(response.data)
        setUnreachable(false)
        return
      } catch (error) {
        if (error.response?.status === 401) {
          return
        }
        await sleep(1000)
      }
    }
    setUnreachable(true)
  }

  async function restart(item) {
    const confirmed = await Swal.fire({
      title: 'Restart layanan?',
      text: `Yakin ingin me-restart layanan ${item.name}? Koneksi sementara mungkin terputus.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Ya, Restart',
      cancelButtonText: 'Batal',
    })
    if (!confirmed.isConfirmed) {
      return
    }

    setRestarting(item.key)
    holdRef.current = true
    try {
      const response = await api.post('/sistem/restart-service', { service: item.service })
      await fireSuccess({
        title: 'Restart dijalankan',
        text: response.data?.message || `${item.name} sedang di-restart.`,
      }, false)
      await recheckAfter(item.recheckMs)
    } catch (error) {
      await fireError({
        title: 'Gagal',
        text: error.response?.data?.message || `Gagal me-restart ${item.name}.`,
      })
    } finally {
      holdRef.current = false
      setRestarting('')
    }
  }

  function stateOf(key) {
    if (unreachable) {
      // Backend tidak merespons: Web pasti offline, layanan lain tidak bisa diperiksa.
      return key === 'web' ? 'offline' : 'unknown'
    }
    const status = health?.[key]?.status
    if (!status) {
      return 'unknown'
    }
    return status === 'Online' ? 'online' : 'offline'
  }

  function detailOf(key) {
    if (unreachable) {
      return key === 'web' ? 'Backend tidak merespons' : 'Tidak dapat diperiksa'
    }
    if (!health) {
      return 'Memeriksa...'
    }
    if (key === 'database' && health.database?.latency_ms != null) {
      return `Respon ${health.database.latency_ms} ms`
    }
    if (key === 'radius') {
      return `Service: ${health.radius?.detail || '-'}`
    }
    if (key === 'database') {
      return `Error: ${health.database?.detail || '-'}`
    }
    return 'Backend merespons'
  }

  const labels = { online: 'Online', offline: 'Offline', unknown: '...' }

  return (
    <section className={SETTING_CARD} aria-label="Status Layanan">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-bold text-slate-900 dark:text-gray-100">Status Layanan</h2>
          <p className="mt-1 mb-0 text-sm text-slate-500 dark:text-gray-400">
            {unreachable
              ? 'Gagal menghubungi server'
              : `Pemeriksaan terakhir ${formatJam(health?.checked_at)} · otomatis tiap 10 detik`}
          </p>
        </div>
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 ${checking ? 'animate-spin' : ''}`}
          aria-hidden="true"
        >
          <RefreshCw size={16} />
        </span>
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {SERVICES.map((item) => {
          const { key, name, icon: Icon } = item
          const state = stateOf(key)
          const busy = restarting === key
          return (
            <article
              key={key}
              className={`flex items-center gap-4 rounded-xl border p-4 shadow-sm transition-shadow hover:shadow-md ${cardShellClass(state)}`}
            >
              <span
                className={`grid h-12 w-12 shrink-0 place-items-center rounded-full ${iconShellClass(state)}`}
              >
                <Icon size={22} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <h3 className="m-0 text-sm font-bold text-slate-900 dark:text-gray-100">{name}</h3>
                  <span className={badgeClass(state)}>
                    {state === 'online' && (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
                    )}
                    {labels[state]}
                  </span>
                </div>
                <p className="mt-1 mb-0 text-xs text-slate-500 dark:text-gray-400">{detailOf(key)}</p>
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:border-cyan-600 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-cyan-400 dark:hover:text-cyan-300"
                  onClick={() => restart(item)}
                  disabled={Boolean(restarting)}
                >
                  <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
                  {busy ? 'Merestart...' : 'Restart'}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default ServiceHealth
