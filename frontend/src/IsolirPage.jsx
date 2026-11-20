import { AlertTriangle } from 'lucide-react'

const waDigits = String(import.meta.env.VITE_WA_ADMIN || '').replace(/\D/g, '')
const whatsappHref = waDigits ? `https://wa.me/${waDigits}` : ''

// Halaman informasi statis untuk pelanggan yang layanannya diisolir (walled garden).
export default function IsolirPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-900">
      <article className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-lg dark:border-slate-700 dark:bg-slate-800">
        <p className="mb-6 text-sm font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
          RANIAH.NET
        </p>
        <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-amber-500" aria-hidden="true" />
        <h1 className="mb-2 text-xl font-bold text-slate-900 dark:text-slate-100">Layanan Anda sedang diisolir</h1>
        <p className="mb-6 text-sm text-slate-600 dark:text-slate-300">
          Silakan hubungi admin untuk mengaktifkan kembali layanan internet Anda.
        </p>
        {whatsappHref && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Hubungi Admin via WhatsApp
          </a>
        )}
      </article>
    </main>
  )
}
