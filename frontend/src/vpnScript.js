import Swal from 'sweetalert2'

// Modal Salin Script MikroTik untuk halaman Koneksi VPN (WireGuard, OpenVPN, L2TP, Hub CHR).
// Respons backend: { script, script_v6, script_v7, notes[] }. Nilai null = tidak didukung di versi itu.

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

// Salin teks. navigator.clipboard hanya tersedia di secure context (HTTPS atau localhost).
// Di http://IP:5000 API ini tidak ada, jadi dipakai fallback execCommand('copy') pada textarea modal.
export async function copyText(text, element = null) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Lanjut ke fallback.
    }
  }
  const area = element || document.createElement('textarea')
  const attached = !element
  if (attached) {
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
  }
  area.focus()
  area.select()
  area.setSelectionRange(0, area.value.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  if (attached) document.body.removeChild(area)
  return ok
}

const TAB_BASE = 'rounded-lg px-3 py-1.5 text-sm font-bold transition-colors'
const TAB_ON = 'bg-blue-600 text-white'
const TAB_OFF = 'bg-gray-100 text-slate-700 hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700'
const TAB_DISABLED = 'cursor-not-allowed bg-gray-50 text-gray-400 dark:bg-slate-900 dark:text-slate-500'

// Buka modal. Mengembalikan false bila tidak ada script yang bisa ditampilkan (caller menampilkan error).
export function showVpnScriptModal({ title, subtitle = '', body = {} }) {
  const v7 = body.script_v7 || null
  const v6 = body.script_v6 || null
  const fallback = body.script || ''
  const scriptV7 = v7 || (v6 ? null : fallback)
  const scriptV6 = v6
  if (!scriptV7 && !scriptV6) {
    return Promise.resolve(false)
  }
  const defaultTab = scriptV7 ? 'v7' : 'v6'
  const notes = Array.isArray(body.notes) ? body.notes : []

  const tabButton = (tab, label, enabled) => `
    <button type="button" data-tab="${tab}" class="${TAB_BASE} ${enabled ? TAB_OFF : TAB_DISABLED}" ${enabled ? '' : 'disabled'}>${label}</button>`

  const panelV7 = scriptV7
    ? `<textarea id="vpn-area-v7" readonly spellcheck="false" rows="16"
         class="mt-3 w-full rounded-lg border border-gray-300 bg-slate-950 p-3 font-mono text-xs text-emerald-200 outline-none dark:border-slate-600">${esc(scriptV7)}</textarea>`
    : `<p class="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">Protokol ini tidak tersedia untuk RouterOS v7.</p>`
  const panelV6 = scriptV6
    ? `<textarea id="vpn-area-v6" readonly spellcheck="false" rows="16"
         class="mt-3 w-full rounded-lg border border-gray-300 bg-slate-950 p-3 font-mono text-xs text-emerald-200 outline-none dark:border-slate-600">${esc(scriptV6)}</textarea>`
    : `<p class="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">WireGuard membutuhkan RouterOS v7 (7.x) ke atas. Untuk RouterOS v6 gunakan OpenVPN atau L2TP.</p>`

  const html = `
    <div class="text-left">
      ${subtitle ? `<p class="text-sm text-slate-600 dark:text-gray-300">${esc(subtitle)}</p>` : ''}
      <div class="mt-4 flex gap-2" role="tablist">
        ${tabButton('v7', 'RouterOS v7', Boolean(scriptV7))}
        ${tabButton('v6', 'RouterOS v6', Boolean(scriptV6))}
      </div>
      <div data-panel="v7" class="${defaultTab === 'v7' ? '' : 'hidden'}">${panelV7}</div>
      <div data-panel="v6" class="${defaultTab === 'v6' ? '' : 'hidden'}">${panelV6}</div>
      ${notes.length ? `<ul class="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500 dark:text-gray-400">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" id="vpn-copy-btn" class="inline-flex h-10 items-center justify-center rounded-lg bg-emerald-600 px-4 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40">Salin Script</button>
        <span id="vpn-copy-status" class="text-sm font-semibold" role="status" aria-live="polite"></span>
      </div>
    </div>`

  return Swal.fire({
    title,
    html,
    width: 780,
    showConfirmButton: false,
    showCloseButton: true,
    didOpen: (popup) => {
      let active = defaultTab
      const status = popup.querySelector('#vpn-copy-status')
      const copyBtn = popup.querySelector('#vpn-copy-btn')

      const show = (tab) => {
        active = tab
        popup.querySelectorAll('[data-tab]').forEach((btn) => {
          const on = btn.dataset.tab === tab
          btn.className = `${TAB_BASE} ${on ? TAB_ON : btn.disabled ? TAB_DISABLED : TAB_OFF}`
        })
        popup.querySelectorAll('[data-panel]').forEach((panel) => {
          panel.classList.toggle('hidden', panel.dataset.panel !== tab)
        })
        copyBtn.disabled = tab === 'v7' ? !scriptV7 : !scriptV6
        status.textContent = ''
      }

      popup.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!btn.disabled) show(btn.dataset.tab)
        })
      })

      copyBtn.addEventListener('click', async () => {
        const area = popup.querySelector(`#vpn-area-${active}`)
        if (!area) return
        const ok = await copyText(area.value, area)
        status.className = `text-sm font-semibold ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`
        status.textContent = ok
          ? `Script RouterOS ${active === 'v7' ? 'v7' : 'v6'} berhasil disalin.`
          : 'Penyalinan otomatis tidak tersedia di browser ini. Teks sudah dipilih; tekan Ctrl+C (Cmd+C di Mac).'
        if (!ok) {
          area.focus()
          area.select()
        }
      })

      show(defaultTab)
    },
  }).then(() => true)
}
