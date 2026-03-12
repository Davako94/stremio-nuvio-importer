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
  } catch (e) {
    console.log(`ℹ️ get_sync_owner non disponibile: ${e.message}`);
  }
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
// FUNZIONI PER SERIE TV (EPISODI VISTI)
// ============================================

function parseSeasonEpisode(videoId) {
  if (!videoId) return { season: null, episode: null };
  const parts = String(videoId).split(':');
  if (parts.length < 3) return { season: null, episode: null };
  const epRaw = parts[parts.length - 1];
  const seasonRaw = parts[parts.length - 2];
  const season = Number(seasonRaw);
  const episode = Number(epRaw);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return { season: null, episode: null };
  return { season: Math.trunc(season), episode: Math.trunc(episode) };
}

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
  if (values.length < bytesLen) {
    values.push(...new Array(bytesLen - values.length).fill(0));
  }
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
  if (offset === 0) {
    return videoIds.map((_, i) => bitfieldGet(base, i));
  }
  const result = new Array(videoIds.length).fill(false);
  for (let i = 0; i < videoIds.length; i++) {
    const prev = i + offset;
    if (prev >= 0 && prev < base.length) {
      result[i] = bitfieldGet(base, prev);
    }
  }
  return result;
}

function normalizeVideo(raw) {
  const season = raw.season ?? (raw.seriesInfo && raw.seriesInfo.season) ?? null;
  const episode = raw.episode ?? (raw.seriesInfo && raw.seriesInfo.episode) ?? null;
  const releasedMs = raw.released ? Date.parse(String(raw.released)) : NaN;
  return {
    id: raw.id,
    season: Number.isFinite(season) ? Number(season) : null,
    episode: Number.isFinite(episode) ? Number(episode) : null,
    releasedMs: Number.isFinite(releasedMs) ? releasedMs : null,
    title: raw.title || '',
  };
}

function sortVideos(videos) {
  return videos.slice().sort((a, b) => {
    const as = a.season ?? -1;
    const bs = b.season ?? -1;
    if (as !== bs) return as - bs;
    const ae = a.episode ?? -1;
    const be = b.episode ?? -1;
    if (ae !== be) return ae - be;
    const ar = a.releasedMs ?? -1;
    const br = b.releasedMs ?? -1;
    return ar - br;
  });
}

async function fetchCinemetaVideos(id) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(id)}.json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || !data.meta || !Array.isArray(data.meta.videos)) return null;
    return data.meta.videos;
  } catch (error) {
    console.log(`⚠️ Cinemeta error per ${id}: ${error.message}`);
    return null;
  }
}

async function buildWatchedEpisodesPayload(items, concurrency = 4) {
  const seriesItems = items.filter(i => 
    i.type === 'series' && 
    i.state && 
    i.state.watchedField && 
    typeof i.state.watchedField === 'string'
  );
  
  if (seriesItems.length === 0) return [];

  console.log(`🎬 Analizzo ${seriesItems.length} serie con episodi visti...`);

  const videosMap = new Map();
  
  for (let i = 0; i < seriesItems.length; i += concurrency) {
    const batch = seriesItems.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      if (!item || !item.id) return;
      try {
        const videos = await fetchCinemetaVideos(item.id);
        if (Array.isArray(videos) && videos.length > 0) {
          videosMap.set(item.id, videos);
          console.log(`   ✓ ${item.name}: ${videos.length} episodi`);
        }
      } catch (e) {
        // ignore
      }
    }));
  }

  const payload = [];

  for (const item of seriesItems) {
    const rawVideos = videosMap.get(item.id);
    if (!rawVideos || rawVideos.length === 0) continue;
    
    const normalized = sortVideos(rawVideos.map(normalizeVideo)).filter(v => v.id);
    if (normalized.length === 0) continue;

    const watchedField = parseWatchedField(item.state.watchedField);
    if (!watchedField) continue;

    let watchedFlags;
    try {
      watchedFlags = constructWatchedBoolArray(watchedField, normalized.map(v => v.id));
    } catch (e) {
      console.log(`⚠️ Errore decodifica watchedField per ${item.name}: ${e.message}`);
      continue;
    }

    const watchedAt = toTimestamp(item.state.lastWatched) || toTimestamp(item._mtime) || Date.now();

    for (let i = 0; i < normalized.length; i++) {
      if (!watchedFlags[i]) continue;
      const v = normalized[i];
      if (v.season == null || v.episode == null) continue;
      
      payload.push({
        content_id: String(item.id),
        content_type: 'series',
        title: item.name || String(item.id),
        season: v.season,
        episode: v.episode,
        watched_at: watchedAt,
      });
    }
  }

  console.log(`✅ Trovati ${payload.length} episodi visti`);
  return payload;
}

// ============================================
// FUNZIONI WATCHED
// ============================================

function extractSupportedContentId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const imdbMatch = text.match(/tt\d+/i);
  if (imdbMatch) return imdbMatch[0].toLowerCase();
  const tmdbMatch = text.match(/(?:^|:)tmdb:(\d+)(?::|$)/i);
  if (tmdbMatch?.[1]) return `tmdb:${tmdbMatch[1]}`;
  return '';
}

function isSupportedContentId(value) {
  return Boolean(extractSupportedContentId(value));
}

function normalizeContentType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'series' || text === 'tv' ? 'series' : 'movie';
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

function mapStremioMovieToWatched(item) {
  const contentId = extractSupportedContentId(item._id || item.id);
  if (!isSupportedContentId(contentId)) return null;
  const state = item.state || {};
  return normalizeWatchedItem({
    contentId,
    contentType: 'movie',
    title: item.name || '',
    watchedAt: state.lastWatched || item._mtime || Date.now()
  });
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

function extractWatchedMoviesFromStremio(stremioItems) {
  return dedupeWatchedItems(
    stremioItems
      .filter(item => isWatchedStremioMovieItem(item))
      .map(item => mapStremioMovieToWatched(item))
      .filter(Boolean)
  );
}

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
// FUNZIONE PER PUSHARE LIBRARY + EPISODI VISTI
// ============================================
async function pushLibraryAndWatchedToSupabase(email, password, stremioItems, options = {}) {
  console.log(`☁️ Push cloud per ${email}...`);
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

  const { includeWatchedEpisodes = true, cinemetaConcurrency = 4 } = options;

  const uniqueItems = new Map();
  stremioItems.forEach(item => {
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
  console.log(`📦 Push library: ${libraryItems.length} items`);
  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
  }

  let watchedEpisodesCount = 0;
  let watchedMoviesCount = 0;
  
  if (includeWatchedEpisodes) {
    try {
      const watchedMovies = extractWatchedMoviesFromStremio(stremioItems);
      watchedMoviesCount = watchedMovies.length;
      
      const watchedEpisodes = await buildWatchedEpisodesPayload(stremioItems, cinemetaConcurrency);
      
      const allWatched = [...watchedMovies, ...watchedEpisodes];
      
      if (allWatched.length > 0) {
        console.log(`📌 Push watched: ${allWatched.length} items (${watchedMoviesCount} film, ${watchedEpisodes.length} episodi)`);
        
        const deduped = new Map();
        for (const w of allWatched) {
          const key = `${w.contentId}::${w.season ?? -1}::${w.episode ?? -1}`;
          const prev = deduped.get(key);
          if (!prev || w.watchedAt > prev.watchedAt) deduped.set(key, w);
        }
        const finalPayload = Array.from(deduped.values()).map(item => toRemotePayloadItem(item));
        
        await supabaseRpc('sync_push_watched_items', { 
          p_profile_id: 1,
          p_items: finalPayload 
        }, accessToken);
        
        watchedEpisodesCount = watchedEpisodes.length;
      }
    } catch (error) {
      console.error('❌ Errore push episodi visti:', error.message);
    }
  }

  console.log(`✅ Push completato! Library: ${libraryItems.length}, Film visti: ${watchedMoviesCount}, Episodi visti: ${watchedEpisodesCount}`);
  return { 
    libraryCount: libraryItems.length, 
    watchedMoviesCount, 
    watchedEpisodesCount, 
    accessToken 
  };
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
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  try {
    console.log('🚀 Avvio sync diretto con episodi visti...');

    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];
    console.log(`📊 Trovati ${stremioItems.length} elementi su Stremio`);
    if (stremioItems.length === 0) throw new Error('La tua libreria Stremio è vuota');

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const profileId = 1;

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

    const result = await pushLibraryAndWatchedToSupabase(nuvioEmail, nuvioPassword, stremioItems, {
      includeWatchedEpisodes: true,
      cinemetaConcurrency: 4
    });

    const newNuvioLibrary = await getNuvioLibrary(accessToken);
    const newWatchedRaw = await getNuvioWatchedItems(accessToken, profileId);
    const newArray = Array.isArray(newNuvioLibrary) ? newNuvioLibrary : [];

    res.json({
      success: true,
      backupId: `pre-sync-${backupId}`,
      stats: {
        stremio: stremioItems.length,
        pushedLibrary: result.libraryCount,
        pushedMoviesWatched: result.watchedMoviesCount,
        pushedEpisodesWatched: result.watchedEpisodesCount,
        nuvioPrima: currentNuvioLibrary.length,
        nuvioDopo: newArray.length,
        nuvioWatchedDopo: newWatchedRaw.length
      },
      message: `✅ SYNC COMPLETATO! ${newArray.length} titoli · ${result.watchedMoviesCount} film visti · ${result.watchedEpisodesCount} episodi visti su Nuvio · Backup: pre-sync-${backupId}`
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
    const profileId = 1;

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
    
    await pushLibraryAndWatchedToSupabase(nuvioEmail, nuvioPassword, items, {
      includeWatchedEpisodes: true
    });

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

    res.json({ success: true, message: `✅ Backup ripristinato! ${backupLibrary.length} titoli, ${backupWatched.length} visti.` });
  } catch (error) {
    console.error('❌ Errore restore:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: DEBUG EPISODI VISTI
// ============================================
app.post('/debug-episodes', async (req, res) => {
  const { stremioEmail, stremioPassword } = req.body;
  
  try {
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    let stremioItems = await getStremioLibrary(stremioAuth.token);
    stremioItems = stremioItems || [];
    
    const seriesWithWatched = stremioItems.filter(i => 
      i.type === 'series' && 
      i.state && 
      i.state.watchedField
    );
    
    console.log(`📺 Trovate ${seriesWithWatched.length} serie con episodi visti`);
    
    const details = [];
    for (const serie of seriesWithWatched.slice(0, 5)) {
      const videos = await fetchCinemetaVideos(serie.id);
      details.push({
        name: serie.name,
        id: serie.id,
        watchedField: serie.state.watchedField?.substring(0, 50) + '...',
        hasVideos: !!videos,
        videoCount: videos?.length || 0
      });
    }
    
    res.json({
      success: true,
      totalSeries: stremioItems.filter(i => i.type === 'series').length,
      seriesWithWatched: seriesWithWatched.length,
      sample: details
    });
    
  } catch (error) {
    res.json({ success: false, error: error.message });
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
    const watchedMovies = extractWatchedMoviesFromStremio(stremioItems);
    const watchedEpisodes = await buildWatchedEpisodesPayload(stremioItems, 4);
    
    addLog(`✅ Stremio: ${stremioItems.length} totali`);
    addLog(`   Film visti: ${watchedMovies.length}`);
    addLog(`   Episodi visti: ${watchedEpisodes.length}`);

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    addLog(`✅ Login Nuvio OK`);

    const profileId = 1;
    try {
      const existing = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
      addLog(`📖 Nuvio watched attuali: ${Array.isArray(existing) ? existing.length : 0} items`);
    } catch (e) { addLog(`❌ sync_pull_watched_items: ${e.message}`); }

    res.json({ 
      success: true, 
      log, 
      stats: {
        stremioMovies: watchedMovies.length,
        stremioEpisodes: watchedEpisodes.length
      },
      sampleMovies: watchedMovies.slice(0, 3).map(toRemotePayloadItem),
      sampleEpisodes: watchedEpisodes.slice(0, 3)
    });
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
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (CON BOLLINO BLU PER SERIE!)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  console.log(`🖼️  TMDB: ${process.env.TMDB_API_KEY ? '✅' : '❌ (TMDB_API_KEY non impostata)'}`);
  console.log(`📦 zlib: ✅ (per decodifica episodi visti)`);
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • GET  /tmdb-poster`);
  console.log(`   • POST /test-stremio-login`);
  console.log(`   • POST /get-stremio-data`);
  console.log(`   • POST /get-nuvio-data`);
  console.log(`   • POST /sync                    ← ORA COPIA ANCHE EPISODI VISTI!`);
  console.log(`   • POST /debug-episodes           ← NUOVO: diagnostica episodi visti`);
  console.log(`   • POST /debug-watched`);
  console.log(`   • POST /debug-sync`);
  console.log(`   • GET  /backups`);
  console.log(`   • POST /restore`);
  console.log(`   • GET  /supabase-status\n`);
});
