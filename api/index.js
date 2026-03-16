'use strict';
const express = require('express');
const cors    = require('cors');
const zlib    = require('zlib');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================
// SUPABASE
// ============================================================
const SUPABASE_URL      = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function supabaseRequest(urlPath, { method = 'GET', body, authToken } = {}) {
  const headers = { 'apikey': SUPABASE_ANON_KEY };
  if (authToken)          headers['Authorization']  = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type']   = 'application/json';
  const res  = await fetch(`${SUPABASE_URL}${urlPath}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object')
      ? (parsed.message || parsed.msg || parsed.error_description || parsed.error || text)
      : (text || `HTTP ${res.status}`);
    throw new Error(String(msg).slice(0, 500));
  }
  return parsed;
}

async function supabaseLogin(email, password) {
  return supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email, password },
  });
}

async function supabaseRpc(fn, payload, token) {
  return supabaseRequest(`/rest/v1/rpc/${fn}`, {
    method: 'POST', body: payload ?? {}, authToken: token,
  });
}

// ============================================================
// NUVIO HELPERS
// ============================================================
async function getEffectiveOwnerId(token) {
  const r = await supabaseRpc('get_sync_owner', {}, token);
  if (typeof r === 'string' && r.length > 10) return r;
  if (Array.isArray(r) && r.length > 0)       return String(r[0]);
  if (r && typeof r === 'object' && r.id)     return r.id;
  throw new Error(`get_sync_owner() unexpected: ${JSON.stringify(r)}`);
}
async function getNuvioLibrary(token)      { const r = await supabaseRpc('sync_pull_library',        {}, token); return Array.isArray(r) ? r : []; }
async function getNuvioWatchProgress(token){ const r = await supabaseRpc('sync_pull_watch_progress', {}, token); return Array.isArray(r) ? r : []; }

// getNuvioWatchedItems: legge watched_items via RPC
// Restituisce tutto (sia titoli-livello che episodi).
async function getNuvioWatchedItems(token) {
  const r = await supabaseRpc('sync_pull_watched_items', {}, token);
  return Array.isArray(r) ? r : [];
}

// ============================================================
// PUSH — SINGLE CALL (no batching: these RPCs do DELETE-then-INSERT)
// ============================================================
async function pushLibrary(items, token) {
  // Strip description to reduce payload, keep everything else
  const payload = (items || []).map(item => ({
    content_id:    item.content_id,
    content_type:  item.content_type,
    name:          item.name          || '',
    poster:        item.poster        || null,
    poster_shape:  item.poster_shape  || 'POSTER',
    background:    item.background    || null,
    description:   null,   // skip — saves payload space
    release_info:  item.release_info  || '',
    imdb_rating:   item.imdb_rating   || null,
    genres:        item.genres        || [],
    addon_base_url: null,
    added_at:      item.added_at      || Date.now(),
  }));
  await supabaseRpc('sync_push_library', { p_items: payload }, token);
  return payload.length;
}

async function pushWatchedItems(items, token) {
  const allItems = items || [];
  // Invia SOLO season=null via RPC (DELETE-then-INSERT, stabile, nessun limite con <1000 items)
  const titleLevel = allItems.filter(i => i.season == null && i.episode == null);
  await supabaseRpc('sync_push_watched_items', { p_items: titleLevel }, token);
  console.log(`pushWatchedItems: ${titleLevel.length} titoli-livello via RPC`);
  return titleLevel.length;
}

// Aggiunge proxy S1E1 per le serie watched (necessario per badge in Nuvio).
// Pushia SOLO un episodio per serie (S1E1) — NON gli episodi reali del bitfield.
// I 72 proxy S1E1 sommati ai 203 titoli-livello = 275 voci totali,
// ben sotto il limite 1000 della RPC sync_pull_watched_items.
// Gli episodi reali del bitfield vanno pushati separatamente via /push-episodes.
async function pushSeriesProxyEpisodes(watchedSeriesTitles, token, ownerId) {
  // Un S1E1 per ogni serie watched — necessario per badge in Nuvio
  // ownerId passato dall'esterno per evitare RPC extra (rischio timeout Vercel)
  const proxyEps = (watchedSeriesTitles || []).map(s => ({
    content_id:   s.content_id,
    content_type: 'movie',
    title:        s.title || '',
    season:       1,
    episode:      1,
    watched_at:   s.watched_at || Date.now(),
  }));
  const allEps = dedupeWatched(proxyEps);
  if (!allEps.length) return 0;

  if (!ownerId) ownerId = await getEffectiveOwnerId(token);
  const BATCH = 200;
  let pushed = 0;
  for (let i = 0; i < allEps.length; i += BATCH) {
    const batch = allEps.slice(i, i + BATCH).map(ep => ({
      user_id:      ownerId,
      content_id:   ep.content_id,
      content_type: ep.content_type,
      title:        ep.title || '',
      season:       ep.season,
      episode:      ep.episode,
      watched_at:   ep.watched_at || Date.now(),
      profile_id:   1,
    }));
    const r = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (!r.ok) {
      const err = await r.text();
      console.warn(`pushSeriesProxyEpisodes batch ${i} failed (${r.status}): ${err.slice(0,150)}`);
    } else {
      pushed += batch.length;
    }
  }
  console.log(`pushSeriesProxyEpisodes: ${proxyEps.length} proxy S1E1 → ${pushed} pushati`);
  return pushed;
}

async function pushWatchProgress(entries, token) {
  await supabaseRpc('sync_push_watch_progress', { p_entries: entries || [] }, token);
  return (entries || []).length;
}

// ============================================================
// STREMIO API
// ============================================================
const STREMIO_API = 'https://api.strem.io';
const STREMIO_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.159';

async function stremioLogin(email, password) {
  const res  = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ email, password, facebook: false, type: 'login' }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Stremio non JSON (${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`Login Stremio: ${data?.error || `HTTP ${res.status}`}`);
  const authKey = data?.result?.authKey;
  if (!authKey) throw new Error('authKey non trovato');
  return { token: authKey };
}

async function getStremioLibraryRaw(authKey) {
  const res  = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
    body: JSON.stringify({ authKey, collection: 'libraryItem', all: true }),
  });
  if (!res.ok) throw new Error(`datastoreGet HTTP ${res.status}`);
  const data = await res.json();
  let items = [];
  if (Array.isArray(data))                    items = data;
  else if (data.result) {
    if (Array.isArray(data.result))           items = data.result;
    else if (Array.isArray(data.result.rows)) items = data.result.rows.map(r => r.value).filter(Boolean);
    else if (data.result.value)               items = [data.result.value];
  } else if (Array.isArray(data.items))       items = data.items;
  return items.filter(i => i && (i._id || i.id) && ['movie','series','show'].includes(i.type || ''));
}

// ============================================================
// NORMALIZATION
// ============================================================
function extractContentId(value) {
  const t = String(value ?? '').trim();
  if (!t) return '';

  // IMDB: tt1234567 (anche in formato tt1234567:2:5 → prendi solo tt parte)
  const m = t.match(/tt\d+/i);
  if (m) return m[0].toLowerCase();

  // TMDB: tmdb:12345
  const m2 = t.match(/(?:^|:)tmdb:(\d+)(?::|$)/i);
  if (m2?.[1]) return `tmdb:${m2[1]}`;

  // Anime e altri provider: kitsu:10740, mal:1376, anilist:1, youtube:xyz, ecc.
  // Formato: "provider:id" — accetta qualsiasi provider non vuoto con id numerico o alfanumerico
  const m3 = t.match(/^([a-z][a-z0-9_-]{1,20}):([a-zA-Z0-9_-]{1,30})(?::|$)/i);
  if (m3 && m3[1] && m3[2]) return `${m3[1].toLowerCase()}:${m3[2]}`;

  // Fallback: usa il valore grezzo se non è vuoto e sembra un ID valido
  // (no spazi, lunghezza ragionevole)
  if (t.length <= 50 && !/\s/.test(t)) return t.toLowerCase();

  return '';
}

function normalizeType(value) {
  const t = String(value ?? '').trim().toLowerCase();
  return (t === 'series' || t === 'show' || t === 'tv') ? 'series' : 'movie';
}

function toMs(value, fallback = Date.now()) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e11 ? Math.trunc(value * 1000) : Math.trunc(value);
  const t = String(value).trim();
  if (/^\d+$/.test(t)) { const n = Number(t); return n < 1e11 ? Math.trunc(n*1000) : Math.trunc(n); }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : fallback;
}

function toPosInt(v) { const n = Number(v||0); return (Number.isFinite(n) && n > 0) ? Math.trunc(n) : 0; }

function parseSE(videoId) {
  if (!videoId) return { season: null, episode: null };
  const str = String(videoId);

  // Formato standard: qualsiasi:N:N — prende gli ultimi due numeri
  // Es: tt1234567:2:5, aiometadata:tt1234567:2:5, kitsu:220:1:3
  const parts = str.split(':');
  if (parts.length >= 3) {
    const ep  = Number(parts[parts.length - 1]);
    const sea = Number(parts[parts.length - 2]);
    if (Number.isFinite(sea) && Number.isFinite(ep) && sea > 0 && ep > 0)
      return { season: Math.trunc(sea), episode: Math.trunc(ep) };
  }

  // Formato SxE o S01E01: "2x5", "S2E5", "s02e05"
  const sxe = str.match(/[Ss](\d{1,3})[Ee](\d{1,3})/);
  if (sxe) return { season: Number(sxe[1]), episode: Number(sxe[2]) };

  return { season: null, episode: null };
}

function makeProgressKey(ct, cid, sea, ep) {
  if (ct === 'movie') return cid;
  if (sea != null && ep != null) return `${cid}_s${sea}e${ep}`;
  return cid;
}

function normalizeItem(raw) {
  const id    = String(raw._id || raw.id || '').trim();
  const state = raw.state || {};
  return {
    id,
    type:        String(raw.type || '').toLowerCase(),
    name:        String(raw.name || '').trim(),
    poster:      raw.poster      || null,
    posterShape: String(raw.posterShape || 'POSTER').toUpperCase(),
    background:  raw.background  || null,
    description: raw.description || null,
    year:        raw.year        || null,
    imdbRating:  raw.imdbRating  ? parseFloat(raw.imdbRating) : null,
    genres:      Array.isArray(raw.genres) ? raw.genres : [],
    removed:     Boolean(raw.removed),
    temp:        Boolean(raw.temp),
    mtime:       raw._mtime || raw.mtime || null,
    state: {
      timeOffset:    toPosInt(state.timeOffset     ?? state.time_offset    ?? 0),
      duration:      toPosInt(state.duration       ?? 0),
      lastWatched:   state.lastWatched ?? state.last_watched ?? null,
      videoId:       state.video_id   ?? state.videoId       ?? null,
      timesWatched:  toPosInt(state.timesWatched   ?? state.times_watched  ?? 0),
      flaggedWatched:toPosInt(state.flaggedWatched ?? state.flagged_watched ?? 0),
      // state.watched può essere:
      //   true/false   → booleano (film visti/non visti in Stremio)
      //   "tt:N:base64" → bitfield episodi (serie)
      watchedBool:   state.watched === true || state.watched === 1,
      watchedField:  (typeof state.watched === 'string' && state.watched.includes(':'))
                       ? state.watched : null,
    },
  };
}

// ============================================================
// BUILD PAYLOADS
// ============================================================

// FIX #3: Rigorous dedup — Map keyed on (cid:ct), keep item with most data
function buildLibraryPayload(rawItems) {
  const seen = new Map(); // key -> best raw item
  for (const raw of rawItems) {
    if (!raw) continue;
    const id = raw._id || raw.id;
    if (!id) continue;
    const cid = extractContentId(id);
    if (!cid) continue;
    const ct  = normalizeType(raw.type || '');
    if (!['movie','series'].includes(ct)) continue;
    const key = `${cid}:${ct}`;
    const existing = seen.get(key);
    // Keep item with more data (prefer one with poster, then with name)
    if (!existing || (!existing.poster && raw.poster) || (!existing.name && raw.name)) {
      seen.set(key, { ...raw, _cid: cid, _ct: ct });
    }
  }
  return Array.from(seen.values()).map(raw => ({
    content_id:    raw._cid,
    content_type:  raw._ct,
    name:          String(raw.name || '').trim(),
    poster:        raw.poster      || null,
    poster_shape:  String(raw.posterShape || 'POSTER').toUpperCase(),
    background:    raw.background  || null,
    description:   null,
    release_info:  raw.year ? String(raw.year) : '',
    imdb_rating:   raw.imdbRating ? parseFloat(raw.imdbRating) : null,
    genres:        Array.isArray(raw.genres) ? raw.genres : [],
    addon_base_url: null,
    added_at:      toMs(raw._mtime || raw.mtime || null),
  }));
}

// FIX #1: CW — for series, video_id MUST contain season:episode (tt:S:E)
// If the videoId doesn't have valid S/E, try the raw item._id itself.
// Entries without resolvable S/E for series are SKIPPED (Nuvio can't resume them).
function buildWatchProgressPayload(normalizedItems) {
  const candidates = [];
  for (const item of normalizedItems) {
    if (!item.id) continue;
    if (item.temp) continue; // salta solo temporanei, non i rimossi
    if (item.type !== 'movie' && item.type !== 'series' && item.type !== 'show') continue;
    const { timeOffset, duration, videoId, lastWatched } = item.state;
    if (timeOffset <= 0 || duration <= 0) continue;
    const pct = (timeOffset / duration) * 100;
    // 3%–92%: same threshold as Stremio CW
    if (pct < 3 || pct > 92) continue;
    const cid = extractContentId(item.id);
    if (!cid) continue;
    const ct  = normalizeType(item.type);

    // Try to get season/episode from videoId first, then from raw item id
    let vid = String(videoId || '').trim();
    let { season, episode } = parseSE(vid);

    if (ct === 'series' && (season == null || episode == null)) {
      // videoId has no S/E — try item.id (Stremio sometimes stores tt:S:E as _id)
      const seFromId = parseSE(item.id);
      if (seFromId.season != null && seFromId.episode != null) {
        vid    = item.id;
        season = seFromId.season;
        episode = seFromId.episode;
      }
      // Se ancora nessun S/E: usa video_id grezzo come fallback.
      // Nuvio legge position/duration comunque — meglio mostrarlo che non mostrarlo.
      // season/episode restano null → Nuvio non saprà l'episodio ma mostrerà il CW.
    }

    // Fallback video_id: usa raw videoId se disponibile, altrimenti content_id
    if (!vid) vid = String(videoId || cid);

    candidates.push({
      content_id:   cid,
      content_type: ct,
      video_id:     vid,
      season,
      episode,
      position:     timeOffset,
      duration,
      last_watched: toMs(lastWatched || item.mtime),
      progress_key: makeProgressKey(ct, cid, season, episode),
      _lastWatched: toMs(lastWatched || item.mtime),
    });
  }
  candidates.sort((a, b) => b._lastWatched - a._lastWatched);
  const result = candidates.slice(0, 20).map(({ _lastWatched, ...item }) => item);
  return result;
}

// WATCHED — Badge "visto" in Nuvio
// NOTA: include anche i rimossi (item.removed) perché "aver visto qualcosa"
// è permanente anche se poi lo si rimuove dalla libreria Stremio.
function buildWatchedPayload(normalizedItems) {
  const result = [];
  for (const item of normalizedItems) {
    if (item.temp) continue; // salta solo i temporanei
    const cid = extractContentId(item.id);
    if (!cid) continue;
    const ct = normalizeType(item.type);
    const { timesWatched, flaggedWatched, timeOffset, duration, lastWatched, watchedBool } = item.state;
    const pct = duration > 0 ? (timeOffset / duration) : 0;
    // Stremio marca come visto con: watched=true, timesWatched>0, flaggedWatched>0, o pct>=80%
    // NON includiamo le serie con solo bitfield qui — non sappiamo se sono complete.
    // Il badge watched per le serie viene aggiunto dal bottone EPISODI che ha i dati
    // Cinemeta per distinguere serie complete (→ season=null) da parziali (→ solo episodi).
    const isWatched = watchedBool || timesWatched > 0 || flaggedWatched > 0 || pct >= 0.80;
    if (!isWatched) continue;
    // Il developer Nuvio indica di trattare le serie watched come i film:
    // pushaimo content_type='movie' per tutti i title-level (season=null).
    // Questo fa sì che reconcileRemoteWatchedItems chiami setLocalWatchedStatus('movie',id)
    // che scrive watched:movie:${id}=true in mmkv → badge visibile in ContentItem.
    result.push({
      content_id:   cid,
      content_type: 'movie',
      title:        item.name || '',
      season:       null,
      episode:      null,
      watched_at:   toMs(lastWatched || item.mtime),
    });
  }
  return result;
}

// ============================================================
// EPISODE BITFIELD DECODER
// ============================================================
function parseWatchedField(str) {
  if (!str || typeof str !== 'string') return null;
  const parts     = str.split(':');
  if (parts.length < 3) return null;
  const bitfield  = parts.pop();
  const anchorLen = Number(parts.pop());
  if (!Number.isFinite(anchorLen)) return null;
  return { anchorVideo: parts.join(':'), anchorLength: Math.trunc(anchorLen), bitfield };
}

function decodeBitfield(encoded, lengthBits) {
  const buf    = zlib.inflateSync(Buffer.from(encoded, 'base64'));
  const values = Array.from(buf);
  const need   = Math.ceil(lengthBits / 8);
  while (values.length < need) values.push(0);
  return values;
}

function bitGet(values, idx) {
  const byte = Math.floor(idx / 8), bit = idx % 8;
  return byte < values.length ? ((values[byte] >> bit) & 1) !== 0 : false;
}

function resolveWatchedFlags(wf, videoIds) {
  const anchorIdx = videoIds.indexOf(wf.anchorVideo);
  if (anchorIdx === -1) return new Array(videoIds.length).fill(false);
  const values = decodeBitfield(wf.bitfield, videoIds.length);
  const offset = wf.anchorLength - anchorIdx - 1;
  if (offset === 0) return videoIds.map((_, i) => bitGet(values, i));
  return videoIds.map((_, i) => {
    const prev = i + offset;
    return prev >= 0 ? bitGet(values, prev) : false;
  });
}

function normalizeVideo(raw) {
  const sea  = raw.season  ?? raw.seriesInfo?.season  ?? null;
  const ep   = raw.episode ?? raw.seriesInfo?.episode ?? null;
  const relMs = raw.released ? Date.parse(String(raw.released)) : NaN;
  return {
    id:      raw.id,
    season:  Number.isFinite(Number(sea)) ? Number(sea)  : null,
    episode: Number.isFinite(Number(ep))  ? Number(ep)   : null,
    relMs:   Number.isFinite(relMs) ? relMs : null,
    title:   raw.title || '',
  };
}

function sortVideos(vs) {
  return vs.slice().sort((a, b) => {
    if ((a.season  ?? -1) !== (b.season  ?? -1)) return (a.season  ?? -1) - (b.season  ?? -1);
    if ((a.episode ?? -1) !== (b.episode ?? -1)) return (a.episode ?? -1) - (b.episode ?? -1);
    return (a.relMs ?? -1) - (b.relMs ?? -1);
  });
}

async function fetchCinemetaVideos(id) {
  try {
    // Normalizza l'ID prima di chiamare Cinemeta:
    // "aiometadata:tt1234567" → "tt1234567"
    // "tt1234567" → "tt1234567"
    // "kitsu:123" → non è Cinemeta, saltiamo
    const normalizedId = extractContentId(id);
    if (!normalizedId) return null;
    // Cinemeta supporta solo IMDB (tt...) e TMDB (tmdb:...)
    if (!normalizedId.match(/^tt\d+/) && !normalizedId.match(/^tmdb:/)) return null;
    const r = await fetch(
      `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(normalizedId)}.json`,
      { headers: { 'User-Agent': 'NuvioSync/1.0' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data?.meta?.videos) ? data.meta.videos : null;
  } catch { return null; }
}

async function buildWatchedEpisodesPayload(normalizedItems, concurrency = 5, onProgress) {
  const seriesWithField = normalizedItems.filter(i =>
    (i.type === 'series' || i.type === 'show') && i.state.watchedField
  );
  if (!seriesWithField.length) return [];
  if (onProgress) onProgress(`Recupero ${seriesWithField.length} serie da Cinemeta...`);

  const queue     = [...seriesWithField];
  const videosMap = new Map();
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      const cid  = extractContentId(item.id);
      if (!cid) continue;
      const vids = await fetchCinemetaVideos(cid);
      if (Array.isArray(vids) && vids.length > 0) videosMap.set(item.id, vids);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const payload = [];
  for (const item of seriesWithField) {
    const rawVids = videosMap.get(item.id);
    if (!rawVids?.length) continue;
    const sorted = sortVideos(rawVids.map(normalizeVideo)).filter(v => v.id);
    if (!sorted.length) continue;
    const wf = parseWatchedField(item.state.watchedField);
    if (!wf) continue;
    let flags;
    try { flags = resolveWatchedFlags(wf, sorted.map(v => v.id)); } catch { continue; }
    const cid      = extractContentId(item.id);
    if (!cid) continue;
    const watchedAt = toMs(item.state.lastWatched || item.mtime);

    // Conta episodi per stagione e traccia l'ultimo episodio visto
    const bySeason = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i];
      if (v.season == null || v.episode == null) continue;
      if (!bySeason.has(v.season)) bySeason.set(v.season, { total: 0, watchedCount: 0, lastWatchedEp: null });
      const s = bySeason.get(v.season);
      s.total++;
      if (flags[i]) {
        s.watchedCount++;
        s.lastWatchedEp = v; // teniamo sempre l'ultimo episodio visto della stagione
      }
    }

    const totalEps   = [...bySeason.values()].reduce((a, s) => a + s.total, 0);
    const watchedEps = [...bySeason.values()].reduce((a, s) => a + s.watchedCount, 0);
    if (watchedEps === 0) continue;

    // Serie "completa" se >= 95% degli episodi sono visti
    // (5% margine per episodi futuri/non ancora usciti che Cinemeta include)
    const completionRatio = totalEps > 0 ? watchedEps / totalEps : 0;
    const isEffectivelyComplete = completionRatio >= 0.95;

    // È in CW? (progress 3-92%)
    const cwPct = item.state.duration > 0
      ? (item.state.timeOffset / item.state.duration) * 100 : 0;
    const isInCW = cwPct >= 3 && cwPct <= 92;

    // Log per stagione
    for (const [season, data] of bySeason) {
      if (data.watchedCount === 0) continue;
      if (onProgress) onProgress(
        `  ${data.watchedCount === data.total ? '✅' : '📺'} "${item.name}" S${season}: ${data.watchedCount}/${data.total} ep`
      );
    }

    if (isEffectivelyComplete && !isInCW) {
      // CASO 1 — serie completa e non in CW:
      // Pushaimo TUTTI gli episodi visti — Nuvio controlla che ogni episodio
      // sia al 100% in storageService per mostrare il badge "watched" sulla card.
      // Con dry-run + single push non c'è il limite 1000 righe.
      let epCount = 0;
      payload.push({ content_id: cid, content_type: 'movie', title: item.name||'', season: null, episode: null, watched_at: watchedAt });
      for (let i = 0; i < sorted.length; i++) {
        if (!flags[i]) continue;
        const v = sorted[i];
        if (v.season == null || v.episode == null) continue;
        payload.push({ content_id: cid, content_type: 'movie', title: item.name||'', season: v.season, episode: v.episode, watched_at: watchedAt });
        epCount++;
      }
      if (onProgress) onProgress(
        `  ✅ "${item.name}" — ${Math.round(completionRatio*100)}% completa → title-level + ${epCount} episodi`
      );
    } else {
      // CASO 2 — serie parziale o in CW:
      // Pushaimo title-level + solo gli episodi effettivamente visti
      let epCount = 0;
      payload.push({ content_id: cid, content_type: 'movie', title: item.name||'', season: null, episode: null, watched_at: watchedAt });
      for (let i = 0; i < sorted.length; i++) {
        if (!flags[i]) continue;
        const v = sorted[i];
        if (v.season == null || v.episode == null) continue;
        payload.push({ content_id: cid, content_type: 'movie', title: item.name||'', season: v.season, episode: v.episode, watched_at: watchedAt });
        epCount++;
      }
      if (onProgress) onProgress(
        `  📺 "${item.name}" — ${Math.round(completionRatio*100)}% parziale${isInCW?' (CW)':''} → title-level + ${epCount} ep visti`
      );
    }
  }

  if (onProgress) onProgress(`${payload.length} entries (title-level + proxy)`);
  return payload;
}

function dedupeWatched(items) {
  const map = new Map();
  for (const item of items) {
    const key  = `${item.content_id}:${item.content_type}:${item.season ?? ''}:${item.episode ?? ''}`;
    const prev = map.get(key);
    if (!prev || (item.watched_at || 0) >= (prev.watched_at || 0)) map.set(key, item);
  }
  return Array.from(map.values());
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => res.json({ status: 'ok', supabase: isSupabaseConfigured() }));
app.get('/supabase-status', (req, res) => res.json({ configured: isSupabaseConfigured() }));

// Expose Supabase config to browser so it can call Supabase directly
// ANON_KEY is safe to expose — it's designed to be public
app.get('/supabase-config', (req, res) => {
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// ─── test-stremio-login ──────────────────────────────────────
app.post('/test-stremio-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, message: '❌ Email e password richieste' });
  try { await stremioLogin(email, password); res.json({ success: true, message: '✅ Login Stremio OK!' }); }
  catch (e) { res.json({ success: false, message: `❌ ${e.message}` }); }
});

// ─── test-login ──────────────────────────────────────────────
app.post('/test-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, message: '❌ Email e password richieste' });
  if (!isSupabaseConfigured()) return res.json({ success: false, message: '❌ Supabase non configurato' });
  try {
    const session = await supabaseLogin(email, password);
    const owner   = await getEffectiveOwnerId(session.access_token).catch(() => null);
    // Return access_token so browser can reuse it for push calls (avoids re-login)
    res.json({ success: true, message: `✅ Login Nuvio OK! Owner: ${owner || 'unknown'}`, access_token: session.access_token });
  } catch (e) { res.json({ success: false, message: `❌ ${e.message}` }); }
});

// ─── get-stremio-data ────────────────────────────────────────
app.post('/get-stremio-data', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Credenziali richieste' });
  try {
    const auth      = await stremioLogin(email, password);
    const rawAll    = await getStremioLibraryRaw(auth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);

    const normalized       = rawAll.map(normalizeItem);
    const normalizedActive = normalized.filter(i => !i.removed && !i.temp);

    const watchedAll  = buildWatchedPayload(normalized);
    const watchedIds  = [...new Set(watchedAll.map(w => w.content_id))];

    const inProgressItems = normalizedActive
      .filter(item => {
        const { timeOffset, duration } = item.state;
        if (timeOffset <= 0 || duration <= 0) return false;
        const pct = (timeOffset / duration) * 100;
        return pct >= 1 && pct <= 98;
      })
      .sort((a, b) => toMs(b.state.lastWatched || b.mtime) - toMs(a.state.lastWatched || a.mtime))
      .map(item => ({
        ...item,
        progressPct: Math.round((item.state.timeOffset / item.state.duration) * 100),
      }));

    const removedItems       = rawAll.filter(i => i.removed && !i.temp);
    const seriesWithEpisodes = normalized.filter(i =>
      (i.type === 'series' || i.type === 'show') && i.state.watchedField
    );

    res.json({
      success: true,
      library:         rawActive,
      libraryAll:      rawAll,
      inProgressItems,
      removedItems,
      watchedIds,
      stats: {
        total:              rawActive.length,
        movies:             rawActive.filter(i => i.type === 'movie').length,
        series:             rawActive.filter(i => i.type === 'series' || i.type === 'show').length,
        continueWatching:   inProgressItems.length,
        watched:            watchedIds.length,
        watchedSeriesCount: seriesWithEpisodes.length,
        removed:            removedItems.length,
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── get-nuvio-data ──────────────────────────────────────────
app.post('/get-nuvio-data', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(email, password);
    const token   = session.access_token;
    const [library, watchedItems, watchProgress] = await Promise.all([
      getNuvioLibrary(token),
      getNuvioWatchedItems(token),
      getNuvioWatchProgress(token),
    ]);
    // watchedItems è già filtrato season=null da getNuvioWatchedItems
    const watchedIds = [...new Set(
      watchedItems.map(w => String(w.content_id || '').trim().toLowerCase()).filter(Boolean)
    )];
    res.json({
      success: true,
      library, watchedItems, watchProgress, watchedIds,
      stats: {
        total:           library.length,
        movies:          library.filter(i => i.content_type === 'movie').length,
        series:          library.filter(i => i.content_type === 'series').length,
        watched:         watchedIds.length,
        watchedMovies:   watchedItems.filter(i => i.content_type === 'movie').length,
        watchedSeries:   watchedItems.filter(i => i.content_type === 'series').length,
        inProgress:      watchProgress.length,
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── preview-sync ────────────────────────────────────────────
app.post('/preview-sync', async (req, res) => {
  const { stremioEmail, stremioPassword } = req.body;
  if (!stremioEmail || !stremioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali Stremio richieste' });
  try {
    const auth    = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll  = await getStremioLibraryRaw(auth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    const norm    = rawAll.map(normalizeItem);
    const normActive = norm.filter(i => !i.removed && !i.temp);

    const libraryPayload  = buildLibraryPayload(rawActive);
    const progressPayload = buildWatchProgressPayload(normActive);
    const watchedTitles   = buildWatchedPayload(norm);

    const cwItems = progressPayload.map(i =>
      `${i.content_id} (${i.content_type}) | video_id:${i.video_id} | pos:${i.position}ms/${i.duration}ms | pct:${Math.round(i.position/i.duration*100)}%`
    );
    const watchedItems = watchedTitles.map(i =>
      `${i.content_id} (${i.content_type}) | ${i.title}`
    );

    const withTimesWatched  = norm.filter(i => i.state.timesWatched > 0).length;
    const withFlagged       = norm.filter(i => i.state.flaggedWatched > 0).length;
    const withPct80         = norm.filter(i => i.state.duration > 0 && i.state.timeOffset / i.state.duration >= 0.80).length;
    const withAnyProgress   = norm.filter(i => i.state.timeOffset > 0 && i.state.duration > 0).length;

    res.json({
      success: true,
      wouldPush: {
        library: libraryPayload.length,
        watchProgress: progressPayload.length,
        watchedTitles: watchedTitles.length,
      },
      watchedSignals: {
        timesWatched_gt0: withTimesWatched,
        flaggedWatched_gt0: withFlagged,
        pct_gte80: withPct80,
        anyProgress: withAnyProgress,
      },
      cwItems,
      watchedTitlesPreview: watchedItems.slice(0, 20),
      message: progressPayload.length === 0
        ? '⚠️ Nessun item in progress — CW Nuvio sarà VUOTO dopo il sync'
        : `✅ ${progressPayload.length} item CW · ${watchedTitles.length} badge watched`,
    });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message).slice(0, 300) }); }
});


// ─── /push-episodes ──────────────────────────────────────────
// Decode Cinemeta bitfield + push episode-level watched badges.
// Slow (1-3 min) — called separately, browser shows progress.
// Processes max 3 series at a time to stay under 10s per call.
// USA REST diretto con ignore-duplicates (NON la RPC sync_push_watched_items)
// perché la RPC fa DELETE-then-INSERT e cancellerebbe gli altri badge.
// Il unique index su watched_items(user_id, content_id, season, episode)
// garantisce che i duplicati vengano ignorati silenziosamente.
app.post('/push-episodes', async (req, res) => {
  const { nuvioEmail, nuvioPassword, stremioEmail, stremioPassword, offset = 0, batchSize = 3, dryRun = true } = req.body;
  if (!nuvioEmail || !nuvioPassword || !stremioEmail || !stremioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  const log = []; const L = m => { console.log(m); log.push(m); };
  try {
    const [stAuth, nvSess] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const token   = nvSess.access_token;
    const userId  = nvSess.user?.id;
    const ownerId = await getEffectiveOwnerId(token);

    const rawAll     = await getStremioLibraryRaw(stAuth.token);
    const normalized = rawAll.map(normalizeItem);

    const withField = normalized.filter(i => (i.type==='series'||i.type==='show') && i.state.watchedField);
    const batch     = withField.slice(offset, offset + batchSize);
    const total     = withField.length;
    L(`📺 Batch ${offset}-${offset+batch.length} di ${total} serie con bitfield`);

    const eps = await buildWatchedEpisodesPayload(batch, 3, m => L(m));
    L(`Episodi decodificati: ${eps.length}`);

    // dryRun=true → restituisce solo gli episodi decodificati, NON pushare nulla.
    // Il browser accumula tutti i batch e fa UN solo push finale con il dataset completo.
    // Questo evita il limite 1000 righe di sync_pull_watched_items che causava la perdita
    // di dati quando ogni batch leggeva il DB e sovrascriveva con meno righe.
    if (dryRun) {
      L(`📦 dryRun: ${eps.length} episodi pronti (nessun push)`);
      const done = (offset + batchSize) >= total;
      return res.json({
        success: true, log,
        episodes: eps,   // <-- array episodi da accumulare nel browser
        pushed: 0,
        offset, batchSize, total,
        done,
        nextOffset: done ? null : offset + batchSize,
        message: `📦 Batch ${offset}-${offset+batch.length}/${total}: ${eps.length} episodi decodificati`,
      });
    }

    // dryRun=false (default) → push immediato con dataset completo passato dal browser
    // NON usato nel flusso normale — solo per compatibilità backward
    let pushed = 0;
    if (eps.length > 0) {
      const current = await getNuvioWatchedItems(token);
      const currentPayload = current.map(w => ({
        content_id:   w.content_id,
        content_type: w.content_type,
        title:        w.title || '',
        season:       w.season != null ? Number(w.season) : null,
        episode:      w.episode != null ? Number(w.episode) : null,
        watched_at:   Number(w.watched_at) || Date.now(),
      }));
      const merged = dedupeWatched([...currentPayload, ...eps]);
      await supabaseRpc('sync_push_watched_items', { p_items: merged }, token);
      pushed = eps.length;
      L(`✅ Push OK: ${merged.length} items nel DB`);
    }

    const done = (offset + batchSize) >= total;
    res.json({
      success: true, log,
      pushed,
      offset, batchSize, total,
      done,
      nextOffset: done ? null : offset + batchSize,
      message: done
        ? `✅ Episodi completi: ${pushed} badge da ${total} serie`
        : `⏩ Batch ${offset}-${offset+batchSize}/${total} — continua con offset=${offset+batchSize}`,
    });
  } catch(e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log }); }
});

// ============================================================
// SELF-CONTAINED SYNC ENDPOINTS
// Each does its own login+fetch+build+push in one shot.
// Kept small to stay under Vercel 10s limit.
// /sync-library  : login both + fetch Stremio + push library only
// /sync-progress : login both + fetch Stremio + push CW only
// /sync-watched  : login both + fetch Stremio + push watched-titles only
// /push-episodes : login both + fetch Stremio + Cinemeta batch + push episodes
// Browser calls them in sequence.
// ============================================================

// ─── /sync-library ──────────────────────────────────────────
app.post('/sync-library', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, includeRemoved = false } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  try {
    const [stAuth, nvSess] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const rawAll   = await getStremioLibraryRaw(stAuth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    const source   = includeRemoved ? rawAll : rawActive;
    const payload  = buildLibraryPayload(source);
    await pushLibrary(payload, nvSess.access_token);
    const norm = rawAll.map(normalizeItem);
    const serieConBitfield = norm.filter(i => (i.type==='series'||i.type==='show') && i.state.watchedField).length;
    res.json({ success: true, pushed: payload.length, total: rawAll.length, active: rawActive.length, serieConBitfield });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── /sync-progress ─────────────────────────────────────────
app.post('/sync-progress', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  try {
    const [stAuth, nvSess] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const rawAll    = await getStremioLibraryRaw(stAuth.token);
    const normActive = rawAll.map(normalizeItem).filter(i => !i.removed && !i.temp);
    const payload   = buildWatchProgressPayload(normActive);
    await pushWatchProgress(payload, nvSess.access_token);
    const movies = payload.filter(i => i.content_type === 'movie').length;
    const series = payload.filter(i => i.content_type === 'series').length;
    res.json({
      success: true,
      pushed: payload.length,
      movies, series,
      message: `✅ ${payload.length} CW pushati (${movies} film, ${series} serie)`,
      sample: payload.slice(0, 5).map(i => `${i.content_id} ${i.content_type} video_id="${i.video_id}" ${Math.round(i.position/i.duration*100)}%`),
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── /sync-watched ──────────────────────────────────────────
// Sincronizza TUTTI i watched da Stremio → Nuvio (titoli livello-serie/film).
// NON include episodi singoli (per quelli usa /push-episodes).
app.post('/sync-watched', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  try {
    const [stAuth, nvSess] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const rawAll  = await getStremioLibraryRaw(stAuth.token);
    const norm    = rawAll.map(normalizeItem);
    const payload = dedupeWatched(buildWatchedPayload(norm));
    await pushWatchedItems(payload, nvSess.access_token);
    const movies  = payload.filter(i => i.content_type === 'movie').length;
    const series  = payload.filter(i => i.content_type === 'series').length;
    res.json({
      success: true,
      pushed: payload.length,
      movies, series,
      message: `✅ ${payload.length} watched pushati (${movies} film, ${series} serie)`,
      sample: payload.slice(0, 5).map(i => `${i.content_id} ${i.content_type} "${i.title}"`),
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── /sync ──────────────────────────────────────────────────
// Full nuke-and-replace: login both + fetch Stremio + nuke Nuvio + push all

// ─── /nuke-and-sync ──────────────────────────────────────────
// Wipe tutto Nuvio poi reimport da zero — garantisce zero duplicati
app.post('/nuke-and-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword,
          includeWatchedEpisodes = true, includeRemoved = false } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
    addLog('\ud83d\udca3 NUKE & SYNC \u2014 Pulizia totale + reimport...');
    const stAuth = await stremioLogin(stremioEmail, stremioPassword);
    addLog('\u2705 Login Stremio');
    const rawAll    = await getStremioLibraryRaw(stAuth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    addLog(`\ud83d\udcda Stremio: ${rawActive.length} attivi / ${rawAll.filter(i=>i.removed).length} rimossi`);
    if (!rawActive.length) return res.json({ success: false, error: 'Libreria Stremio vuota' });
    const normalized       = rawAll.map(normalizeItem);
    const normalizedActive = normalized.filter(i => !i.removed && !i.temp);
    const librarySource    = includeRemoved ? rawAll : rawActive;
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token        = nuvioSession.access_token;
    const ownerId      = await getEffectiveOwnerId(token);
    addLog(`\u2705 Login Nuvio \u2014 owner: ${ownerId}`);
    addLog('\ud83d\uddd1\ufe0f Pulizia library...');
    await supabaseRpc('sync_push_library', { p_items: [] }, token);
    addLog('\ud83d\uddd1\ufe0f Pulizia watched...');
    await supabaseRpc('sync_push_watched_items', { p_items: [] }, token);
    addLog('\ud83d\uddd1\ufe0f Pulizia progress...');
    await supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token);
    await Promise.allSettled([
      fetch(SUPABASE_URL + '/rest/v1/watched_items?user_id=eq.' + ownerId, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' },
      }),
      fetch(SUPABASE_URL + '/rest/v1/watch_progress?user_id=eq.' + ownerId, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' },
      }),
    ]);
    addLog('\u2705 Pulizia completata');
    const warnings = [];
    const libraryPayload = buildLibraryPayload(librarySource);
    addLog(`\ud83d\udce6 Library: ${libraryPayload.length} item (deduplicati da ${librarySource.length})`);
    await pushLibrary(libraryPayload, token);
    addLog('\u2705 Library OK');
    // Passa normalized completo (inclusi rimossi) per includere CW di item rimossi
    const progressPayload = buildWatchProgressPayload(normalized);
    addLog(`\u23e9 Progress: ${progressPayload.length} item`);
    // Log dettagliato di ogni CW item
    progressPayload.forEach(p => addLog(`  CW: ${p.content_id} ${p.content_type} video_id="${p.video_id}" S${p.season}E${p.episode} ${Math.round(p.position/p.duration*100)}%`));
    // Verifica anche i candidati scartati (fuori range pct o senza S/E)
    const allCwCandidates = normalizedActive.filter(i => i.state.timeOffset > 0 && i.state.duration > 0);
    const cwSkipped = allCwCandidates.filter(i => {
      const cid = extractContentId(i.id);
      return !progressPayload.some(p => p.content_id === cid);
    });
    if (cwSkipped.length > 0) {
      addLog(`  Scartati dal CW (${cwSkipped.length}):`);
      cwSkipped.forEach(i => {
        const pct = Math.round(i.state.timeOffset / i.state.duration * 100);
        addLog(`    ✗ "${i.name}" id="${i.id}" videoId="${i.state.videoId}" pct=${pct}%`);
      });
    }
    try { await pushWatchProgress(progressPayload, token); addLog('\u2705 Progress OK'); }
    catch (e) { addLog(`\u26a0\ufe0f Progress: ${e.message}`); warnings.push(`Progress: ${e.message}`); }
    const watchedTitles = buildWatchedPayload(normalized);
    // NON chiamiamo buildWatchedEpisodesPayload qui: richiede Cinemeta per 79 serie
    // e supera il timeout 10s di Vercel — usa /push-episodes separatamente se servono episodi reali.
    // I proxy S1E1 sotto sono SUFFICIENTI per i badge serie in Nuvio.
    addLog(`\ud83d\udce4 Push ${watchedTitles.length} watched titoli-livello...`);
    addLog(`  film visti: ${watchedTitles.filter(i=>i.content_type==='movie').length} | serie viste: ${watchedTitles.filter(i=>i.content_type==='series').length}`);
    try { await pushWatchedItems(watchedTitles, token); addLog('\u2705 Watched titoli-livello OK'); }
    catch (e) { addLog(`\u26a0\ufe0f Watched: ${e.message}`); warnings.push(`Watched: ${e.message}`); }

    // Push proxy S1E1 per serie watched (badge Nuvio richiede episodi per le serie)
    const watchedSeriesTitles = watchedTitles.filter(w => w.content_type === 'series');
    addLog(`\ud83c\udfa6 Badge serie: ${watchedSeriesTitles.length} serie → proxy S1E1...`);
    try {
      const pushed = await pushSeriesProxyEpisodes(watchedSeriesTitles, token, ownerId);
      addLog(`\u2705 Badge serie OK: ${pushed} proxy S1E1 pushati`);
    } catch(e) { addLog(`\u26a0\ufe0f Badge serie: ${e.message}`); warnings.push(`Badge serie: ${e.message}`); }

    // Assicura che WATCHED e CW siano in library
    // (Nuvio mostra badge e CW solo se il titolo è in library)
    const libraryCidSet = new Set(libraryPayload.map(l => l.content_id));
    // Aggiungi anche i CW items che non sono in library (es. serie rimosse da Stremio)
    const cwMissingFromLib = progressPayload.filter(p => !libraryCidSet.has(p.content_id));
    const missingWatched = [
      ...watchedTitles.filter(w => !libraryCidSet.has(w.content_id)),
      ...cwMissingFromLib.map(p => ({ content_id: p.content_id, content_type: p.content_type, title: '' })),
    ].filter((v, i, a) => a.findIndex(x => x.content_id === v.content_id) === i); // dedup
    if (missingWatched.length > 0) {
      addLog(`\u26a0\ufe0f ${missingWatched.length} watched non in library (rimossi/anime) → aggiungo alla library...`);
      const extraLib = missingWatched.map(w => {
        const raw = normalized.find(i => extractContentId(i.id) === w.content_id);
        return {
          content_id:    w.content_id,
          content_type:  w.content_type,
          name:          (raw && raw.name) || w.title || w.content_id,
          poster:        (raw && raw.poster) || null,
          poster_shape:  'POSTER',
          background:    null,
          description:   null,
          release_info:  (raw && raw.year) ? String(raw.year) : '',
          imdb_rating:   (raw && raw.imdbRating) || null,
          genres:        (raw && raw.genres) || [],
          addon_base_url: null,
          added_at:      toMs((raw && raw.mtime) || null),
        };
      }).filter(Boolean);
      if (extraLib.length > 0) {
        const fullLib = [...libraryPayload, ...extraLib];
        try {
          await supabaseRpc('sync_push_library', { p_items: fullLib }, token);
          addLog(`\u2705 Library aggiornata con ${extraLib.length} extra (totale ${fullLib.length})`);
        } catch(e) { addLog(`\u26a0\ufe0f Library extra: ${e.message}`); }
      }
    }

    const [finalLib, finalW, finalP] = await Promise.all([
      getNuvioLibrary(token), getNuvioWatchedItems(token), getNuvioWatchProgress(token),
    ]);
    addLog(`\n\ud83d\udcca NUVIO DOPO: library=${finalLib.length} watched=${finalW.length} progress=${finalP.length}`);
    res.json({
      success: true, warnings, log,
      message: warnings.length
        ? `\u26a0\ufe0f Nuke & Sync con ${warnings.length} warning. Library:${finalLib.length}`
        : `\u2705 NUKE & SYNC COMPLETO!\nLibrary:${finalLib.length} \u00b7 Watched:${finalW.length} \u00b7 CW:${finalP.length}`,
      stats: {
        stremioActive: rawActive.length, pushedLibrary: libraryPayload.length,
        pushedProgress: progressPayload.length, pushedWatched: allWatched.length,
        nuvioLibraryAfter: finalLib.length, nuvioWatchedAfter: finalW.length, nuvioProgressAfter: finalP.length,
      },
    });
  } catch (e) {
    addLog(`\ud83d\udca5 ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log });
  }
});

app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword,
          includeRemoved = false } = req.body;
  // Gli episodi sono sempre inclusi nel sync — quando il developer
  // aggiungerà il fix in setLocalWatchedStatus per scrivere watched:series:id
  // in mmkv, i badge serie compariranno automaticamente al prossimo sync.
  const includeWatchedEpisodes = true;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
    addLog('🚀 Sync Stremio → Nuvio...');
    const sa = await stremioLogin(stremioEmail, stremioPassword);
    addLog('✅ Login Stremio');
    const rawAll = await getStremioLibraryRaw(sa.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    addLog(`📚 Stremio: ${rawActive.length} attivi / ${rawAll.filter(i=>i.removed).length} rimossi`);
    if (!rawActive.length) return res.json({ success: false, error: 'Libreria Stremio vuota' });
    const normalized = rawAll.map(normalizeItem);
    const normalizedActive = normalized.filter(i => !i.removed && !i.temp);
    const librarySource = includeRemoved ? rawAll : rawActive;
    const ns = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token = ns.access_token;
    addLog('✅ Login Nuvio');
    const warnings = [];
    // Nuke
    try {
      await Promise.all([
        supabaseRpc('sync_push_library',        { p_items:   [] }, token),
        supabaseRpc('sync_push_watched_items',  { p_items:   [] }, token),
        supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token),
      ]);
      addLog('✅ Nuke OK');
    } catch(e) { addLog(`⚠️ Nuke: ${e.message}`); }
    // Library
    const lp = buildLibraryPayload(librarySource);
    addLog(`📦 Library: ${lp.length}`);
    try { await pushLibrary(lp, token); addLog('✅ Library OK'); }
    catch(e) { addLog(`❌ Library: ${e.message}`); warnings.push(e.message); }
    // Progress
    const pp = buildWatchProgressPayload(normalizedActive);
    addLog(`⏩ CW: ${pp.length}`);
    try { await pushWatchProgress(pp, token); addLog('✅ Progress OK'); }
    catch(e) { addLog(`⚠️ Progress: ${e.message}`); warnings.push(e.message); }
    // Watched
    const wt = buildWatchedPayload(normalized);
    addLog(`🎬 Watched: ${wt.length}`);
    let we = [];
    if (includeWatchedEpisodes) {
      try { we = await buildWatchedEpisodesPayload(normalized, 5, m => addLog('  '+m)); addLog(`✅ Episodi: ${we.length}`); }
      catch(e) { addLog(`⚠️ Episodi: ${e.message}`); warnings.push(e.message); }
    }
    const aw = dedupeWatched([...wt, ...we]);
    try { await pushWatchedItems(aw, token); addLog(`✅ Watched OK (${aw.length})`); }
    catch(e) { addLog(`⚠️ Watched: ${e.message}`); warnings.push(e.message); }
    addLog('✅ SYNC COMPLETO!');
    res.json({ success: true, warnings, log,
      message: `✅ SYNC OK!\nLibrary:${lp.length} · Watched:${aw.length} · CW:${pp.length}`,
      stats: { pushedLibrary: lp.length, pushedWatched: aw.length, pushedProgress: pp.length,
               serieConEpisodi: normalized.filter(i=>(i.type==='series'||i.type==='show')&&i.state.watchedField).length } });
  } catch(e) { addLog(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log }); }
});

// ─── force-all-badges ────────────────────────────────────────
app.post('/force-all-badges', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail||!stremioPassword||!nuvioEmail||!nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
    addLog('🔥 Force All Badges...');
    const sa  = await stremioLogin(stremioEmail, stremioPassword);
    const raw = await getStremioLibraryRaw(sa.token);
    const norm = raw.map(normalizeItem);
    addLog(`Stremio: ${raw.length} totali`);
    const ns    = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token = ns.access_token;

    const libPl = buildLibraryPayload(raw.filter(i => !i.removed));
    await pushLibrary(libPl, token);
    addLog(`✅ Library: ${libPl.length}`);

    const wt = buildWatchedPayload(norm);
    addLog(`📺 Decodifica episodi...`);
    const we = await buildWatchedEpisodesPayload(norm, 5, addLog);
    const aw = dedupeWatched([...wt, ...we]);
    await pushWatchedItems(aw, token);
    addLog(`✅ Watched: ${aw.length} (${wt.length} titoli + ${we.length} ep)`);

    res.json({ success: true, log,
      message: `🎉 ${aw.length} badge! (${wt.length} titoli + ${we.length} ep)`,
      stats: { watchedTitles: wt.length, watchedEpisodes: we.length, total: aw.length },
    });
  } catch (e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

// ─── reset-watched ───────────────────────────────────────────
app.post('/reset-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali richieste' });

  res.json({ success: true, message: '✅ Reset avviato. Attendi 5 secondi poi fai Carica Nuvio per verificare.', before: '?', after: 0 });

  setImmediate(async () => {
    try {
      const session = await supabaseLogin(nuvioEmail, nuvioPassword);
      const token   = session.access_token;
      const ownerId = await getEffectiveOwnerId(token);
      await supabaseRpc('sync_push_watched_items', { p_items: [] }, token);
      await supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token);
      await Promise.allSettled([
        fetch(SUPABASE_URL + '/rest/v1/watched_items?user_id=eq.' + ownerId, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' },
        }),
        fetch(SUPABASE_URL + '/rest/v1/watch_progress?user_id=eq.' + ownerId, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' },
        }),
      ]);
      console.log('reset-watched background: done for owner', ownerId);
    } catch(e) { console.error('reset-watched background error:', e.message); }
  });
});

// ─── reset-library ───────────────────────────────────────────
// Wipes library + watched + progress in parallel — no pre-count to stay fast
app.post('/reset-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword, nuvioToken } = req.body;
  if (!nuvioToken && (!nuvioEmail || !nuvioPassword)) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const token = nuvioToken || (await supabaseLogin(nuvioEmail, nuvioPassword)).access_token;
    const ownerId  = await getEffectiveOwnerId(token);
    // Push empty arrays (RPC does DELETE-then-INSERT) + direct DELETE, all in parallel
    await Promise.all([
      supabaseRpc('sync_push_library',        { p_items:   [] }, token),
      supabaseRpc('sync_push_watched_items',  { p_items:   [] }, token),
      supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token),
      fetch(SUPABASE_URL + '/rest/v1/watched_items?user_id=eq.'  + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
      fetch(SUPABASE_URL + '/rest/v1/watch_progress?user_id=eq.' + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
    ]);
    res.json({ success: true, message: '✅ Library + watched + progress azzerati', before: '?' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── mark-watched ────────────────────────────────────────────
// Segna/rimuovi badge visto per UN item specifico su Nuvio.
// Usa DELETE + INSERT REST diretto (~200ms, no timeout Vercel).
// Se REST fallisce (RLS) → fallback RPC in background.
// NOTA: questo NON usa i dati Stremio — aggiorna solo Nuvio DB.
// Per sincronizzare TUTTI i watched da Stremio usa /sync-watched.
app.post('/mark-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId, contentType, title, watched = true } = req.body;
  if (!nuvioEmail || !nuvioPassword || !contentId || !contentType)
    return res.status(400).json({ success: false, error: 'Parametri richiesti' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const userId  = session.user?.id;

    const filterQ = `content_id=eq.${encodeURIComponent(contentId)}`
                  + `&content_type=eq.${encodeURIComponent(contentType)}`
                  + `&season=is.null&episode=is.null`;
    const baseHeaders = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Prefer': 'return=minimal',
    };

    // Sempre DELETE prima (evita duplicati — watched_items senza unique constraint)
    const delR = await fetch(`${SUPABASE_URL}/rest/v1/watched_items?${filterQ}`, {
      method: 'DELETE', headers: baseHeaders,
    });
    const delOk = delR.ok || delR.status === 404;

    let insertOk = true;
    if (watched) {
      const insR = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id:      userId,
          content_id:   contentId,
          content_type: 'movie',  // sempre 'movie' per watched title-level (fix badge serie)
          title:        title || contentId,
          season:       null,
          episode:      null,
          watched_at:   Date.now(),
          profile_id:   1,
        }),
      });
      insertOk = insR.ok;
      if (!insR.ok) {
        const errText = await insR.text();
        console.warn(`mark-watched INSERT failed (${insR.status}): ${errText.slice(0,200)}`);
        // Fallback RPC in background
        setImmediate(async () => {
          try {
            const current  = await getNuvioWatchedItems(token);
            const filtered = current.filter(i =>
              !(String(i.content_id) === contentId && String(i.content_type) === contentType
                && i.season == null && i.episode == null)
            );
            await pushWatchedItems([...filtered, {
              content_id: contentId, content_type: contentType,
              title: title || contentId, season: null, episode: null, watched_at: Date.now(),
            }], token);
            console.log(`mark-watched RPC fallback OK: ${contentId}`);
          } catch(e2) { console.error('mark-watched RPC fallback:', e2.message); }
        });
      }

      // Per le SERIE: Nuvio mostra il badge solo se esiste almeno un episodio watched.
      // Inseriamo un proxy S1E1 — necessario e sufficiente per il badge nell'app.
      if (contentType === 'series') {
        // Prima elimina eventuali proxy S1E1 già presenti (evita duplicati)
        const filterEp = `content_id=eq.${encodeURIComponent(contentId)}`
                       + `&content_type=eq.series&season=eq.1&episode=eq.1`;
        await fetch(`${SUPABASE_URL}/rest/v1/watched_items?${filterEp}`, {
          method: 'DELETE', headers: baseHeaders,
        }).catch(() => {});

        // Inserisci proxy S1E1
        const epR = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, {
          method: 'POST',
          headers: { ...baseHeaders, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            user_id:      userId,
            content_id:   contentId,
            content_type: 'movie',  // 'movie' anche per episodi watched
            title:        title || contentId,
            season:       1,
            episode:      1,
            watched_at:   Date.now(),
            profile_id:   1,
          }),
        });
        if (!epR.ok) {
          console.warn(`mark-watched S1E1 proxy failed (${epR.status})`);
        } else {
          console.log(`mark-watched S1E1 proxy OK: ${contentId}`);
        }
      }
    } else {
      // Se si rimuove il badge da una serie, rimuovi anche i proxy S1E1
      if (contentType === 'series') {
        const filterEp = `content_id=eq.${encodeURIComponent(contentId)}`
                       + `&content_type=eq.series&season=is.not.null`;
        await fetch(`${SUPABASE_URL}/rest/v1/watched_items?${filterEp}`, {
          method: 'DELETE', headers: baseHeaders,
        }).catch(() => {});
      }
    }

    if (!delOk) console.warn(`mark-watched DELETE failed (${delR.status})`);

    res.json({
      success: true,
      via: (insertOk && delOk) ? 'rest' : 'rpc-fallback',
      message: `✅ "${title || contentId}" ${watched ? 'marcato come visto' : 'badge rimosso'}`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── add-to-nuvio ────────────────────────────────────────────
// REST diretto: INSERT singolo senza scaricare tutta la libreria
app.post('/add-to-nuvio', async (req, res) => {
  const { nuvioEmail, nuvioPassword, item } = req.body;
  if (!nuvioEmail || !nuvioPassword || !item)
    return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const userId  = session.user?.id;
    const cid     = extractContentId(item._id || item.id || item.content_id || '');
    const ct      = normalizeType(item.type || item.content_type || 'movie');
    if (!cid) return res.status(400).json({ success: false, error: 'ID non valido' });
    const built = buildLibraryPayload([item])[0];
    if (!built) return res.status(400).json({ success: false, error: 'Impossibile costruire payload' });
    // Upsert via REST con resolution=ignore-duplicates (non modifica se esiste già)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/library_items`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({ ...built, user_id: userId, profile_id: 1 }),
    });
    if (!r.ok) {
      // Fallback: scarica libreria + usa RPC (più lento ma sicuro)
      const errText = await r.text();
      console.warn(`add-to-nuvio REST failed (${r.status}): ${errText} — fallback RPC`);
      const current = await getNuvioLibrary(token);
      const exists = current.some(i => String(i.content_id) === cid && String(i.content_type) === ct);
      if (exists) return res.json({ success: true, message: `"${item.name}" è già nella libreria Nuvio` });
      const allItems = [...current.map(i => ({
        content_id: i.content_id, content_type: i.content_type, name: i.name||'',
        poster: i.poster||null, poster_shape: i.poster_shape||'POSTER',
        background: i.background||null, release_info: i.release_info||'',
        imdb_rating: i.imdb_rating||null, genres: i.genres||[], addon_base_url: null,
        added_at: i.added_at||Date.now(),
      })), built];
      await pushLibrary(allItems, token);
    }
    res.json({ success: true, message: `✅ "${item.name||cid}" aggiunto alla libreria Nuvio` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── remove-from-nuvio ───────────────────────────────────────
// REST diretto: DELETE singolo senza scaricare tutta la libreria
app.post('/remove-from-nuvio', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId, contentType } = req.body;
  if (!nuvioEmail || !nuvioPassword || !contentId)
    return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    let filterQ = `content_id=eq.${encodeURIComponent(contentId)}`;
    if (contentType) filterQ += `&content_type=eq.${encodeURIComponent(contentType)}`;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/library_items?${filterQ}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'return=minimal',
      },
    });
    if (!r.ok) {
      // Fallback: scarica libreria + usa RPC
      const errText = await r.text();
      console.warn(`remove-from-nuvio REST failed (${r.status}): ${errText} — fallback RPC`);
      const current  = await getNuvioLibrary(token);
      const filtered = current.filter(i =>
        !(String(i.content_id) === contentId && (!contentType || String(i.content_type) === contentType))
      );
      if (filtered.length === current.length)
        return res.json({ success: true, message: 'Item non trovato nella libreria Nuvio' });
      await pushLibrary(filtered.map(i => ({
        content_id: i.content_id, content_type: i.content_type, name: i.name||'',
        poster: i.poster||null, poster_shape: i.poster_shape||'POSTER',
        background: i.background||null, release_info: i.release_info||'',
        imdb_rating: i.imdb_rating||null, genres: i.genres||[], addon_base_url: null,
        added_at: i.added_at||Date.now(),
      })), token);
    }
    res.json({ success: true, message: `✅ Rimosso dalla libreria Nuvio` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── DEBUG RAW STREMIO ───────────────────────────────────────
app.post('/debug-raw-stremio', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const auth   = await stremioLogin(email, password);
    const rawAll = await getStremioLibraryRaw(auth.token);
    const norm   = rawAll.map(normalizeItem);

    const moviesWatched  = norm.filter(i => i.type === 'movie' && (i.state.watchedBool || i.state.timesWatched > 0 || i.state.flaggedWatched > 0 || (i.state.duration > 0 && i.state.timeOffset / i.state.duration >= 0.80)));
    const seriesWatched  = norm.filter(i => (i.type === 'series' || i.type === 'show') && (i.state.watchedBool || i.state.timesWatched > 0 || i.state.flaggedWatched > 0 || i.state.watchedField));
    const inProgress     = norm.filter(i => i.state.timeOffset > 0 && i.state.duration > 0 && !i.removed && (i.state.timeOffset / i.state.duration) >= 0.03 && (i.state.timeOffset / i.state.duration) <= 0.92);

    const stateKeys = rawAll.length > 0 ? Object.keys(rawAll[0].state || {}) : [];
    const firstItem = rawAll[0];
    const firstState = firstItem?.state || {};

    const cwSample = inProgress.slice(0, 5).map(i => `${i.name} | ${i.type} | pct:${Math.round(i.state.timeOffset/i.state.duration*100)}% | videoId:${i.state.videoId||'null'} | tw:${i.state.timesWatched} | fw:${i.state.flaggedWatched}`);
    const watchedSample = moviesWatched.slice(0, 5).map(i => `${i.name} | tw:${i.state.timesWatched} | fw:${i.state.flaggedWatched} | pct:${i.state.duration>0?Math.round(i.state.timeOffset/i.state.duration*100)+'%':'?'}`);

    res.json({
      success: true,
      summary: {
        total: rawAll.length,
        active: rawAll.filter(i => !i.removed && !i.temp).length,
        removed: rawAll.filter(i => i.removed).length,
        movies: rawAll.filter(i => i.type === 'movie').length,
        series: rawAll.filter(i => i.type === 'series' || i.type === 'show').length,
        moviesWatched: moviesWatched.length,
        seriesWatched: seriesWatched.length,
        inProgress: inProgress.length,
        seriesWithBitfield: norm.filter(i => i.state.watchedField).length,
      },
      firstItemStateKeys: stateKeys,
      firstItemState: {
        timeOffset: firstState.timeOffset,
        duration: firstState.duration,
        timesWatched: firstState.timesWatched,
        flaggedWatched: firstState.flaggedWatched,
        videoId: firstState.videoId || firstState.video_id,
        lastWatched: firstState.lastWatched,
        watched: typeof firstState.watched === 'string' ? firstState.watched.slice(0, 50) + '...' : firstState.watched,
      },
      cwSample,
      watchedSample,
    });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message).slice(0, 200) }); }
});

// ─── debug-watched ───────────────────────────────────────────
app.post('/debug-watched', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
    const sa     = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll = await getStremioLibraryRaw(sa.token);
    const norm   = rawAll.map(normalizeItem);
    const wt = buildWatchedPayload(norm);
    const pr = buildWatchProgressPayload(norm.filter(i => !i.removed && !i.temp));
    addLog(`Stremio: ${rawAll.length} · Watched: ${wt.length} · Progress: ${pr.length}`);
    if (wt.length) addLog(`Esempio watched: ${JSON.stringify(wt[0])}`);
    if (pr.length) addLog(`Esempio progress: ${JSON.stringify(pr[0])}`);
    const ns    = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token = ns.access_token;
    addLog(`Owner: ${await getEffectiveOwnerId(token).catch(() => '?')}`);
    const existing = await getNuvioWatchedItems(token);
    addLog(`Watched Nuvio: ${existing.length}`);
    if (wt.length) {
      addLog(`\nTest push 1 watched: ${JSON.stringify(wt[0])}`);
      try {
        await supabaseRpc('sync_push_watched_items', { p_items: [wt[0]] }, token);
        const after = await getNuvioWatchedItems(token);
        addLog(`${after.some(w => w.content_id === wt[0].content_id) ? '✅' : '❌'}`);
      } catch (e) { addLog(`❌ ${e.message}`); }
    }
    if (pr.length) {
      addLog(`\nTest push 1 progress: ${JSON.stringify(pr[0])}`);
      try {
        await supabaseRpc('sync_push_watch_progress', { p_entries: [pr[0]] }, token);
        addLog('✅ Progress push OK');
      } catch (e) { addLog(`❌ ${e.message}`); }
    }
    res.json({ success: true, log, sample: { wt: wt.slice(0,3), pr: pr.slice(0,3) } });
  } catch (e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

// ─── debug-episodes-full ─────────────────────────────────────
app.post('/debug-episodes-full', async (req, res) => {
  const { stremioEmail, stremioPassword } = req.body;
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
    const auth   = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll = await getStremioLibraryRaw(auth.token);
    const norm   = rawAll.map(normalizeItem);
    const wf     = norm.filter(i => (i.type==='series'||i.type==='show') && i.state.watchedField);
    addLog(`Serie con watchedField: ${wf.length}`);
    const eps = await buildWatchedEpisodesPayload(norm, 5, addLog);
    addLog(`Episodi: ${eps.length}`);
    res.json({ success: true, log, stats: { total: rawAll.length, seriesWithField: wf.length, episodes: eps.length }, sample: eps.slice(0,10) });
  } catch (e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

// ─── debug-library ───────────────────────────────────────────
app.post('/debug-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    log.push(`Owner: ${await getEffectiveOwnerId(token).catch(() => '?')}`);
    const [library, watched, progress] = await Promise.all([
      getNuvioLibrary(token), getNuvioWatchedItems(token), getNuvioWatchProgress(token),
    ]);
    log.push(`Library:${library.length} Watched:${watched.length} Progress:${progress.length}`);
    res.json({ success: true, log, library: library.slice(0,20), watched: watched.slice(0,10), total: library.length });
  } catch (e) { res.status(500).json({ success: false, log, error: e.message }); }
});

// ─── check-nuvio-watched ─────────────────────────────────────
app.post('/check-nuvio-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId } = req.body;
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const items   = await getNuvioWatchedItems(session.access_token);
    const result  = { success: true, total: items.length,
      movies: items.filter(i=>i.content_type==='movie'&&i.season==null).length,
      seriesLevel: items.filter(i=>i.content_type==='series'&&i.season==null).length,
      episodes: items.filter(i=>i.season!=null&&i.episode!=null).length,
      sample: items.slice(0,10) };
    if (contentId) result.specific = items.filter(i=>i.content_id===contentId||i.content_id.includes(contentId));
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── debug-stremio-library ───────────────────────────────────
app.post('/debug-stremio-library', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth  = await stremioLogin(email, password);
    const items = await getStremioLibraryRaw(auth.token);
    const norm  = items.map(normalizeItem);
    const inPr  = norm.filter(i => i.state.timeOffset > 0 && i.state.duration > 0 && !i.removed);
    res.json({ success: true, rows_count: items.length, inProgress: inPr.length, sample: items.slice(0,3),
      progressSample: inPr.slice(0,5).map(i => ({
        id: i.id, name: i.name, type: i.type,
        pct: Math.round(i.state.timeOffset/i.state.duration*100)+'%',
        videoId: i.state.videoId,
      })),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── debug-sync ──────────────────────────────────────────────
app.post('/debug-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  try {
    const [sa, ns] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const [si, nl] = await Promise.all([getStremioLibraryRaw(sa.token).then(i=>i.filter(x=>!x.removed&&!x.temp)), getNuvioLibrary(ns.access_token)]);
    res.json({ success: true, stats: { stremio: si.length, nuvio: nl.length } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── debug-full-sync ─────────────────────────────────────────
app.post('/debug-full-sync', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId = 'tt0111161' } = req.body;
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  if (!nuvioEmail||!nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    addLog(`Owner: ${await getEffectiveOwnerId(token).catch(() => '?')}`);
    try {
      await supabaseRpc('sync_push_watched_items', { p_items: [{ content_id: contentId, content_type: 'movie', title: 'Test', season: null, episode: null, watched_at: Date.now() }] }, token);
      const w = await getNuvioWatchedItems(token);
      addLog(`Watched: ${w.some(i=>i.content_id===contentId)?'✅':'❌'}`);
    } catch (e) { addLog(`Watched ❌: ${e.message}`); }
    try {
      await supabaseRpc('sync_push_library', { p_items: [{ content_id: contentId, content_type: 'movie', name: 'Test', poster: null, poster_shape: 'POSTER', added_at: Date.now() }] }, token);
      const l = await getNuvioLibrary(token);
      addLog(`Library: ${l.some(i=>i.content_id===contentId)?'✅':'❌'}`);
    } catch (e) { addLog(`Library ❌: ${e.message}`); }
    try {
      await supabaseRpc('sync_push_watch_progress', { p_entries: [{ content_id: contentId, content_type: 'movie', video_id: contentId, season: null, episode: null, position: 120000, duration: 240000, last_watched: Date.now(), progress_key: contentId }] }, token);
      addLog('Progress ✅');
    } catch (e) { addLog(`Progress ❌: ${e.message}`); }
    res.json({ success: true, log });
  } catch (e) { addLog(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

// ─── nuvio-stats-fast ────────────────────────────────────────
app.post('/nuvio-stats-fast', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);

    async function countTable(table) {
      try {
        const r = await fetch(
          SUPABASE_URL + '/rest/v1/' + table + '?user_id=eq.' + ownerId + '&select=id',
          { method: 'GET', headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + token,
            'Prefer': 'count=exact',
            'Range': '0-0',
          }}
        );
        const contentRange = r.headers.get('content-range');
        if (contentRange) {
          const parts = contentRange.split('/');
          if (parts[1] && parts[1] !== '*') return parseInt(parts[1], 10);
        }
        const data = await r.json();
        return Array.isArray(data) ? data.length : '?';
      } catch { return '?'; }
    }

    const [library, watched, progress] = await Promise.all([
      countTable('library_items'),
      countTable('watched_items'),
      countTable('watch_progress'),
    ]);

    res.json({
      success: true,
      ownerId,
      counts: { library, watched, progress },
      message: library === 0
        ? '⚠️ Library VUOTA nel DB — il sync non ha funzionato'
        : watched === 0
          ? '⚠️ Watched VUOTO — i badge non sono stati pushati'
          : '✅ DB OK: dati presenti',
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── tmdb-poster ─────────────────────────────────────────────
app.get('/tmdb-poster', async (req, res) => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(204).end();
  const { title, year, type } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const ep   = type === 'movie'
      ? `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year||''}&language=it-IT`
      : `https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=it-IT`;
    const r    = await fetch(ep);
    const data = await r.json();
    const url  = data.results?.[0]?.poster_path ? `https://image.tmdb.org/t/p/w185${data.results[0].poster_path}` : null;
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ url });
  } catch { res.status(500).json({ url: null }); }
});

// ─── /diagnose ────────────────────────────────────────────────
// Full diagnostic: reads Stremio raw data + Nuvio DB state + tests a single push.
// Call this to understand EXACTLY why sync/watched/CW is not working.
app.post('/diagnose', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Tutte e 4 le credenziali richieste' });

  const L = []; const log = m => { console.log('[diag]', m); L.push(m); };

  try {
    log('━━━ STEP 1: LOGIN ━━━');
    const [stAuth, nvSess] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const token   = nvSess.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    log(`✅ Stremio OK | Nuvio owner: ${ownerId}`);

    log('');
    log('━━━ STEP 2: LEGGO STREMIO RAW ━━━');
    const rawAll = await getStremioLibraryRaw(stAuth.token);
    const norm   = rawAll.map(normalizeItem);
    const active = norm.filter(i => !i.removed && !i.temp);
    log(`Totale items: ${rawAll.length}`);
    log(`Attivi: ${active.length} | Rimossi: ${norm.filter(i=>i.removed).length}`);
    log(`Film: ${active.filter(i=>i.type==='movie').length} | Serie: ${active.filter(i=>i.type==='series'||i.type==='show').length}`);

    // CW signals
    const cwItems = active.filter(i => i.state.timeOffset > 0 && i.state.duration > 0);
    const cwValid = cwItems.filter(i => {
      const pct = i.state.timeOffset / i.state.duration * 100;
      const ct  = normalizeType(i.type);
      if (ct === 'series') {
        const vid = String(i.state.videoId || '');
        const { season, episode } = parseSE(vid);
        return pct >= 3 && pct <= 92 && season != null && episode != null;
      }
      return pct >= 3 && pct <= 92;
    });
    log('');
    log(`CW items con timeOffset>0: ${cwItems.length}`);
    log(`CW validi (pct 3-92% + S/E per serie): ${cwValid.length}`);
    if (cwItems.length > 0 && cwValid.length === 0) {
      log('⚠️  CW PROBLEMA: tutti gli item CW sono serie senza S/E nel videoId!');
      cwItems.slice(0,3).forEach(i => {
        const pct = Math.round(i.state.timeOffset / i.state.duration * 100);
        log(`   → "${i.name}" | videoId="${i.state.videoId}" | pct=${pct}%`);
      });
    } else if (cwValid.length > 0) {
      cwValid.slice(0,3).forEach(i => {
        const pct = Math.round(i.state.timeOffset / i.state.duration * 100);
        const vid = String(i.state.videoId || i.id);
        log(`   ✓ "${i.name}" | videoId="${vid}" | pct=${pct}%`);
      });
    }

    // Watched signals
    const wTitles = buildWatchedPayload(norm);
    const wBitfield = norm.filter(i => i.state.watchedField).length;
    log('');
    log(`Watched titoli (tw>0 | fw>0 | pct>=80%): ${wTitles.length}`);
    log(`Serie con bitfield episodi: ${wBitfield}`);
    if (wTitles.length === 0) {
      log('⚠️  WATCHED PROBLEMA: nessun segnale di visione trovato in Stremio');
      log('   Stremio non traccia visioni localmente se usi Trakt/Simkl/Letterboxd');
      const sample = active.slice(0,3);
      sample.forEach(i => log(`   → "${i.name}" tw=${i.state.timesWatched} fw=${i.state.flaggedWatched} pct=${i.state.duration>0?Math.round(i.state.timeOffset/i.state.duration*100)+'%':'n/a'}`));
    } else {
      wTitles.slice(0,3).forEach(i => log(`   ✓ ${i.content_id} "${i.title}"`));
    }

    log('');
    log('━━━ STEP 3: LEGGO NUVIO DB ATTUALE ━━━');
    const [nvLib, nvWatched, nvProgress] = await Promise.all([
      getNuvioLibrary(token),
      getNuvioWatchedItems(token),
      getNuvioWatchProgress(token),
    ]);
    log(`library_items:  ${nvLib.length}`);
    log(`watched_items:  ${nvWatched.length}`);
    log(`watch_progress: ${nvProgress.length}`);

    // Duplicates check
    const libKeys = nvLib.map(i => `${i.content_id}:${i.content_type}`);
    const libUniq  = new Set(libKeys);
    const dupCount = libKeys.length - libUniq.size;
    if (dupCount > 0) {
      log(`⚠️  DUPLICATI LIBRARY: ${dupCount} righe duplicate nel DB Nuvio`);
      const seen = {}; libKeys.forEach(k => { seen[k] = (seen[k]||0)+1; });
      Object.entries(seen).filter(([,v])=>v>1).slice(0,5).forEach(([k,v]) => log(`   → ${k} × ${v}`));
    } else {
      log(`✅ Nessun duplicato in library`);
    }

    if (nvProgress.length > 0) {
      log('Esempio progress:');
      nvProgress.slice(0,2).forEach(p => log(`   ${p.content_id} video_id="${p.video_id}" pos=${p.position}/${p.duration}`));
    }

    log('');
    log('━━━ STEP 4: TEST PUSH SINGOLO ━━━');
    const TEST_ID = 'tt0111161'; // The Shawshank Redemption — safe test item

    // Test watched push
    log(`Test push watched per ${TEST_ID}...`);
    const currentW = await getNuvioWatchedItems(token);
    const testWatched = [...currentW.filter(i => i.content_id !== TEST_ID), {
      content_id: TEST_ID, content_type: 'movie', title: 'TEST',
      season: null, episode: null, watched_at: Date.now(),
    }];
    await pushWatchedItems(testWatched, token);
    const afterW = await getNuvioWatchedItems(token);
    const watchedOk = afterW.some(i => i.content_id === TEST_ID);
    log(watchedOk ? `✅ watched push funziona` : `❌ watched push FALLITO — item non trovato dopo push`);

    // Test progress push
    log(`Test push progress per ${TEST_ID}...`);
    const testProg = [{
      content_id: TEST_ID, content_type: 'movie', video_id: TEST_ID,
      season: null, episode: null,
      position: 3600000, duration: 7200000,
      last_watched: Date.now(), progress_key: TEST_ID,
    }];
    await pushWatchProgress(testProg, token);
    const afterP = await getNuvioWatchProgress(token);
    const progOk = afterP.some(i => i.content_id === TEST_ID);
    log(progOk ? `✅ progress push funziona` : `❌ progress push FALLITO`);

    // Clean up test data
    await pushWatchedItems(currentW, token);
    await pushWatchProgress(nvProgress, token);
    log(`Cleanup test data OK`);

    log('');
    log('━━━ STEP 5: RIEPILOGO PROBLEMI ━━━');
    const problems = [];
    if (dupCount > 0)          problems.push(`DUPLICATI: ${dupCount} doppioni nel DB — sync_push_library non deduplicata sul server Nuvio`);
    if (cwValid.length === 0 && cwItems.length > 0) problems.push(`CW: ${cwItems.length} item in corso ma nessuno con S/E valido nel videoId — Nuvio non riesce a riprendere`);
    if (cwValid.length === 0 && cwItems.length === 0) problems.push(`CW: nessun item con timeOffset>0 in Stremio`);
    if (wTitles.length === 0)  problems.push(`WATCHED: Stremio non ha segnali di visione (timesWatched=0, flaggedWatched=0, pct<80%) — usi Trakt/Simkl?`);
    if (!watchedOk)            problems.push(`WATCHED PUSH: il push su Supabase non funziona correttamente`);
    if (!progOk)               problems.push(`PROGRESS PUSH: il push su Supabase non funziona correttamente`);

    if (problems.length === 0) {
      log('✅ Nessun problema rilevato — i dati sembrano corretti nel DB');
      log('   Se Nuvio non mostra badge/CW: Impostazioni → Sync → Sincronizza ora');
    } else {
      problems.forEach(p => log(`❌ ${p}`));
    }

    res.json({ success: true, log: L, problems, stats: {
      stremio: { total: rawAll.length, active: active.length, cwItems: cwItems.length, cwValid: cwValid.length, watched: wTitles.length, bitfield: wBitfield },
      nuvio:   { library: nvLib.length, watched: nvWatched.length, progress: nvProgress.length, duplicates: dupCount },
      pushTest: { watchedOk, progressOk: progOk },
    }});

  } catch(e) {
    L.push(`💥 ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log: L });
  }
});


// ─── /diagnose-series ─────────────────────────────────────────
// Focused diagnostic: shows raw videoId and watched data for series only
app.post('/diagnose-series', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const L = []; const log = m => { console.log('[diag-series]', m); L.push(m); };
  try {
    const [stAuth, nvSess] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const token = nvSess.access_token;
    const rawAll = await getStremioLibraryRaw(stAuth.token);
    const norm   = rawAll.map(normalizeItem);
    const series = norm.filter(i => (i.type==='series'||i.type==='show') && !i.removed && !i.temp);

    log(`Serie totali in Stremio: ${series.length}`);
    log('');

    // ── CW analysis ──────────────────────────────────────────
    log('━━━ CONTINUA A GUARDARE (serie) ━━━');
    const cwSeries = series.filter(i => i.state.timeOffset > 0 && i.state.duration > 0);
    log(`Serie con timeOffset > 0: ${cwSeries.length}`);
    cwSeries.forEach(i => {
      const pct = Math.round(i.state.timeOffset / i.state.duration * 100);
      const vid = String(i.state.videoId || '');
      const { season, episode } = parseSE(vid);
      const ok = season != null && episode != null && pct >= 3 && pct <= 92;
      log(`  ${ok?'✅':'❌'} "${i.name}"`);
      log(`     videoId raw = "${vid}"`);
      log(`     item._id    = "${i.id}"`);
      log(`     season=${season} episode=${episode} pct=${pct}%`);
      if (!ok) {
        if (pct < 3 || pct > 92) log(`     ⚠️  pct fuori range 3-92%`);
        if (season == null)       log(`     ⚠️  videoId non contiene stagione/episodio`);
      }
    });
    if (cwSeries.length === 0) log('  (nessuna serie in corso)');

    log('');
    log('━━━ WATCHED SERIES (badge livello-serie) ━━━');
    const watchedSeries = series.filter(i =>
      i.state.timesWatched > 0 || i.state.flaggedWatched > 0 ||
      (i.state.duration > 0 && i.state.timeOffset / i.state.duration >= 0.80)
    );
    log(`Serie con segnale "visto": ${watchedSeries.length}`);
    watchedSeries.slice(0,5).forEach(i => {
      const pct = i.state.duration > 0 ? Math.round(i.state.timeOffset/i.state.duration*100) : 0;
      log(`  ✅ "${i.name}" tw=${i.state.timesWatched} fw=${i.state.flaggedWatched} pct=${pct}%`);
    });

    log('');
    log('━━━ EPISODE BITFIELD ━━━');
    const withBitfield = series.filter(i => i.state.watchedField);
    log(`Serie con watchedField (episodi tracciati): ${withBitfield.length}`);
    withBitfield.slice(0,3).forEach(i => {
      log(`  "${i.name}" → watchedField: "${(i.state.watchedField||'').slice(0,60)}…"`);
    });

    log('');
    log('━━━ NUVIO DB SERIE ━━━');
    const [nvWatched, nvProgress] = await Promise.all([
      getNuvioWatchedItems(token),
      getNuvioWatchProgress(token),
    ]);
    const nvWatchedSeries = nvWatched.filter(i => i.content_type === 'series');
    const nvWatchedEp     = nvWatched.filter(i => i.season != null && i.episode != null);
    log(`watched_items serie (livello titolo):  ${nvWatchedSeries.filter(i=>i.season==null).length}`);
    log(`watched_items episodi (con S/E):       ${nvWatchedEp.length}`);
    log(`watch_progress (CW):                   ${nvProgress.length}`);
    if (nvProgress.length > 0) {
      log('Esempi progress nel DB:');
      nvProgress.slice(0,3).forEach(p =>
        log(`  content_id="${p.content_id}" video_id="${p.video_id}" pos=${p.position} dur=${p.duration}`)
      );
    }

    log('');
    log('━━━ TEST PUSH CW SERIE ━━━');
    if (cwSeries.length > 0) {
      const best = cwSeries.find(i => {
        const vid = String(i.state.videoId || '');
        const { season, episode } = parseSE(vid);
        return season != null && episode != null;
      });
      if (best) {
        const cid = extractContentId(best.id);
        const vid = String(best.state.videoId || best.id);
        const { season, episode } = parseSE(vid);
        const entry = {
          content_id: cid, content_type: 'series', video_id: vid,
          season, episode,
          position: best.state.timeOffset, duration: best.state.duration,
          last_watched: toMs(best.state.lastWatched || best.mtime),
          progress_key: makeProgressKey('series', cid, season, episode),
        };
        log(`Provo push CW: ${JSON.stringify(entry)}`);
        await pushWatchProgress([entry], token);
        const after = await getNuvioWatchProgress(token);
        const ok = after.some(p => p.content_id === cid);
        log(ok ? `✅ CW push OK — "${best.name}" è ora nel watch_progress` : `❌ CW push FALLITO`);
      } else {
        log('⚠️  Nessuna serie CW con videoId valido (S:E) — questo è il problema!');
        log("    Stremio salva l'ultimo videoId solo se hai guardato da Stremio direttamente.");
        log('    Se guardi da un altro player il videoId potrebbe mancare.');
        // Try pushing with item._id as video_id anyway
        const fallback = cwSeries[0];
        const cid = extractContentId(fallback.id);
        // Try item id as video_id
        const vid = fallback.id; // es. "tt1234567:2:5" se Stremio lo salva così
        const { season, episode } = parseSE(vid);
        if (season != null) {
          log(`    Provo fallback con item.id="${vid}" come video_id...`);
          const entry = {
            content_id: cid, content_type: 'series', video_id: vid,
            season, episode,
            position: fallback.state.timeOffset, duration: fallback.state.duration,
            last_watched: toMs(fallback.state.lastWatched || fallback.mtime),
            progress_key: makeProgressKey('series', cid, season, episode),
          };
          await pushWatchProgress([entry], token);
          const after = await getNuvioWatchProgress(token);
          const ok = after.some(p => p.content_id === cid);
          log(ok ? `✅ Fallback OK con item.id` : `❌ Fallback fallito`);
        } else {
          log(`    item.id="${vid}" non contiene S/E neanche lui.`);
          log(`    → Il videoId di Stremio è ASSENTE per questa serie.`);
        }
      }
    } else {
      log('Nessuna serie CW da testare');
    }

    log('');
    log('━━━ TEST PUSH WATCHED SERIE ━━━');
    if (withBitfield.length > 0) {
      log(`Provo decode bitfield per "${withBitfield[0].name}"...`);
      try {
        const eps = await buildWatchedEpisodesPayload([withBitfield[0]], 1, m => log('  '+m));
        log(`Episodi decodificati: ${eps.length}`);
        if (eps.length > 0) {
          log(`Primo: S${eps[0].season}E${eps[0].episode}`);
          await pushWatchedItems(eps, token);
          const after = await getNuvioWatchedItems(token);
          const ok = after.some(i => i.content_id === eps[0].content_id && i.season != null);
          log(ok ? `✅ Push episodi OK` : `❌ Push episodi FALLITO`);
        }
      } catch(e) { log(`❌ Errore bitfield: ${e.message}`); }
    } else {
      log('Nessuna serie con bitfield episodi');
      // Push a series-level watched badge test
      if (watchedSeries.length > 0) {
        const s = watchedSeries[0];
        const cid = extractContentId(s.id);
        log(`Provo push badge livello-serie per "${s.name}" (${cid})...`);
        const current = await getNuvioWatchedItems(token);
        const test = [...current.filter(i => i.content_id !== cid), {
          content_id: cid, content_type: 'series', title: s.name,
          season: null, episode: null, watched_at: Date.now(),
        }];
        await pushWatchedItems(test, token);
        const after = await getNuvioWatchedItems(token);
        const ok = after.some(i => i.content_id === cid && i.content_type === 'series');
        log(ok ? `✅ Badge livello-serie OK` : `❌ Badge livello-serie FALLITO`);
        // Restore
        await pushWatchedItems(current, token);
      }
    }

    res.json({ success: true, log: L });
  } catch(e) {
    L.push(`💥 ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log: L });
  }
});


// ============================================================
// PURE PUSH ENDPOINTS — receive ready-made payloads from browser
// No Stremio fetch, no Nuvio read — just supabaseLogin + one RPC.
// Each responds in ~1-2s. Browser builds payloads from loaded data.
// ============================================================

// ─── /do-push-library ───────────────────────────────────────
app.post('/do-push-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword, items } = req.body;
  if (!nuvioEmail || !nuvioPassword || !Array.isArray(items))
    return res.status(400).json({ success: false, error: 'nuvioEmail, nuvioPassword, items richiesti' });
  try {
    const { access_token } = await supabaseLogin(nuvioEmail, nuvioPassword);
    await pushLibrary(items, access_token);
    res.json({ success: true, pushed: items.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});












// ─── Token login helper ─────────────────────────────────────
// Accept either {nuvioToken} directly OR {nuvioEmail,nuvioPassword}
// Using token skips the login roundtrip entirely — much faster
async function resolveToken(body) {
  if (body.nuvioToken) return body.nuvioToken;
  const s = await supabaseLogin(body.nuvioEmail, body.nuvioPassword);
  return s.access_token;
}

// ─── /do-push-library ───────────────────────────────────────
app.post('/do-push-library-append', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items richiesti' });
  try {
    const token = await resolveToken(req.body);
    await pushLibrary(items, token);
    res.json({ success: true, pushed: items.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── /do-push-watched-append ────────────────────────────────
// REST diretto con ignore-duplicates — ADDITIVO, non cancella nulla.
// Usato dal bottone EPISODI per aggiungere title-level + S1E1 proxy
// senza toccare il watched già presente dal SYNC.
// Il unique index su watched_items(user_id,content_id,season,episode)
// gestisce silenziosamente i duplicati.
app.post('/do-push-watched-append', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items richiesti' });
  try {
    const token   = await resolveToken(req.body);
    const session = req.body.nuvioToken
      ? null
      : await supabaseLogin(req.body.nuvioEmail, req.body.nuvioPassword);
    const ownerId = await getEffectiveOwnerId(token);

    const BATCH = 200;
    let pushed = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH).map(item => ({
        user_id:      ownerId,
        content_id:   item.content_id,
        content_type: item.content_type,
        title:        item.title || '',
        season:       item.season != null ? Number(item.season) : null,
        episode:      item.episode != null ? Number(item.episode) : null,
        watched_at:   Number(item.watched_at) || Date.now(),
        profile_id:   1,
      }));
      const r = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify(slice),
      });
      if (r.ok) {
        pushed += slice.length;
      } else {
        const err = await r.text();
        console.warn(`do-push-watched-append batch ${i} failed (${r.status}): ${err.slice(0,150)}`);
      }
    }
    res.json({ success: true, pushed });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── /do-push-progress ──────────────────────────────────────
app.post('/do-push-progress', async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ success: false, error: 'entries richiesti' });
  try {
    const token = await resolveToken(req.body);
    await pushWatchProgress(entries, token);
    res.json({ success: true, pushed: entries.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── /do-push-watched (alias) ───────────────────────────────
// Riceve il dataset COMPLETO (titoli season=null + episodi season!=null)
// e lo pusha direttamente via RPC senza filtrare.
// La RPC sync_push_watched_items accetta sia title-level che episode-level.
app.post('/do-push-watched', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items richiesti' });
  try {
    const token = await resolveToken(req.body);
    // Usa RPC diretta con TUTTI gli items — non passare per pushWatchedItems
    // che filtra solo season=null e butterebbe via gli episodi
    await supabaseRpc('sync_push_watched_items', { p_items: items }, token);
    res.json({ success: true, pushed: items.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});


// ─── /debug-db-raw ────────────────────────────────────────────
// Legge direttamente watched_items e watch_progress via REST (bypassa RPC)
// e confronta con quello che restituiscono le RPC.
// Mostra i primi 20 watched + conteggi per capire cosa vede Nuvio.
app.post('/debug-db-raw', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const L = []; const log = m => { console.log(m); L.push(m); };
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const userId  = session.user?.id;
    const ownerId = await getEffectiveOwnerId(token);
    log(`userId:  ${userId}`);
    log(`ownerId: ${ownerId}`);
    log(`equal:   ${userId === ownerId}`);
    log('');

    // ── Leggi via RPC (come fa Nuvio app) ──────────────────────
    const rpcWatched  = await getNuvioWatchedItems(token);
    const rpcProgress = await getNuvioWatchProgress(token);
    const rpcLibrary  = await getNuvioLibrary(token);
    log(`RPC sync_pull_watched_items:  ${rpcWatched.length} items`);
    log(`RPC sync_pull_watch_progress: ${rpcProgress.length} items`);
    log(`RPC sync_pull_library:        ${rpcLibrary.length} items`);
    log('');

    // ── Leggi via REST diretto (bypassa RPC, vede i dati grezzi) ─
    async function restCount(table, filter='') {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${filter}&select=id`,
        { method: 'GET', headers: {
          'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`,
          'Prefer': 'count=exact', 'Range': '0-0',
        }}
      );
      const cr = r.headers.get('content-range');
      if (cr) { const p = cr.split('/'); if (p[1] && p[1] !== '*') return parseInt(p[1]); }
      const d = await r.json(); return Array.isArray(d) ? d.length : '?';
    }
    async function restFetch(table, filter='', limit=10) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${filter}&limit=${limit}`,
        { method: 'GET', headers: {
          'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`,
        }}
      );
      return await r.json();
    }

    // Contiamo con diversi filtri per capire cosa la RPC vede
    const [
      totalWatched,
      watchedByUserId,
      watchedByOwnerId,
      watchedP1,
      watchedNullSeason,
      totalProgress,
      progressByUserId,
      totalLibrary,
    ] = await Promise.all([
      restCount('watched_items'),
      restCount('watched_items', `user_id=eq.${userId}`),
      ownerId !== userId ? restCount('watched_items', `user_id=eq.${ownerId}`) : Promise.resolve('=userId'),
      restCount('watched_items', `user_id=eq.${userId}&profile_id=eq.1`),
      restCount('watched_items', `user_id=eq.${userId}&season=is.null`),
      restCount('watch_progress'),
      restCount('watch_progress', `user_id=eq.${userId}`),
      restCount('library_items', `user_id=eq.${userId}`),
    ]);

    log(`REST watched_items totale:                ${totalWatched}`);
    log(`REST watched_items user_id=${userId.slice(0,8)}...: ${watchedByUserId}`);
    log(`REST watched_items user_id=ownerId:       ${watchedByOwnerId}`);
    log(`REST watched_items profile_id=1:          ${watchedP1}`);
    log(`REST watched_items season=null:           ${watchedNullSeason}`);
    log(`REST watch_progress totale:               ${totalProgress}`);
    log(`REST watch_progress user_id=userId:       ${progressByUserId}`);
    log(`REST library_items user_id=userId:        ${totalLibrary}`);
    log('');

    // Campione dei watched reali (season=null = badge titolo-livello)
    const sampleNull = await restFetch('watched_items', `user_id=eq.${userId}&season=is.null&order=created_at.desc`, 20);
    log(`Campione watched season=null (badge titolo-livello, ultimi 20):`);
    if (Array.isArray(sampleNull)) {
      sampleNull.forEach(w => log(`  ${w.content_id} | ${w.content_type} | profile_id=${w.profile_id}`));
    } else {
      log(`  ERRORE: ${JSON.stringify(sampleNull).slice(0,200)}`);
    }
    log('');

    // Confronto con library: quali watched NON hanno corrispondenza in library?
    const libSample = await restFetch('library_items', `user_id=eq.${userId}&order=created_at.desc`, 10);
    log(`Campione library (primi 10):`);
    if (Array.isArray(libSample)) {
      libSample.forEach(i => log(`  ${i.content_id} | ${i.content_type} | ${i.name}`));
    }
    log('');

    const sample = await restFetch('watched_items', `user_id=eq.${userId}&order=created_at.desc`, 5);
    log(`Campione watched ultimi 5 inseriti (con season):`);
    if (Array.isArray(sample)) {
      sample.forEach(w => log(`  ${w.content_id} | ${w.content_type} | S${w.season} E${w.episode} | profile_id=${w.profile_id}`));
    } else {
      log(`  ERRORE: ${JSON.stringify(sample).slice(0,200)}`);
    }
    log('');

    // Conteggio per tipo
    const rpcMovies  = rpcWatched.filter(w => w.content_type === 'movie').length;
    const rpcSeries  = rpcWatched.filter(w => w.content_type === 'series').length;
    log(`Breakdown watched (RPC): ${rpcMovies} film + ${rpcSeries} serie = ${rpcWatched.length} totale`);
    log('');

    // Campione serie watched
    const seriesWatched = rpcWatched.filter(w => w.content_type === 'series');
    if (seriesWatched.length > 0) {
      log(`Serie in watched_items (prime ${Math.min(10, seriesWatched.length)}):`);
      seriesWatched.slice(0, 10).forEach(w => log(`  ${w.content_id} | "${w.title || ''}"`));
    } else {
      log('⚠️  ZERO serie in watched_items — solo film!');
    }
    log('');

    // Confronto: RPC vs REST
    log(`DIAGNOSI:`);
    if (rpcWatched.length < watchedByUserId) {
      log(`⚠️  RPC restituisce ${rpcWatched.length} ma REST vede ${watchedByUserId} watched`);
      log(`   → La RPC sync_pull_watched_items filtra per profile_id o season`);
      log(`   → Nuvio app usa la RPC → vede solo ${rpcWatched.length} watched`);
    } else {
      log(`✅ RPC e REST concordano su watched count`);
    }

    // Mostra cosa restituisce la RPC vs cosa abbiamo nel DB
    if (rpcWatched.length > 0) {
      log('');
      log(`RPC watched campione (primi 5):`);
      rpcWatched.slice(0,5).forEach(w =>
        log(`  ${w.content_id} | ${w.content_type} | S${w.season} E${w.episode} | profile=${w.profile_id}`)
      );
    }

    res.json({ success: true, log: L, counts: {
      rpcWatched: rpcWatched.length, rpcProgress: rpcProgress.length, rpcLibrary: rpcLibrary.length,
      restWatched: watchedByUserId, restWatchedNullSeason: watchedNullSeason,
      restProgress: progressByUserId, restLibrary: totalLibrary,
    }});
  } catch(e) {
    L.push(`💥 ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log: L });
  }
});


// ─── /debug-watched-match ─────────────────────────────────────
// Confronta content_id tra watched_items (serie) e library_items
// per capire perché i badge non appaiono sulle serie in Nuvio.
app.post('/debug-watched-match', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const L = []; const log = m => { console.log(m); L.push(m); };
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;

    const [rpcWatched, rpcLibrary] = await Promise.all([
      getNuvioWatchedItems(token),
      getNuvioLibrary(token),
    ]);

    const libSeriesIds = new Set(
      rpcLibrary.filter(i => i.content_type === 'series').map(i => i.content_id)
    );
    const libMovieIds = new Set(
      rpcLibrary.filter(i => i.content_type === 'movie').map(i => i.content_id)
    );

    const watchedSeries = rpcWatched.filter(i => i.content_type === 'series');
    const watchedMovies = rpcWatched.filter(i => i.content_type === 'movie');

    log(`Library: ${rpcLibrary.filter(i=>i.content_type==='series').length} serie | ${rpcLibrary.filter(i=>i.content_type==='movie').length} film`);
    log(`Watched: ${watchedSeries.length} serie | ${watchedMovies.length} film`);
    log('');

    // Confronto FILM
    const moviesMatch   = watchedMovies.filter(w => libMovieIds.has(w.content_id));
    const moviesMissing = watchedMovies.filter(w => !libMovieIds.has(w.content_id));
    log(`Film watched con match in library:    ${moviesMatch.length}/${watchedMovies.length}`);
    if (moviesMissing.length > 0) {
      log(`Film watched SENZA match (primi 5):`);
      moviesMissing.slice(0,5).forEach(w => log(`  ${w.content_id} | "${w.title}"`));
    }
    log('');

    // Confronto SERIE
    const seriesMatch   = watchedSeries.filter(w => libSeriesIds.has(w.content_id));
    const seriesMissing = watchedSeries.filter(w => !libSeriesIds.has(w.content_id));
    log(`Serie watched con match in library:   ${seriesMatch.length}/${watchedSeries.length}`);
    log('');

    if (seriesMissing.length > 0) {
      log(`⚠️  ${seriesMissing.length} serie watched SENZA match in library:`);
      seriesMissing.forEach(w => log(`  WATCHED: ${w.content_id} | "${w.title}"`));
      log('');
      log('Esempi serie IN library (prime 10):');
      [...libSeriesIds].slice(0,10).forEach(id => {
        const item = rpcLibrary.find(i => i.content_id === id);
        log(`  LIBRARY: ${id} | "${item?.name || ''}"`);
      });
    } else {
      log('✅ Tutte le serie watched hanno match in library!');
      log('→ Se Nuvio non mostra il badge, potrebbe essere comportamento app:');
      log('  Nuvio potrebbe richiedere episodi watched (non solo titolo-livello) per le serie.');
      log('');
      log('Prime 10 serie con badge:');
      seriesMatch.slice(0,10).forEach(w => log(`  ✅ ${w.content_id} | "${w.title}"`));
    }

    res.json({ success: true, log: L, stats: {
      libraryMovies: libMovieIds.size, librarySeries: libSeriesIds.size,
      watchedMovies: watchedMovies.length, watchedSeries: watchedSeries.length,
      moviesMatch: moviesMatch.length, moviesMissing: moviesMissing.length,
      seriesMatch: seriesMatch.length, seriesMissing: seriesMissing.length,
    }});
  } catch(e) {
    L.push(`💥 ${e.message}`);
    res.status(500).json({ success: false, error: e.message, log: L });
  }
});

// ─── /do-push-episode-markers ───────────────────────────────
// Pusha marker di completamento episodi in watch_progress.
// Questo PREVIENE la cascata: quando Nuvio reconcile scrive placeholder
// {currentTime:1,duration:1}, il check `existing.currentTime > 1` trova
// il nostro marker (currentTime=5400) e lo salta → nessun cascade push.
// position=duration=5400000ms (90min) → pct=100% → isEpisodeWatched=true ✓
// → non compare nel CW (pct>92%) ✓
// → setLocalWatchedStatus non lo sovrascrive (ct=5400>1) ✓
app.post('/do-push-episode-markers', async (req, res) => {
  const { episodes } = req.body; // [{content_id, content_type, season, episode, watched_at}]
  if (!Array.isArray(episodes)) return res.status(400).json({ success: false, error: 'episodes richiesti' });
  try {
    const token = await resolveToken(req.body);
    // Fetch current CW to preserve it
    const currentCW = await getNuvioWatchProgress(token);
    // Build completion markers: position=duration=5400000ms → pct=100%, currentTime=5400>1
    const MARKER_MS = 5400000;
    const markers = episodes
      .filter(ep => ep.season != null && ep.episode != null)
      .map(ep => ({
        content_id:   ep.content_id,
        content_type: 'movie',  // tratta episodi watched come film
        video_id:     `${ep.content_id}:${ep.season}:${ep.episode}`,
        season:       ep.season,
        episode:      ep.episode,
        position:     MARKER_MS,
        duration:     MARKER_MS,
        last_watched: ep.watched_at || Date.now(),
        progress_key: `${ep.content_id}_s${ep.season}e${ep.episode}`,
      }));
    // Merge: CW entries (priorità) + episode markers (non sovrascrivere CW)
    const cwKeys = new Set(currentCW.map(e => e.progress_key));
    const filteredMarkers = markers.filter(m => !cwKeys.has(m.progress_key));
    const allEntries = [...currentCW, ...filteredMarkers];
    await supabaseRpc('sync_push_watch_progress', { p_entries: allEntries }, token);
    res.json({ success: true, pushed: allEntries.length, cw: currentCW.length, markers: filteredMarkers.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════
// ADDON SYNC ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ─── get-stremio-addons ─────────────────────────────────────
// Recupera gli addon installati da Stremio via API addonCollectionGet
app.post('/get-stremio-addons', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const debugLog = [];
  const L = m => { console.log('[addons]', m); debugLog.push(m); };

  try {
    const auth = await stremioLogin(email, password);
    L(`Login OK, token: ${auth.token.slice(0,8)}...`);

    let rawAddons = [];

    // ── Strategia 1: getUser ─────────────────────────────────
    try {
      const r = await fetch(`${STREMIO_API}/api/getUser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
        body: JSON.stringify({ authKey: auth.token }),
      });
      const text = await r.text();
      L(`getUser → status:${r.status} len:${text.length} preview:${text.slice(0,120)}`);
      if (r.ok && text.trim()) {
        const d = JSON.parse(text);
        const found = d?.result?.addons || d?.result?.user?.addons || d?.addons || [];
        if (found.length) { rawAddons = found; L(`getUser: ${found.length} addon`); }
      }
    } catch(e) { L(`getUser errore: ${e.message}`); }

    // ── Strategia 2: addonCollectionGet ──────────────────────
    if (!rawAddons.length) {
      try {
        const r = await fetch(`${STREMIO_API}/api/addonCollectionGet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
          body: JSON.stringify({ authKey: auth.token, update: true }),
        });
        const text = await r.text();
        L(`addonCollectionGet → status:${r.status} len:${text.length} preview:${text.slice(0,120)}`);
        if (r.ok && text.trim()) {
          const d = JSON.parse(text);
          const found = d?.result?.addons || d?.addons || [];
          if (found.length) { rawAddons = found; L(`addonCollectionGet: ${found.length} addon`); }
        }
      } catch(e) { L(`addonCollectionGet errore: ${e.message}`); }
    }

    // ── Strategia 3: getAddonCollection ──────────────────────
    if (!rawAddons.length) {
      try {
        const r = await fetch(`${STREMIO_API}/api/getAddonCollection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
          body: JSON.stringify({ authKey: auth.token }),
        });
        const text = await r.text();
        L(`getAddonCollection → status:${r.status} len:${text.length} preview:${text.slice(0,120)}`);
        if (r.ok && text.trim()) {
          const d = JSON.parse(text);
          const found = d?.result?.addons || d?.addons || [];
          if (found.length) { rawAddons = found; L(`getAddonCollection: ${found.length} addon`); }
        }
      } catch(e) { L(`getAddonCollection errore: ${e.message}`); }
    }

    if (!rawAddons.length) {
      return res.json({ success: false, error: 'Nessun addon trovato con nessuna strategia', debug: debugLog });
    }

    const addons = rawAddons
      .filter(a => a && (a.transportUrl || a.manifest?.transportUrl))
      .map((a, i) => {
        const manifest = a.manifest || {};
        const transportUrl = (a.transportUrl || manifest.transportUrl || '').trim();
        let manifestUrl = transportUrl;
        if (manifestUrl && !manifestUrl.endsWith('manifest.json')) {
          manifestUrl = manifestUrl.replace(/\/?$/, '/manifest.json');
        }
        return {
          id:          manifest.id || '',
          name:        manifest.name || transportUrl || '',
          description: manifest.description || '',
          version:     manifest.version || '',
          transportUrl,
          manifestUrl,
          types:       Array.isArray(manifest.types) ? manifest.types : [],
          logo:        manifest.logo || manifest.icon || null,
          official:    Boolean(manifest.official),
          sort_order:  i,
        };
      })
      .filter(a => a.manifestUrl);

    L(`Addon pronti: ${addons.length}`);
    res.json({ success: true, addons, total: addons.length, debug: debugLog });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, debug: debugLog });
  }
});

// ─── get-nuvio-addons ───────────────────────────────────────
// Recupera gli addon installati su Nuvio via Supabase REST
app.post('/get-nuvio-addons', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/addons?select=url,sort_order&user_id=eq.${encodeURIComponent(ownerId)}&profile_id=eq.1&order=sort_order.asc`, {
      method: 'GET',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Addons query HTTP ${r.status}`);
    const rows = await r.json();
    // Arricchisce con dati manifest (name, logo) se possibile
    const addons = await Promise.all((rows || []).map(async (row, i) => {
      let name = row.url || '';
      let description = '';
      let logo = null;
      let types = [];
      let id = '';
      let version = '';
      try {
        const mr = await fetch(row.url, { signal: AbortSignal.timeout(4000) });
        if (mr.ok) {
          const m = await mr.json();
          name        = m.name || name;
          description = m.description || '';
          logo        = m.logo || null;
          types       = m.types || [];
          id          = m.id || '';
          version     = m.version || '';
        }
      } catch { /* manifest non raggiungibile, usa URL come nome */ }
      return { id, name, description, version, manifestUrl: row.url, logo, types, sort_order: row.sort_order ?? i };
    }));
    res.json({ success: true, addons, total: addons.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── push-addons-to-nuvio ───────────────────────────────────
// Pusha lista addon a Nuvio via RPC sync_push_addons (full-replace)
app.post('/push-addons-to-nuvio', async (req, res) => {
  const { nuvioEmail, nuvioPassword, addons } = req.body;
  if (!nuvioEmail || !nuvioPassword || !Array.isArray(addons))
    return res.status(400).json({ success: false, error: 'nuvioEmail, nuvioPassword, addons richiesti' });
  try {
    const token = await resolveToken(req.body);
    // Filtra URL vuoti e normalizza
    const payload = addons
      .filter(a => a.manifestUrl && a.manifestUrl.trim())
      .map((a, i) => ({
        url:        a.manifestUrl.trim(),
        sort_order: a.sort_order ?? i,
      }));
    await supabaseRpc('sync_push_addons', { p_addons: payload }, token);
    res.json({ success: true, pushed: payload.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});


// ─── debug-stremio-addons ────────────────────────────────────
// Prova tutti i possibili endpoint per recuperare gli addon Stremio
app.post('/debug-stremio-addons', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const log = []; const L = m => { console.log(m); log.push(m); };
  try {
    const auth = await stremioLogin(email, password);
    L(`✅ Login OK, authKey: ${auth.token.slice(0,8)}...`);

    // Prova 1: getUser (fonte principale addon)
    L('\n--- Prova 1: getUser ---');
    try {
      const r1 = await fetch(`${STREMIO_API}/api/getUser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
        body: JSON.stringify({ authKey: auth.token }),
      });
      const t1 = await r1.text();
      let preview = t1.slice(0,400);
      try {
        const d1 = JSON.parse(t1);
        const addonsCount = d1?.result?.addons?.length || d1?.result?.user?.addons?.length || 0;
        preview = `addons trovati: ${addonsCount} — ${JSON.stringify(d1?.result?.addons?.[0] || d1?.result?.user?.addons?.[0] || 'nessuno').slice(0,200)}`;
      } catch {}
      L(`Status: ${r1.status}, Body: ${t1.length} chars — ${preview}`);
    } catch(e) { L(`Errore: ${e.message}`); }

    // Prova 2: addonCollectionGet
    L('\n--- Prova 2: addonCollectionGet ---');
    try {
      const r2 = await fetch(`${STREMIO_API}/api/addonCollectionGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
        body: JSON.stringify({ authKey: auth.token, update: true }),
      });
      const t2 = await r2.text();
      L(`Status: ${r2.status}, Body length: ${t2.length}, Preview: ${t2.slice(0,200)}`);
    } catch(e) { L(`Errore: ${e.message}`); }

    // Prova 3: datastoreGet con collection 'addon'
    L('\n--- Prova 3: datastoreGet addon ---');
    try {
      const r3 = await fetch(`${STREMIO_API}/api/datastoreGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
        body: JSON.stringify({ authKey: auth.token, collection: 'addon', all: true }),
      });
      const t3 = await r3.text();
      L(`Status: ${r3.status}, Body length: ${t3.length}, Preview: ${t3.slice(0,200)}`);
    } catch(e) { L(`Errore: ${e.message}`); }

    // Prova 4: getUser (per vedere la struttura dati utente)
    L('\n--- Prova 4: getUser ---');
    try {
      const r4 = await fetch(`${STREMIO_API}/api/getUser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
        body: JSON.stringify({ authKey: auth.token }),
      });
      const t4 = await r4.text();
      L(`Status: ${r4.status}, Body length: ${t4.length}, Preview: ${t4.slice(0,500)}`);
    } catch(e) { L(`Errore: ${e.message}`); }

    res.json({ success: true, log });
  } catch(e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log }); }
});

app.get('/backups', (req, res) => res.json({ backups: [] }));
app.post('/restore', (req, res) => res.status(400).json({ success: false, error: 'Non disponibile.' }));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

module.exports = app;
