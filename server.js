const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { createRealtime, rawSql } = require('@neon/realtime/server');

// Muat konfigurasi env dari .env.local (hasil neon deploy) lalu fallback ke .env
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_KEY = 'notes:all';
const CACHE_TTL_SECONDS = 60;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================
// 1. NEON POSTGRESQL SERVICE (Koneksi Database Utama)
// ==============================================================
const dbConnectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
let pool = null;
let isDbReady = false;

if (dbConnectionString) {
  pool = new Pool({
    connectionString: dbConnectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });

  pool.on('error', (err) => {
    console.error('❌ Neon PostgreSQL Pool Error:', err.message);
  });
} else {
  console.warn('⚠️ PERINGATAN: DATABASE_URL belum diatur.');
}

async function initDatabase() {
  if (!pool) return;
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(createTableQuery);
    isDbReady = true;
    console.log('✅ Neon PostgreSQL terhubung & tabel "notes" siap.');
  } catch (error) {
    console.error('❌ Gagal inisialisasi tabel Neon PostgreSQL:', error.message);
  }
}

// ==============================================================
// 2. NEON OBJECT STORAGE SERVICE (AWS S3 Compatible Bucket: assets)
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
  console.log('✅ Neon Object Storage (S3 Client) siap untuk bucket:', S3_BUCKET_NAME);
} else {
  console.warn('⚠️ Neon Object Storage credentials tidak lengkap.');
}

// ==============================================================
// 3. NEON FUNCTIONS SERVICE (Serverless Function 'hello')
// ==============================================================
function getHelloFunctionUrl() {
  if (process.env.NEON_BRANCH_ID && process.env.NEON_FUNCTION_HOST_SUFFIX) {
    return `https://${process.env.NEON_BRANCH_ID}-hello${process.env.NEON_FUNCTION_HOST_SUFFIX}`;
  }
  return null;
}

// ==============================================================
// 4. NEON AI GATEWAY SERVICE (OpenAI Compatible API)
// ==============================================================
const aiGatewayBaseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
const aiGatewayToken = process.env.NEON_AI_GATEWAY_TOKEN;

// ==============================================================
// 5. NEON REALTIME SERVICE (Live Queries & Cryptographic Sealing)
// ==============================================================
let realtimeServer = null;
if (process.env.NEON_REALTIME_SECRET) {
  try {
    realtimeServer = createRealtime({
      secret: process.env.NEON_REALTIME_SECRET,
      db: 'neondb'
    });
    console.log('✅ Neon Realtime Service siap untuk menyegel live queries.');
  } catch (err) {
    console.warn('⚠️ Gagal inisialisasi Neon Realtime:', err.message);
  }
}

// ==============================================================
// 6. REDIS CACHE (Upstash) - Opsional sesuai Panduan Vibe Coding
// ==============================================================
let redis = null;
let isRedisReady = false;

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      retryStrategy: () => null
    });
    redis.on('connect', () => { isRedisReady = true; console.log('✅ Redis Cache terhubung.'); });
    redis.on('error', () => { isRedisReady = false; });
  } catch {
    isRedisReady = false;
  }
}

async function invalidateCache() {
  if (redis && isRedisReady) {
    try { await redis.del(CACHE_KEY); } catch {}
  }
}

// ==============================================================
// 7. HEALTH CHECK ENDPOINT (GET /health)
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
    timestamp: new Date().toISOString(),
    neonServices: {
      postgres: {
        status: dbStatus,
        branch: process.env.NEON_BRANCH || 'unknown',
        branchId: process.env.NEON_BRANCH_ID || 'unknown'
      },
      objectStorage: {
        status: s3Client ? 'configured' : 'not_configured',
        bucket: S3_BUCKET_NAME,
        endpoint: process.env.AWS_ENDPOINT_URL_S3 || null
      },
      functions: {
        status: getHelloFunctionUrl() ? 'configured' : 'not_configured',
        url: getHelloFunctionUrl()
      },
      aiGateway: {
        status: (aiGatewayBaseUrl && aiGatewayToken) ? 'configured' : 'not_configured',
        baseUrl: aiGatewayBaseUrl || null
      },
      realtime: {
        status: realtimeServer ? 'configured' : 'not_configured',
        url: process.env.NEON_REALTIME_URL || null
      }
    }
  });
});

// ==============================================================
// 8. API ROUTES UNTUK CATATAN (Neon PostgreSQL CRUD)
// ==============================================================
app.get('/api/notes', async (req, res) => {
  const startTime = Date.now();
  try {
    // Cek Redis jika aktif
    if (redis && isRedisReady) {
      try {
        const cached = await redis.get(CACHE_KEY);
        if (cached) {
          const notes = JSON.parse(cached);
          return res.json({
            success: true,
            source: 'Redis Cache ⚡',
            cached: true,
            duration: `${Date.now() - startTime}ms`,
            count: notes.length,
            data: notes
          });
        }
      } catch {}
    }

    if (!pool) {
      return res.status(500).json({ success: false, error: 'Neon PostgreSQL belum dikonfigurasi.' });
    }

    const result = await pool.query('SELECT * FROM notes ORDER BY created_at DESC');
    const notes = result.rows;

    if (redis && isRedisReady && notes.length > 0) {
      try { await redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(notes)); } catch {}
    }

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

app.post('/api/notes', async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ success: false, error: 'Judul dan isi catatan wajib diisi!' });
  }

  try {
    const insertQuery = `
      INSERT INTO notes (title, content)
      VALUES ($1, $2)
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [title.trim(), content.trim()]);
    await invalidateCache();

    res.status(201).json({
      success: true,
      message: 'Catatan berhasil disimpan ke Neon PostgreSQL!',
      data: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  const noteId = parseInt(req.params.id, 10);
  if (isNaN(noteId)) {
    return res.status(400).json({ success: false, error: 'ID catatan tidak valid.' });
  }

  try {
    await pool.query('DELETE FROM notes WHERE id = $1', [noteId]);
    await invalidateCache();
    res.json({ success: true, message: `Catatan #${noteId} berhasil dihapus dari Neon.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 9. API ROUTES UNTUK NEON OBJECT STORAGE (S3)
// ==============================================================
// Cadangkan (Backup) seluruh catatan ke bucket 'assets'
app.post('/api/storage/backup', async (req, res) => {
  if (!s3Client) {
    return res.status(500).json({ success: false, error: 'Neon Object Storage belum dikonfigurasi.' });
  }

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

    res.json({
      success: true,
      message: 'Catatan berhasil dicadangkan ke Neon Object Storage!',
      bucket: S3_BUCKET_NAME,
      file: fileName
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Daftar file yang ada di bucket 'assets'
app.get('/api/storage/files', async (req, res) => {
  if (!s3Client) {
    return res.status(500).json({ success: false, error: 'Neon Object Storage belum dikonfigurasi.' });
  }

  try {
    const listRes = await s3Client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      MaxKeys: 20
    }));

    const files = (listRes.Contents || []).map(f => ({
      key: f.Key,
      size: `${f.Size} bytes`,
      lastModified: f.LastModified
    }));

    res.json({
      success: true,
      bucket: S3_BUCKET_NAME,
      filesCount: files.length,
      files
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 10. API ROUTE UNTUK NEON FUNCTIONS (Serverless 'hello')
// ==============================================================
app.get('/api/functions/hello', async (req, res) => {
  const fnUrl = getHelloFunctionUrl();
  if (!fnUrl) {
    return res.status(500).json({ success: false, error: 'Neon Function URL tidak ditemukan.' });
  }

  try {
    const response = await fetch(fnUrl);
    const text = await response.text();
    res.json({
      success: true,
      function: 'hello',
      status: response.status,
      url: fnUrl,
      output: text
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 11. API ROUTE UNTUK NEON AI GATEWAY
// ==============================================================
app.get('/api/ai/status', async (req, res) => {
  if (!aiGatewayBaseUrl || !aiGatewayToken) {
    return res.status(500).json({ success: false, error: 'Neon AI Gateway belum dikonfigurasi.' });
  }

  try {
    const response = await fetch(`${aiGatewayBaseUrl}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${aiGatewayToken}`
      }
    });

    const data = await response.json();
    const modelList = Array.isArray(data.data) ? data.data : [];

    res.json({
      success: true,
      gatewayUrl: aiGatewayBaseUrl,
      modelsCount: modelList.length,
      availableSampleModels: modelList.slice(0, 5).map(m => m.id),
      status: response.status === 200 ? 'Operational' : 'Limited',
      note: 'AI Gateway terhubung melalui endpoint OpenAI-compatible.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 12. API ROUTE UNTUK NEON REALTIME (Live Query Sealing)
// ==============================================================
app.get('/api/realtime/seal', async (req, res) => {
  if (!realtimeServer) {
    return res.status(500).json({ success: false, error: 'Neon Realtime belum dikonfigurasi.' });
  }

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
      },
      message: 'Query berhasil disegel dengan kredensial kriptografis Neon Realtime!'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// 13. START SERVER
// ==============================================================
app.listen(PORT, async () => {
  console.log('==============================================');
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log('==============================================');
  await initDatabase();
});
