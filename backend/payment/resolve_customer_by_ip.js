/**
 * Cocokkan IP isolir pool → username PPPoE → data langganan.
 *
 * Alur:
 *  1. Pelanggan isolir tetap online (profil walled garden); MikroTik/RADIUS memberi IP pool isolir.
 *  2. FreeRADIUS menulis sesi aktif ke radacct (acctstoptime IS NULL) dengan framedipaddress.
 *  3. Backend membaca IP request (req.ip / X-Forwarded-For) dan mencari baris radacct terbaru
 *     dengan framedipaddress = IP tersebut.
 *  4. username di radacct di-JOIN ke langganan_pelanggan → tagihan tanpa login admin.
 *
 * Catatan: jika beberapa username share NAT (jarang di PPPoE), ambil sesi paling baru (ORDER BY acctstarttime DESC).
 */

const SELECT_BY_IP = `
  SELECT
    c.id,
    c.pelanggan,
    c.username,
    c.status,
    c.total,
    c.sub_total,
    c.ppn_nominal,
    c.kode_unik,
    c.jatuh_tempo,
    c.phone,
    c.nolayanan,
    a.framedipaddress AS session_ip,
    a.callingstationid AS mac_address,
    a.acctstarttime AS session_start
  FROM radacct a
  INNER JOIN langganan_pelanggan c ON c.username = a.username
  WHERE a.acctstoptime IS NULL
    AND a.framedipaddress = ?
  ORDER BY a.acctstarttime DESC, a.radacctid DESC
  LIMIT 1
`;

async function findCustomerBySessionIp(db, clientIp) {
  const ip = String(clientIp || '').trim();
  if (!ip) {
    return { ok: false, status: 400, message: 'IP klien tidak terdeteksi' };
  }

  const [rows] = await db.execute(SELECT_BY_IP, [ip]);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      status: 404,
      message: 'Tidak ada sesi PPPoE aktif untuk IP ini. Pastikan perangkat terhubung ke jaringan isolir.',
      ip,
    };
  }

  return { ok: true, customer: row, ip };
}

module.exports = { SELECT_BY_IP, findCustomerBySessionIp };
