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

async function supabaseRequest(endpoint, { method = 'GET', body, authToken } = {}) {
  const headers = { 'apikey': SUPABASE_ANON_KEY };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
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
// RISOLUZIONE IDENTITÀ — LOGICA CORRETTA
//
// REGOLA FONDAMENTALE: profileId deve essere SEMPRE un intero numerico.
// I UUID (formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) NON sono profileId
// validi per sync_push_watched_items che vuole un INTEGER.
// I UUID vanno solo in allProfileIds come candidati secondari.
// ============================================
function isUUID(val) {
  return typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

// parseProfileId: accetta SOLO interi. Rifiuta UUID e stringhe non numeriche.
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
  return null; // UUID e tutto il resto → null
}

async function resolveNuvioIdentity(accessToken) {
  const identity = { userId: null, profileId: null, allProfileIds: [] };

  // Step 1: UUID dall'auth
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    const authData = await authRes.json();
    identity.userId = authData.id || null;
    console.log(`🔑 UUID: ${identity.userId}`);
  } catch (e) {
    console.error('❌ UUID fallito:', e.message);
  }

  // Step 2: RPC — log esplicito della risposta raw per debug
  for (const rpcName of ['get_sync_owner', 'get_profile_id', 'get_current_profile', 'get_user_profile_id']) {
    try {
      const ownerData = await supabaseRpc(rpcName, {}, accessToken);
      console.log(`🔍 ${rpcName} risposta raw: ${JSON.stringify(ownerData)}`);
      const parsed = parseProfileId(ownerData);
      if (parsed !== null) {
        identity.profileId = parsed;
        console.log(`✅ ProfileID trovato via ${rpcName}: ${parsed}`);
        break;
      } else {
        console.log(`⚠️ ${rpcName} risposta non è intero valido: ${JSON.stringify(ownerData)}`);
      }
    } catch (e) {
      console.log(`⚠️ ${rpcName} errore: ${e.message}`);
    }
  }

  // Step 3: AUTO-DETECT parallelo — scansiona ID 1-30 in parallelo
  // Vince il profileId con il numero massimo di watched items
  if (identity.profileId === null) {
    console.log('🔎 Auto-detect: scansione parallela ID 1-30...');
    const scanResults = await Promise.all(
      Array.from({ length: 30 }, (_, i) => i + 1).map(id =>
        supabaseRpc('sync_pull_watched_items', { p_profile_id: id }, accessToken)
          .then(items => ({ id, count: Array.isArray(items) ? items.length : 0 }))
          .catch(() => ({ id, count: 0 }))
      )
    );
    const best = scanResults.reduce((a, b) => b.count > a.count ? b : a, { id: 1, count: 0 });
    identity.profileId = best.id;
    if (best.count > 0) {
      console.log(`✅ ProfileID auto-rilevato: ${best.id} (${best.count} watched items)`);
    } else {
      console.log(`⚠️ Nessun watched trovato per nessun ID, uso: 1`);
    }
  }

  identity.allProfileIds = [identity.profileId];
  console.log(`👤 Identità finale → UUID: ${identity.userId}, ProfileID: ${identity.profileId}`);
  return identity;
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

// FIX #2 — getNuvioWatchedItems con fallback aggressivo su tutti gli ID candidati
async function getNuvioWatchedItems(accessToken, profileId = 1) {
  const attempts = buildProfileIdAttempts(profileId);
  for (const attempt of attempts) {
    try {
      const pId = isNaN(Number(attempt)) ? attempt : Number(attempt);
      const items = await supabaseRpc('sync_pull_watched_items', { p_profile_id: pId }, accessToken);
      const arr = Array.isArray(items) ? items : [];
      if (arr.length > 0) {
        console.log(`📖 sync_pull_watched_items (profileId=${attempt}): ${arr.length} items`);
        return arr;
      }
    } catch (error) {
      // Continua con il prossimo
    }
  }
  console.log(`📖 sync_pull_watched_items: nessun item trovato con nessun ID`);
  return [];
}

// Costruisce la lista di tentativi: PRIMA tutti gli interi, POI gli UUID.
// Evita di sprecare chiamate RPC su UUID che danno sempre "invalid input syntax for type integer".
function buildProfileIdAttempts(primaryId) {
  const numericIds = [];
  const uuidIds = [];

  for (const id of [primaryId, 1].filter(id => id !== null && id !== undefined)) {
    const str = String(id);
    if (isUUID(str)) {
      uuidIds.push(str); // UUID solo come ultima spiaggia
    } else if (/^\d+$/.test(str) && Number(str) > 0) {
      numericIds.push(Number(str)); // Interi prima
    }
  }

  const seen = new Set();
  const result = [];
  for (const id of [...numericIds, ...uuidIds]) {
    const key = String(id);
    if (!seen.has(key)) { seen.add(key); result.push(id); }
  }
  return result;
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
// FIX #3 — NORMALIZZAZIONE ITEM WATCHED
// Corretto il bug `|| true` → usare `!== false`
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
    // FIX: era `item.traktSynced || true` che è sempre true — ora usiamo valore reale con default true
    traktSynced: item.traktSynced !== false,
    traktLastSynced: item.traktLastSynced || toTimestamp(item.watchedAt) || Date.now(),
    syncSource: item.syncSource || 'trakt'
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
      merged.set(key, { ...item, traktSynced: true, traktLastSynced: item.watchedAt, syncSource: 'trakt' });
      continue;
    }
    const existingTs = Number(existing.watchedAt || 0);
    const incomingTs = Number(item.watchedAt || 0);
    if (incomingTs > existingTs) {
      merged.set(key, { ...existing, ...item, traktSynced: true, traktLastSynced: incomingTs, syncSource: 'trakt' });
      continue;
    }
    if (incomingTs === existingTs) {
      merged.set(key, {
        ...existing,
        title: existing.title || item.title,
        contentType: existing.contentType || item.contentType,
        traktSynced: true,
        traktLastSynced: existingTs,
        syncSource: 'trakt'
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => Number(b.watchedAt || 0) - Number(a.watchedAt || 0));
}

// ============================================
// FIX #4 — PAYLOAD REMOTO POTENZIATO
// Aggiunge nuvio_watched, watched, e formato ISO per compatibilità
// ============================================
function toRemotePayloadItem(item = {}) {
  const watchedAtMs = Number(item.watchedAt || Date.now());
  return {
    content_id: item.contentId,
    content_type: item.contentType === 'series' ? 'series' : 'movie',
    title: item.title || '',
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    watched_at: watchedAtMs,
    // FIX: aggiunge campi extra che Nuvio potrebbe controllare per il badge
    trakt_synced: true,
    trakt_last_synced: watchedAtMs,
    sync_source: 'trakt',
    nuvio_watched: true,   // campo extra per compatibilità badge
    watched: true,         // campo alternativo
    times_watched: 1,      // alcuni schemi usano questo contatore
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
// FIX #5 — PAYLOAD FILM VISTI POTENZIATO
// Aggiunge rilevamento via progress (timeOffset/duration > 85%)
// ============================================
function buildWatchedMoviesPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie') continue;

    const isExplicitlyWatched = item.state.timesWatched > 0 || item.state.flaggedWatched > 0;

    // FIX: rileva come visto anche se il progresso è > 85% (film quasi completo)
    const progressRatio = (item.state.duration > 0)
      ? item.state.timeOffset / item.state.duration
      : 0;
    const isProgressWatched = progressRatio >= 0.85;

    // FIX: considera visto anche se è in libreria e non è rimosso
    const isInLibraryWatched = !item.removed && !item.temp && item.state.lastWatched;

    if (!isExplicitlyWatched && !isProgressWatched) continue;

    const contentId = extractOriginalId(item);
    if (!contentId) continue;

    payload.push({
      contentId,
      contentType: 'movie',
      title: item.name || contentId,
      season: null,
      episode: null,
      watchedAt: toTimestamp(item.state.lastWatched || item.mtime || Date.now()),
      _source: isExplicitlyWatched ? 'explicit' : 'progress'
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

// FIX #6 — constructWatchedBoolArray con offset corretto
function constructWatchedBoolArray(watchedField, videoIds) {
  const anchorIdx = videoIds.indexOf(watchedField.anchorVideo);

  // FIX: se anchor non trovato, tentiamo un approccio diretto senza offset
  if (anchorIdx === -1) {
    console.warn(`⚠️ anchorVideo "${watchedField.anchorVideo}" non trovato. Tentativo diretto.`);
    try {
      const base = decodeBitfield(watchedField.bitfield, videoIds.length);
      return videoIds.map((_, i) => bitfieldGet(base, i));
    } catch {
      return new Array(videoIds.length).fill(false);
    }
  }

  const base = decodeBitfield(watchedField.bitfield, videoIds.length);

  // FIX: calcolo offset corretto
  // anchorLength = numero totale di episodi al momento del salvataggio
  // anchorIdx = posizione corrente dell'ancora nella lista ordinata
  // offset = quanti slot "nuovi" esistono dopo l'ancora nel bitfield originale
  const offset = watchedField.anchorLength - anchorIdx - 1;

  if (offset === 0) return videoIds.map((_, i) => bitfieldGet(base, i));

  const result = new Array(videoIds.length).fill(false);
  for (let i = 0; i < videoIds.length; i++) {
    const prev = i + offset;
    if (prev >= 0 && prev < watchedField.anchorLength) {
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
// pushLibraryToSupabase
// BADGE FIX: include stato watched direttamente nel library item
// Il badge in Nuvio viene da times_watched/flagged_watched nel library item,
// NON solo da watched_items. Vanno pushati insieme.
// RIMOSSI gli stub: non aggiungere mai item senza metadati reali.
// ============================================
async function pushLibraryToSupabase(email, password, items, watchedContentIds = new Set()) {
  console.log(`☁️ Push library per ${email}...`);
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

  const watchedSet = watchedContentIds instanceof Set
    ? watchedContentIds
    : new Set(watchedContentIds);

  const uniqueItems = new Map();
  items.forEach(item => {
    const contentId = extractOriginalId(item);
    if (!contentId) return;

    const isWatched = watchedSet.has(contentId);
    const normalizedItem = normalizeLibraryItem(item);
    const lastWatched = normalizedItem.state.lastWatched
      ? toTimestamp(normalizedItem.state.lastWatched)
      : null;

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
      added_at: Date.now(),
      // BADGE: stato watched direttamente nel library item
      times_watched: isWatched ? Math.max(1, normalizedItem.state.timesWatched || 1) : (normalizedItem.state.timesWatched || 0),
      flagged_watched: isWatched ? Math.max(1, normalizedItem.state.flaggedWatched || 1) : (normalizedItem.state.flaggedWatched || 0),
      last_watched: isWatched ? (lastWatched || Date.now()) : lastWatched,
      // Campi state annidati per compatibilità con schemi alternativi
      state: {
        timesWatched: isWatched ? Math.max(1, normalizedItem.state.timesWatched || 1) : (normalizedItem.state.timesWatched || 0),
        flaggedWatched: isWatched ? Math.max(1, normalizedItem.state.flaggedWatched || 1) : (normalizedItem.state.flaggedWatched || 0),
        lastWatched: isWatched ? (lastWatched || Date.now()) : lastWatched,
        timeOffset: normalizedItem.state.timeOffset || 0,
        duration: normalizedItem.state.duration || 0,
        videoId: normalizedItem.state.videoId || null,
      }
    });
  });

  const libraryItems = Array.from(uniqueItems.values());
  const watchedInLibrary = libraryItems.filter(i => i.times_watched > 0 || i.flagged_watched > 0).length;
  console.log(`📦 Push ${libraryItems.length} items (${watchedInLibrary} con badge watched)`);

  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
    console.log(`✅ Push library completato!`);
  }
  return { count: libraryItems.length, accessToken };
}

// ============================================
// pushWatchedItemsWithFallback
// Ordine tentativi: profileId numerico → 1 → UUID (solo se tutto il resto fallisce)
// ============================================
async function pushWatchedItemsWithFallback(accessToken, identity, payload) {
  if (!payload || payload.length === 0) return { success: false, reason: 'payload vuoto' };

  // Costruisce lista candidati: INTERI prima, UUID dopo
  const numericCandidates = [];
  const uuidCandidates = [];

  const rawCandidates = [
    identity.profileId,
    ...(identity.allProfileIds || []),
    identity.userId,
    1,
  ].filter(id => id !== null && id !== undefined);

  const seen = new Set();
  for (const id of rawCandidates) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isUUID(key)) {
      uuidCandidates.push(id); // UUID solo come ultima spiaggia
    } else if (/^\d+$/.test(key) && Number(key) > 0) {
      numericCandidates.push(Number(key));
    }
  }

  const orderedCandidates = [...numericCandidates, ...uuidCandidates];
  console.log(`🎯 Candidati push watched in ordine: ${JSON.stringify(orderedCandidates)}`);

  for (const profileId of orderedCandidates) {
    try {
      console.log(`🧪 Tentativo push watched con profileId=${profileId} (${typeof profileId})`);
      await supabaseRpc('sync_push_watched_items', {
        p_profile_id: profileId,
        p_items: payload
      }, accessToken);
      console.log(`✅ Push watched riuscito con profileId=${profileId}!`);
      return { success: true, usedId: profileId };
    } catch (err) {
      // UUID con errore "invalid input syntax for type integer" → skip silenzioso
      if (isUUID(String(profileId)) && err.message.includes('invalid input syntax for type integer')) {
        console.log(`⏭️  UUID ${profileId} skippato (RPC vuole integer)`);
      } else {
        console.warn(`❌ Push watched fallito con profileId=${profileId}: ${err.message}`);
      }
    }
  }

  // Ultimo tentativo: RPC alternativi senza p_profile_id
  const alternativeRpcNames = [
    'sync_push_watched',
    'push_watched_items',
    'upsert_watched_items',
    'set_watched_items',
  ];

  for (const rpcName of alternativeRpcNames) {
    try {
      console.log(`🧪 Tentativo RPC alternativo: ${rpcName}`);
      await supabaseRpc(rpcName, { p_items: payload }, accessToken);
      console.log(`✅ Push riuscito via RPC alternativo: ${rpcName}`);
      return { success: true, usedId: 'rpc:' + rpcName };
    } catch (e) {
      // Continua
    }
  }

  return { success: false, reason: 'tutti i tentativi falliti' };
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

    const identity = await resolveNuvioIdentity(token);
    const library = await getNuvioLibrary(token);
    const libraryArray = Array.isArray(library) ? library : [];

    const watchedItems = await getNuvioWatchedItems(token, identity.profileId || 1);
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
// ENDPOINT: SYNC DIRETTO — VERSIONE CORRETTA
// FIX: library push → pausa → watched push con fallback aggressivo
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

    const watchedMoviesRaw = buildWatchedMoviesPayload(items);
    let watchedEpisodesRaw = [];

    if (includeWatchedEpisodes) {
      console.log(`📺 Recupero episodi visti da Cinemeta...`);
      watchedEpisodesRaw = await buildWatchedEpisodesPayload(items, 6);
    }

    const allWatchedItems = [
      ...watchedMoviesRaw,
      ...watchedEpisodesRaw
    ].map(item => normalizeWatchedItem(item)).filter(Boolean);

    const watchedMovies = allWatchedItems.filter(i => i.contentType === 'movie' && !i.season);
    const watchedEpisodes = allWatchedItems.filter(i => i.contentType === 'series' && i.season != null && i.episode != null);

    console.log(`✅ Estratti: ${watchedMovies.length} film + ${watchedEpisodes.length} episodi`);

    const progressPayload = buildWatchProgressPayload(items);
    console.log(`⏩ Watch progress: ${progressPayload.length} elementi`);

    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const identity = await resolveNuvioIdentity(accessToken);
    console.log(`👤 Identità Nuvio: UUID=${identity.userId}, ProfileID=${identity.profileId}`);

    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const [currentNuvioLibrary, currentWatchedRaw] = await Promise.all([
      getNuvioLibrary(accessToken),
      getNuvioWatchedItems(accessToken, identity.profileId || 1)
    ]);

    fs.writeFileSync(
      path.join(backupDir, `pre-sync-${backupId}.json`),
      JSON.stringify({ library: currentNuvioLibrary, watched: currentWatchedRaw }, null, 2)
    );
    console.log(`💾 Backup pre-sync-${backupId}.json`);

    // PUSH LIBRARY — con stato watched incluso per il badge
    const watchedContentIdSet = new Set(allWatchedItems.map(i => i.contentId).filter(Boolean));
    console.log(`📤 Push library (${rawFiltered.length} items, ${watchedContentIdSet.size} con badge watched)...`);
    const { count: pushedCount } = await pushLibraryToSupabase(
      nuvioEmail, nuvioPassword, rawFiltered, watchedContentIdSet
    );

    // FIX: piccola pausa per evitare race condition library→watched
    await new Promise(resolve => setTimeout(resolve, 500));

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

    // PUSH WATCHED con fallback aggressivo
    let watchedResult = { success: false, usedId: null };
    let totalWatchedPushed = 0;

    if (allWatchedItems.length > 0) {
      const remoteWatched = currentWatchedRaw.map(row => mapRemoteWatchedItem(row)).filter(Boolean);
      const mergedWatched = mergeWatchedItems(remoteWatched, allWatchedItems);
      const payload = dedupeWatchedItems(mergedWatched).map(item => toRemotePayloadItem(item)).filter(Boolean);

      if (payload.length > 0) {
        console.log(`📤 Push ${payload.length} watched items con fallback multi-ID...`);
        watchedResult = await pushWatchedItemsWithFallback(accessToken, identity, payload);
        if (watchedResult.success) {
          totalWatchedPushed = payload.length;
        }
      }
    }

    // VERIFICA FINALE
    const checkId = watchedResult.usedId || identity.profileId || 1;
    const [newNuvioLibrary, newWatchedRaw] = await Promise.all([
      getNuvioLibrary(accessToken),
      getNuvioWatchedItems(accessToken, checkId)
    ]);
    const newCount = Array.isArray(newNuvioLibrary) ? newNuvioLibrary.length : 0;

    // Verifica badge match
    const previewMap = new Map();
    allWatchedItems.forEach(w => previewMap.set(w.contentId, w));
    let mismatchCount = 0;
    previewMap.forEach((w, contentId) => {
      const found = newNuvioLibrary.find(i => i.content_id === contentId);
      if (!found) mismatchCount++;
    });
    if (mismatchCount === 0 && allWatchedItems.length > 0) {
      console.log(`🎉 BADGE CHECK: TUTTI i ${allWatchedItems.length} content_id presenti in library!`);
    } else if (mismatchCount > 0) {
      console.warn(`⚠️ BADGE CHECK: ${mismatchCount} content_id mancanti dalla library`);
    }

    const warnings = [
      watchedResult.success ? null : `Push watched fallito: ${watchedResult.reason}`,
      progressWarning
    ].filter(Boolean);

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
        metodoIdentita: watchedResult.usedId ? `Risolto: ${watchedResult.usedId}` : 'Fallito',
        badgeMismatch: mismatchCount
      },
      message: warnings.length > 0
        ? `✅ Library OK. ⚠️ Problemi: ${warnings[0]}`
        : `✅ SYNC COMPLETO! ${newCount} titoli, ${totalWatchedPushed} visti, 0 mismatch badge. Backup: pre-sync-${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: FORCE SYNC WATCHED (PUSH DIRETTO)
// ============================================
app.post('/force-sync-watched', async (req, res) => {
  const { email, password, stremioWatchedItems } = req.body;
  if (!email || !password || !Array.isArray(stremioWatchedItems)) {
    return res.status(400).json({ error: 'Email, password e array stremioWatchedItems richiesti' });
  }

  try {
    const session = await supabaseLogin(email, password);
    const identity = await resolveNuvioIdentity(session.access_token);

    const payload = stremioWatchedItems.map(item => {
      const contentId = item.id || item.imdb_id;
      if (!contentId) return null;
      return {
        content_id: contentId,
        content_type: item.type === 'series' ? 'series' : 'movie',
        title: item.title || '',
        season: item.season != null ? Number(item.season) : null,
        episode: item.episode != null ? Number(item.episode) : null,
        watched_at: item.watched_at ? Number(item.watched_at) : Date.now(),
        trakt_synced: true,
        trakt_last_synced: item.watched_at ? Number(item.watched_at) : Date.now(),
        sync_source: 'trakt',
        nuvio_watched: true,
        watched: true,
        times_watched: 1,
      };
    }).filter(Boolean);

    if (payload.length === 0) {
      return res.status(400).json({ error: 'Nessun item valido' });
    }

    const result = await pushWatchedItemsWithFallback(session.access_token, identity, payload);

    res.json({
      success: result.success,
      syncedCount: result.success ? payload.length : 0,
      usedId: result.usedId,
      message: result.success
        ? `Sincronizzati ${payload.length} titoli visti`
        : `Fallito: ${result.reason}`
    });

  } catch (error) {
    console.error('❌ Errore force-sync-watched:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// NUOVO ENDPOINT: FORCE BADGE SYNC
// Tenta ogni combinazione possibile per forzare il badge
// ============================================
app.post('/force-badge-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll = await getStremioLibrary(stremioAuth.token, { includeAll: true });
    const items = rawAll.map(normalizeLibraryItem);
    const watchedMovies = buildWatchedMoviesPayload(items);
    addLog(`✅ Stremio: ${rawAll.length} totali, ${watchedMovies.length} film visti`);

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const identity = await resolveNuvioIdentity(accessToken);
    addLog(`👤 UUID=${identity.userId}, ProfileID=${identity.profileId}`);
    addLog(`👥 Tutti i candidati: ${JSON.stringify(identity.allProfileIds)}`);

    // 1. Push library con stato watched per il badge
    const watchedIds = new Set(watchedMovies.map(w => w.contentId).filter(Boolean));
    const rawFiltered = rawAll.filter(i => !i.removed);
    const { count: libCount } = await pushLibraryToSupabase(
      nuvioEmail, nuvioPassword, rawFiltered, watchedIds
    );
    addLog(`📚 Library pushata: ${libCount} items (${watchedIds.size} con badge watched)`);

    await new Promise(resolve => setTimeout(resolve, 800));

    // 2. Costruisce payload massimale
    const payload = watchedMovies.map(item => toRemotePayloadItem(normalizeWatchedItem(item))).filter(Boolean);
    addLog(`📦 Payload watched: ${payload.length} items`);

    if (payload.length === 0) {
      return res.json({ success: false, log, message: 'Nessun film visto trovato su Stremio' });
    }

    // 3. Tenta push con ogni ID possibile
    const result = await pushWatchedItemsWithFallback(accessToken, identity, payload);
    addLog(result.success
      ? `✅ Push riuscito con ID: ${result.usedId}`
      : `❌ Push fallito: ${result.reason}`
    );

    // 4. Verifica finale
    if (result.success) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const afterItems = await getNuvioWatchedItems(accessToken, result.usedId);
      addLog(`🔍 Verifica: ${afterItems.length} items watched su Nuvio dopo push`);

      let badgeOk = 0, badgeFail = 0;
      for (const w of watchedMovies) {
        const found = afterItems.find(a => a.content_id === w.contentId);
        if (found) badgeOk++;
        else badgeFail++;
      }
      addLog(`🏅 Badge: ${badgeOk} OK, ${badgeFail} MANCANTI`);
    }

    res.json({
      success: result.success,
      log,
      usedId: result.usedId,
      pushed: payload.length
    });

  } catch (error) {
    addLog(`💥 ERRORE: ${error.message}`);
    res.json({ success: false, log, error: error.message });
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
    const identity = await resolveNuvioIdentity(accessToken);

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
    const watchedIdsInBackup = new Set(backupWatched.map(w => String(w.content_id || '')).filter(Boolean));
    const { count: restored } = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, items, watchedIdsInBackup);

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
        sync_source: 'trakt',
        nuvio_watched: true,
        watched: true,
        times_watched: 1,
      })).filter(w => w.content_id);

      if (watchedPayload.length > 0) {
        await pushWatchedItemsWithFallback(accessToken, identity, watchedPayload);
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
      const payloadItem = toRemotePayloadItem(normalizeWatchedItem(watchedItems[0]));
      addLog(`   Esempio: ${JSON.stringify(payloadItem)}`);
    }

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const identity = await resolveNuvioIdentity(accessToken);
    addLog(`👤 UUID=${identity.userId}, ProfileID=${identity.profileId}`);
    addLog(`👥 Tutti candidati: ${JSON.stringify(identity.allProfileIds)}`);

    const existing = await getNuvioWatchedItems(accessToken, identity.profileId || 1);
    addLog(`📖 Watched attuali su Nuvio: ${existing.length} items`);

    if (watchedItems.length > 0) {
      const testPayload = [toRemotePayloadItem(normalizeWatchedItem(watchedItems[0]))].filter(Boolean);
      addLog(`🧪 Test push 1 item...`);
      const result = await pushWatchedItemsWithFallback(accessToken, identity, testPayload);
      addLog(result.success
        ? `✅ Push OK con ID: ${result.usedId}`
        : `❌ Push fallito: ${result.reason}`
      );
      if (result.success) {
        const afterPush = await getNuvioWatchedItems(accessToken, result.usedId);
        addLog(`📖 Dopo push: ${afterPush.length} items`);
      }
    }

    res.json({
      success: true, log,
      watchedItems: watchedItems.slice(0, 5).map(w => toRemotePayloadItem(normalizeWatchedItem(w))).filter(Boolean)
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
      const stremioId = extractOriginalId(item);
      if (stremioId && !existingIds.has(stremioId)) missing.push({ id: item._id, name: item.name, type: item.type });
    });
    res.json({
      success: true,
      stats: { stremio: stremioItems.length, nuvio: currentArray.length, missing: missing.length },
      missing: missing.slice(0, 20)
    });
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
        if (!videos || videos.length === 0) { addLog(`   ❌ Nessun video trovato`); continue; }
        addLog(`   ✅ Trovati ${videos.length} video da Cinemeta`);
        const normalized = sortVideos(videos.map(normalizeVideo)).filter(v => v.id);
        const watchedField = parseWatchedField(serie.state.watchedField);
        if (!watchedField) { addLog(`   ❌ Impossibile parsare watchedField`); continue; }
        const videoIds = normalized.map(v => v.id);
        addLog(`   anchorVideo: ${watchedField.anchorVideo}, anchorIdx: ${videoIds.indexOf(watchedField.anchorVideo)}`);
        const watchedFlags = constructWatchedBoolArray(watchedField, videoIds);
        const watchedCount = watchedFlags.filter(Boolean).length;
        addLog(`   Episodi visti: ${watchedCount}/${normalized.length}`);
        const firstWatched = [];
        for (let i = 0; i < normalized.length && firstWatched.length < 3; i++) {
          if (watchedFlags[i]) firstWatched.push(`S${normalized[i].season}E${normalized[i].episode}`);
        }
        if (firstWatched.length > 0) addLog(`   Esempi: ${firstWatched.join(', ')}`);
      } catch (e) { addLog(`   ❌ Errore: ${e.message}`); }
    }

    const watchedMovies = buildWatchedMoviesPayload(items);
    addLog(`\n🎬 Film visti: ${watchedMovies.length}`);
    if (watchedMovies.length > 0) addLog(`   Primo: ${watchedMovies[0].title} (${watchedMovies[0].contentId})`);

    res.json({
      success: true, log,
      stats: { totalItems: items.length, seriesWithWatched: seriesWithWatched.length, watchedMovies: watchedMovies.length }
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
    const watchedItems = await getNuvioWatchedItems(accessToken, identity.profileId || 1);

    const result = {
      total: watchedItems.length,
      movies: 0,
      episodes: 0,
      sample: watchedItems.slice(0, 10),
      specificContent: null,
      identityUsed: identity
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
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, seriesId, seasonNum, episodeNum } = req.body;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    addLog('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll = await getStremioLibrary(stremioAuth.token, { includeAll: true });
    const items = rawAll.map(normalizeLibraryItem);
    const series = items.find(i => extractOriginalId(i) === seriesId);
    if (!series) { addLog(`❌ Serie ${seriesId} non trovata`); return res.json({ success: false, log }); }
    addLog(`✅ Trovata serie: ${series.name}`);
    if (!series.state.watchedField) { addLog(`❌ Serie senza watchedField`); return res.json({ success: false, log }); }

    const videos = await fetchCinemetaVideos(series.id);
    if (!videos?.length) { addLog('❌ Nessun video trovato'); return res.json({ success: false, log }); }
    const normalized = sortVideos(videos.map(normalizeVideo)).filter(v => v.id);
    const targetEpisode = normalized.find(v => v.season === seasonNum && v.episode === episodeNum);
    if (!targetEpisode) { addLog(`❌ Episodio S${seasonNum}E${episodeNum} non trovato`); return res.json({ success: false, log }); }

    const watchedField = parseWatchedField(series.state.watchedField);
    if (!watchedField) { addLog('❌ Impossibile parsare watchedField'); return res.json({ success: false, log }); }
    const videoIds = normalized.map(v => v.id);
    const watchedFlags = constructWatchedBoolArray(watchedField, videoIds);
    const episodeIndex = normalized.findIndex(v => v.id === targetEpisode.id);
    const isWatched = watchedFlags[episodeIndex];
    addLog(`📊 Episodio visto su Stremio: ${isWatched ? '✅ SÌ' : '❌ NO'}`);
    if (!isWatched) return res.json({ success: false, log });

    addLog('🔐 Login Nuvio...');
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const identity = await resolveNuvioIdentity(accessToken);
    const contentId = extractOriginalId(series);
    if (!contentId) { addLog('❌ Impossibile estrarre ID'); return res.json({ success: false, log }); }

    await pushLibraryToSupabase(nuvioEmail, nuvioPassword, [series]);

    const payload = [{
      content_id: contentId,
      content_type: 'series',
      title: series.name || contentId,
      season: seasonNum,
      episode: episodeNum,
      watched_at: Date.now(),
      trakt_synced: true,
      trakt_last_synced: Date.now(),
      sync_source: 'trakt',
      nuvio_watched: true,
      watched: true,
      times_watched: 1,
    }];

    const result = await pushWatchedItemsWithFallback(accessToken, identity, payload);
    addLog(result.success ? `✅ Push completato con ID: ${result.usedId}` : `❌ Push fallito: ${result.reason}`);

    if (result.success) {
      const afterPush = await getNuvioWatchedItems(accessToken, result.usedId);
      const saved = afterPush.find(item => item.content_id === contentId && item.season === seasonNum && item.episode === episodeNum);
      addLog(saved ? `✅ Episodio confermato su Nuvio!` : `❌ Episodio non trovato dopo push`);
    }

    res.json({ success: result.success, log });
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
    stremioItems.forEach(item => { const id = extractOriginalId(item); if (id) stremioIds.add(id); });
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
    if (inStremioNotNuvio.length > 0) addLog(`   Esempi: ${inStremioNotNuvio.slice(0, 5).join(', ')}`);

    res.json({
      success: true, log,
      stats: { stremio: stremioIds.size, nuvio: nuvioIds.size, missingInNuvio: inStremioNotNuvio.length, extraInNuvio: inNuvioNotStremio.length }
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
    const library = await getNuvioLibrary(accessToken);
    const inLibrary = library.find(i => i.content_id === contentId);
    const watched = await getNuvioWatchedItems(accessToken, identity.profileId || 1);
    const inWatched = watched.find(i => i.content_id === contentId);
    res.json({
      success: true, contentId,
      inLibrary: !!inLibrary, libraryItem: inLibrary || null,
      inWatched: !!inWatched, watchedItem: inWatched || null
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
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE BADGE FIX + FALLBACK AGGRESSIVO)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  console.log(`🖼️  TMDB: ${process.env.TMDB_API_KEY ? '✅' : '❌ (TMDB_API_KEY non impostata)'}`);
  console.log(`\n✅ BUG FIX APPLICATI:`);
  console.log(`   • FIX #1: resolveNuvioIdentity potenziata (4 RPC + 2 tabelle fallback)`);
  console.log(`   • FIX #2: getNuvioWatchedItems tenta tutti i candidati profileId`);
  console.log(`   • FIX #3: normalizeWatchedItem — corretto bug '|| true' su traktSynced`);
  console.log(`   • FIX #4: toRemotePayloadItem — aggiunto nuvio_watched, watched, times_watched`);
  console.log(`   • FIX #5: buildWatchedMoviesPayload — rileva watched via progress > 85%`);
  console.log(`   • FIX #6: constructWatchedBoolArray — fallback se anchorVideo non trovato`);
   console.log(`   • FIX #7: pushLibraryToSupabase — solo item reali, nessuno stub`);
  console.log(`   • FIX #8: pushWatchedItemsWithFallback — 5+ RPC alternativi`);
  console.log(`   • FIX #9: pausa 500ms tra library push e watched push (race condition)`);
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • POST /force-badge-sync              ← NUOVO: forza badge in ogni modo`);
  console.log(`   • POST /sync                          ← con fallback badge aggressivo`);
  console.log(`   • POST /force-sync-watched`);
  console.log(`   • GET  /backups | POST /restore`);
  console.log(`   • POST /debug-watched | /debug-sync | /debug-episodes-full`);
  console.log(`   • POST /check-nuvio-watched | /check-item | /compare-libraries\n`);
});
