import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
// qrcode.react sudah ada di package.json (^4.x); QRCodeCanvas untuk render canvas (lebih tajam saat dicetak).
import { QRCodeCanvas } from 'qrcode.react'
import api from './api/axios.js'

const waDigits = String(import.meta.env.VITE_WA_ADMIN || '').replace(/\D/g, '')
const whatsappHref = waDigits ? `https://wa.me/${waDigits}` : 'https://wa.me/NOMOR_WA_ADMIN'

function formatRupiah(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n)
}

/** Format angka bulat dengan pemisah ribuan titik (contoh: 150123 → "150.123"). */
function formatNominalUnik(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(n)
}

let snapScriptPromise = null
function loadSnapScript(src, clientKey) {
  if (window.snap) return Promise.resolve()
  if (!snapScriptPromise) {
    snapScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = src
      script.setAttribute('data-client-key', clientKey)
      script.onload = resolve
      script.onerror = () => {
        snapScriptPromise = null
        script.remove()
        reject(new Error('snap.js gagal dimuat'))
      }
      document.head.appendChild(script)
    })
  }
  return snapScriptPromise
}

function IsolirPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)
  const [tagihan, setTagihan] = useState(null)
  const [error, setError] = useState('')
  const [paying, setPaying] = useState(false)
  const [payNotice, setPayNotice] = useState(null)

  async function handlePay() {
    const customer = data?.customer || tagihan?.customer
    if (!customer) return
    setPaying(true)
    setPayNotice(null)
    try {
      const { data: tx } = await api.post('/payment/create', { id_pelanggan: customer.id })

      if (!tx.client_key) {
        if (tx.redirect_url) {
          window.location.href = tx.redirect_url
          return
        }
        throw new Error('Pembayaran online belum dikonfigurasi di server.')
      }

      await loadSnapScript(tx.snap_js_url, tx.client_key)
      window.snap.pay(tx.token, {
        onSuccess: () => {
          setPayNotice({
            type: 'success',
            text: 'Pembayaran diterima. Internet akan aktif kembali dalam beberapa detik; jika belum, matikan lalu nyalakan lagi koneksi/router Anda.',
          })
          setPaying(false)
        },
        onPending: () => {
          setPayNotice({
            type: 'info',
            text: 'Menunggu pembayaran. Selesaikan pembayaran sesuai instruksi; layanan aktif otomatis setelah terkonfirmasi.',
          })
          setPaying(false)
        },
        onError: () => {
          setPayNotice({ type: 'error', text: 'Pembayaran gagal. Silakan coba lagi.' })
          setPaying(false)
        },
        onClose: () => setPaying(false),
      })
    } catch (requestError) {
      setPayNotice({
        type: 'error',
        text: requestError.response?.data?.message || requestError.message || 'Gagal memulai pembayaran.',
      })
      setPaying(false)
    }
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [meRes, tagihanRes] = await Promise.all([
        api.get('/isolir/me'),
        api.get('/isolir/tagihan'),
      ])
      setData(meRes.data)
      setTagihan(tagihanRes.data)
      if (!tagihanRes.data?.success && !meRes.data?.success) {
        setError(tagihanRes.data?.message || meRes.data?.message || 'Tidak dapat memuat data tagihan.')
      }
    } catch (requestError) {
      const payload = requestError.response?.data
      setData(payload || null)
      setTagihan(null)
      setError(payload?.message || 'Tidak dapat memuat data tagihan.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const customer = data?.customer || tagihan?.customer
  const debug = data?.debug
  const qrisString = tagihan?.qris_dinamis_string
  const nominalUnik = tagihan?.nominal_unik

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-900">
      <article className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-lg dark:border-slate-700 dark:bg-slate-800">
        <p className="mb-6 text-sm font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
          RANIAH.NET
        </p>

        <div
          className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-950/60 dark:text-orange-400"
          aria-hidden="true"
        >
          <AlertTriangle size={36} strokeWidth={2.25} />
        </div>

        <h1 className="m-0 text-2xl font-bold text-slate-900 dark:text-slate-100">
          Layanan Internet Ditangguhkan
        </h1>

        <p className="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Mohon maaf, koneksi internet Anda saat ini diisolir karena telah melewati batas waktu
          pembayaran tagihan. Silakan lakukan pembayaran untuk mengaktifkan kembali layanan.
        </p>

        {loading && (
          <p className="mt-6 flex items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            Memuat tagihan…
          </p>
        )}

        {!loading && qrisString && nominalUnik != null && (
          <div className="mx-auto mt-8 flex max-w-xs flex-col items-center gap-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-inner dark:border-slate-600 dark:bg-slate-950">
              <QRCodeCanvas value={qrisString} size={256} level="M" />
            </div>
            <p className="m-0 text-base font-bold text-slate-900 dark:text-slate-100">
              {`Total Pembayaran: Rp ${formatNominalUnik(nominalUnik)} (Harus pas hingga 3 digit terakhir)`}
            </p>
            {tagihan?.kode_unik != null && (
              <p className="m-0 text-xs text-slate-500 dark:text-gray-400">
                Tagihan dasar {formatRupiah(tagihan.nominal_tagihan_dasar)} + kode unik{' '}
                {String(tagihan.kode_unik).padStart(3, '0')}
              </p>
            )}
          </div>
        )}

        {!loading && customer && (
          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-sm dark:border-slate-600 dark:bg-slate-900/40">
            <p className="m-0 font-semibold text-slate-800 dark:text-slate-100">{customer.pelanggan}</p>
            <p className="mt-1 mb-0 text-slate-600 dark:text-slate-300">
              No layanan: {customer.nolayanan || '-'}
              {' · '}
              Status: {customer.status}
            </p>
            {tagihan?.qris_error && (
              <p className="mt-2 mb-0 text-rose-600">{tagihan.qris_error}</p>
            )}
            {customer.status === 'Isolir' && !tagihan?.qris_error && !qrisString && tagihan?.qris_configured === false && (
              <p className="mt-3 mb-0 text-amber-700 dark:text-amber-300">
                QRIS belum dikonfigurasi. Admin: isi String QRIS di menu Payment Gateway.
              </p>
            )}
            {customer.status === 'Isolir' && (
              <button
                type="button"
                onClick={handlePay}
                disabled={paying}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-cyan-700 disabled:opacity-60"
              >
                {paying && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {paying ? 'Memproses…' : `Bayar via Payment Gateway${customer.total ? ` ${formatRupiah(customer.total)}` : ''}`}
              </button>
            )}
            {payNotice && (
              <p
                role="status"
                className={`mt-3 mb-0 text-sm ${
                  payNotice.type === 'success'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : payNotice.type === 'error'
                      ? 'text-rose-600'
                      : 'text-amber-700 dark:text-amber-300'
                }`}
              >
                {payNotice.text}
              </p>
            )}
          </div>
        )}

        {!loading && error && !customer && (
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="m-0 font-semibold">{error}</p>
            {(data?.ip || tagihan?.ip) && (
              <p className="mt-2 mb-0 text-xs">
                IP terdeteksi dari browser:{' '}
                <code className="font-mono">{data?.ip || tagihan?.ip}</code>
              </p>
            )}
            {debug?.active_radacct_sessions?.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 font-semibold">IP sesi PPP aktif di database:</p>
                <ul className="m-0 list-inside list-disc text-xs">
                  {debug.active_radacct_sessions.slice(0, 8).map((row) => (
                    <li key={`${row.ip}-${row.username}`}>
                      {row.ip} — {row.username} ({row.status || '?'})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            <RefreshCw size={16} aria-hidden="true" />
            Muat ulang
          </button>
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-1 items-center justify-center rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700"
          >
            Konfirmasi via WhatsApp
          </a>
        </div>
      </article>
    </main>
  )
}

export default IsolirPage
