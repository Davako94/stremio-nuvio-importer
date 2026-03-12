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

  // PARSING ROBUSTO
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

  // Filter finale
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
// FUNZIONI WATCHED (dallo script dello sviluppatore)
// ============================================

function normalizeText(value) {
  return String(value ?? "").trim();
}

function extractSupportedContentId(value) {
  const text = normalizeText(value);
  if (!text) return "";

  const imdbMatch = text.match(/tt\d+/i);
  if (imdbMatch) return imdbMatch[0].toLowerCase();

  const tmdbMatch = text.match(/(?:^|:)tmdb:(\d+)(?::|$)/i);
  if (tmdbMatch?.[1]) return `tmdb:${tmdbMatch[1]}`;

  return "";
}

function isSupportedContentId(value) {
  return Boolean(extractSupportedContentId(value));
}

function normalizeContentType(value) {
  const text = normalizeText(value).toLowerCase();
  return text === "series" || text === "tv" ? "series" : "movie";
}

function isMovieStremioType(value) {
  return normalizeText(value).toLowerCase() === "movie";
}

function isSeriesStremioType(value) {
  return normalizeContentType(value) === "series";
}

function toTimestamp(value, fallback = Date.now()) {
  if (value == null || value === "") return fallback;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100000000000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }

  const text = normalizeText(value);
  if (!text) return fallback;

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      return numeric < 100000000000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    }
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function watchedKey(item = {}) {
  const contentId = normalizeText(item.contentId);
  const season = item.season == null ? "" : String(Number(item.season));
  const episode = item.episode == null ? "" : String(Number(item.episode));
  return `${contentId}:${season}:${episode}`;
}

function normalizeWatchedItem(item = {}) {
  const contentId = extractSupportedContentId(item.contentId);
  if (!contentId) return null;

  const seasonValue = item.season == null ? null : Number(item.season);
  const episodeValue = item.episode == null ? null : Number(item.episode);

  return {
    contentId,
    contentType: normalizeContentType(item.contentType),
    title: normalizeText(item.title),
    season: Number.isFinite(seasonValue) && seasonValue > 0 ? Math.trunc(seasonValue) : null,
    episode: Number.isFinite(episodeValue) && episodeValue > 0 ? Math.trunc(episodeValue) : null,
    watchedAt: toTimestamp(item.watchedAt)
  };
}

function dedupeWatchedItems(items = []) {
  const byKey = new Map();

  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = normalizeWatchedItem(rawItem);
    if (!item?.contentId) continue;

    const key = watchedKey(item);
    const existing = byKey.get(key);
    if (!existing || Number(item.watchedAt || 0) >= Number(existing.watchedAt || 0)) {
      byKey.set(key, item);
    }
  }

  return Array.from(byKey.values())
    .sort((left, right) => Number(right.watchedAt || 0) - Number(left.watchedAt || 0));
}

function mergeWatchedItems(remoteItems = [], incomingItems = []) {
  const merged = new Map();

  for (const item of dedupeWatchedItems(remoteItems)) {
    merged.set(watchedKey(item), item);
  }

  for (const item of dedupeWatchedItems(incomingItems)) {
    const key = watchedKey(item);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }

    const existingWatchedAt = Number(existing.watchedAt || 0);
    const incomingWatchedAt = Number(item.watchedAt || 0);
    if (incomingWatchedAt > existingWatchedAt) {
      merged.set(key, { ...existing, ...item });
      continue;
    }

    if (incomingWatchedAt === existingWatchedAt) {
      merged.set(key, {
        ...existing,
        title: existing.title || item.title,
        contentType: existing.contentType || item.contentType
      });
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => Number(right.watchedAt || 0) - Number(left.watchedAt || 0));
}

function isWatchedState(state = {}) {
  const timesWatched = Number(state.timesWatched || 0);
  const flaggedWatched = Number(state.flaggedWatched || 0);
  const duration = Number(state.duration || 0);
  const timeWatched = Number(state.timeWatched || 0);
  const completionRatio = duration > 0 ? timeWatched / duration : 0;

  return timesWatched > 0 || flaggedWatched > 0 || completionRatio >= 0.7;
}

function isWatchedStremioMovieItem(item = {}) {
  if (!isMovieStremioType(item.type)) return false;

  const contentId = extractSupportedContentId(item._id || item.id);
  if (!isSupportedContentId(contentId)) return false;

  return isWatchedState(item.state || {});
}

function isWatchedStremioSeriesItem(item = {}) {
  if (!isSeriesStremioType(item.type)) return false;

  const contentId = extractSupportedContentId(item._id || item.id);
  if (!isSupportedContentId(contentId)) return false;

  return isWatchedState(item.state || {});
}

function mapStremioWatchedItem(item = {}) {
  const contentId = extractSupportedContentId(item._id || item.id);
  if (!isSupportedContentId(contentId)) return null;

  const state = item.state || {};
  return normalizeWatchedItem({
    contentId,
    contentType: item.type,
    title: item.name,
    watchedAt: state.lastWatched || item._mtime || Date.now()
  });
}

function getStremioWatchedItemsFromLibrary(libraryItems) {
  return dedupeWatchedItems(
    libraryItems
      .filter(item => isWatchedStremioMovieItem(item) || isWatchedStremioSeriesItem(item))
      .map(item => mapStremioWatchedItem(item))
      .filter(Boolean)
  );
}

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

async function fetchNuvioWatchedItems(accessToken, profileId = 1) {
  try {
    const response = await supabaseRpc('sync_pull_watched_items', 
      { p_profile_id: profileId }, 
      accessToken
    );
    
    return dedupeWatchedItems(
      (Array.isArray(response) ? response : [])
        .map(row => mapRemoteWatchedItem(row))
        .filter(Boolean)
    );
  } catch (error) {
    console.error('❌ Errore fetchNuvioWatchedItems:', error);
    return [];
  }
}

function toRemotePayloadItem(item = {}) {
  return {
    content_id: item.contentId,
    content_type: item.contentType,
    title: item.title || "",
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    watched_at: Number(item.watchedAt || Date.now())
  };
}

async function pushWatchedItemsToNuvio(accessToken, profileId, items) {
  try {
    const dedupedItems = dedupeWatchedItems(items).map(item => toRemotePayloadItem(item));
    
    if (dedupedItems.length === 0) return 0;
    
    await supabaseRpc('sync_push_watched_items', {
      p_profile_id: profileId,
      p_items: dedupedItems
    }, accessToken);
    
    return dedupedItems.length;
  } catch (error) {
    console.error('❌ Errore pushWatchedItemsToNuvio:', error);
    throw error;
  }
}

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE (COPIA TOTALE)
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

  // Prepara TUTTI gli items senza confronti
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

  // Se la chiave non è configurata, rispondi 204 (niente da mostrare)
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

    // Cache lato client: 1 giorno
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
    
    // Ottieni anche i watched
    const watchedItems = await fetchNuvioWatchedItems(session.access_token, 1);
    
    res.json({
      success: true,
      library: libraryArray,
      watched: watchedItems,
      stats: {
        total: libraryArray.length,
        movies: libraryArray.filter(i => i.content_type === 'movie').length,
        series: libraryArray.filter(i => i.content_type === 'series').length,
        watched: watchedItems.length
      }
    });
  } catch (error) {
    console.error('❌ Errore get-nuvio-data:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC DIRETTO (CON WATCHED)
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, profileId = 1 } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  try {
    console.log('🚀 Avvio sync diretto (incluso watched)...');
    
    // 1. Login Stremio e ottieni TUTTA la library
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];

    console.log(`📊 Trovati ${stremioItems.length} elementi su Stremio`);

    if (stremioItems.length === 0) {
      throw new Error("La tua libreria Stremio è vuota");
    }

    // 2. Estrai gli elementi "visti" dalla library Stremio
    const stremioWatchedItems = getStremioWatchedItemsFromLibrary(stremioItems);
    console.log(`👁️ Trovati ${stremioWatchedItems.length} elementi "visti" su Stremio`);

    // 3. Login Nuvio
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    
    // 4. Crea backup PRIMA di sovrascrivere
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // Backup della library Nuvio attuale
    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const backupPath = path.join(backupDir, `pre-sync-${backupId}.json`);
    fs.writeFileSync(
      backupPath,
      JSON.stringify(currentNuvioLibrary, null, 2)
    );
    console.log(`💾 Backup library creato: pre-sync-${backupId}.json (${currentNuvioLibrary.length} elementi)`);

    // Backup dei watched Nuvio attuali
    let currentNuvioWatched = [];
    try {
      currentNuvioWatched = await fetchNuvioWatchedItems(accessToken, profileId);
      const watchedBackupPath = path.join(backupDir, `watched-pre-sync-${backupId}.json`);
      fs.writeFileSync(
        watchedBackupPath,
        JSON.stringify(currentNuvioWatched, null, 2)
      );
      console.log(`💾 Backup watched creato: watched-pre-sync-${backupId}.json (${currentNuvioWatched.length} elementi)`);
    } catch (watchedError) {
      console.log('⚠️ Impossibile leggere i watched da Nuvio:', watchedError.message);
    }

    // 5. Push TUTTA la library Stremio (SOVRASCRIVE Nuvio)
    const pushedCount = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, stremioItems);
    console.log(`✅ Copia library completata! ${pushedCount} elementi trasferiti`);

    // 6. Merge e push dei watched
    let watchedResult = { pushed: 0, merged: 0 };
    if (stremioWatchedItems.length > 0) {
      // Merge con watched esistenti
      const mergedWatched = mergeWatchedItems(currentNuvioWatched, stremioWatchedItems);
      console.log(`🔄 Merge watched: ${currentNuvioWatched.length} esistenti + ${stremioWatchedItems.length} nuovi = ${mergedWatched.length} totali`);
      
      // Push dei watched mergiati
      const pushedWatched = await pushWatchedItemsToNuvio(accessToken, profileId, mergedWatched);
      watchedResult = { pushed: pushedWatched, merged: mergedWatched.length };
      console.log(`✅ Push watched completato! ${pushedWatched} elementi salvati`);
    } else {
      console.log('ℹ️ Nessun elemento "visto" da sincronizzare');
    }

    // 7. Verifica il risultato DOPO il sync
    const newNuvioLibrary = await getNuvioLibrary(accessToken);
    const newArray = Array.isArray(newNuvioLibrary) ? newNuvioLibrary : [];

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      backupPath: backupPath,
      stats: {
        library: {
          stremio: stremioItems.length,
          stremioUnici: pushedCount,
          nuvioPrima: currentNuvioLibrary.length,
          nuvioDopo: newArray.length,
          copiati: pushedCount
        },
        watched: {
          stremio: stremioWatchedItems.length,
          nuvioPrima: currentNuvioWatched.length,
          nuvioDopo: watchedResult.merged,
          pushEffettuato: watchedResult.pushed
        }
      },
      message: `✅ SYNC COMPLETATO! Library: ${newArray.length} elementi. Watched: ${watchedResult.merged} elementi. Backup: pre-sync-${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC SOLO WATCHED
// ============================================
app.post('/sync-watched', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, profileId = 1, merge = true } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  try {
    console.log('👁️ Avvio sync solo watched...');
    
    // 1. Login Stremio
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];

    // 2. Estrai gli elementi "visti"
    const stremioWatchedItems = getStremioWatchedItemsFromLibrary(stremioItems);
    console.log(`📊 Trovati ${stremioWatchedItems.length} elementi "visti" su Stremio`);

    if (stremioWatchedItems.length === 0) {
      return res.json({ 
        success: true, 
        message: "Nessun elemento 'visto' trovato su Stremio",
        stats: { trovati: 0 }
      });
    }

    // 3. Login Nuvio
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;

    // 4. Ottieni watched esistenti da Nuvio
    const currentNuvioWatched = await fetchNuvioWatchedItems(accessToken, profileId);
    console.log(`📚 Trovati ${currentNuvioWatched.length} elementi "visti" su Nuvio`);

    // 5. Merge o sovrascrivi
    let finalWatchedItems;
    let operation;
    
    if (merge) {
      finalWatchedItems = mergeWatchedItems(currentNuvioWatched, stremioWatchedItems);
      operation = 'merge';
    } else {
      finalWatchedItems = stremioWatchedItems;
      operation = 'sovrascrittura';
    }

    // 6. Push a Nuvio
    const pushedCount = await pushWatchedItemsToNuvio(accessToken, profileId, finalWatchedItems);

    res.json({
      success: true,
      message: `✅ Sync watched completato! ${pushedCount} elementi salvati su Nuvio (${operation})`,
      stats: {
        stremio: stremioWatchedItems.length,
        nuvioPrima: currentNuvioWatched.length,
        nuvioDopo: finalWatchedItems.length,
        pushEffettuato: pushedCount
      }
    });

  } catch (error) {
    console.error('❌ Errore sync-watched:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: LISTA BACKUP (CON WATCHED)
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  
  if (!fs.existsSync(backupsDir)) {
    return res.json({ backups: [], watchedBackups: [] });
  }

  try {
    const files = fs.readdirSync(backupsDir);
    
    // Backup library
    const backups = files
      .filter(f => f.endsWith('.json') && f.startsWith('pre-sync-') && !f.startsWith('watched-'))
      .map(f => {
        const id = f.replace('.json', '').replace('pre-sync-', '');
        const stats = fs.statSync(path.join(backupsDir, f));
        return {
          id: id,
          fullName: f,
          date: new Date(parseInt(id)).toLocaleString(),
          size: stats.size,
          type: 'library'
        };
      })
      .sort((a, b) => parseInt(b.id) - parseInt(a.id));

    // Backup watched
    const watchedBackups = files
      .filter(f => f.endsWith('.json') && f.startsWith('watched-pre-sync-'))
      .map(f => {
        const id = f.replace('.json', '').replace('watched-pre-sync-', '');
        const stats = fs.statSync(path.join(backupsDir, f));
        return {
          id: id,
          fullName: f,
          date: new Date(parseInt(id)).toLocaleString(),
          size: stats.size,
          type: 'watched'
        };
      })
      .sort((a, b) => parseInt(b.id) - parseInt(a.id));

    res.json({ backups, watchedBackups });
  } catch (error) {
    console.error('Errore lettura backup:', error);
    res.json({ backups: [], watchedBackups: [] });
  }
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP (CON WATCHED)
// ============================================
app.post('/restore', async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword, backupType = 'library' } = req.body;

  if (!backupId || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'backupId, email e password richiesti' });
  }

  try {
    let backupPath;
    
    if (backupType === 'watched') {
      backupPath = path.join(__dirname, 'backups', `watched-pre-sync-${backupId}.json`);
    } else {
      // Prova prima con pre-sync-{backupId}.json
      backupPath = path.join(__dirname, 'backups', `pre-sync-${backupId}.json`);
      
      // Se non esiste, prova con backupId.json (vecchio formato)
      if (!fs.existsSync(backupPath)) {
        backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
      }
    }
    
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: 'Backup non trovato' });
    }

    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const backupArray = Array.isArray(backupData) ? backupData : [];

    // Login Nuvio
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;

    if (backupType === 'watched') {
      // Ripristino watched
      const restored = await pushWatchedItemsToNuvio(accessToken, 1, backupArray);
      res.json({
        success: true,
        message: `✅ Backup watched ripristinato! ${restored} elementi.`
      });
    } else {
      // Prepara items per il push della library
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

      // Push del backup completo
      const restored = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, items);

      res.json({
        success: true,
        message: `✅ Backup library ripristinato! ${restored} film/serie.`
      });
    }

  } catch (error) {
    console.error('❌ Errore restore:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: DEBUG SYNC (AGGIORNATO CON WATCHED)
// ============================================
app.post('/debug-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;

  try {
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];

    const stremioWatchedItems = getStremioWatchedItemsFromLibrary(stremioItems);

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const currentArray = Array.isArray(currentNuvioLibrary) ? currentNuvioLibrary : [];
    
    const currentNuvioWatched = await fetchNuvioWatchedItems(accessToken, 1);

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

    // Confronto watched
    const stremioWatchedIds = new Set(stremioWatchedItems.map(w => w.contentId));
    const nuvioWatchedIds = new Set(currentNuvioWatched.map(w => w.contentId));
    
    const missingWatched = [];
    stremioWatchedItems.forEach(item => {
      if (!nuvioWatchedIds.has(item.contentId)) {
        missingWatched.push({
          contentId: item.contentId,
          title: item.title,
          type: item.contentType
        });
      }
    });

    res.json({
      success: true,
      stats: {
        library: {
          stremio: stremioItems.length,
          nuvio: currentArray.length,
          missing: missing.length
        },
        watched: {
          stremio: stremioWatchedItems.length,
          nuvio: currentNuvioWatched.length,
          missing: missingWatched.length
        }
      },
      missing: missing.slice(0, 20),
      missingWatched: missingWatched.slice(0, 20)
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
    
    // Analizza anche i watched
    const items = data?.result?.rows?.map(r => r.value).filter(Boolean) || [];
    const watchedItems = getStremioWatchedItemsFromLibrary(items);
    
    res.json({ 
      success: true, 
      raw_response: data, 
      rows_count: items.length,
      watched_count: watchedItems.length,
      watched_samples: watchedItems.slice(0, 5)
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE CON WATCHED)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  
  if (!isSupabaseConfigured()) {
    console.log(`   → Imposta SUPABASE_URL e SUPABASE_ANON_KEY su Render`);
  }
  
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • GET  /tmdb-poster - Recupera poster da TMDB (richiede TMDB_API_KEY)`);
  console.log(`   • POST /test-stremio-login - Test login Stremio`);
  console.log(`   • POST /get-stremio-data - Ottieni library Stremio`);
  console.log(`   • POST /debug-stremio-library - Debug library Stremio (con watched)`);
  console.log(`   • POST /test-login - Test login Nuvio`);
  console.log(`   • POST /get-nuvio-data - Ottieni library Nuvio (con watched)`);
  console.log(`   • POST /sync - SYNC TOTALE (library + watched)`);
  console.log(`   • POST /sync-watched - SYNC SOLO WATCHED (merge/sovrascrivi)`);
  console.log(`   • POST /debug-sync - Debug sync (vedi cosa manca)`);
  console.log(`   • GET /backups - Lista backup (library + watched)`);
  console.log(`   • POST /restore - Ripristina backup (specifica backupType)`);
  console.log(`   • GET /supabase-status - Stato Supabase`);
  console.log(`\n✨ IMPORTANTE: Ora il sync include anche i "Visti" (badge 👁️)`);
  console.log(`   • I watched vengono estratti dalla library Stremio (stato "visto")`);
  console.log(`   • Merge intelligente con watched esistenti su Nuvio`);
  console.log(`   • Backup separati per library e watched\n`);
});
