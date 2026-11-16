/**
 * Menyajikan hasil build React (frontend/dist) dari Express yang sama dengan API,
 * sehingga frontend & backend satu origin (satu port): tanpa CORS dan tanpa Mixed Content.
 *
 * Pasang SETELAH semua route /api dan /uploads. Bila dist belum dibuild, tidak ada
 * yang dipasang (mode dev tetap memakai Vite di port 5173).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const DEFAULT_DIST = path.join(__dirname, '..', 'frontend', 'dist');
const BACKEND_PREFIXES = ['/api/', '/uploads/'];

function cacheHeaders(res, filePath) {
  if (/[\\/]assets[\\/]/.test(filePath)) {
    // File di assets/ bernama hash: aman di-cache selamanya.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

function mountFrontend(app, distDir = DEFAULT_DIST) {
  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return false;
  }

  app.use(express.static(distDir, { index: false, setHeaders: cacheHeaders }));

  // Fallback SPA: URL halaman React (mis. /langganan/data saat di-refresh) -> index.html.
  // API/uploads dan permintaan file yang tidak ada (ada ekstensi) tetap 404, bukan HTML.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    if (BACKEND_PREFIXES.some((prefix) => req.path.startsWith(prefix)) || path.extname(req.path)) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });

  return true;
}

module.exports = { mountFrontend, DEFAULT_DIST };
