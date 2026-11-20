import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Swal from 'sweetalert2'
import {
  Activity,
  ClipboardList,
  IdCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Router,
  ScrollText,
  Settings,
  Shield,
  Ticket,
  User,
  Users,
  WalletCards,
  Wifi,
} from 'lucide-react'
import { clearSession, getNamaLengkap, getRoleLabel, getUsername } from './api/auth.js'
import ChangePasswordModal from './ChangePasswordModal.jsx'
import AdminProfileModal from './AdminProfileModal.jsx'
import api from './api/axios.js'
import ServerClock from './ServerClock.jsx'
import ThemeToggle from './ThemeToggle.jsx'

const langgananMenu = [
  { to: '/langganan/profil', label: 'Profil Langganan', icon: IdCard },
  // Form tambah dibuka dari tombol TAMBAH di Data Langganan, jadi menu ini tetap aktif di sana.
  { to: '/langganan/data', label: 'Data Langganan', icon: ClipboardList, alsoActive: ['/langganan/tambah', '/langganan/registrasi'] },
  { to: '/langganan/online', label: 'Langganan Online', icon: Activity },
]

const hotspotMenu = [
  { to: '/dashboard/hotspot/profil', label: 'Profil Hotspot', icon: Wifi },
  { to: '/dashboard/hotspot/stok', label: 'Stok Voucher', icon: Ticket },
  { to: '/dashboard/hotspot/terjual', label: 'Voucher Terjual', icon: WalletCards },
  { to: '/dashboard/hotspot/online', label: 'Voucher Online', icon: Activity },
]

const sistemMenu = [
  { to: '/manajemen-admin', label: 'Manajemen Admin', icon: Shield },
  { to: '/sistem/pengaturan', label: 'Pengaturan', icon: Settings },
]

const navLinkClass = ({ isActive }) =>
  [
    'flex h-11 w-full items-center justify-between gap-3 rounded-xl px-3.5 text-left text-[15px] font-semibold text-sky-100 no-underline transition-colors duration-300',
    isActive ? 'bg-white/15 text-white shadow-[inset_3px_0_0_#67e8f9]' : 'hover:bg-white/10 hover:text-white',
  ].join(' ')

function SidebarIcon({ icon: Icon }) {
  if (!Icon) {
    return null
  }
  return <Icon size={18} strokeWidth={2.1} className="shrink-0 text-sky-200/90" aria-hidden="true" />
}

function SidebarNavLink({ to, end, label, icon: Icon, alsoActive = [] }) {
  const { pathname } = useLocation()
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => navLinkClass({
        isActive: isActive || alsoActive.some((path) => pathname.startsWith(path)),
      })}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <SidebarIcon icon={Icon} />
        <span className="truncate">{label}</span>
      </span>
    </NavLink>
  )
}

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

function MenuGroup({ label, icon: Icon, items, open, onToggle }) {
  return (
    <div>
      <button
        type="button"
        className={`flex h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border-0 bg-transparent px-3.5 text-left text-[15px] font-semibold transition-colors duration-300 ${open ? 'text-white' : 'text-sky-100 hover:bg-white/10 hover:text-white'}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <SidebarIcon icon={Icon} />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-lg leading-none text-sky-200" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="mt-0.5 mb-2 grid gap-1 pl-3">
          {items.map((item) => (
            <SidebarNavLink
              key={item.to}
              to={item.to}
              label={item.label}
              icon={item.icon}
              alsoActive={item.alsoActive}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function profilePhotoUrl(path) {
  if (!path) {
    return ''
  }
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  const base = api.defaults.baseURL || ''
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

function ProfileMenu({ username, onLogout }) {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState('')
  const [namaLengkap, setNamaLengkap] = useState(getNamaLengkap)
  const [roleLabel, setRoleLabel] = useState(getRoleLabel)
  const menuRef = useRef(null)
  const label = namaLengkap || username || 'Pengguna'

  useEffect(() => {
    const syncIdentity = () => {
      setNamaLengkap(getNamaLengkap())
      setRoleLabel(getRoleLabel())
    }
    syncIdentity()
    window.addEventListener('admin-session-changed', syncIdentity)
    return () => window.removeEventListener('admin-session-changed', syncIdentity)
  }, [username])

  useEffect(() => {
    let ignore = false
    api.get('/users/profile')
      .then((response) => {
        if (!ignore && response.data?.foto_profil) {
          setAvatarUrl(profilePhotoUrl(response.data.foto_profil))
        }
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [username])

  useEffect(() => {
    if (!isProfileMenuOpen) {
      return undefined
    }
    function onPointerDown(event) {
      if (!menuRef.current?.contains(event.target)) {
        setIsProfileMenuOpen(false)
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        setIsProfileMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isProfileMenuOpen])

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        className="flex h-10 max-w-[16rem] cursor-pointer items-center gap-2 rounded-xl border border-gray-200 bg-white px-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
        aria-expanded={isProfileMenuOpen}
        aria-haspopup="menu"
        onClick={() => setIsProfileMenuOpen((open) => !open)}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-cyan-700 text-white" aria-hidden="true">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <User size={16} />
          )}
        </span>
        <span className="min-w-0 text-left">
          <span className="block max-w-[10rem] truncate leading-tight">{label}</span>
          <span className="block truncate text-[11px] font-semibold text-gray-400 leading-tight dark:text-gray-400">{roleLabel}</span>
        </span>
      </button>

      {isProfileMenuOpen && (
        <div
          className="absolute top-full right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
          role="menu"
        >
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-sm font-semibold text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700"
            role="menuitem"
            onClick={() => {
              setIsProfileMenuOpen(false)
              setProfileOpen(true)
            }}
          >
            <User size={16} aria-hidden="true" />
            Profil Saya
          </button>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-sm font-semibold text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700"
            role="menuitem"
            onClick={() => {
              setIsProfileMenuOpen(false)
              setPasswordOpen(true)
            }}
          >
            <KeyRound size={16} aria-hidden="true" />
            Ubah Password
          </button>
          <p className="m-0 border-t border-gray-200 px-3 py-2 text-[11px] font-semibold text-gray-400 dark:border-gray-700 dark:text-gray-500">
            Login sebagai {username} · {roleLabel}
          </p>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-sm font-semibold text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950"
            role="menuitem"
            onClick={() => {
              setIsProfileMenuOpen(false)
              onLogout()
            }}
          >
            <LogOut size={16} aria-hidden="true" />
            Logout
          </button>
        </div>
      )}

      {profileOpen && (
        <AdminProfileModal
          username={username}
          onClose={() => setProfileOpen(false)}
          onSaved={(profile) => {
            setAvatarUrl(profile?.foto_profil ? profilePhotoUrl(profile.foto_profil) : '')
            setNamaLengkap(getNamaLengkap())
            window.dispatchEvent(new Event('admin-session-changed'))
          }}
        />
      )}
      {passwordOpen && <ChangePasswordModal onClose={() => setPasswordOpen(false)} />}
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
          <SidebarNavLink to="/dashboard" end label="Dashboard" icon={LayoutDashboard} />
          <MenuGroup
            label="Langganan"
            icon={Users}
            items={langgananMenu}
            open={openMenus.langganan}
            onToggle={() => toggleMenu('langganan')}
          />
          <MenuGroup
            label="Hotspot"
            icon={Wifi}
            items={hotspotMenu}
            open={openMenus.hotspot}
            onToggle={() => toggleMenu('hotspot')}
          />
          <SidebarNavLink to="/acs" label="GenieACS" icon={Network} />
          <SidebarNavLink to="/router" label="Router" icon={Router} />
          <SidebarNavLink to="/logs" label="Logs" icon={ScrollText} />
          <MenuGroup
            label="Sistem"
            icon={Settings}
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
        <header className="sticky top-0 z-30 -mx-6 -mt-6 mb-5 flex h-14 items-center justify-between gap-3 border-b border-gray-200 bg-white/95 px-3 backdrop-blur-sm md:-mx-10 md:-mt-9 md:px-6 dark:border-gray-700 dark:bg-gray-900/95">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="grid h-10 w-10 cursor-pointer place-items-center rounded-xl border-0 bg-transparent text-gray-800 transition-colors duration-300 hover:bg-gray-100 md:hidden dark:text-gray-100 dark:hover:bg-gray-800"
              aria-label="Buka menu"
              aria-controls="app-sidebar"
              aria-expanded={isSidebarOpen}
              onClick={() => setIsSidebarOpen(true)}
            >
              <Menu size={22} strokeWidth={2.2} />
            </button>
            <span className="truncate text-sm font-bold tracking-[0.08em] text-gray-900 uppercase md:hidden dark:text-gray-100">
              Sistem Billing
            </span>
          </div>
          <ProfileMenu username={getUsername()} onLogout={handleLogout} />
        </header>
        <Outlet />
      </main>
    </div>
  )
}

export default Dashboard
