// Dipasang setelah requireAuth. Role yang tidak ada di daftar ditolak dengan 403.
//
// Aturan:
//  - Role SUPER_ROLES (admin/administrator/owner/superadmin) selalu lolos, sehingga
//    menambah role baru tidak pernah mengunci akun administrator lama.
//  - Role tambahan bisa diminta per-route, mis. requireRole('admin', 'operator', 'cs').
const { isSuperRole, normalizeRole } = require('../roles');

function requireRole(...roles) {
  const allowed = new Set(roles.map(normalizeRole));

  return function requireRoleMiddleware(req, res, next) {
    const role = normalizeRole(req.user?.role);
    if (allowed.has(role) || isSuperRole(role)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: 'Akses ditolak',
    });
  };
}

module.exports = requireRole;
