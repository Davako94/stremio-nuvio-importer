const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

const SUPABASE_URL = 'https://tupmspjgifldbheqzmbk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1cG1zcGpnaWZsZGJoZXF6bWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDQyNjU4MTAsImV4cCI6MjAxOTg0MTgxMH0.F5k4q8d9GjLkQyP2VX3wF1zF6HjLkQyP2VX3wF1zF6H';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// HELPER: raw fetch-based Supabase calls
// (no Supabase client needed — avoids session state issues)
// ============================================
async function supabaseRpc(functionName, payload, accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload || {}),
  });

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.message || text; } catch (_) {}
    throw new Error(msg || `RPC ${functionName} failed (${res.status})`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

// Sign up anonymously to get a Supabase access token.
// Each import session uses a fresh anonymous user so there's no
// persistent auth state to manage on the server.
async function signUpAnonymously() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({}), // empty body = anonymous sign-up
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.message || 'Anonymous sign-up failed');
  }
  return data.access_token;
}

// ============================================
// HOME / CONFIGURE
// ============================================
app.get('/', (req, res) => res.redirect('/configure'));

app.get('/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);

app.get('/configure', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'configure.html'))
);

// ============================================
// MANIFEST
// ============================================
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'community.stremio-nuvio-importer',
    name: 'Stremio Backup Importer',
    description: 'Importa la tua libreria Stremio in NUVIO con un click',
    version: '1.0.0',
    logo: 'https://i.imgur.com/AIZFSRF.jpeg',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: [{ type: 'movie', id: 'stremio-import', name: '📦 Stremio Importer' }],
    behaviorHints: { configurable: true, configurationRequired: false },
  });
});

// ============================================
// CONNECT — anonymous sign-up + claim sync code
//
// FIX: we now sign in anonymously FIRST so that claim_sync_code
// is called with a real Bearer token. The resulting access token
// is returned to the client and must be sent with every /import
// request (Authorization: Bearer <token>).
// ============================================
app.post('/connect', async (req, res) => {
  try {
    const { code, pin } = req.body;
    if (!code || !pin) {
      return res.status(400).json({ error: 'Codice e PIN richiesti' });
    }

    // 1. Get an anonymous Supabase session
    let accessToken;
    try {
      accessToken = await signUpAnonymously();
    } catch (err) {
      console.error('Errore sign-up anonimo:', err);
      return res.status(500).json({ error: 'Impossibile creare sessione anonima: ' + err.message });
    }

    // 2. Claim the sync code with the authenticated token
    let result;
    try {
      const rows = await supabaseRpc('claim_sync_code', {
        p_code: code,
        p_pin: pin,
        p_device_name: 'Stremio Importer Web',
      }, accessToken);

      result = Array.isArray(rows) ? rows[0] : rows;
    } catch (err) {
      console.error('Errore claim_sync_code:', err);
      return res.status(401).json({ error: 'Codice o PIN non validi: ' + err.message });
    }

    if (!result?.success) {
      return res.status(401).json({ error: result?.message || 'Errore durante la connessione' });
    }

    console.log(`✅ Collegato. Owner ID: ${result.result_owner_id}`);

    // Return the access token so the client can use it for /import
    res.json({
      success: true,
      ownerId: result.result_owner_id,
      accessToken,            // <-- KEY FIX: client must send this with /import
      message: 'Dispositivo collegato con successo',
    });
  } catch (err) {
    console.error('Errore in /connect:', err);
    res.status(500).json({ error: err.message || 'Errore interno del server' });
  }
});

// ============================================
// IMPORT — uses the access token from /connect
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    // Access token must be sent by the client (set during /connect)
    const authHeader = req.headers['authorization'] || '';
    const accessToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : req.body.accessToken || null;

    if (!accessToken) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({
        error: 'Token di accesso mancante. Completa prima la connessione con sync code.',
      });
    }

    // Parse backup file
    let backupData;
    try {
      const fileContent = fs.readFileSync(req.file.path, 'utf8');
      backupData = JSON.parse(fileContent);
    } catch (parseErr) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File JSON non valido: ' + parseErr.message });
    }

    const { library, progress, watched } = convertStremioBackup(backupData);
    const results = {};

    // Push library items
    if (library.length > 0) {
      await supabaseRpc('sync_push_library', { p_items: library }, accessToken);
      results.library = library.length;
    }

    // Push watch progress
    if (progress.length > 0) {
      await supabaseRpc('sync_push_watch_progress', { p_entries: progress }, accessToken);
      results.progress = progress.length;
    }

    // Push watched items
    if (watched.length > 0) {
      await supabaseRpc('sync_push_watched_items', { p_items: watched }, accessToken);
      results.watched = watched.length;
    }

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ Importati ${library.length} film/serie, ${progress.length} progressi, ${watched.length} visti`,
      results,
    });
  } catch (err) {
    console.error('❌ Errore importazione:', err);
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    if (err.message?.includes('JWT') || err.message?.includes('auth')) {
      return res.status(401).json({
        error: 'Sessione scaduta. Riconnetti l\'account con sync code.',
      });
    }
    res.status(500).json({ error: err.message || 'Errore durante importazione' });
  }
});

// ============================================
// CATALOG (placeholder)
// ============================================
app.get('/catalog/movie/stremio-import.json', (req, res) => {
  res.json({
    metas: [{
      id: 'stremio-importer',
      type: 'movie',
      name: 'Stremio Importer',
      poster: 'https://via.placeholder.com/300x450/00a8ff/ffffff?text=Stremio+Importer',
      description: 'Apri la pagina di configurazione per importare il tuo backup Stremio',
    }],
  });
});

// ============================================
// CONVERTER
// ============================================
function convertStremioBackup(items) {
  const library = [];
  const progress = [];
  const watched = [];

  const itemsArray = Array.isArray(items) ? items : Object.values(items);

  itemsArray.forEach(item => {
    if (item.removed || item.temp) return;
    if (item.type !== 'movie' && item.type !== 'series') return;

    library.push({
      content_id: item._id,
      content_type: item.type,
      name: item.name || '',
      poster: item.poster || '',
      poster_shape: (item.posterShape || 'poster').toUpperCase(),
      release_info: item.year || '',
      added_at: new Date(item._ctime || item._mtime || Date.now()).getTime(),
    });

    if (item.state?.timeOffset > 0) {
      progress.push({
        content_id: item._id,
        content_type: item.type,
        video_id: item.state.video_id || item._id,
        season: null,
        episode: null,
        position: (item.state.timeOffset || 0) * 1000,
        duration: (item.state.duration || 0) * 1000,
        last_watched: new Date(item.state.lastWatched || item._mtime).getTime(),
        progress_key: item._id,
      });
    }

    const isWatched =
      item.state?.flaggedWatched === 1 ||
      item.state?.timesWatched > 0 ||
      (item.state?.watched && item.state.watched !== '');

    if (isWatched) {
      watched.push({
        content_id: item._id,
        content_type: item.type,
        title: item.name || '',
        season: null,
        episode: null,
        watched_at: new Date(item.state?.lastWatched || item._mtime).getTime(),
      });
    }
  });

  return { library, progress, watched };
}

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 https://stremio-nuvio-importer.onrender.com/\n`);
});