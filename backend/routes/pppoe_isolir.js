/**
 * API isolir / buka isolir PPPoE.
 *
 *   POST /api/langganan/isolir/:id
 *   POST /api/langganan/isolir/:id/buka
 *   POST /api/isolir/:id          (alias)
 *   POST /api/buka-isolir/:id     (alias)
 */

const express = require('express');
const requireRole = require('../middleware/requireRole');
const { IsolirError, isolirPelanggan, bukaIsolirPelanggan } = require('../pppoe_isolir/service');

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
    const result = await isolirPelanggan(id, { sumber: 'manual', kick });
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
    const result = await bukaIsolirPelanggan(id, { kick });
    return res.json(result);
  } catch (error) {
    return handleError(res, error, 'Gagal membuka isolir');
  }
}

const mainRouter = express.Router();
mainRouter.post('/:id', requireAdmin, handleIsolir);
mainRouter.post('/:id/buka', requireAdmin, handleBukaIsolir);

const bukaAliasRouter = express.Router();
bukaAliasRouter.post('/:id', requireAdmin, handleBukaIsolir);

module.exports = mainRouter;
module.exports.bukaAliasRouter = bukaAliasRouter;
module.exports.handleIsolir = handleIsolir;
module.exports.handleBukaIsolir = handleBukaIsolir;
