# 🚀 Panduan Deployment: Aplikasi Catatan Harian

Proyek ini telah disiapkan berdasarkan arsitektur pada panduan:
1. **Panduan Lengkap Deployment Aplikasi Web** (Arsitektur Tahap 1 hingga Tahap 3).
2. **Panduan Praktik Deploy Aplikasi Menggunakan AI (Tanpa Coding)**.

---

## 📁 Struktur File Proyek

```text
├── .gitignore            # Mengabaikan node_modules dan file .env agar kredensial tidak bocor
├── .env.example          # Panduan template environment variables
├── package.json          # Konfigurasi dependensi Node.js & script start
├── server.js             # Backend Express, PostgreSQL (pg), Redis (ioredis), dan rute /health
├── public/
│   └── index.html        # Frontend modern mandiri (HTML/CSS/JS) dengan visualisasi cache & status
└── README.md             # Panduan langkah demi langkah deployment
```

---

## 🛠️ Tahap 1: Siapkan Layanan Cloud Gratis (15 Menit)

Sebelum menyalakan server di internet, buat akun gratis pada 4 platform berikut:

1. **GitHub** ([github.com](https://github.com)):
   - Digunakan untuk menyimpan kode repositori Anda secara online.
2. **Neon** ([neon.tech](https://neon.tech)):
   - Buat satu database PostgreSQL baru.
   - Salin **Connection String** (berformat: `postgres://user:password@ep-xyz.neon.tech/neondb?sslmode=require`).
3. **Upstash** ([upstash.com](https://upstash.com)):
   - Buat satu database Redis baru (pilih region terdekat, misal Singapura).
   - Salin nilai **REDIS_URL** (berformat: `rediss://default:password@xyz.upstash.io:6379`).
4. **Render** ([render.com](https://render.com)):
   - Daftar dan hubungkan langsung dengan akun GitHub Anda.

---

## 📤 Tahap 2: Unggah Kode ke GitHub

Anda dapat mengunggah file ini ke GitHub melalui dua cara:

### Cara A: Melalui Browser (Tanpa Instalasi Git/Node di Laptop)
1. Buka [github.com/new](https://github.com/new) dan buat repositori baru (misal: `aplikasi-catatan-ai`).
2. Buat file satu per satu dengan mengklik **Add file -> Create new file**:
   - `package.json`
   - `.gitignore`
   - `server.js`
   - `public/index.html` (mengetik `public/` otomatis membuat folder).
3. Tempelkan seluruh kode dari folder ini ke masing-masing file lalu klik **Commit changes**.

### Cara B: Menggunakan Git CLI (Jika Git Terpasang di Komputer)
```bash
git init
git add .
git commit -m "feat: inisialisasi aplikasi catatan harian siap deploy"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA_REPOSITORI.git
git push -u origin main
```

---

## 🌐 Tahap 3: Deploy ke Render (Web Service)

1. Buka dashboard Render: [dashboard.render.com](https://dashboard.render.com).
2. Klik tombol **New +** lalu pilih **Web Service**.
3. Pilih repositori GitHub Anda (`aplikasi-catatan-ai`) lalu klik **Connect**.
4. Isi konfigurasi dasar:
   - **Name**: `catatan-pertamaku` (atau nama lain sesuai keinginan)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free ($0/bulan)`
5. Gulir ke bagian **Environment Variables**, klik **Add Environment Variable**, lalu tambahkan:
   - **Key**: `DATABASE_URL` | **Value**: *(tempel connection string dari Neon)*
   - **Key**: `REDIS_URL` | **Value**: *(tempel REDIS_URL dari Upstash)*
6. Klik tombol **Create Web Service** di bagian paling bawah.

---

## 🔍 Tahap 4: Verifikasi & Uji Fitur

1. **Pantau Layar Logs**: Tunggu proses build selama 1–2 menit sampai muncul pesan hijau `Live`.
2. **Cek Health Check**: Buka `https://<nama-aplikasi>.onrender.com/health` di browser. Respons harus berstatus `200 OK` dengan status database dan redis `connected`.
3. **Uji Fitur Catatan & Cache-Aside Redis**:
   - Buka URL publik aplikasi Anda.
   - Tambahkan catatan baru.
   - Klik tombol **🔄 Refresh Data (Uji Cache)**:
     - Panggilan pertama mengambil langsung dari database PostgreSQL.
     - Panggilan kedua dalam rentang 60 detik akan menampilkan badge hijau: **"Sumber Data: Redis Cache ⚡"** dengan respon secepat beberapa milidetik!
   - Saat Anda membuat catatan baru atau menghapus catatan, cache Redis otomatis dibersihkan (*invalidated*).

---

## 🛡️ Tahap 5: Pasang Custom Domain & Cloudflare (Opsional)

Jika ingin menggunakan domain sendiri (misal: `.my.id` atau `.com`):
1. Beli domain murah di registrar lokal (seperti DomaiNesia atau Niagahoster) atau Cloudflare Registrar.
2. Arahkan Nameserver domain ke akun gratis Cloudflare.
3. Di Render, buka **Settings -> Custom Domains** dan masukkan nama domain Anda.
4. Buat record CNAME di DNS Cloudflare sesuai petunjuk dari Render (aktifkan fitur *Proxied* / awan oranye agar otomatis mendapatkan CDN dan perlindungan SSL/HTTPS gratis).
