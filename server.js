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

async function getNuvioWatchedItems(accessToken, profileId = 1) {
  try {
    const items = await supabaseRpc('sync_pull_watched_items', { p_profile_id: Number(profileId) }, accessToken);
    const arr = Array.isArray(items) ? items : [];
    console.log(`📖 sync_pull_watched_items (profileId=${profileId}): ${arr.length} items`);
    return arr;
  } catch (error) {
    console.error('❌ Errore getNuvioWatchedItems:', error.message);
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

// ============================================
// WATCHED LOGIC — porta fedele dello script originale sync.mjs
// IMPORTANTE: solo film vengono sincronizzati come "visti".
// Le serie richiedono dati episodio per episodio (S01E01...) che
// Stremio non espone in modo affidabile — come da nota dello script.
// ============================================

function isSupportedContentId(value) {
  return Boolean(extractSupportedContentId(value));
}

function normalizeContentType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'series' || text === 'tv' ? 'series' : 'movie';
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

// Solo film visti (come da script originale — le serie vengono saltate)
function isWatchedStremioMovieItem(item = {}) {
  if (String(item.type || '').toLowerCase() !== 'movie') return false;
  const contentId = extractSupportedContentId(item._id || item.id);
  if (!isSupportedContentId(contentId)) return false;
  return isWatchedState(item.state || {});
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

// Formato intermedio camelCase (come normalizeWatchedItem nello script)
function normalizeWatchedItem(item = {}) {
  const contentId = extractSupportedContentId(item.contentId);
  if (!contentId) return null;
  const seasonValue = item.season == null ? null : Number(item.season);
  const episodeValue = item.episode == null ? null : Number(item.episode);
  return {
    contentId,
    contentType: normalizeContentType(item.contentType),
    title: String(item.title ?? '').trim(),
    season: Number.isFinite(seasonValue) && seasonValue > 0 ? Math.trunc(seasonValue) : null,
    episode: Number.isFinite(episodeValue) && episodeValue > 0 ? Math.trunc(episodeValue) : null,
    watchedAt: toTimestamp(item.watchedAt)
  };
}

// Chiave univoca per deduplicazione (come watchedKey nello script)
function watchedKey(item = {}) {
  const contentId = String(item.contentId || '').trim();
  const season = item.season == null ? '' : String(Number(item.season));
  const episode = item.episode == null ? '' : String(Number(item.episode));
  return `${contentId}:${season}:${episode}`;
}

// Deduplica: tieni il più recente per ogni chiave
function dedupeWatchedItems(items = []) {
  const byKey = new Map();
  for (const rawItem of (Array.isArray(items) ? items : [])) {
    const item = normalizeWatchedItem(rawItem);
    if (!item?.contentId) continue;
    const key = watchedKey(item);
    const existing = byKey.get(key);
    if (!existing || Number(item.watchedAt || 0) >= Number(existing.watchedAt || 0)) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => Number(b.watchedAt || 0) - Number(a.watchedAt || 0));
}

// Merge: unisce remote + incoming, tieni il più recente
function mergeWatchedItems(remoteItems = [], incomingItems = []) {
  const merged = new Map();
  for (const item of dedupeWatchedItems(remoteItems)) {
    merged.set(watchedKey(item), item);
  }
  for (const item of dedupeWatchedItems(incomingItems)) {
    const key = watchedKey(item);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, item); continue; }
    const existingTs = Number(existing.watchedAt || 0);
    const incomingTs = Number(item.watchedAt || 0);
    if (incomingTs > existingTs) { merged.set(key, { ...existing, ...item }); continue; }
    if (incomingTs === existingTs) {
      merged.set(key, { ...existing, title: existing.title || item.title, contentType: existing.contentType || item.contentType });
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => Number(b.watchedAt || 0) - Number(a.watchedAt || 0));
}

// Formato snake_case per Supabase (come toRemotePayloadItem nello script)
function toRemotePayloadItem(item = {}) {
  return {
    content_id: item.contentId,
    content_type: item.contentType,
    title: item.title || '',
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    watched_at: Number(item.watchedAt || Date.now())
  };
}

// Converte item da Stremio a formato intermedio camelCase (solo FILM visti)
function mapStremioMovieToWatched(item) {
  const contentId = extractSupportedContentId(item._id || item.id);
  if (!isSupportedContentId(contentId)) return null;
  const state = item.state || {};
  return normalizeWatchedItem({
    contentId,
    contentType: 'movie', // solo film
    title: item.name || '',
    watchedAt: state.lastWatched || item._mtime || Date.now()
  });
}

// Converte item da Nuvio (snake_case) a formato intermedio camelCase
function mapRemoteWatchedItem(row = {}) {
  return normalizeWatchedItem({
    contentId: row.content_id || row.contentId,
    contentType: row.content_type || row.contentType,
    title: row.title || row.name,
    season: row.season,
    episode: row.episode,
    watchedAt: row.watched_at || row.watchedAt
  });
}

// Estrae solo i film visti da Stremio (come fetchStremioWatchedItems nello script)
function extractWatchedMoviesFromStremio(stremioItems) {
  return dedupeWatchedItems(
    stremioItems
      .filter(item => isWatchedStremioMovieItem(item))
      .map(item => mapStremioMovieToWatched(item))
      .filter(Boolean)
  );
}

// Signature per confronto (evita push inutili)
function buildWatchedSignature(items = []) {
  return dedupeWatchedItems(items)
    .map(item => `${watchedKey(item)}|${item.contentType}|${item.title}|${item.watchedAt}`)
    .join('\n');
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

    // watchedIds: solo i film visti (le serie non hanno dati episodio affidabili)
    const watchedMovies = extractWatchedMoviesFromStremio(library || []);
    const watchedIds = watchedMovies.map(w => w.contentId).filter(Boolean);

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
    if (stremioItems.length === 0) throw new Error('La tua libreria Stremio è vuota');

    // 2. Watched: solo FILM (come da script originale — le serie richiedono dati episodio)
    const incomingWatched = extractWatchedMoviesFromStremio(stremioItems);
    console.log(`👁️  Film visti su Stremio: ${incomingWatched.length} (le serie vengono saltate)`);

    // 3. Login Nuvio
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const profileId = 1; // sempre 1 come da script originale
    console.log(`👤 profileId: ${profileId}`);

    // 4. Backup
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const currentWatchedRaw = await getNuvioWatchedItems(accessToken, profileId);

    fs.writeFileSync(
      path.join(backupDir, `pre-sync-${backupId}.json`),
      JSON.stringify({ library: currentNuvioLibrary, watched: currentWatchedRaw }, null, 2)
    );
    console.log(`💾 Backup pre-sync-${backupId}.json`);

    // 5. Push library Stremio → Nuvio
    const { count: pushedCount } = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, stremioItems);

    // 6. Push watched — merge fedele allo script originale
    let watchedPushed = 0;
    let watchedWarning = null;

    if (incomingWatched.length > 0) {
      try {
        // Converti watched già su Nuvio in formato camelCase per il merge
        const remoteWatched = currentWatchedRaw
          .map(row => mapRemoteWatchedItem(row))
          .filter(Boolean);

        // Merge: porta avanti remoti + integra nuovi Stremio
        const mergedWatched = mergeWatchedItems(remoteWatched, incomingWatched);

        const remoteSig = buildWatchedSignature(remoteWatched);
        const mergedSig = buildWatchedSignature(mergedWatched);

        if (remoteSig === mergedSig) {
          console.log('✅ Watched già aggiornati, nessun push necessario');
        } else {
          // Converti in formato snake_case per Supabase (come toRemotePayloadItem)
          const payload = dedupeWatchedItems(mergedWatched).map(item => toRemotePayloadItem(item));

          console.log(`📤 Push watched: ${payload.length} items, profileId=${profileId}`);
          console.log(`   Esempio: ${JSON.stringify(payload[0])}`);

          const pushRes = await supabaseRpc('sync_push_watched_items', {
            p_profile_id: profileId,
            p_items: payload
          }, accessToken);

          console.log(`✅ Risposta push watched:`, JSON.stringify(pushRes));
          watchedPushed = payload.length - remoteWatched.length;
        }
      } catch (err) {
        console.error('❌ Errore push watched:', err.message);
        watchedWarning = err.message;
      }
    }

    // 7. Verifica finale
    const newNuvioLibrary = await getNuvioLibrary(accessToken);
    const newWatchedRaw = await getNuvioWatchedItems(accessToken, profileId);
    const newArray = Array.isArray(newNuvioLibrary) ? newNuvioLibrary : [];

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      watchedWarning,
      stats: {
        stremio: stremioItems.length,
        pushedLibrary: pushedCount,
        watchedDaStremio: incomingWatched.length,
        nuvioPrima: currentNuvioLibrary.length,
        nuvioDopo: newArray.length,
        nuvioWatchedDopo: newWatchedRaw.length
      },
      message: watchedWarning
        ? `✅ Library OK (${newArray.length} titoli). ⚠️ Watched: ${watchedWarning}`
        : `✅ SYNC COMPLETATO! ${newArray.length} titoli · ${newWatchedRaw.length} film visti su Nuvio · Backup: pre-sync-${backupId}`
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
    const profileId = 1; // come da script originale

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

    // Ripristina watched se presenti (usa toRemotePayloadItem per formato corretto)
    if (backupWatched.length > 0) {
      const watchedPayload = backupWatched.map(w => ({
        content_id: String(w.content_id || ''),
        content_type: String(w.content_type || 'movie'),
        title: String(w.title || ''),
        season: w.season != null ? Number(w.season) : null,
        episode: w.episode != null ? Number(w.episode) : null,
        watched_at: Number(w.watched_at || Date.now())
      })).filter(w => w.content_id);

      await supabaseRpc('sync_push_watched_items', {
        p_profile_id: profileId,
        p_items: watchedPayload
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
    const watchedItems = extractWatchedMoviesFromStremio(stremioItems);
    addLog(`✅ Stremio: ${stremioItems.length} totali, ${watchedItems.length} film visti`);
    addLog(`   (le serie sono escluse — Nuvio richiede dati episodio per episodio)`);
    if (watchedItems.length > 0) addLog(`   Esempio: ${JSON.stringify(toRemotePayloadItem(watchedItems[0]))}`);

    // 2. Login Nuvio
    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    addLog(`✅ Login Nuvio OK`);

    // 3. get_sync_owner (solo informativo)
    try {
      const owner = await supabaseRpc('get_sync_owner', {}, accessToken);
      addLog(`👤 get_sync_owner: ${JSON.stringify(owner)}`);
    } catch (e) { addLog(`ℹ️  get_sync_owner: ${e.message}`); }

    // 4. Pull watched con profileId=1
    const profileId = 1;
    try {
      const existing = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
      addLog(`📖 sync_pull_watched_items (profileId=${profileId}): ${Array.isArray(existing) ? existing.length : JSON.stringify(existing)} items`);
    } catch (e) { addLog(`❌ sync_pull_watched_items: ${e.message}`); }

    // 5. Test push con 1 solo item
    if (watchedItems.length > 0) {
      const testItem = toRemotePayloadItem(watchedItems[0]);
      addLog(`🧪 Test push 1 item: ${JSON.stringify(testItem)}`);
      try {
        const pushRes = await supabaseRpc('sync_push_watched_items', {
          p_profile_id: profileId,
          p_items: [testItem]
        }, accessToken);
        addLog(`✅ Push OK: ${JSON.stringify(pushRes)}`);
      } catch (e) { addLog(`❌ Push fallito: ${e.message}`); }

      // 6. Verifica che sia stato salvato
      try {
        const afterPush = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
        addLog(`📖 Dopo push: ${Array.isArray(afterPush) ? afterPush.length : '?'} items`);
      } catch (e) { addLog(`❌ Pull dopo push: ${e.message}`); }
    }

    res.json({ success: true, log, watchedItems: watchedItems.slice(0, 5).map(toRemotePayloadItem) });
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
