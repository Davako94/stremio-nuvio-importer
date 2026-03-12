const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

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

  const res = await fetch(`${SUPABASE_URL}${path}`, {
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

// Recupera il profileId reale dell'utente Nuvio.
// NOTA: sync_push/pull_watched_items si aspetta p_profile_id come INTEGER (1, 2, 3...).
// get_sync_owner restituisce invece l'UUID owner — non è il profile_id.
// Lo script originale usa sempre 1 come default, facciamo lo stesso.
async function getNuvioProfileId(accessToken) {
  // Prova a chiamare get_sync_owner solo per log/debug, ma usa sempre 1 come profile_id
  try {
    const response = await supabaseRpc('get_sync_owner', {}, accessToken);
    console.log(`👤 get_sync_owner risposta:`, JSON.stringify(response));
  } catch (e) {
    console.log(`ℹ️  get_sync_owner non disponibile: ${e.message}`);
  }
  // p_profile_id è sempre 1 (default Nuvio, come da script originale)
  return 1;
}

async function getNuvioWatchedItems(accessToken, profileId) {
  // Se profileId non passato, lo risolviamo da get_sync_owner
  const pid = profileId ?? await getNuvioProfileId(accessToken);
  try {
    const items = await supabaseRpc('sync_pull_watched_items', { p_profile_id: pid }, accessToken);
    console.log(`📖 Watched items per profileId=${pid}: ${Array.isArray(items) ? items.length : 0}`);
    return Array.isArray(items) ? items : [];
  } catch (error) {
    console.error('❌ Errore getNuvioWatchedItems:', error);
    return [];
  }
}

// ============================================
// FUNZIONI WATCHED (dalla logica dello script)
// ============================================

// Estrae content_id IMDB o TMDB da un _id Stremio (es. "tt1234567:1:2" → "tt1234567")
function extractSupportedContentId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const imdbMatch = text.match(/tt\d+/i);
  if (imdbMatch) return imdbMatch[0].toLowerCase();
  const tmdbMatch = text.match(/(?:^|:)tmdb:(\d+)(?::|$)/i);
  if (tmdbMatch?.[1]) return `tmdb:${tmdbMatch[1]}`;
  return '';
}

// Determina se un item Stremio è "visto"
function isWatchedState(state = {}) {
  const timesWatched = Number(state.timesWatched || 0);
  const flaggedWatched = Number(state.flaggedWatched || 0);
  const duration = Number(state.duration || 0);
  const timeWatched = Number(state.timeWatched || 0);
  const completionRatio = duration > 0 ? timeWatched / duration : 0;
  return timesWatched > 0 || flaggedWatched > 0 || completionRatio >= 0.7;
}

function toTimestamp(value, fallback = Date.now()) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < 100000000000 ? Math.trunc(n * 1000) : Math.trunc(n);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Mappa un item Stremio watched nel formato Nuvio
function mapStremioItemToWatched(item) {
  const contentId = extractSupportedContentId(item._id || item.id);
  if (!contentId) return null;
  const state = item.state || {};
  return {
    content_id: contentId,
    content_type: item.type === 'series' ? 'series' : 'movie',
    title: item.name || '',
    season: null,
    episode: null,
    watched_at: toTimestamp(state.lastWatched || item._mtime, Date.now())
  };
}

// Costruisce la lista degli items watched da pushare su Nuvio
function buildWatchedItemsFromStremio(stremioItems) {
  const seen = new Set();
  const result = [];
  for (const item of stremioItems) {
    if (!item) continue;
    if (!isWatchedState(item.state || {})) continue;
    const mapped = mapStremioItemToWatched(item);
    if (!mapped || !mapped.content_id) continue;
    if (seen.has(mapped.content_id)) continue;
    seen.add(mapped.content_id);
    result.push(mapped);
  }
  return result;
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
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ email, password, facebook: false, type: 'login' })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Login fallito (${response.status}): ${text.substring(0, 300)}`);
  let data = JSON.parse(text);
  const authKey = data?.result?.authKey;
  if (!authKey) throw new Error('Login fallito: authKey non trovato');
  console.log(`✅ Login Stremio OK`);
  return { token: authKey };
}

async function getStremioLibrary(authKey) {
  console.log(`📚 Richiesta library Stremio...`);
  const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ authKey, collection: 'libraryItem', all: true })
  });
  const text = await response.text();
  console.log(`📥 Status: ${response.status}`);
  if (!response.ok) throw new Error(`Stremio API errore ${response.status}: ${text.substring(0, 500)}`);

  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`Risposta non JSON: ${text.substring(0, 300)}`); }

  let items = [];
  if (data.result) {
    if (Array.isArray(data.result)) items = data.result;
    else if (data.result.rows && Array.isArray(data.result.rows)) items = data.result.rows.map(row => row.value).filter(Boolean);
    else if (data.result.value) items = [data.result.value];
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
  } catch { return []; }
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
  } catch { return []; }
}

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE
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
  console.log(`📦 Push di ${libraryItems.length} items`);
  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
    console.log(`✅ Push library completato!`);
  }
  return { count: libraryItems.length, accessToken };
}

// ============================================
// ENDPOINT: TMDB POSTER PROXY
// ============================================
app.get('/tmdb-poster', async (req, res) => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(204).end();
  const { title, year, type } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const isMovie = type === 'movie';
    const endpoint = isMovie
      ? `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year || ''}&language=it-IT`
      : `https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=it-IT`;
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
// Ora include watchedIds: array di content_id visti
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

    // Calcola watched IDs dalla library (usando lo stato degli item)
    const watchedIds = (library || [])
      .filter(item => isWatchedState(item.state || {}))
      .map(item => extractSupportedContentId(item._id || item.id))
      .filter(Boolean);

    res.json({
      success: true,
      library: library || [],
      continueWatching: continueWatching || [],
      watchedHistory: watchedHistory || [],
      watchedIds,
      stats: {
        movies: (library || []).filter(i => i.type === 'movie').length,
        series: (library || []).filter(i => i.type === 'series').length,
        continueWatching: (continueWatching || []).length,
        watched: watchedIds.length
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
  if (!email || !password) return res.json({ success: false, message: '❌ Inserisci email e password' });
  if (!isSupabaseConfigured()) return res.json({ success: false, message: '❌ Supabase non configurato sul server' });
  try {
    await supabaseLogin(email, password);
    res.json({ success: true, message: `✅ Login Nuvio riuscito!` });
  } catch (error) {
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT: OTTIENI DATI NUVIO
// Ora include watchedIds: array di content_id visti
// ============================================
app.post('/get-nuvio-data', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email e password richieste' });
  try {
    const session = await supabaseLogin(email, password);
    const profileId = await getNuvioProfileId(session.access_token);
    const [library, watchedItems] = await Promise.all([
      getNuvioLibrary(session.access_token),
      getNuvioWatchedItems(session.access_token, profileId)
    ]);

    const libraryArray = Array.isArray(library) ? library : [];
    const watchedIds = watchedItems.map(w => w.content_id).filter(Boolean);

    res.json({
      success: true,
      library: libraryArray,
      watchedIds,
      stats: {
        total: libraryArray.length,
        movies: libraryArray.filter(i => i.content_type === 'movie').length,
        series: libraryArray.filter(i => i.content_type === 'series').length,
        watched: watchedIds.length
      }
    });
  } catch (error) {
    console.error('❌ Errore get-nuvio-data:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC DIRETTO
// Ora copia anche i "watched" da Stremio a Nuvio
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  try {
    console.log('🚀 Avvio sync diretto...');

    // 1. Login Stremio + library completa
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];
    console.log(`📊 Trovati ${stremioItems.length} elementi su Stremio`);
    if (stremioItems.length === 0) throw new Error("La tua libreria Stremio è vuota");

    // 2. Watched items da Stremio
    const watchedItems = buildWatchedItemsFromStremio(stremioItems);
    console.log(`👁️  Trovati ${watchedItems.length} film/serie visti su Stremio`);

    // 3. Login Nuvio + profileId reale + backup
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;

    // ← Recupera il profileId reale (fondamentale per sync_push_watched_items)
    const profileId = await getNuvioProfileId(accessToken);
    console.log(`👤 Nuvio profileId: ${profileId}`);

    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const currentWatched = await getNuvioWatchedItems(accessToken, profileId);

    // Backup di library + watched
    const backupPath = path.join(backupDir, `pre-sync-${backupId}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
      library: currentNuvioLibrary,
      watched: currentWatched
    }, null, 2));
    console.log(`💾 Backup creato: pre-sync-${backupId}.json`);

    // 4. Push library
    const { count: pushedCount } = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, stremioItems);

    // 5. Push watched items
    let watchedPushResult = { pushed: 0, errors: [] };
    if (watchedItems.length > 0) {
      try {
        // Merge: porta avanti i watched già su Nuvio + aggiungi quelli nuovi da Stremio
        const existingWatchedIds = new Set(currentWatched.map(w => w.content_id));
        const newWatched = watchedItems.filter(w => !existingWatchedIds.has(w.content_id));

        // Items già presenti su Nuvio (mantieni il loro formato)
        const existingFormatted = currentWatched.map(w => ({
          content_id: String(w.content_id),
          content_type: String(w.content_type || 'movie'),
          title: String(w.title || ''),
          season: w.season != null ? Number(w.season) : null,
          episode: w.episode != null ? Number(w.episode) : null,
          watched_at: Number(w.watched_at || Date.now())
        }));

        // Nuovi da Stremio
        const newFormatted = newWatched.map(w => ({
          content_id: String(w.content_id),
          content_type: String(w.content_type || 'movie'),
          title: String(w.title || ''),
          season: null,
          episode: null,
          watched_at: Number(w.watched_at || Date.now())
        }));

        const allWatched = [...existingFormatted, ...newFormatted];

        console.log(`👁️  Push watched: ${allWatched.length} totali (${existingFormatted.length} esistenti + ${newFormatted.length} nuovi), profileId=${profileId}`);
        console.log(`   Esempio item: ${JSON.stringify(allWatched[0])}`);

        const pushResult = await supabaseRpc('sync_push_watched_items', {
          p_profile_id: Number(profileId), // FORZA integer
          p_items: allWatched
        }, accessToken);

        console.log(`✅ sync_push_watched_items risposta:`, JSON.stringify(pushResult));
        watchedPushResult.pushed = newFormatted.length;
      } catch (watchedErr) {
        // NON bloccare l'intero sync per un errore watched — logga e segnala
        console.error(`❌ Errore push watched:`, watchedErr.message);
        watchedPushResult.errors.push(watchedErr.message);
      }
    }

    // 6. Verifica
    const newNuvioLibrary = await getNuvioLibrary(accessToken);
    const newWatchedItems = await getNuvioWatchedItems(accessToken, profileId);
    const newArray = Array.isArray(newNuvioLibrary) ? newNuvioLibrary : [];

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      watchedWarning: watchedPushResult.errors.length > 0 ? watchedPushResult.errors[0] : null,
      stats: {
        stremio: stremioItems.length,
        pushedLibrary: pushedCount,
        pushedWatched: watchedPushResult.pushed,
        watchedDaStremio: watchedItems.length,
        nuvioPrima: currentNuvioLibrary.length,
        nuvioDopo: newArray.length,
        nuvioWatchedDopo: newWatchedItems.length
      },
      message: watchedPushResult.errors.length > 0
        ? `✅ Library sincronizzata (${newArray.length} titoli). ⚠️ Watched non sincronizzati: ${watchedPushResult.errors[0]}`
        : `✅ SYNC COMPLETATO! ${newArray.length} titoli, ${newWatchedItems.length} visti su Nuvio. Backup: pre-sync-${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: LISTA BACKUP
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupsDir)) return res.json({ backups: [] });
  try {
    const files = fs.readdirSync(backupsDir);
    const backups = files
      .filter(f => f.endsWith('.json') && f.startsWith('pre-sync-'))
      .map(f => {
        const id = f.replace('.json', '').replace('pre-sync-', '');
        const stats = fs.statSync(path.join(backupsDir, f));
        return { id, fullName: f, date: new Date(parseInt(id)).toLocaleString(), size: stats.size };
      })
      .sort((a, b) => parseInt(b.id) - parseInt(a.id));
    res.json({ backups });
  } catch (error) {
    console.error('Errore lettura backup:', error);
    res.json({ backups: [] });
  }
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP
// ============================================
app.post('/restore', async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;
  if (!backupId || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'backupId, email e password richiesti' });
  }
  try {
    let backupPath = path.join(__dirname, 'backups', `pre-sync-${backupId}.json`);
    if (!fs.existsSync(backupPath)) backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ success: false, error: 'Backup non trovato' });

    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    // Supporta sia il vecchio formato (array) che il nuovo (oggetto con library + watched)
    const backupLibrary = Array.isArray(backupData) ? backupData : (backupData.library || []);
    const backupWatched = Array.isArray(backupData) ? [] : (backupData.watched || []);

    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;
    const profileId = await getNuvioProfileId(accessToken);

    // Ripristina library
    const items = backupLibrary.map(item => ({
      _id: item.content_id,
      type: item.content_type,
      name: item.name,
      poster: item.poster,
      year: item.release_info,
      description: item.description,
      genres: item.genres,
      imdbRating: item.imdb_rating?.toString()
    }));
    const { count: restored } = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, items);

    // Ripristina watched se presenti
    if (backupWatched.length > 0) {
      await supabaseRpc('sync_push_watched_items', {
        p_profile_id: profileId,
        p_items: backupWatched.map(w => ({
          content_id: w.content_id,
          content_type: w.content_type,
          title: w.title || '',
          season: null,
          episode: null,
          watched_at: Number(w.watched_at || Date.now())
        }))
      }, accessToken);
    }

    res.json({ success: true, message: `✅ Backup ripristinato! ${restored} titoli, ${backupWatched.length} visti.` });
  } catch (error) {
    console.error('❌ Errore restore:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: DEBUG WATCHED (diagnostica completa)
// ============================================
app.post('/debug-watched', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    // 1. Login Stremio
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const stremioItems = await getStremioLibrary(stremioAuth.token);
    const watchedItems = buildWatchedItemsFromStremio(stremioItems);
    addLog(`✅ Stremio: ${stremioItems.length} totali, ${watchedItems.length} visti`);
    if (watchedItems.length > 0) addLog(`   Esempio: ${JSON.stringify(watchedItems[0])}`);

    // 2. Login Nuvio
    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    addLog(`✅ Login Nuvio OK, token: ${accessToken.substring(0, 20)}...`);

    // 3. get_sync_owner
    try {
      const owner = await supabaseRpc('get_sync_owner', {}, accessToken);
      addLog(`👤 get_sync_owner: ${JSON.stringify(owner)}`);
    } catch (e) { addLog(`⚠️  get_sync_owner: ${e.message}`); }

    // 4. Pull watched con profileId=1
    try {
      const existing = await supabaseRpc('sync_pull_watched_items', { p_profile_id: 1 }, accessToken);
      addLog(`📖 sync_pull_watched_items (profileId=1): ${Array.isArray(existing) ? existing.length : JSON.stringify(existing)} items`);
    } catch (e) { addLog(`❌ sync_pull_watched_items (1): ${e.message}`); }

    // 5. Test push con 1 solo item
    if (watchedItems.length > 0) {
      const testItem = {
        content_id: String(watchedItems[0].content_id),
        content_type: String(watchedItems[0].content_type),
        title: String(watchedItems[0].title || ''),
        season: null,
        episode: null,
        watched_at: Number(watchedItems[0].watched_at || Date.now())
      };
      addLog(`🧪 Test push 1 item: ${JSON.stringify(testItem)}`);
      try {
        const pushRes = await supabaseRpc('sync_push_watched_items', {
          p_profile_id: 1,
          p_items: [testItem]
        }, accessToken);
        addLog(`✅ Push OK: ${JSON.stringify(pushRes)}`);
      } catch (e) { addLog(`❌ Push fallito: ${e.message}`); }

      // 6. Verifica che sia stato salvato
      try {
        const afterPush = await supabaseRpc('sync_pull_watched_items', { p_profile_id: 1 }, accessToken);
        addLog(`📖 Dopo push: ${Array.isArray(afterPush) ? afterPush.length : '?'} items`);
      } catch (e) { addLog(`❌ Pull dopo push: ${e.message}`); }
    }

    res.json({ success: true, log, watchedItems: watchedItems.slice(0, 5) });
  } catch (error) {
    log.push(`💥 ERRORE FATALE: ${error.message}`);
    res.json({ success: false, log, error: error.message });
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
      if (stremioId && !existingIds.has(stremioId)) missing.push({ id: item._id, name: item.name, type: item.type });
    });
    res.json({ success: true, stats: { stremio: stremioItems.length, nuvio: currentArray.length, missing: missing.length }, missing: missing.slice(0, 20) });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ALTRI ENDPOINT
// ============================================
app.get('/supabase-status', (req, res) => res.json({ configured: isSupabaseConfigured(), message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Supabase non configurato' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  console.log(`\n🚀 Stremio → NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  console.log(`🖼️  TMDB: ${process.env.TMDB_API_KEY ? '✅' : '❌ (TMDB_API_KEY non impostata)'}`);
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • GET  /tmdb-poster`);
  console.log(`   • POST /test-stremio-login`);
  console.log(`   • POST /get-stremio-data       ← ora include watchedIds`);
  console.log(`   • POST /get-nuvio-data          ← ora include watchedIds`);
  console.log(`   • POST /sync                    ← ora copia anche i "visti"`);
  console.log(`   • GET  /backups`);
  console.log(`   • POST /restore                 ← ripristina anche i "visti"`);
  console.log(`   • POST /debug-sync`);
  console.log(`   • POST /debug-watched           ← diagnostica watched`);
  console.log(`   • GET  /supabase-status\n`);
});
