const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const cors    = require('cors');

// node-fetch v2 (CommonJS) — funziona su Node 14+ a differenza del fetch nativo
// Assicurati di avere nel package.json: "node-fetch": "^2.7.0"
const fetch = require('node-fetch');

const app    = express();
const upload = multer({ dest: 'uploads/' });

const SUPABASE_URL  = 'https://tupmspjgifldbheqzmbk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1cG1zcGpnaWZsZGJoZXF6bWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDQyNjU4MTAsImV4cCI6MjAxOTg0MTgxMH0.F5k4q8d9GjLkQyP2VX3wF1zF6HjLkQyP2VX3wF1zF6H';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static('public'));

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sbFetch(urlPath, options = {}) {
  const url = `${SUPABASE_URL}${urlPath}`;
  console.log(`→ Supabase: ${options.method || 'GET'} ${url}`);

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.message || data?.error_description || data?.msg || text || `HTTP ${res.status}`;
    console.error(`← Supabase error ${res.status}:`, msg);
    throw new Error(msg);
  }

  console.log(`← Supabase OK ${res.status}`);
  return data;
}

async function sbRpc(fnName, payload, token) {
  return sbFetch(`/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload || {}),
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/',          (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'public', 'configure.html')));
app.get('/health',    (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/manifest.json', (req, res) => res.json({
  id: 'community.stremio-nuvio-importer',
  name: 'Stremio Backup Importer',
  description: 'Importa la tua libreria Stremio in NUVIO con un click',
  version: '1.0.0',
  logo: 'https://i.imgur.com/AIZFSRF.jpeg',
  resources: ['catalog'],
  types: ['movie', 'series'],
  catalogs: [{ type: 'movie', id: 'stremio-import', name: '📦 Stremio Importer' }],
  behaviorHints: { configurable: true, configurationRequired: false },
}));

app.get('/catalog/movie/stremio-import.json', (req, res) => res.json({
  metas: [{
    id: 'stremio-importer', type: 'movie', name: 'Stremio Importer',
    poster: 'https://via.placeholder.com/300x450/00a8ff/ffffff?text=Stremio+Importer',
    description: 'Apri la pagina di configurazione per importare il tuo backup Stremio',
  }],
}));

// ── LOGIN ────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email e password richiesti' });

  try {
    const data = await sbFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (!data?.access_token)
      return res.status(401).json({ error: 'Login fallito — token mancante' });

    console.log(`✅ Login OK: ${data.user?.email}`);
    res.json({ token: data.access_token, email: data.user?.email });

  } catch (err) {
    console.error('❌ Login error:', err.message);
    const friendly = err.message.toLowerCase().includes('invalid login')
      ? 'Email o password errati'
      : err.message;
    res.status(401).json({ error: friendly });
  }
});

// ── IMPORT ───────────────────────────────────────────────────────────────────
app.post('/import', upload.single('backup'), async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();

  if (!token) return res.status(401).json({ error: 'Non autenticato' });
  if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

  let backupData;
  try {
    backupData = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
  } catch {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'File JSON non valido' });
  }
  fs.unlinkSync(req.file.path);

  try {
    const { library, progress, watched } = convertBackup(backupData);
    const results = { library: 0, progress: 0, watched: 0 };

    if (library.length > 0) {
      await sbRpc('sync_push_library', { p_items: library }, token);
      results.library = library.length;
    }
    if (progress.length > 0) {
      try {
        await sbRpc('sync_push_watch_progress', { p_entries: progress }, token);
        results.progress = progress.length;
      } catch (e) { console.warn('⚠️ progress (non bloccante):', e.message); }
    }
    if (watched.length > 0) {
      try {
        await sbRpc('sync_push_watched_items', { p_items: watched }, token);
        results.watched = watched.length;
      } catch (e) { console.warn('⚠️ watched (non bloccante):', e.message); }
    }

    res.json({
      success: true,
      message: `✅ ${results.library} film/serie · ${results.progress} progressi · ${results.watched} visti`,
      results,
    });

  } catch (err) {
    console.error('❌ Import error:', err.message);
    const status = /jwt|auth|token/i.test(err.message) ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── CONVERTER ────────────────────────────────────────────────────────────────
function convertBackup(raw) {
  const library = [], progress = [], watched = [];
  const items = Array.isArray(raw) ? raw : Object.values(raw);

  for (const item of items) {
    if (item.removed || item.temp) continue;
    if (item.type !== 'movie' && item.type !== 'series') continue;

    library.push({
      content_id:   item._id,
      content_type: item.type,
      name:         item.name || '',
      poster:       item.poster || '',
      poster_shape: (item.posterShape || 'poster').toUpperCase(),
      release_info: item.year ? String(item.year) : '',
      added_at:     new Date(item._ctime || item._mtime || Date.now()).getTime(),
    });

    if (item.state?.timeOffset > 0) {
      progress.push({
        content_id:   item._id,
        content_type: item.type,
        video_id:     item.state.video_id || item._id,
        season:       null,
        episode:      null,
        position:     Math.round((item.state.timeOffset || 0) * 1000),
        duration:     Math.round((item.state.duration   || 0) * 1000),
        last_watched: new Date(item.state.lastWatched || item._mtime || Date.now()).getTime(),
        progress_key: item._id,
      });
    }

    const isWatched =
      item.state?.flaggedWatched === 1 ||
      item.state?.timesWatched   > 0   ||
      (item.state?.watched && item.state.watched !== '');

    if (isWatched) {
      watched.push({
        content_id:   item._id,
        content_type: item.type,
        title:        item.name || '',
        season:       null,
        episode:      null,
        watched_at:   new Date(item.state?.lastWatched || item._mtime || Date.now()).getTime(),
      });
    }
  }
  return { library, progress, watched };
}

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 NUVIO Importer — porta ${PORT}`);
  console.log(`🌐 https://stremio-nuvio-importer.onrender.com/configure\n`);
});