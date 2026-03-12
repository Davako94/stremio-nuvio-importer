const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// SUPABASE CONFIGURAZIONE
// ============================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function supabaseRequest(path, { method = 'GET', body, authToken } = {}) {
  const headers = { 'apikey': SUPABASE_ANON_KEY };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`\( {SUPABASE_URL} \){path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  if (!res.ok) {
    const msg = parsed?.message || parsed?.msg || parsed?.error_description || parsed?.error || text || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return parsed;
}

async function supabaseLogin(email, password) {
  return await supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
}

async function supabaseRpc(functionName, payload, accessToken) {
  return await supabaseRequest(`/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    body: payload || {},
    authToken: accessToken,
  });
}

// ============================================
// FUNZIONI NUVIO
// ============================================
async function getNuvioLibrary(accessToken) {
  try {
    const library = await supabaseRpc('sync_pull_library', {}, accessToken);
    return library || [];
  } catch (error) {
    console.error('❌ Errore getNuvioLibrary:', error);
    return [];
  }
}

// ============================================
// FUNZIONI STREMIO API
// ============================================
const STREMIO_API = 'https://api.strem.io';
const STREMIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.159';

async function stremioLogin(email, password) {
  console.log(`🔐 Login Stremio per: ${email}`);
  
  const response = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': STREMIO_UA
    },
    body: JSON.stringify({
      email: email,
      password: password,
      facebook: false,
      type: 'login'
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Login fallito (${response.status}): ${text.substring(0, 300)}`);
  }

  let data = JSON.parse(text);
  const authKey = data?.result?.authKey;

  if (!authKey) {
    console.error('❌ Risposta login:', JSON.stringify(data, null, 2));
    throw new Error('Login fallito: authKey non trovato');
  }

  console.log(`✅ Login Stremio OK`);
  return { token: authKey };
}

async function getStremioLibrary(authKey) {
  console.log(`📚 Richiesta library Stremio...`);
  
  const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': STREMIO_UA
    },
    body: JSON.stringify({
      authKey: authKey,
      collection: 'libraryItem',
      all: true
    })
  });

  const text = await response.text();
  console.log(`📥 Status: ${response.status}`);

  if (!response.ok) {
    throw new Error(`Stremio API errore ${response.status}: ${text.substring(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Risposta non JSON: ${text.substring(0, 300)}`);
  }

  let items = [];
  if (data.result) {
    if (Array.isArray(data.result)) {
      items = data.result;
    } else if (data.result.rows && Array.isArray(data.result.rows)) {
      items = data.result.rows.map(row => row.value).filter(Boolean);
    } else if (data.result.value) {
      items = [data.result.value];
    }
  } else if (Array.isArray(data)) {
    items = data;
  } else if (data.items) {
    items = data.items;
  }

  items = items.filter(item => {
    if (!item) return false;
    if (item.removed || item.temp) return false;
    const id = item._id || item.id;
    if (!id) return false;
    const type = item.type || '';
    return type === 'movie' || type === 'series' || type === 'show';
  });

  console.log(`✅ Trovati ${items.length} elementi validi nella library`);
  return items || [];
}

async function getStremioContinueWatching(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
      body: JSON.stringify({ authKey, collection: 'continueWatching', all: true })
    });
    const data = await response.json();
    return (data?.result?.rows || []).map(r => r.value).filter(Boolean);
  } catch {
    return [];
  }
}

async function getStremioWatchedHistory(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
      body: JSON.stringify({ authKey, collection: 'watched', all: true })
    });
    const data = await response.json();
    return (data?.result?.rows || []).map(r => r.value).filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================
// === NUOVA PARTE: COPIA TOTALE DEL "VISTO" (film + serie) ===
// ============================================
function normalizeText(v) { return String(v ?? "").trim(); }

function extractSupportedContentId(value) {
  const text = normalizeText(value);
  const imdb = text.match(/tt\d+/i);
  if (imdb) return imdb[0].toLowerCase();
  const tmdb = text.match(/(?:^|:)tmdb:(\d+)(?::|$)/i);
  if (tmdb?.[1]) return `tmdb:${tmdb[1]}`;
  return "";
}

function normalizeContentType(value) {
  const t = normalizeText(value).toLowerCase();
  return (t === "series" || t === "tv") ? "series" : "movie";
}

function toTimestamp(value) {
  if (!value) return Date.now();
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function watchedKey(item = {}) {
  const cid = normalizeText(item.contentId);
  const s = item.season == null ? "" : String(Number(item.season));
  const e = item.episode == null ? "" : String(Number(item.episode));
  return `\( {cid}: \){s}:${e}`;
}

function normalizeWatchedItem(item = {}) {
  const contentId = extractSupportedContentId(item.contentId);
  if (!contentId) return null;
  return {
    contentId,
    contentType: normalizeContentType(item.contentType),
    title: normalizeText(item.title),
    season: item.season != null ? Math.trunc(Number(item.season)) : null,
    episode: item.episode != null ? Math.trunc(Number(item.episode)) : null,
    watchedAt: toTimestamp(item.watchedAt)
  };
}

function dedupeWatchedItems(items = []) {
  const map = new Map();
  for (const raw of items) {
    const item = normalizeWatchedItem(raw);
    if (!item?.contentId) continue;
    const key = watchedKey(item);
    if (!map.has(key) || Number(item.watchedAt) >= Number(map.get(key).watchedAt)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function isWatchedState(state = {}) {
  const tw = Number(state.timesWatched || 0);
  const fw = Number(state.flaggedWatched || 0);
  const dur = Number(state.duration || 0);
  const twa = Number(state.timeWatched || 0);
  return tw > 0 || fw > 0 || (dur > 0 && twa / dur >= 0.7);
}

function mapStremioWatchedItem(item = {}) {
  const contentId = extractSupportedContentId(item._id || item.id);
  if (!contentId) return null;
  const state = item.state || {};
  return normalizeWatchedItem({
    contentId,
    contentType: item.type,
    title: item.name,
    watchedAt: state.lastWatched || item._mtime || Date.now()
  });
}

async function pushWatchedToSupabase(accessToken, profileId = 1, items) {
  if (!items || items.length === 0) return 0;
  await supabaseRpc('sync_push_watched_items', {
    p_profile_id: profileId,
    p_items: dedupeWatchedItems(items).map(item => ({
      content_id: item.contentId,
      content_type: item.contentType,
      title: item.title || "",
      season: item.season,
      episode: item.episode,
      watched_at: Number(item.watchedAt)
    }))
  }, accessToken);
  return items.length;
}

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE (COPIA TOTALE)
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

  const uniqueItems = new Map();
  
  items.forEach(item => {
    const fullId = item._id || item.id || '';
    const contentId = fullId.split(':')[0];
    if (!contentId) return;
    
    uniqueItems.set(contentId, {
      content_id: contentId,
      content_type: item.type === 'series' ? 'series' : 'movie',
      name: item.name || '',
      poster: item.poster || '',
      poster_shape: 'POSTER',
      background: item.background || '',
      description: item.description || '',
      release_info: String(item.year || ''),
      imdb_rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
      genres: Array.isArray(item.genres) ? item.genres : [],
      added_at: Date.now()
    });
  });

  const libraryItems = Array.from(uniqueItems.values());
  console.log(`📦 Push di ${libraryItems.length} items (TUTTI quelli di Stremio)`);

  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
    console.log(`✅ Push completato!`);
  }
  
  return libraryItems.length;
}

// ============================================
// ENDPOINT TMDB PER POSTER (DA AGGIUNGERE SU RENDER)
// ============================================
app.get('/tmdb-poster', async (req, res) => {
  const apiKey = process.env.TMDB_API_KEY;

  if (!apiKey) return res.status(204).end();

  const { title, year, type } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });

  try {
    const isMovie = type === 'movie';
    const endpoint = isMovie
      ? `https://api.themoviedb.org/3/search/movie?api_key=\( {apiKey}&query= \){encodeURIComponent(title)}&year=${year || ''}&language=it-IT`
      : `https://api.themoviedb.org/3/search/tv?api_key=\( {apiKey}&query= \){encodeURIComponent(title)}&language=it-IT`;

    const response = await fetch(endpoint);
    const data = await response.json();

    const hit = data.results && data.results[0];
    const posterPath = hit && hit.poster_path;
    const url = posterPath ? `https://image.tmdb.org/t/p/w185${posterPath}` : null;

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ url });

  } catch (err) {
    console.error('TMDB error:', err.message);
    res.status(500).json({ url: null });
  }
});

// ============================================
// ENDPOINT: TEST LOGIN STREMIO
// ============================================
app.post('/test-stremio-login', async (req, res) => {
  const { email, password } = req.body;
  try {
    await stremioLogin(email, password);
    res.json({ success: true, message: '✅ Login Stremio funzionante!' });
  } catch (error) {
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT: OTTIENI DATI STREMIO
// ============================================
app.post('/get-stremio-data', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth = await stremioLogin(email, password);
    const [library, continueWatching, watchedHistory] = await Promise.all([
      getStremioLibrary(auth.token),
      getStremioContinueWatching(auth.token),
      getStremioWatchedHistory(auth.token)
    ]);

    res.json({
      success: true,
      library: library || [],
      continueWatching: continueWatching || [],
      watchedHistory: watchedHistory || [],
      stats: {
        movies: (library || []).filter(i => i.type === 'movie').length,
        series: (library || []).filter(i => i.type === 'series').length,
        continueWatching: (continueWatching || []).length,
        watched: (watchedHistory || []).length
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: TEST LOGIN NUVIO
// ============================================
app.post('/test-login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, message: '❌ Inserisci email e password' });
  }

  if (!isSupabaseConfigured()) {
    return res.json({ 
      success: false, 
      message: '❌ Supabase non configurato sul server' 
    });
  }

  try {
    const session = await supabaseLogin(email, password);
    res.json({ success: true, message: `✅ Login Nuvio riuscito!` });
  } catch (error) {
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT: OTTIENI DATI NUVIO
// ============================================
app.post('/get-nuvio-data', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, error: 'Email e password richieste' });
  }
  
  try {
    const session = await supabaseLogin(email, password);
    const library = await getNuvioLibrary(session.access_token);
    
    const libraryArray = Array.isArray(library) ? library : [];
    
    res.json({
      success: true,
      library: libraryArray,
      stats: {
        total: libraryArray.length,
        movies: libraryArray.filter(i => i.content_type === 'movie').length,
        series: libraryArray.filter(i => i.content_type === 'series').length
      }
    });
  } catch (error) {
    console.error('❌ Errore get-nuvio-data:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC DIRETTO (VERSIONE COPIA TOTALE + VISTO)
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, profileId } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  const finalProfileId = parseInt(profileId) || 1;

  try {
    console.log('🚀 Avvio sync diretto (Library + VISTO)...');
    
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];

    console.log(`📊 Trovati ${stremioItems.length} elementi su Stremio`);

    if (stremioItems.length === 0) {
      throw new Error("La tua libreria Stremio è vuota");
    }

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const backupPath = path.join(backupDir, `pre-sync-${backupId}.json`);
    fs.writeFileSync(
      backupPath,
      JSON.stringify(currentNuvioLibrary, null, 2)
    );
    console.log(`💾 Backup creato: pre-sync-\( {backupId}.json ( \){currentNuvioLibrary.length} elementi)`);

    // 1. COPIA LIBRARY (esattamente come prima)
    const pushedCount = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, stremioItems);

    // 2. COPIA TOTALE DEL "VISTO" (film + serie – sovrascrive completamente)
    console.log('📺 Copia badge "VISTO" (film + serie)...');
    const watchedRaw = stremioItems.filter(item => isWatchedState(item.state || {}));
    const watchedItems = watchedRaw.map(mapStremioWatchedItem).filter(Boolean);
    const watchedCount = await pushWatchedToSupabase(accessToken, finalProfileId, watchedItems);

    console.log(`✅ ${watchedCount} contenuti segnati come "VISTO" copiati`);

    const newNuvioLibrary = await getNuvioLibrary(accessToken);
    const newArray = Array.isArray(newNuvioLibrary) ? newNuvioLibrary : [];

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      backupPath: backupPath,
      stats: {
        stremio: stremioItems.length,
        stremioUnici: pushedCount,
        nuvioPrima: currentNuvioLibrary.length,
        nuvioDopo: newArray.length,
        copiati: pushedCount,
        watched_copiati: watchedCount,
        profileId: finalProfileId
      },
      message: `✅ COPIA COMPLETATA!\n` +
               `Libreria: ${newArray.length} elementi (come Stremio)\n` +
               `Badge "VISTO": ${watchedCount} film/serie ora hanno il ✓ verde\n` +
               `Profilo Nuvio: ${finalProfileId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: LISTA BACKUP (FIXATO!)
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  
  if (!fs.existsSync(backupsDir)) {
    return res.json({ backups: [] });
  }

  try {
    const files = fs.readdirSync(backupsDir);
    const backups = files
      .filter(f => f.endsWith('.json') && f.startsWith('pre-sync-'))
      .map(f => {
        const id = f.replace('.json', '').replace('pre-sync-', '');
        const stats = fs.statSync(path.join(backupsDir, f));
        return {
          id: id,
          fullName: f,
          date: new Date(parseInt(id)).toLocaleString(),
          size: stats.size
        };
      })
      .sort((a, b) => parseInt(b.id) - parseInt(a.id));

    res.json({ backups });
  } catch (error) {
    console.error('Errore lettura backup:', error);
    res.json({ backups: [] });
  }
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP (FIXATO!)
// ============================================
app.post('/restore', async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;

  if (!backupId || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'backupId, email e password richiesti' });
  }

  try {
    let backupPath = path.join(__dirname, 'backups', `pre-sync-${backupId}.json`);
    
    if (!fs.existsSync(backupPath)) {
      backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    }
    
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: 'Backup non trovato' });
    }

    const backupLibrary = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const backupArray = Array.isArray(backupLibrary) ? backupLibrary : [];

    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;

    const items = backupArray.map(item => ({
      _id: item.content_id,
      type: item.content_type,
      name: item.name,
      poster: item.poster,
      year: item.release_info,
      description: item.description,
      genres: item.genres,
      imdbRating: item.imdb_rating?.toString()
    }));

    const restored = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, items);

    res.json({
      success: true,
      message: `✅ Backup ripristinato! ${restored} film/serie.`
    });

  } catch (error) {
    console.error('❌ Errore restore:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: DEBUG SYNC
// ============================================
app.post('/debug-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;

  try {
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const currentArray = Array.isArray(currentNuvioLibrary) ? currentNuvioLibrary : [];

    const existingIds = new Set(currentArray.map(i => i.content_id));

    const missing = [];
    stremioItems.forEach(item => {
      const stremioId = item._id?.split(':')[0];
      if (stremioId && !existingIds.has(stremioId)) {
        missing.push({
          id: item._id,
          name: item.name,
          type: item.type
        });
      }
    });

    res.json({
      success: true,
      stats: {
        stremio: stremioItems.length,
        nuvio: currentArray.length,
        missing: missing.length
      },
      missing: missing.slice(0, 20)
    });

  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: STATO SUPABASE
// ============================================
app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Supabase non configurato'
  });
});

// ============================================
// ENDPOINT: HEALTH CHECK
// ============================================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ============================================
// ENDPOINT: CONFIGURE PAGE
// ============================================
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// ENDPOINT: DEBUG STREMIO LIBRARY
// ============================================
app.post('/debug-stremio-library', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth = await stremioLogin(email, password);
    const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
      body: JSON.stringify({ authKey: auth.token, collection: 'libraryItem', all: true })
    });
    const data = await response.json();
    res.json({ success: true, raw_response: data, rows_count: data?.result?.rows?.length || 0 });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE FINALE con VISTO copiato)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  
  if (!isSupabaseConfigured()) {
    console.log(`   → Imposta SUPABASE_URL e SUPABASE_ANON_KEY su Render`);
  }
  
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • POST /sync - SYNC TOTALE (library + badge VISTO copiati su film e serie)`);
  console.log(`\n✨ Il badge ✓ verde ora appare anche sulle serie TV!\n`);
});
