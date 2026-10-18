import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Swal from 'sweetalert2'
import './Dashboard.css'

const pppoeMenu = [
  { to: '/dashboard/pppoe/profil', label: 'Profil PPPoE' },
  { to: '/dashboard/pppoe/pelanggan', label: 'Data Pelanggan' },
  { to: '/dashboard/pppoe/online', label: 'Pelanggan Online' },
]

const hotspotMenu = [
  { to: '/dashboard/hotspot/profil', label: 'Profil Hotspot' },
  { to: '/dashboard/hotspot/stok', label: 'Stok Voucher' },
  { to: '/dashboard/hotspot/terjual', label: 'Voucher Terjual' },
  { to: '/dashboard/hotspot/online', label: 'Voucher Online' },
]

const sistemMenu = [
  { to: '/manajemen-admin', label: 'Manajemen Admin' },
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
    pppoe: location.pathname.startsWith('/dashboard/pppoe'),
    hotspot: location.pathname.startsWith('/dashboard/hotspot'),
    sistem: location.pathname.startsWith('/manajemen-admin'),
  })

  useEffect(() => {
    if (location.pathname.startsWith('/dashboard/pppoe')) {
      setOpenMenus((current) => ({ ...current, pppoe: true }))
    }
    if (location.pathname.startsWith('/dashboard/hotspot')) {
      setOpenMenus((current) => ({ ...current, hotspot: true }))
    }
    if (location.pathname.startsWith('/manajemen-admin')) {
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

    localStorage.removeItem('admin_user')
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

        <nav className="sidebar-nav" aria-label="Menu utama">
          <NavLink to="/dashboard" end className="sidebar-link">
            Dashboard
          </NavLink>
          <MenuGroup
            label="PPPoE"
            items={pppoeMenu}
            open={openMenus.pppoe}
            onToggle={() => toggleMenu('pppoe')}
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
