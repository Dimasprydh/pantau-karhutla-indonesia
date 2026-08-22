# Pantau Karhutla Indonesia

Website publik untuk memantau **hotspot / active-fire detection** di Indonesia menggunakan data satelit NASA FIRMS.

> **Penting:** hotspot adalah anomali termal yang terdeteksi satelit dan **tidak otomatis berarti kebakaran hutan terverifikasi**. Hilangnya deteksi satelit juga tidak berarti api sudah padam. Status **padam terverifikasi** hanya boleh ditampilkan jika kelak tersedia sumber resmi lapangan.

## Fitur V1

- Peta Indonesia interaktif.
- Data NASA FIRMS VIIRS NOAA-20, NOAA-21, dan Suomi-NPP NRT.
- Statistik deteksi 24 jam dan deteksi terbaru.
- Filter provinsi, umur deteksi, confidence, dan sensor.
- Detail waktu deteksi, satelit, confidence, FRP, dan koordinat.
- Auto-refresh setiap 15 menit.
- Mode demo otomatis jika backend belum dihubungkan.
- Cloudflare Worker sebagai proxy/cache supaya NASA `MAP_KEY` tidak pernah masuk browser.
- Siap dipublish dengan GitHub Pages.

## Struktur

```text
.
├── index.html
├── styles.css
├── config.js
├── app.js
└── worker/
    ├── src/index.js
    └── wrangler.toml
```

## 1. Jalankan frontend

Frontend bersifat statis. Setelah GitHub Pages aktif, halaman bisa langsung dibuka. Sebelum Worker dikonfigurasi, website menampilkan **MODE DEMO** agar desain, filter, peta, dan interaksi tetap dapat diuji.

## 2. Dapatkan NASA FIRMS MAP_KEY

Daftar gratis:

https://firms.modaps.eosdis.nasa.gov/api/map_key/

Jangan pernah memasukkan key ke `config.js`, JavaScript frontend, commit GitHub, issue, atau README.

## 3. Deploy Cloudflare Worker

Masuk ke folder `worker`, lalu deploy dengan Wrangler:

```bash
npm install -g wrangler
wrangler login
wrangler secret put FIRMS_MAP_KEY
wrangler deploy
```

Saat diminta, paste MAP_KEY NASA FIRMS Anda.

Setelah deploy, Anda mendapat URL seperti:

```text
https://pantau-karhutla-api.<subdomain>.workers.dev
```

Tes endpoint:

```text
https://pantau-karhutla-api.<subdomain>.workers.dev/health
```

## 4. Hubungkan frontend ke Worker

Edit `config.js`:

```js
window.PANTAU_CONFIG = {
  apiUrl: "https://pantau-karhutla-api.<subdomain>.workers.dev"
};
```

Commit perubahan. Website kemudian mengambil data NASA secara otomatis dan label **MODE DEMO** berubah menjadi **LIVE NASA FIRMS**.

## Sumber data

- Active fire / hotspot: NASA FIRMS (Fire Information for Resource Management System).
- Basemap: OpenStreetMap contributors.
- Batas provinsi: GeoJSON publik `AlfianAliM/Indonesia-GeoJSON`, digunakan hanya untuk klasifikasi/filter visual dan bukan sebagai sumber batas administratif resmi.

NASA FIRMS Area API:

https://firms.modaps.eosdis.nasa.gov/api/area/

## Interpretasi status

Website menggunakan istilah berikut:

- **Aktif <6 jam**: satelit mendeteksi anomali termal kurang dari enam jam lalu.
- **Dipantau 6–24 jam**: deteksi masih berada dalam jendela 24 jam tetapi lebih lama.
- **Tidak ada deteksi baru**: tidak boleh diterjemahkan menjadi “padam”.
- **Padam terverifikasi**: belum dihitung pada V1 dan baru akan digunakan jika sumber laporan lapangan resmi dapat diintegrasikan secara bertanggung jawab.

## Catatan teknis

Worker meminta data Indonesia dengan bounding box sekitar `94,-11,142,7` dan menggabungkan tiga feed VIIRS NRT. Respons di-cache agar tidak membebani FIRMS dan agar website publik tetap cepat.

## Lisensi

Kode proyek ini ditujukan untuk kepentingan informasi publik. Data dan peta pihak ketiga tetap mengikuti ketentuan sumber masing-masing.
