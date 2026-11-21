// Jenis server di tabel router_servers: 'hotspot', 'pppoe', atau 'both'
// (satu server melayani Hotspot sekaligus PPPoE).

export const JENIS_LABEL = { hotspot: 'Hotspot', pppoe: 'PPPoE', both: 'Hotspot & PPPoE' }

// true bila server bertipe `jenisServer` boleh dipakai untuk `layanan`
// ('hotspot' atau 'pppoe'). Server 'both' cocok untuk keduanya.
export function melayani(jenisServer, layanan) {
  return jenisServer === 'both' || jenisServer === layanan
}

// Daftar layanan dari jenis server: 'both' -> ['hotspot', 'pppoe'].
export function layananDariJenis(jenisServer) {
  if (jenisServer === 'both') return ['hotspot', 'pppoe']
  return jenisServer === 'hotspot' || jenisServer === 'pppoe' ? [jenisServer] : []
}

// Kebalikannya: ['hotspot', 'pppoe'] -> 'both', ['pppoe'] -> 'pppoe', [] -> ''.
export function jenisDariLayanan({ hotspot, pppoe }) {
  if (hotspot && pppoe) return 'both'
  if (hotspot) return 'hotspot'
  if (pppoe) return 'pppoe'
  return ''
}
