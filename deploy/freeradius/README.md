# FreeRADIUS: sisa waktu voucher

Modul `mods-available/hotspot_time` menjumlahkan `acctsessiontime` di `radacct` dan membandingkannya dengan `Max-All-Session` pada `radgroupcheck`.

## Pemasangan

1. Salin `mods-available/hotspot_time` ke `/etc/freeradius/3.0/mods-available/hotspot_time`.
2. Aktifkan modul: `ln -s ../mods-available/hotspot_time /etc/freeradius/3.0/mods-enabled/hotspot_time`.
3. Di bagian `authorize` situs (biasanya `sites-enabled/default`), panggil `hotspot_time` **sebelum** modul `sql`:

```
authorize {
    # ... modul lain ...
    hotspot_time
    sql
    # ...
}
```

4. `radiusd -XC`, lalu muat ulang FreeRADIUS.

Aplikasi menulis dua atribut saat profil disimpan atau diubah:

- `radgroupreply` / `Session-Timeout`: batas satu sesi.
- `radgroupcheck` / `Max-All-Session`: batas kumulatif seluruh sesi, sama dengan masa aktif profil dalam detik.

## Batas yang tidak ditutup modul ini

`sqlcounter` hanya berjalan saat pengguna autentikasi. Sesi yang sudah terhubung tidak dipotong di tengah jalan; NAS tetap memakai `Session-Timeout` yang diterima saat sesi itu dimulai. Sisa waktu kumulatif baru diterapkan pada autentikasi berikutnya: jawaban membawa `Session-Timeout` sebesar sisa detik, atau permintaan ditolak bila jatah sudah habis.

Job aplikasi (setiap 60 detik) adalah pengaman bila modul ini belum dipasang. Job itu menulis `radcheck` `Auth-Type := Reject` setelah `SUM(acctsessiontime)` mencapai batas, sehingga login berikutnya ditolak. Job itu juga tidak memutus sesi yang sedang berjalan.
