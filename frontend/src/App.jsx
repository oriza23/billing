import { BrowserRouter, Route, Routes } from 'react-router-dom'
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

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
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
        <Route path="/langganan" element={<Dashboard />}>
          <Route path="profil" element={<LanggananProfil />} />
          <Route path="data" element={<LanggananData />} />
          <Route path="online" element={<PppoeOnline />} />
        </Route>
        <Route path="/router" element={<Dashboard />}>
          <Route index element={<RouterMaster />} />
        </Route>
        <Route path="/manajemen-admin" element={<Dashboard />}>
          <Route index element={<ManajemenAdmin />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
