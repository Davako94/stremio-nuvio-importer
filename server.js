const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const zlib = require('zlib');

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
// SISTEMA DI RISOLUZIONE IDENTITÀ (FALLBACK DINAMICO)
// ============================================
async function resolveNuvioIdentity(accessToken) {
  let identity = {
    userId: null,    
    profileId: null  
  };

  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    const authData = await authRes.json();
    identity.userId = authData.id;

    try {
      const ownerData = await supabaseRpc('get_sync_owner', {}, accessToken);
      if (typeof ownerData === 'number') {
        identity.profileId = ownerData;
      } else if (ownerData && typeof ownerData === 'object') {
        identity.profileId = ownerData.id || ownerData.profile_id || ownerData.p_id;
      } else if (!isNaN(parseInt(ownerData))) {
        identity.profileId = parseInt(ownerData);
      }
    } catch (e) {
      console.log(`ℹ️ Impossibile recuperare ProfileID numerico tramite RPC.`);
    }

    return identity;
  } catch (error) {
    console.error("❌ Errore risoluzione identità:", error);
    throw error;
  }
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

async function getNuvioProfileId(accessToken) {
  try {
    const response = await supabaseRpc('get_sync_owner', {}, accessToken);
    console.log(`👤 get_sync_owner risposta:`, JSON.stringify(response));
    if (typeof response === 'number') return response;
    if (response && response.id) return response.id;
  } catch (e) {
    console.log(`ℹ️ get_sync_owner non disponibile: ${e.message}`);
  }
  return 1;
}

async function getNuvioWatchedItems(accessToken, profileId = 1) {
  try {
    // Rimuovo il Number() rigido per permettere l'invio di UUID nel fallback
    const pId = isNaN(Number(profileId)) ? profileId : Number(profileId);
    const items = await supabaseRpc('sync_pull_watched_items', { p_profile_id: pId }, accessToken);
    const arr = Array.isArray(items) ? items : [];
    console.log(`📖 sync_pull_watched_items (profileId=${profileId}): ${arr.length} items`);
    return arr;
  } catch (error) {
    console.error('❌ Errore getNuvioWatchedItems:', error.message);
    return [];
  }
}

// ============================================
// FUNZIONI PER L'ESTRAZIONE DELL'ID ORIGINALE
// ============================================
function extractOriginalId(item) {
  const fullId = item._id || item.id || '';
  if (!fullId) return null;
  return fullId;
}

// ============================================
// NORMALIZZAZIONE TIPI
// ============================================
function normalizeContentType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'series' || text === 'tv' || text === 'show' ? 'series' : 'movie';
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

function toPositiveInt(value, fallback = 0) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function parseSeasonEpisode(videoId) {
  if (!videoId) return { season: null, episode: null };
  const parts = String(videoId).split(':');
  if (parts.length < 3) return { season: null, episode: null };
  const episode = Number(parts[parts.length - 1]);
  const season = Number(parts[parts.length - 2]);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return { season: null, episode: null };
  return { season: Math.trunc(season), episode: Math.trunc(episode) };
}

function buildProgressKey(contentType, contentId, videoId, season, episode) {
  if (contentType === 'movie') return contentId;
  if (season != null && episode != null) return `${contentId}_s${season}e${episode}`;
  return `${contentId}_${videoId || contentId}`;
}

// ============================================
// NORMALIZZAZIONE ITEM WATCHED
// ============================================
function normalizeWatchedItem(item = {}) {
  const contentId = item.contentId;
  if (!contentId) return null;
  const seasonValue = item.season == null ? null : Number(item.season);
  const episodeValue = item.episode == null ? null : Number(item.episode);
  return {
    contentId,
    contentType: normalizeContentType(item.contentType),
    title: String(item.title ?? '').trim(),
    season: Number.isFinite(seasonValue) && seasonValue > 0 ? Math.trunc(seasonValue) : null,
    episode: Number.isFinite(episodeValue) && episodeValue > 0 ? Math.trunc(episodeValue) : null,
    watchedAt: toTimestamp(item.watchedAt),
    traktSynced: item.traktSynced || true,
    traktLastSynced: item.traktLastSynced || toTimestamp(item.watchedAt) || Date.now(),
    syncSource: item.syncSource || "trakt"
  };
}

function watchedKey(item = {}) {
  const contentId = String(item.contentId || '').trim();
  const season = item.season == null ? '' : String(Number(item.season));
  const episode = item.episode == null ? '' : String(Number(item.episode));
  return `${contentId}:${season}:${episode}`;
}

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

function mergeWatchedItems(remoteItems = [], incomingItems = []) {
  const merged = new Map();
  for (const item of dedupeWatchedItems(remoteItems)) merged.set(watchedKey(item), item);
  for (const item of dedupeWatchedItems(incomingItems)) {
    const key = watchedKey(item);
    const existing = merged.get(key);
    if (!existing) { 
      merged.set(key, {
        ...item,
        traktSynced: true,
        traktLastSynced: item.watchedAt,
        syncSource: "trakt"
      }); 
      continue; 
    }
    const existingTs = Number(existing.watchedAt || 0);
    const incomingTs = Number(item.watchedAt || 0);
    if (incomingTs > existingTs) { 
      merged.set(key, { 
        ...existing, 
        ...item,
        traktSynced: true,
        traktLastSynced: incomingTs,
        syncSource: "trakt"
      }); 
      continue; 
    }
    if (incomingTs === existingTs) {
      merged.set(key, { 
        ...existing, 
        title: existing.title || item.title, 
        contentType: existing.contentType || item.contentType,
        traktSynced: true,
        traktLastSynced: existingTs,
        syncSource: "trakt"
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => Number(b.watchedAt || 0) - Number(a.watchedAt || 0));
}

// ============================================
// FUNZIONE PER IL PAYLOAD REMOTO
// ============================================
function toRemotePayloadItem(item = {}) {
  return {
    content_id: item.contentId,
    content_type: item.contentType === 'series' ? 'series' : 'movie',
    title: item.title || '',
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    watched_at: Number(item.watchedAt || Date.now()),
    trakt_synced: true,
    trakt_last_synced: Number(item.watchedAt || Date.now()),
    sync_source: "trakt"
  };
}

function mapRemoteWatchedItem(row = {}) {
  return normalizeWatchedItem({
    contentId: row.content_id || row.contentId,
    contentType: row.content_type || row.contentType,
    title: row.title || row.name,
    season: row.season,
    episode: row.episode,
    watchedAt: row.watched_at || row.watchedAt,
    traktSynced: row.trakt_synced || false,
    traktLastSynced: row.trakt_last_synced || 0,
    syncSource: row.sync_source || null
  });
}

function buildWatchedSignature(items = []) {
  return dedupeWatchedItems(items)
    .map(item => `${watchedKey(item)}|${item.contentType}|${item.title}|${item.watchedAt}|${item.traktSynced}`)
    .join('\n');
}

// ============================================
// NORMALIZZAZIONE ITEM LIBRARY STREMIO
// ============================================
function normalizeLibraryItem(raw) {
  const id = raw._id || raw.id;
  const state = raw.state || {};
  return {
    id,
    type: raw.type || '',
    name: raw.name || '',
    poster: raw.poster || null,
    posterShape: (raw.posterShape || 'POSTER').toString().toUpperCase(),
    removed: Boolean(raw.removed),
    temp: Boolean(raw.temp),
    ctime: raw._ctime || null,
    mtime: raw._mtime || null,
    state: {
      timeOffset: toPositiveInt(state.timeOffset ?? state.time_offset ?? 0),
      duration: toPositiveInt(state.duration ?? 0),
      lastWatched: state.lastWatched ?? null,
      videoId: state.video_id ?? state.videoId ?? null,
      timesWatched: toPositiveInt(state.timesWatched ?? 0),
      flaggedWatched: toPositiveInt(state.flaggedWatched ?? 0),
      watchedField: typeof state.watched === 'string' ? state.watched : null,
    }
  };
}

// ============================================
// COSTRUZIONE PAYLOAD FILM VISTI
// ============================================
function buildWatchedMoviesPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie') continue;
    if (item.state.timesWatched <= 0 && item.state.flaggedWatched <= 0) continue;
    
    const contentId = extractOriginalId(item);
    if (!contentId) continue;
    
    payload.push({
      contentId,
      contentType: 'movie',
      title: item.name || contentId,
      season: null,
      episode: null,
      watchedAt: toTimestamp(item.state.lastWatched || item.mtime || Date.now())
    });
  }
  return payload;
}

// ============================================
// DECODIFICA EPISODI VISTI (BITFIELD)
// ============================================
function parseWatchedField(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(':');
  if (parts.length < 3) return null;
  const bitfield = parts.pop();
  const anchorLengthRaw = parts.pop();
  const anchorLength = Number(anchorLengthRaw);
  if (!Number.isFinite(anchorLength)) return null;
  const anchorVideo = parts.join(':');
  return { anchorVideo, anchorLength: Math.trunc(anchorLength), bitfield };
}

function decodeBitfield(encoded, lengthBits) {
  const compressed = Buffer.from(encoded, 'base64');
  const valuesBuf = zlib.inflateSync(compressed);
  const values = Array.from(valuesBuf);
  const bytesLen = Math.ceil(lengthBits / 8);
  while (values.length < bytesLen) values.push(0);
  return { values, length: lengthBits };
}

function bitfieldGet(bitfield, idx) {
  const index = Math.floor(idx / 8);
  const bit = idx % 8;
  if (index >= bitfield.values.length) return false;
  return ((bitfield.values[index] >> bit) & 1) !== 0;
}

function constructWatchedBoolArray(watchedField, videoIds) {
  const anchorIdx = videoIds.indexOf(watchedField.anchorVideo);
  if (anchorIdx === -1) return new Array(videoIds.length).fill(false);
  const base = decodeBitfield(watchedField.bitfield, videoIds.length);
  const offset = watchedField.anchorLength - anchorIdx - 1;
  if (offset === 0) return videoIds.map((_, i) => bitfieldGet(base, i));
  const result = new Array(videoIds.length).fill(false);
  for (let i = 0; i < videoIds.length; i++) {
    const prev = i + offset;
    if (prev >= 0 && prev < base.length) result[i] = bitfieldGet(base, prev);
  }
  return result;
}

function normalizeVideo(raw) {
  const season = raw.season ?? (raw.seriesInfo && raw.seriesInfo.season) ?? null;
  const episode = raw.episode ?? (raw.seriesInfo && raw.seriesInfo.episode) ?? null;
  const releasedMs = raw.released ? Date.parse(String(raw.released)) : NaN;
  return {
    id: raw.id,
    season: Number.isFinite(Number(season)) ? Number(season) : null,
    episode: Number.isFinite(Number(episode)) ? Number(episode) : null,
    releasedMs: Number.isFinite(releasedMs) ? releasedMs : null,
    title: raw.title || ''
  };
}

function sortVideos(videos) {
  return videos.slice().sort((a, b) => {
    const as = a.season ?? -1, bs = b.season ?? -1;
    if (as !== bs) return as - bs;
    const ae = a.episode ?? -1, be = b.episode ?? -1;
    if (ae !== be) return ae - be;
    return (a.releasedMs ?? -1) - (b.releasedMs ?? -1);
  });
}

async function fetchCinemetaVideos(id) {
  const url = `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(id)}.json`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'NuvioSync/1.0' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data?.meta?.videos || !Array.isArray(data.meta.videos)) return null;
    return data.meta.videos;
  } catch {
    return null;
  }
}

async function mapSeriesVideos(seriesItems, concurrency = 4) {
  const queue = [...seriesItems];
  const results = new Map();
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item?.id) continue;
      const videos = await fetchCinemetaVideos(item.id);
      if (Array.isArray(videos) && videos.length > 0) results.set(item.id, videos);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}

// ============================================
// COSTRUZIONE PAYLOAD EPISODI VISTI
// ============================================
async function buildWatchedEpisodesPayload(items, concurrency = 4, onProgress = null) {
  const seriesItems = items.filter(i => i.type === 'series' && i.state.watchedField);
  if (seriesItems.length === 0) return [];

  if (onProgress) onProgress(`🎬 Recupero episodi da Cinemeta per ${seriesItems.length} serie...`);
  const videosMap = await mapSeriesVideos(seriesItems, concurrency);
  const payload = [];

  for (const item of seriesItems) {
    const rawVideos = videosMap.get(item.id);
    if (!rawVideos?.length) continue;

    const normalized = sortVideos(rawVideos.map(normalizeVideo)).filter(v => v.id);
    if (!normalized.length) continue;

    const watchedField = parseWatchedField(item.state.watchedField);
    if (!watchedField) continue;

    let watchedFlags;
    try {
      watchedFlags = constructWatchedBoolArray(watchedField, normalized.map(v => v.id));
    } catch { continue; }

    const watchedAt = toTimestamp(item.state.lastWatched || item.mtime || Date.now());

    for (let i = 0; i < normalized.length; i++) {
      if (!watchedFlags[i]) continue;
      const v = normalized[i];
      if (v.season == null || v.episode == null) continue;
      
      const contentId = extractOriginalId(item);
      if (!contentId) continue;
      
      payload.push({
        contentId,
        contentType: 'series',
        title: item.name || contentId,
        season: v.season,
        episode: v.episode,
        watchedAt
      });
    }
  }
  if (onProgress) onProgress(`✅ Trovati ${payload.length} episodi visti`);
  return payload;
}

// ============================================
// COSTRUZIONE PAYLOAD WATCH PROGRESS
// ============================================
function buildWatchProgressPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie' && item.type !== 'series') continue;
    if (item.state.timeOffset <= 0 || item.state.duration <= 0) continue;
    if (item.removed && !item.temp) continue;
    const videoId = item.state.videoId || item.id;
    const { season, episode } = parseSeasonEpisode(videoId);
    const lastWatched = toTimestamp(item.state.lastWatched || item.mtime || Date.now());
    const contentId = extractOriginalId(item);
    if (!contentId) continue;
    payload.push({
      content_id: contentId,
      content_type: item.type,
      video_id: String(videoId),
      season,
      episode,
      position: item.state.timeOffset,
      duration: item.state.duration,
      last_watched: lastWatched,
      progress_key: buildProgressKey(item.type, contentId, String(videoId), season, episode)
    });
  }
  return payload;
}

function extractWatchedMoviesFromStremio(stremioRaw) {
  const items = stremioRaw.map(normalizeLibraryItem);
  return buildWatchedMoviesPayload(items);
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

async function getStremioLibrary(authKey, { includeAll = false } = {}) {
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
    const id = item._id || item.id;
    if (!id) return false;
    const type = item.type || '';
    return type === 'movie' || type === 'series' || type === 'show';
  });

  if (!includeAll) {
    items = items.filter(item => !item.removed && !item.temp);
  }

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
    const contentId = extractOriginalId(item);
    if (!contentId) {
      console.log(`⚠️ Item senza ID valido saltato: ${item.name}`);
      return;
    }
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
  console.log(`📦 Push di ${libraryItems.length} items unici su ${items.length} totali`);
  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
    console.log(`✅ Push library completato!`);
  } else {
    console.log(`⚠️ Nessun item valido da pushare.`);
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
// ENDPOINT: OTTIENI DATI STREMIO (VERSIONE COMPLETA)
// ============================================
app.post('/get-stremio-data', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth = await stremioLogin(email, password);
    
    const [libraryFiltered, libraryAll, continueWatching, watchedHistory] = await Promise.all([
      getStremioLibrary(auth.token, { includeAll: false }),
      getStremioLibrary(auth.token, { includeAll: true }),
      getStremioContinueWatching(auth.token),
      getStremioWatchedHistory(auth.token)
    ]);

    const normalizedAll = libraryAll.map(normalizeLibraryItem);
    
    const watchedMoviesRaw = buildWatchedMoviesPayload(normalizedAll);
    const watchedMovieIds = watchedMoviesRaw.map(w => w.contentId).filter(Boolean);
    const seriesWithWatched = normalizedAll.filter(i => i.type === 'series' && i.state.watchedField);
    const watchedIds = watchedMovieIds;

    res.json({
      success: true,
      library: libraryFiltered || [],
      continueWatching: continueWatching || [],
      watchedHistory: watchedHistory || [],
      watchedIds,
      stats: {
        movies: (libraryFiltered || []).filter(i => i.type === 'movie').length,
        series: (libraryFiltered || []).filter(i => i.type === 'series').length,
        continueWatching: (continueWatching || []).length,
        watched: watchedMovieIds.length,
        watchedSeriesCount: seriesWithWatched.length,
        totalWatchedItems: watchedMoviesRaw.length,
        watchedMoviesCount: watchedMoviesRaw.length,
        watchedEpisodesCount: 0
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
// ============================================
app.post('/get-nuvio-data', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email e password richieste' });
  try {
    const session = await supabaseLogin(email, password);
    const token = session.access_token;
    
    // Usiamo l'identità avanzata per trovare tutti i tuoi possibili ID
    const identity = await resolveNuvioIdentity(token);
    const library = await getNuvioLibrary(token);
    const libraryArray = Array.isArray(library) ? library : [];

    let watchedItems = [];
    
    // Fallback: Cerchiamo i "visti" in tutti i possibili ID associati a te
    const attempts = [
      { id: identity.profileId, desc: "ProfileID Numerico" },
      { id: identity.userId,    desc: "UUID Supabase" },
      { id: String(identity.profileId), desc: "ProfileID come Stringa" },
      { id: 1, desc: "ID 1 (Legacy)" }
    ].filter(a => a.id !== null && a.id !== undefined);

    for (const attempt of attempts) {
      try {
        const items = await getNuvioWatchedItems(token, attempt.id);
        if (Array.isArray(items) && items.length > 0) {
          watchedItems = items;
          console.log(`✅ Elementi visti trovati con ${attempt.desc} (${attempt.id})! Totale: ${watchedItems.length}`);
          break; // Trovati! Interrompiamo la ricerca
        }
      } catch (e) {
        // Ignoriamo e passiamo al prossimo ID
      }
    }

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
// ENDPOINT: SYNC DIRETTO (VERSIONE CON FALLBACK ID)
// ============================================
app.post('/sync', async (req, res) => {
  const {
    stremioEmail, stremioPassword, nuvioEmail, nuvioPassword,
    includeWatchedEpisodes = false
  } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  try {
    console.log('🚀 Avvio sync diretto...');

    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    
    const [rawAll, rawFiltered] = await Promise.all([
      getStremioLibrary(stremioAuth.token, { includeAll: true }),
      getStremioLibrary(stremioAuth.token, { includeAll: false })
    ]);
    
    if (!rawFiltered?.length) throw new Error('La tua libreria Stremio è vuota');
    const items = rawAll.map(normalizeLibraryItem);
    console.log(`📊 Library Stremio: ${rawFiltered.length} attivi / ${rawAll.length} totali`);

    console.log(`🎬 Estrazione watched dal libraryItem...`);
    
    const watchedMoviesRaw = buildWatchedMoviesPayload(items);
    let watchedEpisodesRaw = [];
    
    if (includeWatchedEpisodes) {
      console.log(`📺 Recupero episodi visti da Cinemeta...`);
      watchedEpisodesRaw = await buildWatchedEpisodesPayload(items, 6);
    }
    
    const allWatchedItems = [
      ...watchedMoviesRaw,
      ...watchedEpisodesRaw
    ].map(item => normalizeWatchedItem(item));

    const watchedMovies = allWatchedItems.filter(i => i.contentType === 'movie' && !i.season);
    const watchedEpisodes = allWatchedItems.filter(i => i.contentType === 'series' && i.season != null && i.episode != null);

    console.log(`✅ Estratti: ${watchedMovies.length} film + ${watchedEpisodes.length} episodi`);

    const progressPayload = buildWatchProgressPayload(items);
    console.log(`⏩ Watch progress: ${progressPayload.length} elementi`);

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    
    // NUOVO: Risoluzione identità con fallback
    const identity = await resolveNuvioIdentity(accessToken);
    console.log(`👤 Identità Nuvio risolta: UUID=${identity.userId}, ProfileID=${identity.profileId}`);

    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const [currentNuvioLibrary, currentWatchedRaw] = await Promise.all([
      getNuvioLibrary(accessToken),
      getNuvioWatchedItems(accessToken, identity.profileId || 1)
    ]);

    // Backup
    fs.writeFileSync(
      path.join(backupDir, `pre-sync-${backupId}.json`),
      JSON.stringify({ library: currentNuvioLibrary, watched: currentWatchedRaw }, null, 2)
    );
    console.log(`💾 Backup pre-sync-${backupId}.json`);

    // PUSH LIBRARY
    console.log(`📤 Push library...`);
    const { count: pushedCount } = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, rawFiltered);

    // PUSH WATCH PROGRESS
    let progressWarning = null;
    if (progressPayload.length > 0) {
      try {
        await supabaseRpc('sync_push_watch_progress', { p_entries: progressPayload }, accessToken);
        console.log(`✅ Watch progress pushato: ${progressPayload.length} voci`);
      } catch (err) {
        console.error('❌ Errore push watch progress:', err.message);
        progressWarning = err.message;
      }
    }

    // PUSH WATCHED (MULTI-ID FALLBACK)
    let watchedWarning = null;
    let totalWatchedPushed = 0;
    let usedId = null;

    if (allWatchedItems.length > 0) {
      const remoteWatched = currentWatchedRaw.map(row => mapRemoteWatchedItem(row)).filter(Boolean);
      const mergedWatched = mergeWatchedItems(remoteWatched, allWatchedItems);
      
      const payload = dedupeWatchedItems(mergedWatched)
        .map(item => toRemotePayloadItem(item))
        .filter(Boolean);
        
      if (payload.length > 0) {
        console.log(`📤 Tentativo di push watched forzato: ${payload.length} items`);
        
        // Array dei tentativi
        const attempts = [
          { id: identity.profileId, desc: "ProfileID Numerico" },
          { id: identity.userId,    desc: "UUID Supabase" },
          { id: String(identity.profileId), desc: "ProfileID come Stringa" },
          { id: 1, desc: "Fallback ID 1" }
        ].filter(a => a.id !== null && a.id !== undefined);

        for (const attempt of attempts) {
          try {
            console.log(`🧪 Tentativo push visti con ${attempt.desc}: ${attempt.id}`);
            await supabaseRpc('sync_push_watched_items', {
              p_profile_id: attempt.id,
              p_items: payload
            }, accessToken);
            
            usedId = attempt.id;
            totalWatchedPushed = payload.length;
            watchedWarning = null; // Resetta l'errore se ha successo
            console.log(`✅ Successo con ${attempt.desc}!`);
            break; // Se funziona, fermati.
          } catch (err) {
            watchedWarning = err.message;
            console.warn(`❌ Fallito con ${attempt.desc}: ${err.message}`);
          }
        }
      }
    }

    // VERIFICA FINALE
    const checkId = usedId || identity.profileId || 1;
    const [newNuvioLibrary, newWatchedRaw] = await Promise.all([
      getNuvioLibrary(accessToken),
      getNuvioWatchedItems(accessToken, checkId)
    ]);
    const newCount = Array.isArray(newNuvioLibrary) ? newNuvioLibrary.length : 0;

    console.log("🔍 Verifica match library-watched (BOLLINO BLU):");
    const previewMap = new Map();
    allWatchedItems.forEach(w => previewMap.set(w.contentId, w));
    
    let mismatchCount = 0;
    previewMap.forEach((w, contentId) => {
      const found = newNuvioLibrary.find(i => i.content_id === contentId);
      if (!found) {
        console.log(`❌ NOT IN LIBRARY: ${contentId} (${w.title || ''})`);
        mismatchCount++;
      }
    });
    
    if (mismatchCount === 0) {
      console.log(`🎉 TUTTI i ${allWatchedItems.length} content_id presenti → BOLLINO BLU GARANTITO!`);
    }

    const warnings = [watchedWarning, progressWarning].filter(Boolean);

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      watchedWarning: warnings[0] || null,
      stats: {
        stremio: rawAll.length,
        pushedLibrary: pushedCount,
        watchedFilm: watchedMovies.length,
        watchedEpisodi: watchedEpisodes.length,
        watchProgress: progressPayload.length,
        nuvioPrima: currentNuvioLibrary.length,
        nuvioDopo: newCount,
        nuvioWatchedDopo: newWatchedRaw.length,
        totaleVisti: allWatchedItems.length,
        metodoIdentita: usedId ? `Risolto: ${usedId}` : "Fallito"
      },
      message: warnings.length > 0
        ? `✅ Library OK. ⚠️ Problemi con alcuni visti/progressi: ${warnings[0]}`
        : `✅ SYNC COMPLETO! ${newCount} titoli, ${totalWatchedPushed} visti! Backup: pre-sync-${backupId}`
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

    const backupLibrary = Array.isArray(backupData) ? backupData : (backupData.library || []);
    const backupWatched = Array.isArray(backupData) ? [] : (backupData.watched || []);

    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;
    
    // Fallback logic for restore as well
    const identity = await resolveNuvioIdentity(accessToken);
    const profileId = identity.profileId || 1;

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

    // Ripristina watched
    if (backupWatched.length > 0) {
      const watchedPayload = backupWatched.map(w => ({
        content_id: String(w.content_id || ''),
        content_type: String(w.content_type || 'movie'),
        title: String(w.title || ''),
        season: w.season != null ? Number(w.season) : null,
        episode: w.episode != null ? Number(w.episode) : null,
        watched_at: Number(w.watched_at || Date.now()),
        trakt_synced: true,
        trakt_last_synced: Number(w.watched_at || Date.now()),
        sync_source: "trakt"
      })).filter(w => w.content_id);

      if (watchedPayload.length > 0) {
        await supabaseRpc('sync_push_watched_items', {
          p_profile_id: profileId,
          p_items: watchedPayload
        }, accessToken);
      }
    }

    res.json({ success: true, message: `✅ Backup ripristinato! ${restored} titoli, ${backupWatched.length} visti.` });
  } catch (error) {
    console.error('❌ Errore restore:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: DEBUG WATCHED
// ============================================
app.post('/debug-watched', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const stremioItems = await getStremioLibrary(stremioAuth.token);
    const watchedItems = extractWatchedMoviesFromStremio(stremioItems);
    addLog(`✅ Stremio: ${stremioItems.length} totali, ${watchedItems.length} film visti`);
    if (watchedItems.length > 0) {
      const payloadItem = toRemotePayloadItem(watchedItems[0]);
      addLog(`   Esempio: ${JSON.stringify(payloadItem)}`);
    }

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    addLog(`✅ Login Nuvio OK`);

    const identity = await resolveNuvioIdentity(accessToken);
    addLog(`👤 resolveNuvioIdentity: UUID=${identity.userId}, ProfileID=${identity.profileId}`);
    
    const profileId = identity.profileId || 1;

    try {
      const existing = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
      addLog(`📖 sync_pull_watched_items (profileId=${profileId}): ${Array.isArray(existing) ? existing.length : JSON.stringify(existing)} items`);
    } catch (e) { addLog(`❌ sync_pull_watched_items: ${e.message}`); }

    if (watchedItems.length > 0) {
      const testItem = toRemotePayloadItem(watchedItems[0]);
      if (testItem) {
        addLog(`🧪 Test push 1 item: ${JSON.stringify(testItem)}`);
        try {
          const pushRes = await supabaseRpc('sync_push_watched_items', {
            p_profile_id: profileId,
            p_items: [testItem]
          }, accessToken);
          addLog(`✅ Push OK: ${JSON.stringify(pushRes)}`);
        } catch (e) { addLog(`❌ Push fallito: ${e.message}`); }

        try {
          const afterPush = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
          addLog(`📖 Dopo push: ${Array.isArray(afterPush) ? afterPush.length : '?'} items`);
        } catch (e) { addLog(`❌ Pull dopo push: ${e.message}`); }
      } else {
        addLog(`❌ Impossibile creare payload per l'item (manca IMDB)`);
      }
    }

    res.json({ success: true, log, watchedItems: watchedItems.slice(0, 5).map(toRemotePayloadItem).filter(Boolean) });
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
      const stremioId = extractOriginalId(item);
      if (stremioId && !existingIds.has(stremioId)) missing.push({ id: item._id, name: item.name, type: item.type });
    });
    res.json({ success: true, stats: { stremio: stremioItems.length, nuvio: currentArray.length, missing: missing.length }, missing: missing.slice(0, 20) });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
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
// ENDPOINT: SUPABASE STATUS
// ============================================
app.get('/supabase-status', (req, res) => res.json({ 
  configured: isSupabaseConfigured(), 
  message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Supabase non configurato' 
}));

// ============================================
// ENDPOINT: HEALTH
// ============================================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ============================================
// ENDPOINT: CONFIGURE
// ============================================
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================
// ENDPOINT: DEBUG EPISODI FULL
// ============================================
app.post('/debug-episodes-full', async (req, res) => {
  const { stremioEmail, stremioPassword } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    
    addLog('📚 Recupero library Stremio (includeAll=true)...');
    const rawAll = await getStremioLibrary(stremioAuth.token, { includeAll: true });
    addLog(`✅ Trovati ${rawAll.length} elementi totali`);
    
    const items = rawAll.map(normalizeLibraryItem);
    
    const seriesWithWatched = items.filter(i => i.type === 'series' && i.state.watchedField);
    addLog(`📺 Serie con watchedField: ${seriesWithWatched.length}`);
    
    for (const serie of seriesWithWatched.slice(0, 5)) {
      addLog(`\n--- ${serie.name} (${serie.id}) ---`);
      addLog(`   watchedField: ${serie.state.watchedField.substring(0, 100)}...`);
      
      try {
        const videos = await fetchCinemetaVideos(serie.id);
        if (!videos || videos.length === 0) {
          addLog(`   ❌ Nessun video trovato da Cinemeta`);
          continue;
        }
        addLog(`   ✅ Trovati ${videos.length} video da Cinemeta`);
        
        const normalized = sortVideos(videos.map(normalizeVideo)).filter(v => v.id);
        const watchedField = parseWatchedField(serie.state.watchedField);
        
        if (!watchedField) {
          addLog(`   ❌ Impossibile parsare watchedField`);
          continue;
        }
        
        const videoIds = normalized.map(v => v.id);
        addLog(`   anchorVideo: ${watchedField.anchorVideo}`);
        addLog(`   anchorIdx: ${videoIds.indexOf(watchedField.anchorVideo)}`);
        
        const watchedFlags = constructWatchedBoolArray(watchedField, videoIds);
        const watchedCount = watchedFlags.filter(Boolean).length;
        addLog(`   Episodi visti: ${watchedCount}/${normalized.length}`);
        
        const firstWatched = [];
        for (let i = 0; i < normalized.length && firstWatched.length < 3; i++) {
          if (watchedFlags[i]) {
            firstWatched.push(`S${normalized[i].season}E${normalized[i].episode}`);
          }
        }
        if (firstWatched.length > 0) {
          addLog(`   Esempi: ${firstWatched.join(', ')}`);
        }
        
      } catch (e) {
        addLog(`   ❌ Errore: ${e.message}`);
      }
    }
    
    const watchedMovies = buildWatchedMoviesPayload(items);
    addLog(`\n🎬 Film visti: ${watchedMovies.length}`);
    if (watchedMovies.length > 0) {
      addLog(`   Primo: ${watchedMovies[0].title} (${watchedMovies[0].contentId})`);
    }
    
    res.json({ 
      success: true, 
      log,
      stats: {
        totalItems: items.length,
        seriesWithWatched: seriesWithWatched.length,
        watchedMovies: watchedMovies.length
      }
    });
    
  } catch (error) {
    addLog(`💥 ERRORE: ${error.message}`);
    res.json({ success: false, log, error: error.message });
  }
});

// ============================================
// ENDPOINT: VERIFICA WATCHED SU NUVIO
// ============================================
app.post('/check-nuvio-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId } = req.body;
  
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;
    
    const identity = await resolveNuvioIdentity(accessToken);
    const profileId = identity.profileId || 1;
    
    const watchedItems = await supabaseRpc('sync_pull_watched_items', 
      { p_profile_id: profileId }, 
      accessToken
    );
    
    let result = {
      total: watchedItems.length,
      movies: 0,
      episodes: 0,
      sample: watchedItems.slice(0, 10),
      specificContent: null
    };
    
    watchedItems.forEach(item => {
      if (item.content_type === 'movie') result.movies++;
      else if (item.season != null && item.episode != null) result.episodes++;
    });
    
    if (contentId) {
      result.specificContent = watchedItems.filter(item => 
        item.content_id === contentId || item.content_id.includes(contentId)
      );
    }
    
    res.json({ success: true, ...result });
    
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: TEST SINGOLO EPISODIO
// ============================================
app.post('/test-single-episode', async (req, res) => {
  const { 
    stremioEmail, stremioPassword, 
    nuvioEmail, nuvioPassword,
    seriesId, seasonNum, episodeNum 
  } = req.body;

  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    
    addLog('📚 Recupero library Stremio...');
    const rawAll = await getStremioLibrary(stremioAuth.token, { includeAll: true });
    const items = rawAll.map(normalizeLibraryItem);
    
    const series = items.find(i => extractOriginalId(i) === seriesId);
    if (!series) {
      addLog(`❌ Serie ${seriesId} non trovata`);
      return res.json({ success: false, log });
    }
    addLog(`✅ Trovata serie: ${series.name}`);
    
    if (!series.state.watchedField) {
      addLog(`❌ Serie senza watchedField`);
      return res.json({ success: false, log });
    }
    addLog(`📦 watchedField: ${series.state.watchedField.substring(0, 100)}...`);
    
    addLog('🎬 Recupero episodi da Cinemeta...');
    const videos = await fetchCinemetaVideos(series.id);
    if (!videos || videos.length === 0) {
      addLog('❌ Nessun video trovato');
      return res.json({ success: false, log });
    }
    addLog(`✅ Trovati ${videos.length} video`);
    
    const normalized = sortVideos(videos.map(normalizeVideo)).filter(v => v.id);
    const targetEpisode = normalized.find(v => 
      v.season === seasonNum && v.episode === episodeNum
    );
    if (!targetEpisode) {
      addLog(`❌ Episodio S${seasonNum}E${episodeNum} non trovato`);
      return res.json({ success: false, log });
    }
    addLog(`🎯 Target: S${seasonNum}E${episodeNum} - ${targetEpisode.id}`);
    
    const watchedField = parseWatchedField(series.state.watchedField);
    if (!watchedField) {
      addLog('❌ Impossibile parsare watchedField');
      return res.json({ success: false, log });
    }
    
    const videoIds = normalized.map(v => v.id);
    const watchedFlags = constructWatchedBoolArray(watchedField, videoIds);
    const episodeIndex = normalized.findIndex(v => v.id === targetEpisode.id);
    const isWatched = watchedFlags[episodeIndex];
    addLog(`📊 Episodio visto su Stremio: ${isWatched ? '✅ SÌ' : '❌ NO'}`);
    
    if (!isWatched) {
      addLog('❌ Episodio non segnato come visto su Stremio');
      return res.json({ success: false, log });
    }
    
    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    
    const identity = await resolveNuvioIdentity(accessToken);
    const profileId = identity.profileId || 1;
    
    const contentId = extractOriginalId(series);
    if (!contentId) {
      addLog('❌ Impossibile estrarre ID dalla serie');
      return res.json({ success: false, log });
    }
    
    // Prima pusha la library
    addLog('📚 Push library...');
    await pushLibraryToSupabase(nuvioEmail, nuvioPassword, [series]);
    
    // Poi pusha watched
    const payload = [{
      content_id: contentId,
      content_type: 'series',
      title: series.name || contentId,
      season: seasonNum,
      episode: episodeNum,
      watched_at: Date.now(),
      trakt_synced: true,
      trakt_last_synced: Date.now(),
      sync_source: "trakt"
    }];
    
    addLog(`📤 Payload: ${JSON.stringify(payload[0], null, 2)}`);
    
    try {
      await supabaseRpc('sync_push_watched_items', {
        p_profile_id: profileId,
        p_items: payload
      }, accessToken);
      addLog(`✅ Push completato!`);
    } catch (pushError) {
      addLog(`❌ Push fallito: ${pushError.message}`);
      return res.json({ success: false, log, error: pushError.message });
    }
    
    // Verifica
    const afterPush = await supabaseRpc('sync_pull_watched_items', 
      { p_profile_id: profileId }, accessToken
    );
    
    const saved = afterPush.find(item => 
      item.content_id === contentId && 
      item.season === seasonNum && 
      item.episode === episodeNum
    );
    
    if (saved) {
      addLog(`✅ Episodio trovato su Nuvio dopo push!`);
    } else {
      addLog(`❌ Episodio NON trovato su Nuvio dopo push!`);
    }
    
    res.json({ success: true, log });
    
  } catch (error) {
    addLog(`💥 ERRORE: ${error.message}`);
    res.json({ success: false, log, error: error.message });
  }
});

// ============================================
// ENDPOINT: CONFRONTA LIBRERIE
// ============================================
app.post('/compare-libraries', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll = await getStremioLibrary(stremioAuth.token, { includeAll: false });
    const stremioItems = rawAll.map(normalizeLibraryItem);
    const stremioIds = new Set();
    stremioItems.forEach(item => {
      const id = extractOriginalId(item);
      if (id) stremioIds.add(id);
    });
    addLog(`📊 Stremio: ${stremioItems.length} item, ${stremioIds.size} ID unici`);

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const nuvioLibrary = await getNuvioLibrary(accessToken);
    const nuvioIds = new Set(nuvioLibrary.map(i => i.content_id));
    addLog(`📊 Nuvio: ${nuvioLibrary.length} item, ${nuvioIds.size} ID unici`);

    const inStremioNotNuvio = [...stremioIds].filter(id => !nuvioIds.has(id));
    const inNuvioNotStremio = [...nuvioIds].filter(id => !stremioIds.has(id));

    addLog(`\n🔍 DISCREPANZE:`);
    addLog(`   In Stremio ma non in Nuvio: ${inStremioNotNuvio.length}`);
    addLog(`   In Nuvio ma non in Stremio: ${inNuvioNotStremio.length}`);

    if (inStremioNotNuvio.length > 0) {
      addLog(`   Esempi: ${inStremioNotNuvio.slice(0, 5).join(', ')}`);
    }

    res.json({
      success: true,
      log,
      stats: {
        stremio: stremioIds.size,
        nuvio: nuvioIds.size,
        missingInNuvio: inStremioNotNuvio.length,
        extraInNuvio: inNuvioNotStremio.length
      }
    });

  } catch (error) {
    addLog(`💥 ERRORE: ${error.message}`);
    res.json({ success: false, log, error: error.message });
  }
});

// ============================================
// ENDPOINT: VERIFICA SINGOLO ITEM
// ============================================
app.post('/check-item', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId } = req.body;
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;
    
    const identity = await resolveNuvioIdentity(accessToken);
    const profileId = identity.profileId || 1;

    // Verifica in library
    const library = await getNuvioLibrary(accessToken);
    const inLibrary = library.find(i => i.content_id === contentId);

    // Verifica in watched
    const watched = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
    const inWatched = watched.find(i => i.content_id === contentId);

    res.json({
      success: true,
      contentId,
      inLibrary: !!inLibrary,
      libraryItem: inLibrary || null,
      inWatched: !!inWatched,
      watchedItem: inWatched || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE FINALE - FALLBACK MULTI-ID)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  console.log(`🖼️  TMDB: ${process.env.TMDB_API_KEY ? '✅' : '❌ (TMDB_API_KEY non impostata)'}`);
  console.log(`\n✅ FIX APPLICATI:`);
  console.log(`   • Risoluzione identità dinamica Supabase (UUID o ProfileID)`);
  console.log(`   • Fallback di formati (Number/String/UUID) durante il sync dei visti`);
  console.log(`   • Tutti gli endpoint originali sono stati mantenuti intatti`);
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • GET  /tmdb-poster`);
  console.log(`   • POST /test-stremio-login`);
  console.log(`   • POST /get-stremio-data`);
  console.log(`   • POST /get-nuvio-data`);
  console.log(`   • POST /sync                     ← CON MULTI-ID FALLBACK`);
  console.log(`   • GET  /backups`);
  console.log(`   • POST /restore`);
  console.log(`   • POST /debug-sync`);
  console.log(`   • POST /debug-watched`);
  console.log(`   • POST /debug-episodes-full`);
  console.log(`   • POST /check-nuvio-watched`);
  console.log(`   • POST /test-single-episode`);
  console.log(`   • POST /compare-libraries`);
  console.log(`   • POST /check-item`);
  console.log(`   • GET  /supabase-status\n`);
});
