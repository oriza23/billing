/**
 * POST /api/isolir/:id
 * POST /api/buka-isolir/:id
 *
 * Alias HTTP untuk isolir Full RADIUS (logika di pppoe_isolir/isolir_full_radius.js).
 */

const express = require('express');
const pool = require('../../database');
const requireRole = require('../middleware/requireRole');
const {
  IsolirError,
  isolirPelangganFullRadius,
  bukaIsolirPelangganFullRadius,
} = require('../pppoe_isolir/isolir_full_radius');

const requireAdmin = requireRole('admin');

function readId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleError(res, error, fallback) {
  if (error instanceof IsolirError) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  return res.status(500).json({
    success: false,
    message: fallback,
    error: error.message,
  });
}

async function handleIsolir(req, res) {
  const id = readId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
  }
  const kick = req.body?.kick !== false;
  try {
    const result = await isolirPelangganFullRadius(id, { sumber: 'manual', kick }, pool);
    return res.json(result);
  } catch (error) {
    return handleError(res, error, 'Gagal mengisolir pelanggan');
  }
}

async function handleBukaIsolir(req, res) {
  const id = readId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID pelanggan tidak valid' });
  }
  const kick = req.body?.kick !== false;
  try {
    const result = await bukaIsolirPelangganFullRadius(id, { kick }, pool);
    return res.json(result);
  } catch (error) {
    return handleError(res, error, 'Gagal membuka isolir');
  }
}

const isolirRouter = express.Router();
isolirRouter.post('/:id', requireAdmin, handleIsolir);

const bukaIsolirRouter = express.Router();
bukaIsolirRouter.post('/:id', requireAdmin, handleBukaIsolir);

module.exports = isolirRouter;
module.exports.bukaIsolirRouter = bukaIsolirRouter;
module.exports.handleIsolir = handleIsolir;
module.exports.handleBukaIsolir = handleBukaIsolir;
