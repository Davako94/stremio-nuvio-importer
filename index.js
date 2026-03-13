/**
 * Stremio → NUVIO Sync — Cloudflare Workers
 * Zero dipendenze: niente Express, fs, path, zlib, Buffer.
 * Ottimizzato per piano gratuito (limite 50 subrequests).
 *
 * Segreti da impostare con:
 *   wrangler secret put SUPABASE_URL
 *   wrangler secret put SUPABASE_ANON_KEY
 *   wrangler secret put TMDB_API_KEY   (opzionale)
 */

// ─────────────────────────────────────────────────────────────────────────────
// HTML — inline (Workers non ha filesystem)
// ─────────────────────────────────────────────────────────────────────────────
import HTML from '../public/index.html';

// Cache per Cinemeta (riduce subrequests)
const cinemetaCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// UTILS RISPOSTA
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    headers: { 
      'Content-Type': 'application/json', 
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...CORS 
    },
  });
}

function jsonErr(message, status = 500) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function htmlOk(html) {
  return new Response(html, {
    headers: { 
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    },
  });
}

async function parseBody(request) {
  try { return await request.json(); } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────────────────────────────────────

function makeSupabase(env) {
  const BASE = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const ANON = env.SUPABASE_ANON_KEY || '';

  const isConfigured = () => Boolean(BASE && ANON);

  async function request(endpoint, { method = 'GET', body, authToken } = {}) {
    const headers = { apikey: ANON };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${BASE}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!res.ok) {
      const msg =
        parsed?.message || parsed?.msg || parsed?.error_description ||
        parsed?.error || text || `HTTP ${res.status}`;
      throw new Error(String(msg));
    }
    return parsed;
  }

  async function login(email, password) {
    return request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
    });
  }

  async function rpc(fn, payload, accessToken) {
    return request(`/rest/v1/rpc/${fn}`, {
      method: 'POST',
      body: payload || {},
      authToken: accessToken,
    });
  }

  async function getUser(accessToken) {
    const res = await fetch(`${BASE}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${accessToken}` },
    });
    return res.json();
  }

  return { isConfigured, login, rpc, getUser, BASE, ANON };
}

// ─────────────────────────────────────────────────────────────────────────────
// RISOLUZIONE IDENTITÀ NUVIO
// ─────────────────────────────────────────────────────────────────────────────

function isUUID(val) {
  return (
    typeof val === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)
  );
}

function parseProfileId(data) {
  if (data === null || data === undefined) return null;
  if (typeof data === 'number' && Number.isFinite(data) && data > 0) return Math.trunc(data);
  if (typeof data === 'string' && /^\d+$/.test(data.trim())) {
    const n = parseInt(data.trim(), 10);
    return n > 0 ? n : null;
  }
  if (typeof data === 'object') {
    for (const key of ['id', 'profile_id', 'p_id', 'profileId', 'profile']) {
      const val = data[key];
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) return Math.trunc(val);
      if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
        const n = parseInt(val.trim(), 10);
        if (n > 0) return n;
      }
    }
  }
  return null;
}

async function resolveNuvioIdentity(sb, accessToken) {
  const identity = { userId: null, profileId: null, allProfileIds: [] };

  try {
    const authData = await sb.getUser(accessToken);
    identity.userId = authData.id || null;
  } catch {}

  for (const fn of ['get_sync_owner', 'get_profile_id', 'get_current_profile', 'get_user_profile_id']) {
    try {
      const data = await sb.rpc(fn, {}, accessToken);
      const parsed = parseProfileId(data);
      if (parsed !== null) { identity.profileId = parsed; break; }
    } catch {}
  }

  if (identity.profileId === null) {
    const scanResults = await Promise.all(
      Array.from({ length: 30 }, (_, i) => i + 1).map(id =>
        sb.rpc('sync_pull_watched_items', { p_profile_id: id }, accessToken)
          .then(items => ({ id, count: Array.isArray(items) ? items.length : 0 }))
          .catch(() => ({ id, count: 0 }))
      )
    );
    const best = scanResults.reduce((a, b) => (b.count > a.count ? b : a), { id: 1, count: 0 });
    identity.profileId = best.id;
  }

  identity.allProfileIds = [identity.profileId];
  return identity;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNZIONI NUVIO
// ─────────────────────────────────────────────────────────────────────────────

async function getNuvioLibrary(sb, accessToken) {
  try {
    const lib = await sb.rpc('sync_pull_library', {}, accessToken);
    return Array.isArray(lib) ? lib : [];
  } catch { return []; }
}

async function getNuvioWatchedItems(sb, accessToken, profileId = 1) {
  const attempts = [profileId, 1].filter(Boolean);
  const seen = new Set();
  const ordered = [];
  for (const id of attempts) {
    const k = String(id);
    if (!seen.has(k)) { seen.add(k); ordered.push(id); }
  }
  for (const id of ordered) {
    try {
      const items = await sb.rpc('sync_pull_watched_items', { p_profile_id: id }, accessToken);
      const arr = Array.isArray(items) ? items : [];
      if (arr.length > 0) return arr;
    } catch {}
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZZAZIONE / HELPERS DATI
// ─────────────────────────────────────────────────────────────────────────────

function normalizeContentType(value) {
  const t = String(value ?? '').trim().toLowerCase();
  return t === 'series' || t === 'tv' || t === 'show' ? 'series' : 'movie';
}

function toTimestamp(value, fallback = Date.now()) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  const t = String(value).trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n < 1_000_000_000_000 ? Math.trunc(n * 1000) : Math.trunc(n);
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
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
  const contentId = item.contentId;
  if (!contentId) return null;
  const s = item.season == null ? null : Number(item.season);
  const e = item.episode == null ? null : Number(item.episode);
  return {
    contentId,
    contentType: normalizeContentType(item.contentType),
    title: String(item.title ?? '').trim(),
    season: Number.isFinite(s) && s > 0 ? Math.trunc(s) : null,
    episode: Number.isFinite(e) && e > 0 ? Math.trunc(e) : null,
    watchedAt: toTimestamp(item.watchedAt),
    traktSynced: item.traktSynced !== false,
    traktLastSynced: item.traktLastSynced || toTimestamp(item.watchedAt) || Date.now(),
    syncSource: item.syncSource || 'trakt',
  };
}

function watchedKey(item = {}) {
  const cid = String(item.contentId || '').trim();
  const s = item.season == null ? '' : String(Number(item.season));
  const e = item.episode == null ? '' : String(Number(item.episode));
  return `${cid}:${s}:${e}`;
}

function dedupeWatchedItems(items = []) {
  const map = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeWatchedItem(raw);
    if (!item?.contentId) continue;
    const k = watchedKey(item);
    const ex = map.get(k);
    if (!ex || Number(item.watchedAt) >= Number(ex.watchedAt)) map.set(k, item);
  }
  return Array.from(map.values()).sort((a, b) => Number(b.watchedAt) - Number(a.watchedAt));
}

function mergeWatchedItems(remote = [], incoming = []) {
  const map = new Map();
  for (const item of dedupeWatchedItems(remote)) map.set(watchedKey(item), item);
  for (const item of dedupeWatchedItems(incoming)) {
    const k = watchedKey(item);
    const ex = map.get(k);
    if (!ex) { map.set(k, { ...item, traktSynced: true, traktLastSynced: item.watchedAt, syncSource: 'trakt' }); continue; }
    const et = Number(ex.watchedAt), it = Number(item.watchedAt);
    if (it > et) { map.set(k, { ...ex, ...item, traktSynced: true, traktLastSynced: it, syncSource: 'trakt' }); continue; }
    if (it === et) map.set(k, { ...ex, title: ex.title || item.title, traktSynced: true, traktLastSynced: et, syncSource: 'trakt' });
  }
  return Array.from(map.values()).sort((a, b) => Number(b.watchedAt) - Number(a.watchedAt));
}

function toRemotePayloadItem(item = {}) {
  const ts = Number(item.watchedAt || Date.now());
  return {
    content_id: item.contentId,
    content_type: item.contentType === 'series' ? 'series' : 'movie',
    title: item.title || '',
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    watched_at: ts,
    trakt_synced: true,
    trakt_last_synced: ts,
    sync_source: 'trakt',
    nuvio_watched: true,
    watched: true,
    times_watched: 1,
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
    traktSynced: row.trakt_synced !== false,
    traktLastSynced: row.trakt_last_synced || 0,
    syncSource: row.sync_source || null,
  });
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
    },
  };
}

function extractOriginalId(item) {
  return item._id || item.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildWatchedMoviesPayload(items) {
  const out = [];
  for (const item of items) {
    if (!item.id || item.type !== 'movie') continue;
    const explicit = item.state.timesWatched > 0 || item.state.flaggedWatched > 0;
    const ratio = item.state.duration > 0 ? item.state.timeOffset / item.state.duration : 0;
    if (!explicit && ratio < 0.85) continue;
    const contentId = extractOriginalId(item);
    if (!contentId) continue;
    out.push({
      contentId,
      contentType: 'movie',
      title: item.name || contentId,
      season: null,
      episode: null,
      watchedAt: toTimestamp(item.state.lastWatched || item.mtime || Date.now()),
    });
  }
  return out;
}

function buildWatchProgressPayload(items) {
  const out = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie' && item.type !== 'series') continue;
    if (item.state.timeOffset <= 0 || item.state.duration <= 0) continue;
    if (item.removed && !item.temp) continue;
    const videoId = item.state.videoId || item.id;
    const { season, episode } = parseSeasonEpisode(videoId);
    const contentId = extractOriginalId(item);
    if (!contentId) continue;
    out.push({
      content_id: contentId,
      content_type: item.type,
      video_id: String(videoId),
      season,
      episode,
      position: item.state.timeOffset,
      duration: item.state.duration,
      last_watched: toTimestamp(item.state.lastWatched || item.mtime || Date.now()),
      progress_key: buildProgressKey(item.type, contentId, String(videoId), season, episode),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// BITFIELD DECODER — Workers usa DecompressionStream invece di zlib
// ─────────────────────────────────────────────────────────────────────────────

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function inflateBytes(compressed) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed);
      writer.close();
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.length; }
      return out;
    } catch {}
  }
  throw new Error('inflate fallito con tutti i formati');
}

async function decodeBitfield(encoded, lengthBits) {
  const compressed = base64ToUint8Array(encoded);
  const values = await inflateBytes(compressed);
  const bytesLen = Math.ceil(lengthBits / 8);
  const padded = new Uint8Array(Math.max(values.length, bytesLen));
  padded.set(values);
  return padded;
}

function bitfieldGet(arr, idx) {
  const index = Math.floor(idx / 8);
  const bit = idx % 8;
  if (index >= arr.length) return false;
  return ((arr[index] >> bit) & 1) !== 0;
}

async function constructWatchedBoolArray(watchedField, videoIds) {
  const anchorIdx = videoIds.indexOf(watchedField.anchorVideo);
  let base;
  try { base = await decodeBitfield(watchedField.bitfield, videoIds.length); } catch { return new Array(videoIds.length).fill(false); }

  if (anchorIdx === -1) return videoIds.map((_, i) => bitfieldGet(base, i));

  const offset = watchedField.anchorLength - anchorIdx - 1;
  if (offset === 0) return videoIds.map((_, i) => bitfieldGet(base, i));

  const result = new Array(videoIds.length).fill(false);
  for (let i = 0; i < videoIds.length; i++) {
    const prev = i + offset;
    if (prev >= 0 && prev < watchedField.anchorLength) result[i] = bitfieldGet(base, prev);
  }
  return result;
}

function parseWatchedField(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(':');
  if (parts.length < 3) return null;
  const bitfield = parts.pop();
  const anchorLengthRaw = parts.pop();
  const anchorLength = Number(anchorLengthRaw);
  if (!Number.isFinite(anchorLength)) return null;
  return { anchorVideo: parts.join(':'), anchorLength: Math.trunc(anchorLength), bitfield };
}

function normalizeVideo(raw) {
  const season = raw.season ?? raw.seriesInfo?.season ?? null;
  const episode = raw.episode ?? raw.seriesInfo?.episode ?? null;
  const releasedMs = raw.released ? Date.parse(String(raw.released)) : NaN;
  return {
    id: raw.id,
    season: Number.isFinite(Number(season)) ? Number(season) : null,
    episode: Number.isFinite(Number(episode)) ? Number(episode) : null,
    releasedMs: Number.isFinite(releasedMs) ? releasedMs : null,
    title: raw.title || '',
  };
}

function sortVideos(videos) {
  return videos.slice().sort((a, b) => {
    const [as, bs] = [a.season ?? -1, b.season ?? -1];
    if (as !== bs) return as - bs;
    const [ae, be] = [a.episode ?? -1, b.episode ?? -1];
    if (ae !== be) return ae - be;
    return (a.releasedMs ?? -1) - (b.releasedMs ?? -1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CINEMETA CON CACHE (riduce subrequests)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCinemetaVideos(id) {
  // Controlla cache
  if (cinemetaCache.has(id)) {
    console.log(`📦 Cache hit per ${id}`);
    return cinemetaCache.get(id);
  }
  
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(id)}.json`, {
      headers: { 'User-Agent': 'NuvioSync/1.0' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const videos = Array.isArray(data?.meta?.videos) ? data.meta.videos : null;
    
    // Salva in cache
    if (videos) cinemetaCache.set(id, videos);
    
    return videos;
  } catch { return null; }
}

async function mapSeriesVideos(seriesItems, concurrency = 2, maxSeries = 10) {
  const limited = seriesItems.slice(0, maxSeries);
  const queue = [...limited];
  const results = new Map();
  
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item?.id) continue;
      const videos = await fetchCinemetaVideos(item.id);
      if (Array.isArray(videos) && videos.length > 0) results.set(item.id, videos);
    }
  }
  
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

async function buildWatchedEpisodesPayload(items, concurrency = 2, maxSeries = 10) {
  const seriesItems = items.filter(i => i.type === 'series' && i.state.watchedField);
  if (seriesItems.length === 0) return [];
  
  console.log(`📺 Serie con watchedField: ${seriesItems.length}, ne processo massimo ${maxSeries}`);
  
  const videosMap = await mapSeriesVideos(seriesItems, concurrency, maxSeries);
  const payload = [];

  for (const item of seriesItems.slice(0, maxSeries)) {
    const rawVideos = videosMap.get(item.id);
    if (!rawVideos?.length) continue;
    const normalized = sortVideos(rawVideos.map(normalizeVideo)).filter(v => v.id);
    if (!normalized.length) continue;
    const watchedField = parseWatchedField(item.state.watchedField);
    if (!watchedField) continue;
    let flags;
    try { flags = await constructWatchedBoolArray(watchedField, normalized.map(v => v.id)); } catch { continue; }
    const watchedAt = toTimestamp(item.state.lastWatched || item.mtime || Date.now());
    const contentId = extractOriginalId(item);
    if (!contentId) continue;
    for (let i = 0; i < normalized.length; i++) {
      if (!flags[i]) continue;
      const v = normalized[i];
      if (v.season == null || v.episode == null) continue;
      payload.push({ contentId, contentType: 'series', title: item.name || contentId, season: v.season, episode: v.episode, watchedAt });
    }
  }
  
  if (seriesItems.length > maxSeries) {
    console.log(`⚠️ Saltate ${seriesItems.length - maxSeries} serie per rispettare limite subrequests`);
  }
  
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// STREMIO API
// ─────────────────────────────────────────────────────────────────────────────

const STREMIO_API = 'https://api.strem.io';
const STREMIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.159';

async function stremioLogin(email, password) {
  const r = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ email, password, facebook: false, type: 'login' }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Login fallito (${r.status}): ${text.substring(0, 300)}`);
  const data = JSON.parse(text);
  const authKey = data?.result?.authKey;
  if (!authKey) throw new Error('Login fallito: authKey non trovato');
  return { token: authKey };
}

async function getStremioLibrary(authKey, { includeAll = false } = {}) {
  const r = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ authKey, collection: 'libraryItem', all: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Stremio API errore ${r.status}: ${text.substring(0, 500)}`);

  const data = JSON.parse(text);
  let items = [];
  if (data.result) {
    if (Array.isArray(data.result)) items = data.result;
    else if (Array.isArray(data.result.rows)) items = data.result.rows.map(row => row.value).filter(Boolean);
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

  if (!includeAll) items = items.filter(i => !i.removed && !i.temp);
  return items;
}

async function getStremioContinueWatching(authKey) {
  try {
    const r = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
      body: JSON.stringify({ authKey, collection: 'continueWatching', all: true }),
    });
    const data = await r.json();
    return (data?.result?.rows || []).map(r => r.value).filter(Boolean);
  } catch { return []; }
}

async function getStremioWatchedHistory(authKey) {
  try {
    const r = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
      body: JSON.stringify({ authKey, collection: 'watched', all: true }),
    });
    const data = await r.json();
    return (data?.result?.rows || []).map(r => r.value).filter(Boolean);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUSH LIBRARY TO NUVIO — CON OTTIMIZZAZIONE (accetta library esistente)
// ─────────────────────────────────────────────────────────────────────────────

async function pushLibraryToNuvio(sb, accessToken, items, watchedContentIds = new Set(), existingLibrary = null) {
  let existingMap = new Map();
  
  if (existingLibrary) {
    existingMap = new Map(existingLibrary.map(i => [i.content_id, i]));
    console.log(`📦 Usata library esistente fornita (${existingLibrary.length} titoli)`);
  } else {
    try {
      const existing = await getNuvioLibrary(sb, accessToken);
      existingMap = new Map(existing.map(i => [i.content_id, i]));
      console.log(`📦 Recuperati ${existing.length} titoli esistenti su Nuvio`);
    } catch (err) {
      console.warn(`⚠️ Impossibile recuperare library esistente: ${err.message}`);
    }
  }

  const watchedSet = watchedContentIds instanceof Set ? watchedContentIds : new Set(watchedContentIds);
  const unique = new Map();

  for (const item of items) {
    const contentId = extractOriginalId(item);
    if (!contentId) continue;
    
    const norm = normalizeLibraryItem(item);
    const isWatched = watchedSet.has(contentId);
    const ex = existingMap.get(contentId);
    
    const lastWatchedTimestamp = isWatched 
      ? toTimestamp(norm.state.lastWatched || Date.now())
      : (ex?.last_watched || null);

    const timesWatched = isWatched 
      ? Math.max(1, ex?.times_watched || 0, norm.state.timesWatched || 1)
      : (ex?.times_watched || 0);
      
    const flaggedWatched = isWatched 
      ? Math.max(1, ex?.flagged_watched || 0, norm.state.flaggedWatched || 1)
      : (ex?.flagged_watched || 0);

    const libraryItem = {
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
      added_at: Date.now(),
      times_watched: timesWatched,
      flagged_watched: flaggedWatched,
      last_watched: lastWatchedTimestamp,
      state: {
        timesWatched: timesWatched,
        flaggedWatched: flaggedWatched,
        lastWatched: lastWatchedTimestamp,
        timeOffset: norm.state.timeOffset || 0,
        duration: norm.state.duration || 0,
        videoId: norm.state.videoId || null,
      }
    };

    if (ex) {
      libraryItem.poster = libraryItem.poster || ex.poster;
      libraryItem.background = libraryItem.background || ex.background;
      libraryItem.description = libraryItem.description || ex.description;
    }

    unique.set(contentId, libraryItem);
  }

  const libraryItems = Array.from(unique.values());
  const watchedInLibrary = libraryItems.filter(i => i.times_watched > 0 || i.flagged_watched > 0).length;
  console.log(`📦 Push ${libraryItems.length} items (${watchedInLibrary} con badge watched)`);

  if (libraryItems.length > 0) {
    await sb.rpc('sync_push_library', { p_items: libraryItems }, accessToken);
    console.log(`✅ Push library completato!`);
  }
  return { count: libraryItems.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUSH WATCHED CON FALLBACK OTTIMIZZATO
// ─────────────────────────────────────────────────────────────────────────────

async function pushWatchedWithFallback(sb, accessToken, identity, payload) {
  if (!payload?.length) return { success: false, reason: 'payload vuoto' };

  // Prova SOLO con profileId (riduce subrequests)
  try {
    await sb.rpc('sync_push_watched_items', { p_profile_id: identity.profileId, p_items: payload }, accessToken);
    return { success: true, usedId: identity.profileId };
  } catch (err) {
    // Se fallisce, prova con 1
    try {
      await sb.rpc('sync_push_watched_items', { p_profile_id: 1, p_items: payload }, accessToken);
      return { success: true, usedId: 1 };
    } catch (err2) {
      return { success: false, reason: 'push fallito con tutti i tentativi' };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: DEBUG ITEM (VERIFICA SINGOLO ITEM SU NUVIO)
// ─────────────────────────────────────────────────────────────────────────────
async function handleDebugItem(request, env, body) {
  const { nuvioEmail, nuvioPassword, contentId } = body;
  if (!nuvioEmail || !nuvioPassword || !contentId) {
    return jsonErr('Email, password e contentId richiesti', 400);
  }

  try {
    const sb = makeSupabase(env);
    const session = await sb.login(nuvioEmail, nuvioPassword);
    const token = session.access_token;
    
    const library = await getNuvioLibrary(sb, token);
    const item = library.find(i => i.content_id === contentId);
    
    const identity = await resolveNuvioIdentity(sb, token);
    const watched = await getNuvioWatchedItems(sb, token, identity.profileId || 1);
    const watchedItem = watched.find(w => w.content_id === contentId);
    
    return jsonOk({
      success: true,
      contentId,
      inLibrary: !!item,
      libraryItem: item,
      inWatched: !!watchedItem,
      watchedItem: watchedItem
    });
  } catch (err) {
    return jsonOk({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPALE — routing manuale (no Express)
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Pagine HTML ──────────────────────────────────────────────────────────
    if (method === 'GET' && (path === '/' || path === '/configure')) {
      return htmlOk(HTML);
    }

    // ── Health ───────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/health') {
      return jsonOk({ status: 'ok' });
    }

    // ── Supabase status ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/supabase-status') {
      const sb = makeSupabase(env);
      return jsonOk({ configured: sb.isConfigured(), message: sb.isConfigured() ? '✅ Supabase pronto' : '⚠️ Supabase non configurato' });
    }

    // ── Backups (Workers non ha disco) ───────────────────────────────────────
    if (method === 'GET' && path === '/backups') {
      return jsonOk({ backups: [], note: 'Backup su disco non disponibili in Workers. Usa /sync per fare un backup manuale.' });
    }

    // ── TMDB Poster proxy ────────────────────────────────────────────────────
    if (method === 'GET' && path === '/tmdb-poster') {
      const apiKey = env.TMDB_API_KEY;
      if (!apiKey) return new Response(null, { status: 204 });
      const title = url.searchParams.get('title');
      const year = url.searchParams.get('year') || '';
      const type = url.searchParams.get('type');
      if (!title) return jsonErr('title required', 400);
      try {
        const isMovie = type === 'movie';
        const endpoint = isMovie
          ? `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year}&language=it-IT`
          : `https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=it-IT`;
        const r = await fetch(endpoint);
        const data = await r.json();
        const posterPath = data.results?.[0]?.poster_path || null;
        const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w185${posterPath}` : null;
        return new Response(JSON.stringify({ url: posterUrl }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', ...CORS },
        });
      } catch (err) {
        return jsonOk({ url: null });
      }
    }

    // ── POST routes ──────────────────────────────────────────────────────────
    if (method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    const body = await parseBody(request);
    const sb = makeSupabase(env);

    // ── Test login Stremio ───────────────────────────────────────────────────
    if (path === '/test-stremio-login') {
      try {
        await stremioLogin(body.email, body.password);
        return jsonOk({ success: true, message: '✅ Login Stremio funzionante!' });
      } catch (err) {
        return jsonOk({ success: false, message: `❌ ${err.message}` });
      }
    }

    // ── Ottieni dati Stremio ─────────────────────────────────────────────────
    if (path === '/get-stremio-data') {
      try {
        const auth = await stremioLogin(body.email, body.password);
        const [libFiltered, libAll, cw] = await Promise.all([
          getStremioLibrary(auth.token, { includeAll: false }),
          getStremioLibrary(auth.token, { includeAll: true }),
          getStremioContinueWatching(auth.token),
        ]);
        const normalizedAll = libAll.map(normalizeLibraryItem);
        const watchedMoviesRaw = buildWatchedMoviesPayload(normalizedAll);
        const watchedMovieIds = watchedMoviesRaw.map(w => w.contentId).filter(Boolean);
        const seriesWithWatched = normalizedAll.filter(i => i.type === 'series' && i.state.watchedField);
        return jsonOk({
          success: true,
          library: libFiltered,
          continueWatching: cw,
          watchedIds: watchedMovieIds,
          stats: {
            movies: libFiltered.filter(i => i.type === 'movie').length,
            series: libFiltered.filter(i => i.type === 'series').length,
            continueWatching: cw.length,
            watched: watchedMovieIds.length,
            watchedSeriesCount: seriesWithWatched.length,
          },
        });
      } catch (err) {
        return jsonOk({ success: false, error: err.message });
      }
    }

    // ── Test login Nuvio ─────────────────────────────────────────────────────
    if (path === '/test-login') {
      if (!body.email || !body.password) return jsonOk({ success: false, message: '❌ Inserisci email e password' });
      if (!sb.isConfigured()) return jsonOk({ success: false, message: '❌ Supabase non configurato sul server' });
      try {
        await sb.login(body.email, body.password);
        return jsonOk({ success: true, message: '✅ Login Nuvio riuscito!' });
      } catch (err) {
        return jsonOk({ success: false, message: `❌ ${err.message}` });
      }
    }

    // ── Ottieni dati Nuvio ───────────────────────────────────────────────────
    if (path === '/get-nuvio-data') {
      if (!body.email || !body.password) return jsonOk({ success: false, error: 'Email e password richieste' });
      try {
        const session = await sb.login(body.email, body.password);
        const token = session.access_token;
        const identity = await resolveNuvioIdentity(sb, token);
        const library = await getNuvioLibrary(sb, token);
        const watched = await getNuvioWatchedItems(sb, token, identity.profileId || 1);
        const watchedIds = watched.map(w => w.content_id).filter(Boolean);
        return jsonOk({
          success: true,
          library,
          watchedIds,
          stats: {
            total: library.length,
            movies: library.filter(i => i.content_type === 'movie').length,
            series: library.filter(i => i.content_type === 'series').length,
            watched: watchedIds.length,
          },
        });
      } catch (err) {
        return jsonOk({ success: false, error: err.message });
      }
    }

    // ── SYNC DIRETTO ─────────────────────────────────────────────────────────
    if (path === '/sync') {
      const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, includeWatchedEpisodes = false } = body;
      if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
        return jsonErr('Tutte le credenziali sono richieste', 400);
      }
      try {
        console.log('🚀 Avvio sync diretto...');
        
        const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
        const [rawAll, rawFiltered] = await Promise.all([
          getStremioLibrary(stremioAuth.token, { includeAll: true }),
          getStremioLibrary(stremioAuth.token, { includeAll: false }),
        ]);
        if (!rawFiltered?.length) throw new Error('La tua libreria Stremio è vuota');
        const items = rawAll.map(normalizeLibraryItem);
        console.log(`📊 Library Stremio: ${rawFiltered.length} attivi / ${rawAll.length} totali`);

        const watchedMoviesRaw = buildWatchedMoviesPayload(items);
        console.log(`🎬 Film visti: ${watchedMoviesRaw.length}`);
        
        let watchedEpisodesRaw = [];
        if (includeWatchedEpisodes) {
          console.log(`📺 Recupero episodi visti da Cinemeta (max 10 serie)...`);
          watchedEpisodesRaw = await buildWatchedEpisodesPayload(items, 2, 10); // concurrency=2, maxSeries=10
          console.log(`📺 Episodi visti: ${watchedEpisodesRaw.length}`);
        }

        const allWatched = [...watchedMoviesRaw, ...watchedEpisodesRaw]
          .map(normalizeWatchedItem).filter(Boolean);
        console.log(`✅ Estratti: ${allWatched.filter(i => i.contentType === 'movie').length} film + ${allWatched.filter(i => i.contentType === 'series').length} episodi`);

        const progressPayload = buildWatchProgressPayload(items);
        console.log(`⏩ Watch progress: ${progressPayload.length} elementi`);

        const nuvioSession = await sb.login(nuvioEmail, nuvioPassword);
        const accessToken = nuvioSession.access_token;
        const identity = await resolveNuvioIdentity(sb, accessToken);
        console.log(`👤 Identità Nuvio: UUID=${identity.userId}, ProfileID=${identity.profileId}`);

        const [currentLib, currentWatchedRaw] = await Promise.all([
          getNuvioLibrary(sb, accessToken),
          getNuvioWatchedItems(sb, accessToken, identity.profileId || 1),
        ]);
        console.log(`📦 Nuvio attuale: ${currentLib.length} titoli, ${currentWatchedRaw.length} visti`);

        // Push library - PASSA currentLib per evitare una chiamata extra
        const watchedIdSet = new Set(allWatched.map(i => i.contentId).filter(Boolean));
        console.log(`📤 Push library (${rawFiltered.length} items, ${watchedIdSet.size} con badge watched)...`);
        const { count: pushedCount } = await pushLibraryToNuvio(sb, accessToken, rawFiltered, watchedIdSet, currentLib);

        // Pausa per evitare race condition
        await new Promise(resolve => setTimeout(resolve, 500));

        // Push progress
        let progressWarning = null;
        if (progressPayload.length > 0) {
          try {
            await sb.rpc('sync_push_watch_progress', { p_entries: progressPayload }, accessToken);
            console.log(`✅ Watch progress pushato: ${progressPayload.length} voci`);
          } catch (err) { 
            console.error('❌ Errore push watch progress:', err.message);
            progressWarning = err.message; 
          }
        }

        // Push watched
        let watchedResult = { success: false, usedId: null };
        let totalWatchedPushed = 0;
        if (allWatched.length > 0) {
          const remote = currentWatchedRaw.map(mapRemoteWatchedItem).filter(Boolean);
          const merged = mergeWatchedItems(remote, allWatched);
          const payload = dedupeWatchedItems(merged).map(toRemotePayloadItem).filter(Boolean);
          if (payload.length > 0) {
            console.log(`📤 Push ${payload.length} watched items...`);
            watchedResult = await pushWatchedWithFallback(sb, accessToken, identity, payload);
            if (watchedResult.success) {
              totalWatchedPushed = payload.length;
              console.log(`✅ Watched pushati con ID: ${watchedResult.usedId}`);
            }
          }
        }

        const checkId = watchedResult.usedId || identity.profileId || 1;
        const [newLib, newWatched] = await Promise.all([
          getNuvioLibrary(sb, accessToken),
          getNuvioWatchedItems(sb, accessToken, checkId),
        ]);
        const newCount = newLib.length;

        const serieConEpisodi = items.filter(i => i.type === 'series' && i.state.watchedField).length;
        const warnings = [
          watchedResult.success ? null : `Push watched fallito: ${watchedResult.reason}`,
          progressWarning,
        ].filter(Boolean);

        console.log(`✅ SYNC COMPLETO! ${newCount} titoli, ${totalWatchedPushed} visti.`);

        return jsonOk({
          success: true,
          stats: {
            stremio: rawAll.length,
            pushedLibrary: pushedCount,
            watchedFilm: allWatched.filter(i => i.contentType === 'movie').length,
            watchedEpisodi: allWatched.filter(i => i.contentType === 'series').length,
            watchProgress: progressPayload.length,
            serieConEpisodi,
            nuvioPrima: currentLib.length,
            nuvioDopo: newCount,
            nuvioWatchedDopo: newWatched.length,
            totaleVisti: allWatched.length,
          },
          message: warnings.length > 0
            ? `✅ Library OK. ⚠️ Problemi: ${warnings[0]}`
            : `✅ SYNC COMPLETO! ${newCount} titoli, ${totalWatchedPushed} visti.`,
        });
      } catch (err) {
        console.error('❌ Errore sync:', err);
        return jsonErr(err.message);
      }
    }

    // ── Quick sync badge ──────────────────────────────────────────────────────
    if (path === '/quick-sync-badge') {
      const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = body;
      if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
        return jsonErr('Tutte le credenziali sono richieste', 400);
      }
      const log = [];
      const L = msg => { console.log(msg); log.push(msg); };
      try {
        L('🔐 Login Stremio...');
        const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
        const lib = await getStremioLibrary(stremioAuth.token, { includeAll: true });
        const items = lib.map(normalizeLibraryItem);
        const watchedMovies = buildWatchedMoviesPayload(items);
        const watchedEpisodes = await buildWatchedEpisodesPayload(items, 2, 10);
        const allWatched = [...watchedMovies, ...watchedEpisodes].map(normalizeWatchedItem).filter(Boolean);
        L(`✅ Stremio: ${lib.length} titoli, ${allWatched.length} visti`);

        L('🔐 Login Nuvio...');
        const nuvioSession = await sb.login(nuvioEmail, nuvioPassword);
        const accessToken = nuvioSession.access_token;
        const identity = await resolveNuvioIdentity(sb, accessToken);
        L(`👤 UUID=${identity.userId}, ProfileID=${identity.profileId}`);

        const watchedIds = new Set(allWatched.map(w => w.contentId).filter(Boolean));
        const currentLib = await getNuvioLibrary(sb, accessToken);
        const { count } = await pushLibraryToNuvio(sb, accessToken, lib.filter(i => !i.removed), watchedIds, currentLib);
        L(`✅ Library pushata: ${count} titoli (${watchedIds.size} con badge)`);

        await new Promise(resolve => setTimeout(resolve, 800));

        const payload = allWatched.map(toRemotePayloadItem).filter(Boolean);
        const result = await pushWatchedWithFallback(sb, accessToken, identity, payload);
        if (!result.success) { L(`❌ Push watched fallito: ${result.reason}`); return jsonOk({ success: false, log, error: result.reason }); }
        L(`✅ Watched pushati con ID: ${result.usedId}`);

        const finalWatched = await getNuvioWatchedItems(sb, accessToken, result.usedId);
        const successCount = allWatched.filter(w => finalWatched.some(f => f.content_id === w.contentId)).length;
        L(`📊 Badge: ${successCount}/${allWatched.length} sincronizzati`);

        return jsonOk({
          success: true, log,
          stats: { stremioTotal: lib.length, stremioWatched: allWatched.length, nuvioWatched: finalWatched.length, successCount },
          message: `✅ ${successCount}/${allWatched.length} badge sincronizzati.`,
        });
      } catch (err) {
        L(`💥 ERRORE: ${err.message}`);
        return jsonOk({ success: false, log, error: err.message });
      }
    }

    // ── Debug watched ─────────────────────────────────────────────────────────
    if (path === '/debug-watched') {
      const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = body;
      const log = [];
      const L = msg => { console.log(msg); log.push(msg); };
      try {
        L('🔐 Login Stremio...');
        const auth = await stremioLogin(stremioEmail, stremioPassword);
        const items = (await getStremioLibrary(auth.token)).map(normalizeLibraryItem);
        const watched = buildWatchedMoviesPayload(items);
        L(`✅ ${items.length} totali, ${watched.length} film visti`);
        if (watched.length > 0) L(`   Esempio: ${JSON.stringify(toRemotePayloadItem(normalizeWatchedItem(watched[0])))}`);

        L('🔐 Login Nuvio...');
        const session = await sb.login(nuvioEmail, nuvioPassword);
        const token = session.access_token;
        const identity = await resolveNuvioIdentity(sb, token);
        L(`👤 UUID=${identity.userId}, ProfileID=${identity.profileId}`);

        const existing = await getNuvioWatchedItems(sb, token, identity.profileId || 1);
        L(`📖 Watched attuali su Nuvio: ${existing.length} items`);

        if (watched.length > 0) {
          const testPayload = [toRemotePayloadItem(normalizeWatchedItem(watched[0]))].filter(Boolean);
          L('🧪 Test push 1 item...');
          const r = await pushWatchedWithFallback(sb, token, identity, testPayload);
          L(r.success ? `✅ Push OK con ID: ${r.usedId}` : `❌ Push fallito: ${r.reason}`);
        }

        return jsonOk({ success: true, log });
      } catch (err) {
        log.push(`💥 ERRORE: ${err.message}`);
        return jsonOk({ success: false, log, error: err.message });
      }
    }

    // ── Debug sync ────────────────────────────────────────────────────────────
    if (path === '/debug-sync') {
      const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = body;
      try {
        const auth = await stremioLogin(stremioEmail, stremioPassword);
        const stremioItems = await getStremioLibrary(auth.token);
        const session = await sb.login(nuvioEmail, nuvioPassword);
        const nuvioLib = await getNuvioLibrary(sb, session.access_token);
        const nuvioIds = new Set(nuvioLib.map(i => i.content_id));
        const missing = stremioItems
          .map(i => ({ id: i._id || i.id, name: i.name, type: i.type }))
          .filter(i => i.id && !nuvioIds.has(i.id));
        return jsonOk({
          success: true,
          stats: { stremio: stremioItems.length, nuvio: nuvioLib.length, missing: missing.length },
          missing: missing.slice(0, 20),
        });
      } catch (err) {
        return jsonOk({ success: false, error: err.message });
      }
    }

    // ── Compare libraries ─────────────────────────────────────────────────────
    if (path === '/compare-libraries') {
      const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = body;
      const log = [];
      const L = msg => { console.log(msg); log.push(msg); };
      try {
        const auth = await stremioLogin(stremioEmail, stremioPassword);
        const sItems = await getStremioLibrary(auth.token, { includeAll: false });
        const sIds = new Set(sItems.map(i => i._id || i.id).filter(Boolean));
        L(`📊 Stremio: ${sItems.length} item, ${sIds.size} ID unici`);

        const session = await sb.login(nuvioEmail, nuvioPassword);
        const nLib = await getNuvioLibrary(sb, session.access_token);
        const nIds = new Set(nLib.map(i => i.content_id));
        L(`📊 Nuvio: ${nLib.length} item, ${nIds.size} ID unici`);

        const missingInNuvio = [...sIds].filter(id => !nIds.has(id));
        const extraInNuvio = [...nIds].filter(id => !sIds.has(id));
        L(`🔍 In Stremio non Nuvio: ${missingInNuvio.length}`);
        L(`🔍 In Nuvio non Stremio: ${extraInNuvio.length}`);
        if (missingInNuvio.length > 0) L(`   Esempi: ${missingInNuvio.slice(0, 5).join(', ')}`);

        return jsonOk({ success: true, log, stats: { stremio: sIds.size, nuvio: nIds.size, missingInNuvio: missingInNuvio.length, extraInNuvio: extraInNuvio.length } });
      } catch (err) {
        log.push(`💥 ERRORE: ${err.message}`);
        return jsonOk({ success: false, log, error: err.message });
      }
    }

    // ── Check nuvio watched ───────────────────────────────────────────────────
    if (path === '/check-nuvio-watched') {
      const { nuvioEmail, nuvioPassword, contentId } = body;
      try {
        const session = await sb.login(nuvioEmail, nuvioPassword);
        const token = session.access_token;
        const identity = await resolveNuvioIdentity(sb, token);
        const watched = await getNuvioWatchedItems(sb, token, identity.profileId || 1);
        return jsonOk({
          success: true,
          total: watched.length,
          movies: watched.filter(w => w.content_type === 'movie').length,
          episodes: watched.filter(w => w.season != null && w.episode != null).length,
          sample: watched.slice(0, 10),
          specificContent: contentId ? watched.filter(w => w.content_id === contentId || w.content_id?.includes(contentId)) : null,
        });
      } catch (err) {
        return jsonOk({ success: false, error: err.message });
      }
    }

    // ── Debug episodi ─────────────────────────────────────────────────────────
    if (path === '/debug-episodes-full') {
      const { stremioEmail, stremioPassword } = body;
      const log = [];
      const L = msg => { console.log(msg); log.push(msg); };
      try {
        const auth = await stremioLogin(stremioEmail, stremioPassword);
        const raw = await getStremioLibrary(auth.token, { includeAll: true });
        const items = raw.map(normalizeLibraryItem);
        const seriesWithWatched = items.filter(i => i.type === 'series' && i.state.watchedField);
        L(`📺 Serie con watchedField: ${seriesWithWatched.length}`);

        for (const serie of seriesWithWatched.slice(0, 5)) {
          L(`\n--- ${serie.name} (${serie.id}) ---`);
          try {
            const videos = await fetchCinemetaVideos(serie.id);
            if (!videos?.length) { L('   ❌ Nessun video Cinemeta'); continue; }
            const norm = sortVideos(videos.map(normalizeVideo)).filter(v => v.id);
            const wf = parseWatchedField(serie.state.watchedField);
            if (!wf) { L('   ❌ watchedField non parsabile'); continue; }
            const flags = await constructWatchedBoolArray(wf, norm.map(v => v.id));
            const count = flags.filter(Boolean).length;
            L(`   ✅ ${count}/${norm.length} episodi visti`);
          } catch (e) { L(`   ❌ ${e.message}`); }
        }

        const watchedMovies = buildWatchedMoviesPayload(items);
        L(`🎬 Film visti: ${watchedMovies.length}`);
        return jsonOk({ success: true, log, stats: { totalItems: items.length, seriesWithWatched: seriesWithWatched.length, watchedMovies: watchedMovies.length } });
      } catch (err) {
        log.push(`💥 ${err.message}`);
        return jsonOk({ success: false, log, error: err.message });
      }
    }

    // ── Debug item (VERIFICA SINGOLO ITEM) ───────────────────────────────────
    if (path === '/debug-item') {
      return handleDebugItem(request, env, body);
    }

    // ── Restore (stub) ───────────────────────────────────────────────────────
    if (path === '/restore') {
      return jsonOk({ success: false, error: 'Il restore da file non è disponibile in Cloudflare Workers (nessun disco). Usa /sync per re-sincronizzare.' });
    }

    return new Response('Not found', { status: 404 });
  },
};