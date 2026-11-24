import { useEffect, useRef, useState } from 'react'
import api from './api/axios.js'

const API = '/settings/server-time'
const SYNC_INTERVAL_MS = 60000

export const TIMEZONE_CHANGED_EVENT = 'timezone-changed'

const ZONE_LABELS = {
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
}

function formatServerTime(epoch, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch))
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`
}

function ServerClock() {
  const [timezone, setTimezone] = useState('')
  const [text, setText] = useState('')
  const offsetRef = useRef(0)
  const timezoneRef = useRef('')

  useEffect(() => {
    let ignore = false

    async function sync() {
      try {
        const response = await api.get(API)
        if (ignore || !response.data?.now) {
          return
        }
        // Selisih jam server dengan jam browser, agar yang tampil adalah waktu server.
        offsetRef.current = response.data.now - Date.now()
        timezoneRef.current = response.data.timezone
        setTimezone(response.data.timezone)
      } catch {
        // Jika gagal, jam tetap berjalan dengan data sinkron terakhir.
      }
    }

    function tick() {
      if (timezoneRef.current) {
        setText(formatServerTime(Date.now() + offsetRef.current, timezoneRef.current))
      }
    }

    sync()
    const syncTimer = setInterval(sync, SYNC_INTERVAL_MS)
    const tickTimer = setInterval(tick, 1000)
    window.addEventListener(TIMEZONE_CHANGED_EVENT, sync)

    return () => {
      ignore = true
      clearInterval(syncTimer)
      clearInterval(tickTimer)
      window.removeEventListener(TIMEZONE_CHANGED_EVENT, sync)
    }
  }, [])

  // Isi awal segera setelah zona waktu diketahui, tanpa menunggu tick berikutnya.
  const display = timezone && text ? text : timezone ? formatServerTime(Date.now() + offsetRef.current, timezone) : '...'

  return (
    <div
      className="flex h-10 min-w-0 max-w-full items-center rounded-xl border border-gray-200 bg-white px-2.5 dark:border-gray-600 dark:bg-gray-800"
      title="Waktu server saat ini"
    >
      <span className="min-w-0">
        <span className="block text-[9px] leading-none font-bold tracking-[0.14em] text-cyan-700 uppercase sm:text-[10px] dark:text-cyan-300">
          Waktu Server
        </span>
        <strong className="block truncate text-[11px] leading-tight font-semibold text-gray-900 tabular-nums sm:text-[13px] dark:text-gray-100">
          {display}{timezone ? ` ${ZONE_LABELS[timezone] || ''}` : ''}
        </strong>
      </span>
    </div>
  )
}

export default ServerClock
