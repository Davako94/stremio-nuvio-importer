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
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ email, password, facebook: false, type: 'login' })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Login fallito: ${text.substring(0, 300)}`);

  const data = JSON.parse(text);
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

  const data = await response.json();
  let items = Array.isArray(data.result) ? data.result : (data.result?.rows || []).map(r => r.value).filter(Boolean);

  items = items.filter(item => {
    if (!item || item.removed || item.temp) return false;
    const type = item.type || '';
    return type === 'movie' || type === 'series' || type === 'show';
  });

  console.log(`✅ Trovati ${items.length} elementi validi nella library`);
  return items;
}

// ============================================
// HELPER "VISTO" – COPIA TOTALE (film + serie)
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

// ============================================
// PUSH VISTO (COPIA TOTALE – sovrascrive tutto)
// ============================================
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
  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
  }
  return libraryItems.length;
}

// ============================================
// ENDPOINT: SYNC DIRETTO (LIBRARY + VISTO COPIA TOTALE)
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, profileId } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  const finalProfileId = parseInt(profileId) || 1;

  try {
    console.log('🚀 Avvio COPIA TOTALE (Library + VISTO film e serie)...');

    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);

    if (stremioItems.length === 0) throw new Error("La tua libreria Stremio è vuota");

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;

    // Backup library (come prima)
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    const backupPath = path.join(backupDir, `pre-sync-${backupId}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(currentNuvioLibrary, null, 2));

    // 1. COPIA LIBRARY
    const pushedCount = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, stremioItems);

    // 2. COPIA VISTO (film + serie – sovrascrive completamente)
    const watchedRaw = stremioItems.filter(item => isWatchedState(item.state || {}));
    const watchedItems = watchedRaw.map(mapStremioWatchedItem).filter(Boolean);
    const watchedCount = await pushWatchedToSupabase(accessToken, finalProfileId, watchedItems);

    const newNuvioLibrary = await getNuvioLibrary(accessToken);

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      stats: {
        library_copiati: pushedCount,
        watched_copiati: watchedCount,
        profileId: finalProfileId
      },
      message: `✅ COPIA COMPLETATA!\n` +
               `Libreria: ${pushedCount} film/serie (come Stremio)\n` +
               `Badge "VISTO": ${watchedCount} contenuti (film + serie) ora hanno il ✓ verde\n` +
               `Profilo Nuvio: ${finalProfileId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// (Tutti gli altri endpoint rimangono identici a prima)
// ============================================
app.get('/tmdb-poster', /* ... invariato ... */);
app.post('/test-stremio-login', /* ... invariato ... */);
app.post('/get-stremio-data', /* ... invariato ... */);
app.post('/test-login', /* ... invariato ... */);
app.post('/get-nuvio-data', /* ... invariato ... */);
app.get('/backups', /* ... invariato ... */);
app.post('/restore', /* ... invariato ... */);
app.post('/debug-sync', /* ... invariato ... */);
app.get('/supabase-status', /* ... invariato ... */);
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.post('/debug-stremio-library', /* ... invariato ... */);

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE FINALE - COPIA TOTALE + VISTO FILM E SERIE)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`\n✅ Ora il badge "VISTO" viene copiato anche sulle serie TV!\n`);
});
