# Frontend — RANIAH.NET Billing

Antarmuka React 19 + Vite untuk panel billing ISP. Backend ada di direktori induk (`server.js`
dan `backend/`); frontend tidak menyimpan data sendiri dan seluruh API dipanggil ke origin backend.

## Pengembangan

```bash
npm install
npm run dev        # http://localhost:5173
```

Jalankan backend dari direktori induk lebih dulu (`npm start`). Saat dev, halaman dilayani Vite
sehingga header keamanan/CSP dari Express tidak berlaku untuk HTML dev.

## Build produksi

```bash
npm run build      # hasil ke dist/, disajikan Express di port yang sama dengan API
```

`VITE_API_URL` kosong berarti API dipanggil ke origin yang sama (pengaturan default `install.sh`).

## Lint

```bash
npm run lint
```
