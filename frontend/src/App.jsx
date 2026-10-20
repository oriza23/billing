import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { hasValidToken } from './api/auth.js'
import Dashboard, { DashboardHome } from './Dashboard.jsx'
import HotspotOnline from './HotspotOnline.jsx'
import HotspotProfil from './HotspotProfil.jsx'
import HotspotStok from './HotspotStok.jsx'
import HotspotTerjual from './HotspotTerjual.jsx'
import LanggananData from './LanggananData.jsx'
import LanggananProfil from './LanggananProfil.jsx'
import Login from './Login.jsx'
import PrintVoucher from './PrintVoucher.jsx'
import ManajemenAdmin from './ManajemenAdmin.jsx'
import PppoeOnline from './PppoeOnline.jsx'
import PppoePelanggan from './PppoePelanggan.jsx'
import PppoeProfil from './PppoeProfil.jsx'
import RouterMaster from './RouterMaster.jsx'
import SistemPengaturan from './SistemPengaturan.jsx'
import TambahLanggananPppoe from './TambahLanggananPppoe.jsx'

// Halaman yang butuh login: tanpa token yang valid, paksa kembali ke halaman Login.
function ProtectedRoute() {
  return hasValidToken() ? <Outlet /> : <Navigate to="/" replace />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/print" element={<PrintVoucher />} />
          <Route path="/dashboard" element={<Dashboard />}>
            <Route index element={<DashboardHome />} />
            <Route path="pppoe/profil" element={<PppoeProfil />} />
            <Route path="pppoe/pelanggan" element={<PppoePelanggan />} />
            <Route path="pppoe/online" element={<PppoeOnline />} />
            <Route path="hotspot/profil" element={<HotspotProfil />} />
            <Route path="hotspot/stok" element={<HotspotStok />} />
            <Route path="hotspot/terjual" element={<HotspotTerjual />} />
            <Route path="hotspot/online" element={<HotspotOnline />} />
          </Route>
          <Route path="/pelanggan" element={<Navigate to="/langganan/data" replace />} />
          <Route path="/langganan" element={<Dashboard />}>
            <Route path="profil" element={<LanggananProfil />} />
            <Route path="data" element={<LanggananData />} />
            <Route path="tambah" element={<TambahLanggananPppoe />} />
            <Route path="online" element={<PppoeOnline />} />
          </Route>
          <Route path="/router" element={<Dashboard />}>
            <Route index element={<RouterMaster />} />
          </Route>
          <Route path="/sistem" element={<Dashboard />}>
            <Route path="pengaturan" element={<SistemPengaturan />} />
          </Route>
          <Route path="/manajemen-admin" element={<Dashboard />}>
            <Route index element={<ManajemenAdmin />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
