const express = require('express');
const requireRole = require('../middleware/requireRole');
const { restartService } = require('../service_restart');

const router = express.Router();
const requireAdmin = requireRole('admin');

// POST /api/sistem/restart-service  { service: 'web' | 'postgresql' | 'freeradius' }
// Hanya administrator. Aksi ini ikut tercatat di Log Aplikasi lewat activityLogger.
router.post('/restart-service', requireAdmin, async (req, res) => {
  const service = typeof req.body?.service === 'string' ? req.body.service.trim() : '';

  try {
    const result = await restartService(service);
    if (result.deferred) {
      res.json({ success: true, message: result.message, service: result.service });
      result.start();
      return;
    }
    return res.json({ success: true, message: result.message, service: result.service });
  } catch (error) {
    const status = Number(error.status) || 500;
    return res.status(status).json({
      success: false,
      message: status === 500
        ? `Gagal me-restart layanan. ${String(error.message || '').slice(0, 240)}`
        : error.message,
    });
  }
});

module.exports = router;
