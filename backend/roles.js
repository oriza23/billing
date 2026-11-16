// Daftar role admin & aturan izin dasar.
//
// Role bawaan aplikasi:
//   admin     -> Administrator (akses penuh)
//   operator  -> operator jaringan (ACS, router, isolir)
//   teknisi   -> teknisi lapangan (ACS, router)
//   cs        -> customer service (langganan, hotspot, isolir)
//   customer  -> pelanggan (baca data sendiri)
//
// SUPER_ROLES selalu lolos semua pengecekan requireRole: supaya akun lama
// (role "admin") dan alias umum tidak pernah terkunci saat role baru ditambah.
const ROLES = ['admin', 'operator', 'teknisi', 'cs', 'customer'];

const LABELS = {
  admin: 'Administrator',
  operator: 'Operator',
  teknisi: 'Teknisi',
  cs: 'Customer Service',
  customer: 'Pelanggan',
};

const SUPER_ROLES = ['admin', 'administrator', 'owner', 'superadmin'];

function normalizeRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return role.slice(0, 20);
}

function isSuperRole(role) {
  return SUPER_ROLES.includes(normalizeRole(role));
}

function isValidRole(role) {
  return ROLES.includes(normalizeRole(role));
}

function labelOf(role) {
  const key = normalizeRole(role);
  return LABELS[key] || (key ? key : '-');
}

module.exports = {
  ROLES,
  LABELS,
  SUPER_ROLES,
  normalizeRole,
  isSuperRole,
  isValidRole,
  labelOf,
};
