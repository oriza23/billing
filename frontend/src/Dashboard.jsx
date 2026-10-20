import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Swal from 'sweetalert2'
import { Menu } from 'lucide-react'
import { clearSession } from './api/auth.js'
import ServerClock from './ServerClock.jsx'
import ThemeToggle from './ThemeToggle.jsx'

const langgananMenu = [
  { to: '/langganan/profil', label: 'Profil Langganan' },
  // Form tambah dibuka dari tombol TAMBAH di Data Langganan, jadi menu ini tetap aktif di sana.
  { to: '/langganan/data', label: 'Data Langganan', alsoActive: ['/langganan/tambah'] },
  { to: '/langganan/online', label: 'Langganan Online' },
]

const hotspotMenu = [
  { to: '/dashboard/hotspot/profil', label: 'Profil Hotspot' },
  { to: '/dashboard/hotspot/stok', label: 'Stok Voucher' },
  { to: '/dashboard/hotspot/terjual', label: 'Voucher Terjual' },
  { to: '/dashboard/hotspot/online', label: 'Voucher Online' },
]

const sistemMenu = [
  { to: '/manajemen-admin', label: 'Manajemen Admin' },
  { to: '/sistem/pengaturan', label: 'Pengaturan' },
]

const navLinkClass = ({ isActive }) =>
  [
    'flex h-11 w-full items-center justify-between rounded-xl px-3.5 text-left text-[15px] font-semibold text-sky-100 no-underline transition-colors duration-300',
    isActive ? 'bg-white/15 text-white shadow-[inset_3px_0_0_#67e8f9]' : 'hover:bg-white/10 hover:text-white',
  ].join(' ')

export function DashboardHome() {
  return (
    <>
      <header>
        <p className="m-0 mb-1.5 text-[13px] font-bold tracking-[0.12em] text-cyan-700 uppercase transition-colors duration-300 dark:text-cyan-300">
          Ringkasan
        </p>
        <h1 className="m-0 text-3xl font-bold tracking-tight text-gray-900 transition-colors duration-300 dark:text-gray-100">
          Selamat Datang di Sistem Billing
        </h1>
      </header>

      <section className="mt-7 rounded-2xl border border-gray-200 bg-white p-6 text-[15px] text-gray-600 shadow-sm transition-colors duration-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
        <p className="m-0">Gunakan menu di samping untuk mengelola data billing.</p>
      </section>
    </>
  )
}

function MenuGroup({ label, items, open, onToggle }) {
  const { pathname } = useLocation()

  return (
    <div>
      <button
        type="button"
        className={`flex h-11 w-full cursor-pointer items-center justify-between rounded-xl border-0 bg-transparent px-3.5 text-left text-[15px] font-semibold transition-colors duration-300 ${open ? 'text-white' : 'text-sky-100 hover:bg-white/10 hover:text-white'}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span className="text-lg leading-none text-sky-200" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="mt-0.5 mb-2 grid gap-1 pl-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => navLinkClass({
                isActive: isActive || Boolean(item.alsoActive?.some((path) => pathname.startsWith(path))),
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

function Dashboard() {
  const location = useLocation()
  const navigate = useNavigate()
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [openMenus, setOpenMenus] = useState({
    langganan: location.pathname.startsWith('/langganan') || location.pathname.startsWith('/dashboard/pppoe'),
    hotspot: location.pathname.startsWith('/dashboard/hotspot'),
    sistem: location.pathname.startsWith('/manajemen-admin') || location.pathname.startsWith('/sistem'),
  })

  useEffect(() => {
    setIsSidebarOpen(false)
    if (location.pathname.startsWith('/langganan') || location.pathname.startsWith('/dashboard/pppoe')) {
      setOpenMenus((current) => ({ ...current, langganan: true }))
    }
    if (location.pathname.startsWith('/dashboard/hotspot')) {
      setOpenMenus((current) => ({ ...current, hotspot: true }))
    }
    if (location.pathname.startsWith('/manajemen-admin') || location.pathname.startsWith('/sistem')) {
      setOpenMenus((current) => ({ ...current, sistem: true }))
    }
  }, [location.pathname])

  async function handleLogout() {
    const result = await Swal.fire({
      title: 'Yakin ingin keluar?',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Ya',
      cancelButtonText: 'Batal',
    })
    if (!result.isConfirmed) {
      return
    }

    clearSession()
    navigate('/')
  }

  function toggleMenu(menu) {
    setOpenMenus((current) => ({ ...current, [menu]: !current[menu] }))
  }

  const sidebarClass = [
    'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 transform flex-col gap-5 bg-linear-to-b from-slate-950 to-cyan-900 px-4 py-5 text-sky-50 transition-transform duration-300 ease-in-out',
    isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
    'md:sticky md:top-0 md:bottom-auto md:left-auto md:z-auto md:h-svh md:w-70 md:translate-x-0 md:gap-7 md:px-4.5 md:py-7',
  ].join(' ')

  return (
    <div className="flex min-h-svh flex-col bg-gray-50 font-sans text-gray-900 transition-colors duration-300 md:flex-row dark:bg-gray-900 dark:text-gray-100">
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside id="app-sidebar" className={sidebarClass}>
        <div className="flex items-center gap-3 px-2">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-linear-to-br from-cyan-600 to-cyan-800 text-xl font-bold" aria-hidden="true">
            B
          </span>
          <div>
            <p className="m-0 text-xs font-bold tracking-[0.12em] text-sky-200 uppercase">Sistem Billing</p>
            <strong className="mt-0.5 block text-[15px] font-semibold">Panel Admin</strong>
          </div>
        </div>
        <ServerClock />

        <nav className="grid flex-1 content-start gap-1.5 overflow-x-hidden overflow-y-auto pr-1 custom-sidebar-scrollbar" aria-label="Menu utama">
          <NavLink to="/dashboard" end className={navLinkClass}>
            Dashboard
          </NavLink>
          <MenuGroup
            label="Langganan"
            items={langgananMenu}
            open={openMenus.langganan}
            onToggle={() => toggleMenu('langganan')}
          />
          <MenuGroup
            label="Hotspot"
            items={hotspotMenu}
            open={openMenus.hotspot}
            onToggle={() => toggleMenu('hotspot')}
          />
          <NavLink to="/router" className={navLinkClass}>
            Router
          </NavLink>
          <MenuGroup
            label="Sistem"
            items={sistemMenu}
            open={openMenus.sistem}
            onToggle={() => toggleMenu('sistem')}
          />
        </nav>

        <ThemeToggle />
        <button
          type="button"
          className="h-11 cursor-pointer rounded-xl border-0 bg-rose-600 text-[15px] font-bold text-white shadow-lg shadow-rose-600/30 transition-colors duration-300 hover:bg-rose-700"
          onClick={handleLogout}
        >
          Logout
        </button>
      </aside>

      <main className="min-w-0 flex-1 bg-gray-50 p-6 text-gray-900 transition-colors duration-300 md:px-10 md:py-9 dark:bg-gray-900 dark:text-gray-100">
        <header className="sticky top-0 z-30 -mx-6 -mt-6 mb-5 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/95 px-3 backdrop-blur-sm md:hidden dark:border-gray-700 dark:bg-gray-900/95">
          <button
            type="button"
            className="grid h-10 w-10 cursor-pointer place-items-center rounded-xl border-0 bg-transparent text-gray-800 transition-colors duration-300 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800"
            aria-label="Buka menu"
            aria-controls="app-sidebar"
            aria-expanded={isSidebarOpen}
            onClick={() => setIsSidebarOpen(true)}
          >
            <Menu size={22} strokeWidth={2.2} />
          </button>
          <span className="text-sm font-bold tracking-[0.08em] text-gray-900 uppercase dark:text-gray-100">
            Sistem Billing
          </span>
        </header>
        <Outlet />
      </main>
    </div>
  )
}

export default Dashboard
