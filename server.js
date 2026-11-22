const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
// Muat konfigurasi env dari .env.local (hasil neon deploy) lalu fallback ke .env
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

// @neon/realtime/server adalah ES Module — gunakan dynamic import
let createRealtime = null;
let realtimeServer = null;
(async () => {
  try {
    const mod = await import('@neon/realtime/server');
    createRealtime = mod.createRealtime;
    // Inisialisasi realtimeServer setelah modul dimuat
    if (process.env.NEON_REALTIME_SECRET && createRealtime) {
      try {
        realtimeServer = createRealtime({ secret: process.env.NEON_REALTIME_SECRET, db: 'neondb' });
      } catch {}
    }
  } catch (e) {
    console.warn('⚠️ @neon/realtime/server tidak dapat dimuat:', e.message);
  }
})();

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_KEY = 'notes:all';
const CACHE_TTL_SECONDS = 60;

// Middleware (Mendukung upload JSON & file attachment hingga 10MB)
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================
// 1. NEON POSTGRESQL SERVICE (Database Utama)
// ==============================================================
const dbConnectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
let pool = null;
let isDbReady = false;

if (dbConnectionString) {
  pool = new Pool({
    connectionString: dbConnectionString,
    ssl: { rejectUnauthorized: false }
  });

  pool.on('error', (err) => {
    console.error('❌ Neon PostgreSQL Pool Error:', err.message);
  });
}

// Inisialisasi & Migrasi Skema Tabel Otomatis
async function initDatabase() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        attachment_url TEXT,
        attachment_name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS attachment_url TEXT;
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255);
    `);
    isDbReady = true;
    console.log('✅ Neon PostgreSQL terhubung & skema tabel siap.');
  } catch (error) {
    console.error('❌ Inisialisasi Database Error:', error.message);
  }
}

// ==============================================================
// 2. NEON OBJECT STORAGE (S3-Compatible Bucket: assets)
// ==============================================================
let s3Client = null;
const S3_BUCKET_NAME = 'assets';

if (process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    region: process.env.AWS_REGION || 'us-east-2',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });
  console.log('✅ Neon Object Storage siap untuk bucket:', S3_BUCKET_NAME);
}

// ==============================================================
// 3. CACHE SYSTEM (Upstash Redis + High-Speed In-Memory Fallback)
// ==============================================================
let redis = null;
let isRedisReady = false;
let memoryCache = { data: null, expiresAt: 0 };

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      retryStrategy: () => null
    });
    redis.on('connect', () => { isRedisReady = true; console.log('✅ Upstash Redis Cache terhubung.'); });
    redis.on('error', () => { isRedisReady = false; });
  } catch {
    isRedisReady = false;
  }
}

async function getFromCache() {
  if (redis && isRedisReady) {
    try {
      const data = await redis.get(CACHE_KEY);
      if (data) return { source: 'Upstash Redis Cache ⚡', notes: JSON.parse(data) };
    } catch {}
  }
  // In-Memory RAM Cache Fallback
  if (memoryCache.data && Date.now() < memoryCache.expiresAt) {
    return { source: 'In-Memory RAM Cache ⚡ (Simulasi Redis)', notes: memoryCache.data };
  }
  return null;
}

async function setToCache(notes) {
  memoryCache = { data: notes, expiresAt: Date.now() + (CACHE_TTL_SECONDS * 1000) };
  if (redis && isRedisReady) {
    try { await redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(notes)); } catch {}
  }
}

async function invalidateCache() {
  memoryCache = { data: null, expiresAt: 0 };
  if (redis && isRedisReady) {
    try { await redis.del(CACHE_KEY); } catch {}
  }
  console.log('🧹 Cache dibersihkan (Invalidated).');
}

// ==============================================================
// 4. NEON FUNCTIONS & REALTIME
// ==============================================================
function getHelloFunctionUrl() {
  if (process.env.NEON_BRANCH_ID && process.env.NEON_FUNCTION_HOST_SUFFIX) {
    return `https://${process.env.NEON_BRANCH_ID}-hello${process.env.NEON_FUNCTION_HOST_SUFFIX}`;
  }
  return null;
}

// (realtimeServer sudah dideklarasikan dan diinisialisasi via dynamic import di atas)

// ==============================================================
// 5. HEALTH CHECK ROUTE (GET /health)
// ==============================================================
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch {
      dbStatus = 'error';
    }
  }

  res.status(200).json({
    status: 'OK',
    message: 'Server berjalan dengan baik',
    uptime: `${Math.floor(process.uptime())} detik`,
    cacheStatus: isRedisReady ? 'Upstash Redis Connected' : 'In-Memory RAM Active',
    neonServices: {
      postgres: { status: dbStatus, branch: process.env.NEON_BRANCH || 'production' },
      objectStorage: { status: s3Client ? 'configured' : 'not_configured', bucket: S3_BUCKET_NAME },
      functions: { status: getHelloFunctionUrl() ? 'configured' : 'not_configured', url: getHelloFunctionUrl() },
      aiGateway: { status: process.env.NEON_AI_GATEWAY_TOKEN ? 'configured' : 'not_configured' },
      realtime: { status: realtimeServer ? 'configured' : 'not_configured' }
    }
  });
});

// ==============================================================
// 6. API CATATAN (CRUD + Neon Object Storage + Cache-Aside)
// ==============================================================
app.get('/api/notes', async (req, res) => {
  const startTime = Date.now();
  try {
    // 1. Cek Cache (Hit)
    const cached = await getFromCache();
    if (cached) {
      return res.json({
        success: true,
        source: cached.source,
        cached: true,
        duration: `${Date.now() - startTime}ms`,
        count: cached.notes.length,
        data: cached.notes
      });
    }

    // 2. Cache Miss: Ambil dari Neon PostgreSQL
    if (!pool) return res.status(500).json({ success: false, error: 'Postgres belum siap.' });

    const result = await pool.query('SELECT * FROM notes ORDER BY created_at DESC');
    const notes = result.rows;

    // 3. Simpan ke Cache dengan TTL 60 detik
    await setToCache(notes);

    res.json({
      success: true,
      source: 'Neon PostgreSQL (Cloud) 🐘',
      cached: false,
      duration: `${Date.now() - startTime}ms`,
      count: notes.length,
      data: notes
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Tambah Catatan Baru + Opsional Unggah Lampiran ke Neon S3
app.post('/api/notes', async (req, res) => {
  const { title, content, attachmentBase64, attachmentName, attachmentType } = req.body;

  if (!title || !content) {
    return res.status(400).json({ success: false, error: 'Judul dan isi catatan wajib diisi!' });
  }

  try {
    let attachmentUrl = null;
    let savedAttachmentName = null;

    // Jika ada lampiran file/foto, simpan ke Neon Object Storage
    if (attachmentBase64 && s3Client) {
      const buffer = Buffer.from(attachmentBase64.replace(/^data:.*?;base64,/, ''), 'base64');
      const ext = attachmentName ? path.extname(attachmentName) : '.bin';
      const fileKey = `attachments/${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;

      await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: fileKey,
        Body: buffer,
        ContentType: attachmentType || 'application/octet-stream'
      }));

      attachmentUrl = `/api/storage/file/${encodeURIComponent(fileKey)}`;
      savedAttachmentName = attachmentName || 'file-lampiran';
    }

    const insertQuery = `
      INSERT INTO notes (title, content, attachment_url, attachment_name)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [
      title.trim(),
      content.trim(),
      attachmentUrl,
      savedAttachmentName
    ]);

    await invalidateCache();

    res.status(201).json({
      success: true,
      message: 'Catatan berhasil disimpan ke Neon!',
      data: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  const noteId = parseInt(req.params.id, 10);
  try {
    await pool.query('DELETE FROM notes WHERE id = $1', [noteId]);
    await invalidateCache();
    res.json({ success: true, message: `Catatan #${noteId} berhasil dihapus.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bersihkan Cache secara manual untuk pengujian
app.post('/api/cache/clear', async (req, res) => {
  await invalidateCache();
  res.json({ success: true, message: 'Cache berhasil dibersihkan!' });
});

// ==============================================================
// 7. NEON OBJECT STORAGE STREAMING & BACKUP
// ==============================================================
app.get('/api/storage/file/:key', async (req, res) => {
  if (!s3Client) return res.status(404).send('Object storage not configured');
  try {
    const key = decodeURIComponent(req.params.key);
    const getRes = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key
    }));
    if (getRes.ContentType) res.setHeader('Content-Type', getRes.ContentType);
    getRes.Body.pipe(res);
  } catch (err) {
    res.status(404).send('File not found: ' + err.message);
  }
});

app.post('/api/storage/backup', async (req, res) => {
  if (!s3Client) return res.status(500).json({ success: false, error: 'S3 belum siap.' });
  try {
    const notesResult = await pool.query('SELECT * FROM notes ORDER BY created_at DESC');
    const backupData = JSON.stringify({
      backedUpAt: new Date().toISOString(),
      branch: process.env.NEON_BRANCH,
      totalNotes: notesResult.rows.length,
      notes: notesResult.rows
    }, null, 2);

    const fileName = `backups/notes-backup-${Date.now()}.json`;
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: fileName,
      Body: backupData,
      ContentType: 'application/json'
    }));

    res.json({ success: true, message: 'Cadangan tersimpan di Neon Object Storage!', file: fileName });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/storage/files', async (req, res) => {
  if (!s3Client) return res.status(500).json({ success: false, error: 'S3 belum siap.' });
  try {
    const listRes = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET_NAME, MaxKeys: 25 }));
    const files = (listRes.Contents || []).map(f => ({
      key: f.Key,
      size: `${f.Size} bytes`,
      lastModified: f.LastModified
    }));
    res.json({ success: true, filesCount: files.length, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 8. NEON AI GATEWAY (Bantuan Ide & Ringkasan Catatan)
// ==============================================================
app.post('/api/ai/assist', async (req, res) => {
  const { prompt, type } = req.body;
  const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
  const token = process.env.NEON_AI_GATEWAY_TOKEN;

  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt wajib diisi!' });

  try {
    // Panggil model via OpenAI-compatible endpoint di Neon AI Gateway
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-1-flash',
        messages: [
          { role: 'system', content: 'Anda adalah asisten cerdas untuk aplikasi catatan harian. Berikan jawaban yang ringkas, bernas, dan bermanfaat dalam bahasa Indonesia.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300
      })
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || 'Tidak ada respons.';
      return res.json({ success: true, result: content });
    }

    // Jika akun belum menambahkan kartu kredit untuk kredit AI Gateway:
    const errData = await response.json().catch(() => ({}));
    if (response.status === 402 || response.status === 403 || (errData && errData.error)) {
      // Sediakan respons cerdas lokal agar UX tetap responsif & informatif
      let fallbackText = '';
      if (type === 'summarize') {
        fallbackText = `📌 Ringkasan Catatan: "${prompt.substring(0, 150)}..." (Catatan menyoroti poin-poin penting di atas).`;
      } else {
        fallbackText = `💡 Rekomendasi Ide: 1. Target harian & checklist eksekusi. 2. Evaluasi progres mingguan. 3. Catatan refleksi pembelajaran hari ini.`;
      }
      return res.json({
        success: true,
        result: fallbackText,
        note: 'Dihasilkan oleh Asisten Lokal (Aktifkan Billing Neon AI Gateway untuk inferensi frontier model langsung).'
      });
    }

    res.status(response.status).json({ success: false, error: 'AI Gateway respons tidak berhasil.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 9. NEON FUNCTIONS & REALTIME ROUTES
// ==============================================================
app.get('/api/functions/hello', async (req, res) => {
  const fnUrl = getHelloFunctionUrl();
  if (!fnUrl) return res.status(500).json({ success: false, error: 'Function URL not available' });
  try {
    const response = await fetch(fnUrl);
    const text = await response.text();
    res.json({ success: true, function: 'hello', output: text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/realtime/seal', async (req, res) => {
  if (!realtimeServer) return res.status(500).json({ success: false, error: 'Realtime not configured' });
  try {
    const query = rawSql('SELECT * FROM notes ORDER BY created_at DESC');
    const sealedQuery = await realtimeServer.seal({ query });
    res.json({
      success: true,
      realtimeUrl: process.env.NEON_REALTIME_URL,
      sealedQuery: {
        capability: sealedQuery.capability.substring(0, 32) + '...',
        queryFingerprint: sealedQuery.queryFingerprint,
        expiresAt: sealedQuery.expiresAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================
// 10. START SERVER
// ==============================================================
app.listen(PORT, async () => {
  console.log('==============================================');
  console.log(`🚀 Server Catatan Harian v2.0 aktif di http://localhost:${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log('==============================================');
  await initDatabase();
});
