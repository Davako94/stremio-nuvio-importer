// api/index.js — Versione per Vercel (serverless) con fix badge e batch
const express = require('express');
const cors = require('cors');
const zlib = require('zlib');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================
// SUPABASE CONFIGURAZIONE
// ============================================
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://dpyhjjcoabcglfmgecug.supabase.co').replace(/\/$/, '');
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

async function getNuvioProfileId(accessToken) {
  try {
    const response = await supabaseRpc('get_sync_owner', {}, accessToken);
    console.log(`👤 get_sync_owner risposta:`, JSON.stringify(response));

    if (typeof response === 'number' && response > 0) return response;
    if (response?.profile_id) return Number(response.profile_id);
    if (response?.id) return Number(response.id);
    if (Array.isArray(response) && response.length > 0) {
      const first = response[0];
      if (typeof first === 'number') return first;
      if (first?.profile_id) return Number(first.profile_id);
      if (first?.id) return Number(first.id);
    }
  } catch (e) {
    console.log(`ℹ️ get_sync_owner non disponibile: ${e.message}`);
  }
  return 1; // fallback
}

async function getNuvioLibrary(accessToken, profileId = null) {
  const pid = Number(profileId ?? 1);
  try {
    const r = await supabaseRpc('sync_pull_library', { p_profile_id: pid }, accessToken);
    if (Array.isArray(r)) return r;
    if (r && Array.isArray(r.data)) return r.data;
    if (r && Array.isArray(r.items)) return r.items;
    return [];
  } catch (error) {
    console.error('❌ Errore getNuvioLibrary:', error);
    return [];
  }
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
// FUNZIONI DI NORMALIZZAZIONE
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

function normalizeContentType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'series' || text === 'tv' ? 'series' : 'movie';
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
  for (const item of dedupeWatchedItems(remoteItems)) merged.set(watchedKey(item), item);
  for (const item of dedupeWatchedItems(incomingItems)) {
    const key = watchedKey(item);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item });
      continue;
    }
    const existingTs = Number(existing.watchedAt || 0);
    const incomingTs = Number(item.watchedAt || 0);
    if (incomingTs > existingTs) {
      merged.set(key, { ...existing, ...item });
      continue;
    }
    if (incomingTs === existingTs) {
      merged.set(key, {
        ...existing,
        title: existing.title || item.title,
        contentType: existing.contentType || item.contentType
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => Number(b.watchedAt || 0) - Number(a.watchedAt || 0));
}

// ============================================
// FIX 1: Payload minimo per watched items (senza campi extra)
// ============================================
function toRemotePayloadItem(item = {}) {
  const ts = Number(item.watchedAt || Date.now());
  return {
    content_id: item.contentId,
    content_type: item.contentType,
    title: item.title || '',
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    watched_at: ts
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
  });
}

function buildWatchedSignature(items = []) {
  return dedupeWatchedItems(items)
    .map(item => `${watchedKey(item)}|${item.contentType}|${item.title}|${item.watchedAt}`)
    .join('\n');
}

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

function buildWatchedMoviesPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie') continue;
    if (item.state.timesWatched <= 0 && item.state.flaggedWatched <= 0) continue;
    const contentId = extractSupportedContentId(item.id);
    if (!contentId) continue;
    payload.push({
      contentId,
      contentType: 'movie',
      title: item.name || contentId,
      season: null,
      episode: null,
      watchedAt: toTimestamp(item.state.lastWatched || item.mtime)
    });
  }
  return payload;
}

function buildWatchedSeriesPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'series') continue;
    if (item.state.timesWatched <= 0 && item.state.flaggedWatched <= 0) continue;
    const contentId = extractSupportedContentId(item.id);
    if (!contentId) continue;
    payload.push({
      contentId,
      contentType: 'series',
      title: item.name || contentId,
      season: null,
      episode: null,
      watchedAt: toTimestamp(item.state.lastWatched || item.mtime)
    });
  }
  return payload;
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

    const watchedAt = toTimestamp(item.state.lastWatched || item.mtime);

    for (let i = 0; i < normalized.length; i++) {
      if (!watchedFlags[i]) continue;
      const v = normalized[i];
      if (v.season == null || v.episode == null) continue;
      const contentId = extractSupportedContentId(item.id);
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

function buildWatchProgressPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie' && item.type !== 'series') continue;
    if (item.state.timeOffset <= 0 || item.state.duration <= 0) continue;
    if (item.removed && !item.temp) continue;
    const videoId = item.state.videoId || item.id;
    const { season, episode } = parseSeasonEpisode(videoId);
    const lastWatched = toTimestamp(item.state.lastWatched || item.mtime);
    const contentId = extractSupportedContentId(item.id);
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
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('❌ Risposta non JSON da Stremio:', text.substring(0, 200));
    throw new Error(`Risposta non JSON da Stremio (status ${response.status}): ${text.substring(0, 100)}`);
  }
  if (!response.ok) {
    const msg = data?.error || data?.message || `HTTP ${response.status}`;
    throw new Error(`Login fallito: ${msg}`);
  }
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

  if (!includeAll) items = items.filter(item => !item.removed && !item.temp);
  return items;
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
// FIX 2 e 3: pushLibrary con preservazione stato e batch
// ============================================
async function pushLibraryToSupabase(email, password, items, watchedContentIds = new Set()) {
  console.log(`☁️ Push cloud per ${email}...`);
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

  const uniqueItems = new Map();
  items.forEach(item => {
    const fullId = item._id || item.id || '';
    const contentId = extractSupportedContentId(fullId) || fullId.split(':')[0];
    if (!contentId) return;

    const isWatched = watchedContentIds.has(contentId);
    const now = Date.now();

    // Preserva lo stato originale di Stremio
    const origState = item.state || {};
    const origTimesWatched = Number(origState.timesWatched || 0);
    const origFlaggedWatched = Number(origState.flaggedWatched || 0);

    uniqueItems.set(contentId, {
      content_id: contentId,
      content_type: item.type === 'series' ? 'series' : 'movie',
      name: item.name || '',
      poster: item.poster || null,
      poster_shape: (item.posterShape || 'POSTER').toString().toUpperCase(),
      background: null,
      description: null,
      release_info: null,
      imdb_rating: null,
      genres: [],
      addon_base_url: null,
      added_at: now,
      // Flag per il badge (livello radice)
      times_watched: isWatched ? Math.max(1, origTimesWatched) : origTimesWatched,
      flagged_watched: isWatched ? Math.max(1, origFlaggedWatched) : origFlaggedWatched,
      last_watched: origState.lastWatched || (isWatched ? now : null),
      // Stato annidato con valori originali (FONDAMENTALE per badge e progressi)
      state: {
        timesWatched: isWatched ? Math.max(1, origTimesWatched) : origTimesWatched,
        flaggedWatched: isWatched ? Math.max(1, origFlaggedWatched) : origFlaggedWatched,
        lastWatched: origState.lastWatched || (isWatched ? now : null),
        // Mantieni timeOffset, duration, videoId originali (non azzerare!)
        timeOffset: Number(origState.timeOffset || origState.time_offset || 0),
        duration: Number(origState.duration || 0),
        videoId: origState.video_id || origState.videoId || null,
        // Fondamentale: preserva il watchedField delle serie (bitfield episodi)
        watched: origState.watched || null
      }
    });
  });

  const libraryItems = Array.from(uniqueItems.values());
  const watchedCount = [...watchedContentIds].length;
  console.log(`📦 Push di ${libraryItems.length} items (${watchedCount} con badge)`);

  // FIX 3: Batch da 500 per evitare limite 1000
  const BATCH_SIZE = 500;
  let totalPushed = 0;
  for (let i = 0; i < libraryItems.length; i += BATCH_SIZE) {
    const batch = libraryItems.slice(i, i + BATCH_SIZE);
    console.log(`  📤 Batch ${Math.floor(i/BATCH_SIZE)+1}: ${batch.length} items (${i+1}-${i+batch.length})`);
    await supabaseRpc('sync_push_library', { p_items: batch }, accessToken);
    totalPushed += batch.length;
    console.log(`  ✅ Batch OK (totale pushato: ${totalPushed})`);
  }

  console.log(`✅ Push library completato! ${totalPushed} items totali`);
  return { count: totalPushed, accessToken };
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
    const [libraryFiltered, libraryAll, continueWatching, watchedHistory] = await Promise.all([
      getStremioLibrary(auth.token, { includeAll: false }),
      getStremioLibrary(auth.token, { includeAll: true }),
      getStremioContinueWatching(auth.token),
      getStremioWatchedHistory(auth.token)
    ]);

    const normalizedAll = libraryAll.map(normalizeLibraryItem);

    const watchedMovies = buildWatchedMoviesPayload(normalizedAll);
    const watchedSeriesLevel = buildWatchedSeriesPayload(normalizedAll);
    const watchedMovieIds = watchedMovies.map(w => w.contentId).filter(Boolean);
    const watchedSeriesIds = watchedSeriesLevel.map(w => w.contentId).filter(Boolean);
    const seriesWithWatched = normalizedAll.filter(i => i.type === 'series' && i.state.watchedField);
    const watchedIds = [...new Set([...watchedMovieIds, ...watchedSeriesIds])];

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
        watched: watchedIds.length,
        watchedMovies: watchedMovieIds.length,
        watchedSeries: watchedSeriesIds.length,
        watchedSeriesCount: seriesWithWatched.length
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
    console.log(`👤 profileId usato: ${profileId}`);

    const [library, watchedItems] = await Promise.all([
      getNuvioLibrary(session.access_token, profileId),
      getNuvioWatchedItems(session.access_token, profileId)
    ]);

    const libraryArray = Array.isArray(library) ? library : [];
    const normalizeId = (id) => String(id || '').trim().toLowerCase();
    const watchedIds = [...new Set(watchedItems.map(w => normalizeId(w.content_id)).filter(Boolean))];

    const watchedSet = [];
    for (const w of watchedItems) {
      const cid = normalizeId(w.content_id);
      if (!cid) continue;
      watchedSet.push(cid);
      if (w.season != null && w.episode != null) {
        watchedSet.push(`${cid}:${w.season}:${w.episode}`);
      }
    }

    const watchedMap = {};
    for (const w of watchedItems) {
      const cid = normalizeId(w.content_id);
      if (!cid) continue;
      if (!watchedMap[cid]) watchedMap[cid] = [];
      watchedMap[cid].push(w);
    }

    res.json({
      success: true,
      library: libraryArray,
      watchedIds,
      watchedSet: [...new Set(watchedSet)],
      watchedMap,
      watchedItems,
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
// ENDPOINT: SYNC DIRETTO (con forceReplace)
// ============================================
app.post('/sync', async (req, res) => {
  const {
    stremioEmail, stremioPassword, nuvioEmail, nuvioPassword,
    includeWatchedEpisodes = false,
    forceReplace = true
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

    const watchedMovies = buildWatchedMoviesPayload(items);
    console.log(`🎬 Film visti: ${watchedMovies.length}`);

    const watchedSeriesLevel = buildWatchedSeriesPayload(items);
    console.log(`📺 Serie watched (series-level): ${watchedSeriesLevel.length}`);

    let watchedEpisodes = [];
    if (includeWatchedEpisodes) {
      const seriesWithBitfield = items.filter(i => i.type === 'series' && i.state.watchedField);
      console.log(`📺 Serie con watchedField: ${seriesWithBitfield.length} — avvio scansione Cinemeta...`);
      watchedEpisodes = await buildWatchedEpisodesPayload(items, 4, msg => console.log(msg));
      console.log(`📺 Episodi visti: ${watchedEpisodes.length}`);
    } else {
      const seriesWithBitfield = items.filter(i => i.type === 'series' && i.state.watchedField).length;
      if (seriesWithBitfield > 0) {
        console.log(`ℹ️ ${seriesWithBitfield} serie con episodi — passa includeWatchedEpisodes=true per sincronizzarli`);
      }
    }

    const progressPayload = buildWatchProgressPayload(items);
    console.log(`⏩ Watch progress: ${progressPayload.length} elementi`);

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const profileId = await getNuvioProfileId(accessToken);
    console.log(`👤 Nuvio profileId: ${profileId}`);

    // Prepara l'insieme di ID watched per la library (inclusi lowercase e uppercase per sicurezza)
    const allWatched = [...watchedMovies, ...watchedSeriesLevel, ...watchedEpisodes];
    const watchedIdSet = new Set([
      ...allWatched.map(i => i.contentId).filter(Boolean),
      ...allWatched.map(i => (i.contentId || '').toUpperCase()).filter(Boolean)
    ]);
    console.log(`📌 ID watched unici per library: ${watchedIdSet.size}`);

    // Push library con i flag watched (batch e stato preservato)
    const { count: pushedCount } = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, rawFiltered, watchedIdSet);

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

    let watchedWarning = null;
    let totalWatchedPushed = 0;

    // Deduplica e prepara payload watched (forza replace)
    const deduped = new Map();
    for (const w of allWatched) {
      const key = `${w.contentId}::${w.season ?? -1}::${w.episode ?? -1}`;
      const prev = deduped.get(key);
      if (!prev || w.watchedAt > prev.watchedAt) deduped.set(key, w);
    }
    const incomingWatched = Array.from(deduped.values());

    if (incomingWatched.length > 0) {
      try {
        const payload = dedupeWatchedItems(incomingWatched).map(item => toRemotePayloadItem(item));
        console.log(`📤 Push watched (replace): ${payload.length} items (${watchedMovies.length} film + ${watchedSeriesLevel.length} serie + ${watchedEpisodes.length} episodi)`);
        // Push watched senza campi extra (fix 1)
        await supabaseRpc('sync_push_watched_items', { p_profile_id: profileId, p_items: payload }, accessToken);
        totalWatchedPushed = payload.length;
      } catch (err) {
        console.error('❌ Errore push watched:', err.message);
        watchedWarning = err.message;
      }
    }

    const newWatchedRaw = await getNuvioWatchedItems(accessToken, profileId);

    const warnings = [watchedWarning, progressWarning].filter(Boolean);
    const seriesCount = items.filter(i => i.type === 'series' && i.state.watchedField).length;

    res.json({
      success: true,
      watchedWarning: warnings[0] || null,
      stats: {
        stremio: rawAll.length,
        pushedLibrary: pushedCount,
        watchedFilm: watchedMovies.length,
        watchedSerie: watchedSeriesLevel.length,
        watchedEpisodi: watchedEpisodes.length,
        watchProgress: progressPayload.length,
        serieConEpisodi: seriesCount,
        nuvioDopo: pushedCount,
        nuvioWatchedDopo: newWatchedRaw.length
      },
      message: warnings.length > 0
        ? `✅ Library OK (${pushedCount} titoli pushati). ⚠️ ${warnings[0]}`
        : includeWatchedEpisodes
          ? `✅ SYNC COMPLETO! ${pushedCount} titoli · ${watchedMovies.length} film + ${watchedSeriesLevel.length} serie + ${watchedEpisodes.length} episodi visti · ${newWatchedRaw.length} watched nel cloud`
          : `✅ SYNC COMPLETATO! ${pushedCount} titoli pushati · ${newWatchedRaw.length} watched nel cloud · ${seriesCount} serie con episodi (riavvia con episodi attivi per sincronizzarli)`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: LISTA BACKUP (DISABILITATO)
// ============================================
app.get('/backups', (req, res) => {
  res.json({ backups: [], note: 'Backup non disponibili su Vercel (nessun filesystem).' });
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP (DISABILITATO)
// ============================================
app.post('/restore', async (req, res) => {
  res.status(400).json({ success: false, error: 'Restore non disponibile su Vercel (nessun backup locale).' });
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
    const watchedSeriesLevel = buildWatchedSeriesPayload(stremioItems.map(normalizeLibraryItem));
    addLog(`✅ Stremio: ${stremioItems.length} totali, ${watchedItems.length} film visti, ${watchedSeriesLevel.length} serie viste`);
    if (watchedItems.length > 0) addLog(`   Esempio film: ${JSON.stringify(toRemotePayloadItem(watchedItems[0]))}`);
    if (watchedSeriesLevel.length > 0) addLog(`   Esempio serie: ${JSON.stringify(toRemotePayloadItem(watchedSeriesLevel[0]))}`);

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    addLog(`✅ Login Nuvio OK`);

    const profileId = await getNuvioProfileId(accessToken);
    addLog(`👤 profileId: ${profileId}`);

    try {
      const existing = await supabaseRpc('sync_pull_watched_items', { p_profile_id: profileId }, accessToken);
      addLog(`📖 sync_pull_watched_items (profileId=${profileId}): ${Array.isArray(existing) ? existing.length : JSON.stringify(existing)} items`);
    } catch (e) { addLog(`❌ sync_pull_watched_items: ${e.message}`); }

    const allWatched = [...watchedItems, ...watchedSeriesLevel];
    if (allWatched.length > 0) {
      const testItem = toRemotePayloadItem(allWatched[0]);
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
    }

    res.json({ success: true, log, watchedItems: allWatched.slice(0, 5).map(toRemotePayloadItem) });
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
    res.json({ success: true, stats: { stremio: stremioItems.length, nuvio: 'N/A', missing: 'N/A' }, note: 'Pull library non disponibile per bug PostgreSQL lato Nuvio' });
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
// ENDPOINT: CONFIGURE (SERVE HTML)
// ============================================
app.get('/configure', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

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
    const watchedSeriesLevel = buildWatchedSeriesPayload(items);
    addLog(`\n🎬 Film visti: ${watchedMovies.length}`);
    addLog(`📺 Serie viste (series-level): ${watchedSeriesLevel.length}`);
    if (watchedMovies.length > 0) {
      addLog(`   Primo film: ${watchedMovies[0].title} (${watchedMovies[0].contentId})`);
    }

    res.json({
      success: true,
      log,
      stats: {
        totalItems: items.length,
        seriesWithWatched: seriesWithWatched.length,
        watchedMovies: watchedMovies.length,
        watchedSeriesLevel: watchedSeriesLevel.length
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
    const profileId = await getNuvioProfileId(accessToken);

    const watchedItems = await supabaseRpc('sync_pull_watched_items',
      { p_profile_id: profileId },
      accessToken
    );

    let result = {
      total: watchedItems.length,
      movies: 0,
      series: 0,
      episodes: 0,
      sample: watchedItems.slice(0, 10),
      specificContent: null
    };

    watchedItems.forEach(item => {
      if (item.content_type === 'movie') result.movies++;
      else if (item.season != null && item.episode != null) result.episodes++;
      else result.series++;
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
// ENDPOINT: DEBUG LIBRARY
// ============================================
app.post('/debug-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Nuvio...');
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;
    addLog('✅ Login OK');

    const profileId = await getNuvioProfileId(accessToken);
    addLog(`👤 profileId: ${profileId}`);

    addLog('\n--- Tentativo sync_pull_library (1 param) ---');
    try {
      const r = await supabaseRpc('sync_pull_library', { p_profile_id: profileId }, accessToken);
      addLog(`   Tipo risposta: ${typeof r} | Array: ${Array.isArray(r)} | Lunghezza: ${Array.isArray(r) ? r.length : 'N/A'}`);
      if (Array.isArray(r) && r.length > 0) addLog(`   Primo item: ${JSON.stringify(r[0]).substring(0, 200)}`);
      else addLog(`   Risposta raw: ${JSON.stringify(r).substring(0, 300)}`);
    } catch (e) { addLog(`   ❌ Errore: ${e.message}`); }

    res.json({ success: true, log });
  } catch (error) {
    log.push(`💥 ERRORE FATALE: ${error.message}`);
    res.json({ success: false, log, error: error.message });
  }
});

// ============================================
// ENDPOINT: RESET WATCHED + PROGRESS
// ============================================
app.post('/reset-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.json({ success: false, error: 'Credenziali Nuvio richieste' });

  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Nuvio...');
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;
    const profileId = await getNuvioProfileId(accessToken);
    addLog(`👤 profileId: ${profileId}`);

    const before = await getNuvioWatchedItems(accessToken, profileId);
    addLog(`📊 Watched prima del reset: ${before.length}`);

    addLog('🗑️ Reset watched items...');
    await supabaseRpc('sync_push_watched_items', { p_profile_id: profileId, p_items: [] }, accessToken);
    addLog('✅ Watched azzerati');

    addLog('🗑️ Reset watch progress...');
    try {
      await supabaseRpc('sync_push_watch_progress', { p_entries: [] }, accessToken);
      addLog('✅ Watch progress azzerato');
    } catch (e) {
      addLog(`⚠️ Watch progress reset: ${e.message}`);
    }

    const after = await getNuvioWatchedItems(accessToken, profileId);
    addLog(`📊 Watched dopo il reset: ${after.length}`);

    res.json({ success: true, log, before: before.length, after: after.length });
  } catch (err) {
    log.push(`💥 Errore: ${err.message}`);
    res.json({ success: false, log, error: err.message });
  }
});

// ============================================
// ESPORTA L'APP PER VERCEL
// ============================================
module.exports = app;
