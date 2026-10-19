import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Swal from 'sweetalert2'
import { clearSession } from './api/auth.js'
import ServerClock from './ServerClock.jsx'
import './Dashboard.css'

const langgananMenu = [
  { to: '/langganan/profil', label: 'Profil Langganan' },
  { to: '/langganan/data', label: 'Data Langganan' },
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

export function DashboardHome() {
  return (
    <>
      <header className="dashboard-header">
        <p>Ringkasan</p>
        <h1>Selamat Datang di Sistem Billing</h1>
      </header>

      <section className="dashboard-panel">
        <p>Gunakan menu di samping untuk mengelola data billing.</p>
      </section>
    </>
  )
}

function MenuGroup({ label, items, open, onToggle }) {
  return (
    <div className="sidebar-group">
      <button
        type="button"
        className={open ? 'sidebar-link is-open' : 'sidebar-link'}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span className="sidebar-caret" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="sidebar-submenu">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} className="sidebar-sublink">
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
  const [openMenus, setOpenMenus] = useState({
    langganan: location.pathname.startsWith('/langganan') || location.pathname.startsWith('/dashboard/pppoe'),
    hotspot: location.pathname.startsWith('/dashboard/hotspot'),
    sistem: location.pathname.startsWith('/manajemen-admin') || location.pathname.startsWith('/sistem'),
  })

  useEffect(() => {
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

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">
            B
          </span>
          <div>
            <p>Sistem Billing</p>
            <strong>Panel Admin</strong>
          </div>
        </div>
        <ServerClock />

        <nav className="sidebar-nav" aria-label="Menu utama">
          <NavLink to="/dashboard" end className="sidebar-link">
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
          <NavLink to="/router" className="sidebar-link">
            Router
          </NavLink>
          <MenuGroup
            label="Sistem"
            items={sistemMenu}
            open={openMenus.sistem}
            onToggle={() => toggleMenu('sistem')}
          />
        </nav>

        <button type="button" className="sidebar-logout" onClick={handleLogout}>
          Logout
        </button>
      </aside>

      <main className="dashboard-main">
        <Outlet />
      </main>
    </div>
  )
}

export default Dashboard
