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
async function getNuvioWatchedItems(token) {
  const r = await supabaseRpc('sync_pull_watched_items', {}, token);
  return Array.isArray(r) ? r : [];
}

// ============================================================
// FUNZIONI PER LEGGERE TUTTI I RECORD (con paginazione)
// ============================================================
async function getAllWatchedItems(token, ownerId) {
  let allItems = [];
  let from = 0;
  const step = 1000;
  let hasMore = true;
  
  console.log(`📖 Lettura paginata di watched_items...`);
  
  while (hasMore) {
    const to = from + step - 1;
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/watched_items?user_id=eq.${ownerId}&select=content_id,content_type,season,episode`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Range': `${from}-${to}`
          }
        }
      );
      
      const data = await r.json();
      if (!data || !data.length) {
        hasMore = false;
        break;
      }
      
      allItems = [...allItems, ...data];
      from += step;
      console.log(`   letto batch ${allItems.length} record...`);
      
      if (data.length < step) {
        hasMore = false;
      }
    } catch (e) {
      console.error(`Errore lettura batch: ${e.message}`);
      hasMore = false;
    }
  }
  
  console.log(`✅ Letti ${allItems.length} record totali`);
  return allItems;
}

async function getAllWatchProgress(token, ownerId) {
  let allItems = [];
  let from = 0;
  const step = 1000;
  let hasMore = true;
  
  console.log(`📖 Lettura paginata di watch_progress...`);
  
  while (hasMore) {
    const to = from + step - 1;
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/watch_progress?user_id=eq.${ownerId}&select=*`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Range': `${from}-${to}`
          }
        }
      );
      
      const data = await r.json();
      if (!data || !data.length) {
        hasMore = false;
        break;
      }
      
      allItems = [...allItems, ...data];
      from += step;
      console.log(`   letto batch ${allItems.length} progress...`);
      
      if (data.length < step) {
        hasMore = false;
      }
    } catch (e) {
      console.error(`Errore lettura batch progress: ${e.message}`);
      hasMore = false;
    }
  }
  
  console.log(`✅ Letti ${allItems.length} progress totali`);
  return allItems;
}

// ============================================================
// PUSH (versione robusta con batch per grandi volumi)
// ============================================================
async function pushLibrary(items, token) {
  const payload = (items || []).map(item => ({
    content_id:    item.content_id,
    content_type:  item.content_type,
    name:          item.name          || '',
    poster:        item.poster        || null,
    poster_shape:  item.poster_shape  || 'POSTER',
    background:    item.background    || null,
    description:   null,
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
  const ownerId = await getEffectiveOwnerId(token);
  const titleLevel = (items || []).filter(i => i.season == null && i.episode == null);
  if (!titleLevel.length) return 0;
  
  const BATCH = 200;
  let pushed = 0;
  let totalBatches = Math.ceil(titleLevel.length / BATCH);
  
  console.log(`📦 Push di ${titleLevel.length} title-level in ${totalBatches} batch`);
  
  for (let i = 0; i < titleLevel.length; i += BATCH) {
    const batch = titleLevel.slice(i, i + BATCH).map(item => ({
      user_id:      ownerId,
      content_id:   item.content_id,
      content_type: item.content_type,
      title:        item.content_id,
      season:       null,
      episode:      null,
      watched_at:   Number(item.watched_at) || Date.now(),
      profile_id:   1,
    }));
    
    try {
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
        console.warn(`pushWatchedItems batch ${Math.floor(i/BATCH)+1}/${totalBatches} failed (${r.status}): ${err.slice(0,150)}`);
      } else {
        pushed += batch.length;
        console.log(`✅ Batch title-level ${Math.floor(i/BATCH)+1}/${totalBatches}: ${batch.length} pushati`);
      }
    } catch (e) {
      console.error(`❌ Errore batch title-level: ${e.message}`);
    }
  }
  
  console.log(`pushWatchedItems: ${titleLevel.length} title-level → ${pushed} pushati`);
  return pushed;
}

async function pushWatchedEpisodes(items, token, ownerId) {
  const eps = (items || []).filter(i => i.season != null && i.episode != null);
  if (!eps.length) return 0;
  if (!ownerId) ownerId = await getEffectiveOwnerId(token);
  
  const BATCH = 200;
  let pushed = 0;
  let totalBatches = Math.ceil(eps.length / BATCH);
  
  console.log(`📦 Push di ${eps.length} episodi in ${totalBatches} batch da ${BATCH}`);
  
  for (let i = 0; i < eps.length; i += BATCH) {
    const batch = eps.slice(i, i + BATCH).map(ep => ({
      user_id:      ownerId,
      content_id:   ep.content_id,
      content_type: ep.content_type,
      title:        ep.content_id,
      season:       Number(ep.season),
      episode:      Number(ep.episode),
      watched_at:   Number(ep.watched_at) || Date.now(),
      profile_id:   1,
    }));
    
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, {
        method: 'POST',
        headers: { 
          'apikey': SUPABASE_ANON_KEY, 
          'Authorization': `Bearer ${token}`, 
          'Content-Type': 'application/json', 
          'Prefer': 'resolution=ignore-duplicates,return=minimal' 
        },
        body: JSON.stringify(batch),
      });
      
      if (!r.ok) { 
        const err = await r.text();
        console.warn(`pushWatchedEpisodes batch ${Math.floor(i/BATCH)+1}/${totalBatches} failed (${r.status}): ${err.slice(0,150)}`);
      } else {
        pushed += batch.length;
        console.log(`✅ Batch episodi ${Math.floor(i/BATCH)+1}/${totalBatches}: ${batch.length} pushati`);
      }
    } catch (e) {
      console.error(`❌ Errore batch episodi ${Math.floor(i/BATCH)+1}: ${e.message}`);
    }
  }
  
  console.log(`pushWatchedEpisodes: ${eps.length} episodi → ${pushed} pushati`);
  return pushed;
}

app.post('/test-9999', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  }
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);

    const testEp = [{
      content_id: 'tt0903747',
      content_type: 'series',
      title: 'tt0903747',
      season: 1,
      episode: 9999,
      watched_at: Date.now()
    }];
    const pushed = await pushWatchedEpisodes(testEp, token, ownerId);
    res.json({ success: true, pushed });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

async function pushSeriesProxyEpisodes(watchedSeriesTitles, token, ownerId) {
  const proxyEps = (watchedSeriesTitles || []).map(s => ({
    content_id:   s.content_id,
    content_type: 'series',
    title:        s.content_id,
    season:       1,
    episode:      1,
    watched_at:   Date.now(),
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
      title:        ep.title,
      season:       ep.season,
      episode:      ep.episode,
      watched_at:   ep.watched_at || Date.now(),
      profile_id:   1,
    }));
    const r = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!r.ok) { const err = await r.text(); console.warn(`pushSeriesProxyEpisodes batch ${i} failed (${r.status}): ${err.slice(0,150)}`); }
    else pushed += batch.length;
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
  try { data = JSON.parse(text); } catch { throw new Error(`Stremio non JSON (${res.status}): ${text.slice(0, 120)}`); }
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
  const m = t.match(/tt\d+/i);
  if (m) return m[0].toLowerCase();
  const m2 = t.match(/(?:^|:)tmdb:(\d+)(?::|$)/i);
  if (m2?.[1]) return `tmdb:${m2[1]}`;
  const m3 = t.match(/^([a-z][a-z0-9_-]{1,20}):([a-zA-Z0-9_-]{1,30})(?::|$)/i);
  if (m3 && m3[1] && m3[2]) return `${m3[1].toLowerCase()}:${m3[2]}`;
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
  const parts = str.split(':');
  if (parts.length >= 3) {
    const ep  = Number(parts[parts.length - 1]);
    const sea = Number(parts[parts.length - 2]);
    if (Number.isFinite(sea) && Number.isFinite(ep) && sea > 0 && ep > 0)
      return { season: Math.trunc(sea), episode: Math.trunc(ep) };
  }
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
      watchedBool:   state.watched === true || state.watched === 1,
      watchedField:  (typeof state.watched === 'string' && state.watched.includes(':'))
                       ? state.watched : null,
    },
  };
}

// ============================================================
// BUILD PAYLOADS
// ============================================================
function buildLibraryPayload(rawItems) {
  const seen = new Map();
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

function buildWatchProgressPayload(normalizedItems) {
  const candidates = [];
  for (const item of normalizedItems) {
    if (!item.id) continue;
    if (item.temp) continue;
    if (item.type !== 'movie' && item.type !== 'series' && item.type !== 'show') continue;
    const { timeOffset, duration, videoId, lastWatched } = item.state;
    if (timeOffset <= 0 || duration <= 0) continue;
    const pct = (timeOffset / duration) * 100;
    if (pct < 3 || pct > 92) continue;
    const cid = extractContentId(item.id);
    if (!cid) continue;
    const ct  = normalizeType(item.type);
    let vid = String(videoId || '').trim();
    let { season, episode } = parseSE(vid);
    if (ct === 'series' && (season == null || episode == null)) {
      const seFromId = parseSE(item.id);
      if (seFromId.season != null && seFromId.episode != null) {
        vid = item.id; season = seFromId.season; episode = seFromId.episode;
      }
    }
    if (!vid) vid = String(videoId || cid);
    candidates.push({
      content_id: cid, content_type: ct, video_id: vid, season, episode,
      position: timeOffset, duration,
      last_watched: toMs(lastWatched || item.mtime),
      progress_key: makeProgressKey(ct, cid, season, episode),
      _lastWatched: toMs(lastWatched || item.mtime),
    });
  }
  candidates.sort((a, b) => b._lastWatched - a._lastWatched);
  return candidates.slice(0, 20).map(({ _lastWatched, ...item }) => item);
}

function buildWatchedPayload(normalizedItems) {
  const result = [];
  for (const item of normalizedItems) {
    if (item.temp) continue;
    const cid = extractContentId(item.id);
    if (!cid) continue;
    const ct = normalizeType(item.type);
    const { timesWatched, flaggedWatched, timeOffset, duration, lastWatched, watchedBool, watchedField } = item.state;
    const pct = duration > 0 ? (timeOffset / duration) : 0;
    const hasBitfield = !!(watchedField && (ct === 'series'));
    const isWatched = watchedBool || timesWatched > 0 || flaggedWatched > 0 || pct >= 0.80 || hasBitfield;
    if (!isWatched) continue;
    result.push({ content_id: cid, content_type: ct, title: item.name || '', season: null, episode: null, watched_at: toMs(lastWatched || item.mtime) });
  }
  return result;
}

// ============================================================
// EPISODE BITFIELD DECODER
// ============================================================
function parseWatchedField(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(':');
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
  return videoIds.map((_, i) => { const prev = i + offset; return prev >= 0 ? bitGet(values, prev) : false; });
}

function normalizeVideo(raw) {
  const sea  = raw.season  ?? raw.seriesInfo?.season  ?? null;
  const ep   = raw.episode ?? raw.seriesInfo?.episode ?? null;
  const relMs = raw.released ? Date.parse(String(raw.released)) : NaN;
  return { id: raw.id, season: Number.isFinite(Number(sea)) ? Number(sea) : null, episode: Number.isFinite(Number(ep)) ? Number(ep) : null, relMs: Number.isFinite(relMs) ? relMs : null, title: raw.title || '' };
}

function sortVideos(vs) {
  return vs.slice().sort((a, b) => {
    if ((a.season ?? -1) !== (b.season ?? -1)) return (a.season ?? -1) - (b.season ?? -1);
    if ((a.episode ?? -1) !== (b.episode ?? -1)) return (a.episode ?? -1) - (b.episode ?? -1);
    return (a.relMs ?? -1) - (b.relMs ?? -1);
  });
}

async function fetchCinemetaVideos(id) {
  try {
    const normalizedId = extractContentId(id);
    if (!normalizedId) return null;
    if (!normalizedId.match(/^tt\d+/) && !normalizedId.match(/^tmdb:/)) return null;
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(normalizedId)}.json`, { headers: { 'User-Agent': 'NuvioSync/1.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data?.meta?.videos) ? data.meta.videos : null;
  } catch { return null; }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => res.json({ status: 'ok', supabase: isSupabaseConfigured() }));
app.get('/supabase-status', (req, res) => res.json({ configured: isSupabaseConfigured() }));
app.get('/supabase-config', (req, res) => res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }));

app.post('/test-stremio-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, message: '❌ Email e password richieste' });
  try { await stremioLogin(email, password); res.json({ success: true, message: '✅ Login Stremio OK!' }); }
  catch (e) { res.json({ success: false, message: `❌ ${e.message}` }); }
});

app.post('/test-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, message: '❌ Email e password richieste' });
  if (!isSupabaseConfigured()) return res.json({ success: false, message: '❌ Supabase non configurato' });
  try {
    const session = await supabaseLogin(email, password);
    const owner   = await getEffectiveOwnerId(session.access_token).catch(() => null);
    res.json({ success: true, message: `✅ Login Nuvio OK! Owner: ${owner || 'unknown'}`, access_token: session.access_token });
  } catch (e) { res.json({ success: false, message: `❌ ${e.message}` }); }
});

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
      .filter(item => { const { timeOffset, duration } = item.state; if (timeOffset <= 0 || duration <= 0) return false; const pct = (timeOffset / duration) * 100; return pct >= 1 && pct <= 98; })
      .sort((a, b) => toMs(b.state.lastWatched || b.mtime) - toMs(a.state.lastWatched || a.mtime))
      .map(item => ({ ...item, progressPct: Math.round((item.state.timeOffset / item.state.duration) * 100) }));
    const removedItems       = rawAll.filter(i => i.removed && !i.temp);
    const seriesWithEpisodes = normalized.filter(i => (i.type === 'series' || i.type === 'show') && i.state.watchedField);
    res.json({ success: true, library: rawActive, libraryAll: rawAll, inProgressItems, removedItems, watchedIds,
      stats: { total: rawActive.length, movies: rawActive.filter(i => i.type === 'movie').length, series: rawActive.filter(i => i.type === 'series' || i.type === 'show').length, continueWatching: inProgressItems.length, watched: watchedIds.length, watchedSeriesCount: seriesWithEpisodes.length, removed: removedItems.length } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/get-nuvio-data', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(email, password);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    const library = await getNuvioLibrary(token);
    const watchedItems = await getAllWatchedItems(token, ownerId);
    const watchProgress = await getAllWatchProgress(token, ownerId);
    const watchedIds = [...new Set(watchedItems.map(w => String(w.content_id || '').trim().toLowerCase()).filter(Boolean))];
    res.json({ success: true, library, watchedItems, watchProgress, watchedIds,
      stats: { total: library.length, movies: library.filter(i => i.content_type === 'movie').length, series: library.filter(i => i.content_type === 'series').length, watched: watchedIds.length, watchedMovies: watchedItems.filter(i => i.content_type === 'movie' && i.season == null).length, watchedSeries: watchedItems.filter(i => i.content_type === 'series' && i.season == null).length, inProgress: watchProgress.length } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/preview-sync', async (req, res) => {
  const { stremioEmail, stremioPassword } = req.body;
  if (!stremioEmail || !stremioPassword) return res.status(400).json({ success: false, error: 'Credenziali Stremio richieste' });
  try {
    const auth    = await stremioLogin(stremioEmail, stremioPassword);
    const rawAll  = await getStremioLibraryRaw(auth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    const norm    = rawAll.map(normalizeItem);
    const normActive = norm.filter(i => !i.removed && !i.temp);
    const libraryPayload  = buildLibraryPayload(rawActive);
    const progressPayload = buildWatchProgressPayload(normActive);
    const watchedTitles   = buildWatchedPayload(norm);
    res.json({ success: true,
      wouldPush: { library: libraryPayload.length, watchProgress: progressPayload.length, watchedTitles: watchedTitles.length },
      cwItems: progressPayload.map(i => `${i.content_id} (${i.content_type}) | video_id:${i.video_id} | pct:${Math.round(i.position/i.duration*100)}%`),
      watchedTitlesPreview: watchedTitles.slice(0, 20).map(i => `${i.content_id} (${i.content_type}) | ${i.title}`),
      message: progressPayload.length === 0 ? '⚠️ Nessun item in progress' : `✅ ${progressPayload.length} item CW · ${watchedTitles.length} badge watched` });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message).slice(0, 300) }); }
});

app.post('/push-episodes', async (req, res) => {
  const { nuvioEmail, nuvioPassword, stremioEmail, stremioPassword, offset = 0, batchSize = 3, dryRun = true } = req.body;
  if (!nuvioEmail || !nuvioPassword || !stremioEmail || !stremioPassword) return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  const log = []; const L = m => { console.log(m); log.push(m); };
  try {
    const [stAuth, nvSess] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const token   = nvSess.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    const rawAll     = await getStremioLibraryRaw(stAuth.token);
    const normalized = rawAll.map(normalizeItem);
    const withField = normalized.filter(i => (i.type==='series'||i.type==='show') && i.state.watchedField);
    const batch = withField.slice(offset, offset + batchSize);
    const total = withField.length;
    L(`📺 Batch ${offset}-${offset+batch.length} di ${total} serie con bitfield`);
    const eps = await buildWatchedEpisodesPayload(batch, 3, m => L(m));
    L(`Episodi decodificati: ${eps.length}`);
    if (dryRun) {
      const done = (offset + batchSize) >= total;
      return res.json({ success: true, log, episodes: eps, pushed: 0, offset, batchSize, total, done, nextOffset: done ? null : offset + batchSize, message: `📦 Batch ${offset}-${offset+batch.length}/${total}: ${eps.length} episodi decodificati` });
    }
    let pushed = 0;
    if (eps.length > 0) {
      const current = await getNuvioWatchedItems(token);
      const currentPayload = current.map(w => ({ content_id: w.content_id, content_type: w.content_type, title: w.title || '', season: w.season != null ? Number(w.season) : null, episode: w.episode != null ? Number(w.episode) : null, watched_at: Number(w.watched_at) || Date.now() }));
      const merged = dedupeWatched([...currentPayload, ...eps]);
      await supabaseRpc('sync_push_watched_items', { p_items: merged }, token);
      pushed = eps.length;
      L(`✅ Push OK: ${merged.length} items nel DB`);
    }
    const done = (offset + batchSize) >= total;
    res.json({ success: true, log, pushed, offset, batchSize, total, done, nextOffset: done ? null : offset + batchSize, message: done ? `✅ Episodi completi: ${pushed} badge da ${total} serie` : `⏩ Batch ${offset}-${offset+batchSize}/${total}` });
  } catch(e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log }); }
});

app.post('/sync-library', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, includeRemoved = false } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  try {
    const [stAuth, nvSess] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const rawAll   = await getStremioLibraryRaw(stAuth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    const source   = includeRemoved ? rawAll : rawActive;
    const payload  = buildLibraryPayload(source);
    await pushLibrary(payload, nvSess.access_token);
    const norm = rawAll.map(normalizeItem);
    res.json({ success: true, pushed: payload.length, total: rawAll.length, active: rawActive.length, serieConBitfield: norm.filter(i => (i.type==='series'||i.type==='show') && i.state.watchedField).length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/sync-progress', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  try {
    const [stAuth, nvSess] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const rawAll    = await getStremioLibraryRaw(stAuth.token);
    const normActive = rawAll.map(normalizeItem).filter(i => !i.removed && !i.temp);
    const payload   = buildWatchProgressPayload(normActive);
    await pushWatchProgress(payload, nvSess.access_token);
    res.json({ success: true, pushed: payload.length, movies: payload.filter(i => i.content_type === 'movie').length, series: payload.filter(i => i.content_type === 'series').length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/sync-watched', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  try {
    const [stAuth, nvSess] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const rawAll  = await getStremioLibraryRaw(stAuth.token);
    const norm    = rawAll.map(normalizeItem);
    const payload = dedupeWatched(buildWatchedPayload(norm));
    await pushWatchedItems(payload, nvSess.access_token);
    res.json({ success: true, pushed: payload.length, movies: payload.filter(i => i.content_type === 'movie').length, series: payload.filter(i => i.content_type === 'series').length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/nuke-and-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, includeWatchedEpisodes = false, includeRemoved = false } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
    addLog('💣 NUKE & SYNC...');
    const stAuth = await stremioLogin(stremioEmail, stremioPassword);
    addLog('✅ Login Stremio');
    const rawAll    = await getStremioLibraryRaw(stAuth.token);
    const rawActive = rawAll.filter(i => !i.removed && !i.temp);
    addLog(`📚 Stremio: ${rawActive.length} attivi`);
    if (!rawActive.length) return res.json({ success: false, error: 'Libreria Stremio vuota' });
    const normalized       = rawAll.map(normalizeItem);
    const normalizedActive = normalized.filter(i => !i.removed && !i.temp);
    const librarySource    = includeRemoved ? rawAll : rawActive;
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token        = nuvioSession.access_token;
    const ownerId      = await getEffectiveOwnerId(token);
    addLog(`✅ Login Nuvio — owner: ${ownerId}`);
    await supabaseRpc('sync_push_library', { p_items: [] }, token);
    await supabaseRpc('sync_push_watched_items', { p_items: [] }, token);
    await supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token);
    await Promise.allSettled([
      fetch(SUPABASE_URL + '/rest/v1/watched_items?user_id=eq.' + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
      fetch(SUPABASE_URL + '/rest/v1/watch_progress?user_id=eq.' + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
    ]);
    addLog('✅ Pulizia completata');
    const warnings = [];
    const libraryPayload = buildLibraryPayload(librarySource);
    addLog(`📦 Library: ${libraryPayload.length}`);
    await pushLibrary(libraryPayload, token);
    addLog('✅ Library OK');
    const progressPayload = buildWatchProgressPayload(normalized);
    addLog(`⏩ Progress: ${progressPayload.length}`);
    try { await pushWatchProgress(progressPayload, token); addLog('✅ Progress OK'); }
    catch (e) { addLog(`⚠️ Progress: ${e.message}`); warnings.push(`Progress: ${e.message}`); }
    const watchedTitles = buildWatchedPayload(normalized);
    let watchedEpisodes = [];
    if (includeWatchedEpisodes) {
      try {
        addLog(`📺 Decodifico episodi da bitfield...`);
        const EPISODE_TIMEOUT = 40000;
        watchedEpisodes = await Promise.race([
          buildWatchedEpisodesPayload(normalized, 8, m => addLog('  '+m)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), EPISODE_TIMEOUT)),
        ]);
        addLog(`✅ Episodi decodificati: ${watchedEpisodes.length}`);
      } catch(e) {
        addLog(`⚠️ Episodi: ${e.message === 'timeout' ? 'timeout (dati parziali)' : e.message}`);
      }
    }
    const allWatched = dedupeWatched([...watchedTitles, ...watchedEpisodes]);
    addLog(`📤 Watched: ${allWatched.length} (titoli:${watchedTitles.length} + ep:${watchedEpisodes.length})`);
    try { await pushWatchedItems(allWatched, token); addLog('✅ Watched title-level OK'); }
    catch (e) { addLog(`⚠️ Watched: ${e.message}`); warnings.push(`Watched: ${e.message}`); }
    if (watchedEpisodes.length > 0) {
      try {
        const epPushed = await pushWatchedEpisodes(watchedEpisodes, token, ownerId);
        addLog(`✅ Episodi REST: ${epPushed} pushati`);
      } catch(e) { addLog(`⚠️ Episodi REST: ${e.message}`); warnings.push(e.message); }
    }
    const watchedSeriesTitles = watchedTitles.filter(w => w.content_type === 'series');
    try { const pushed = await pushSeriesProxyEpisodes(watchedSeriesTitles, token, ownerId); addLog(`✅ Badge serie: ${pushed} proxy S1E1`); }
    catch(e) { addLog(`⚠️ Badge serie: ${e.message}`); warnings.push(`Badge serie: ${e.message}`); }
    const libraryCidSet = new Set(libraryPayload.map(l => l.content_id));
    const missingWatched = [...watchedTitles.filter(w => !libraryCidSet.has(w.content_id))].filter((v, i, a) => a.findIndex(x => x.content_id === v.content_id) === i);
    if (missingWatched.length > 0) {
      const extraLib = missingWatched.map(w => { const raw = normalized.find(i => extractContentId(i.id) === w.content_id); return { content_id: w.content_id, content_type: w.content_type, name: (raw && raw.name) || w.title || w.content_id, poster: (raw && raw.poster) || null, poster_shape: 'POSTER', background: null, description: null, release_info: (raw && raw.year) ? String(raw.year) : '', imdb_rating: (raw && raw.imdbRating) || null, genres: (raw && raw.genres) || [], addon_base_url: null, added_at: toMs((raw && raw.mtime) || null) }; }).filter(Boolean);
      if (extraLib.length > 0) {
        try { await supabaseRpc('sync_push_library', { p_items: [...libraryPayload, ...extraLib] }, token); addLog(`✅ Library extra: ${extraLib.length}`); }
        catch(e) { addLog(`⚠️ Library extra: ${e.message}`); }
      }
    }
    const [finalLib, finalW, finalP] = await Promise.all([getNuvioLibrary(token), getNuvioWatchedItems(token), getNuvioWatchProgress(token)]);
    addLog(`\n📊 NUVIO DOPO: library=${finalLib.length} watched=${finalW.length} progress=${finalP.length}`);
    res.json({ success: true, warnings, log, message: `✅ NUKE & SYNC COMPLETO!\nLibrary:${finalLib.length} · Watched:${finalW.length} · CW:${finalP.length}`, stats: { stremioActive: rawActive.length, pushedLibrary: libraryPayload.length, pushedProgress: progressPayload.length, nuvioLibraryAfter: finalLib.length, nuvioWatchedAfter: finalW.length, nuvioProgressAfter: finalP.length } });
  } catch (e) { addLog(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log }); }
});

// ============================================================
// SYNC PRINCIPALE (LOGICA CORRETTA: TUTTE LE SERIE, SOLO ULTIMO EPISODIO)
// ============================================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword, includeRemoved = false } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword)
    return res.status(400).json({ success: false, error: 'Credenziali mancanti' });
  const log = []; 
  const addLog = m => { console.log(m); log.push(m); };
  
  try {
    addLog('🚀 Sync Stremio → Nuvio...');

    const [sa, ns] = await Promise.all([
      stremioLogin(stremioEmail, stremioPassword),
      supabaseLogin(nuvioEmail, nuvioPassword),
    ]);
    const token   = ns.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    addLog(`✅ Login OK — owner: ${ownerId}`);

    const rawAll = await getStremioLibraryRaw(sa.token);
    const rawActive = rawAll.filter(i => !i.removed);
    
    addLog(`📚 Stremio: ${rawActive.length} attivi`);
    
    if (!rawActive.length) return res.json({ success: false, error: 'Libreria Stremio vuota' });
    
    const normalized = rawAll.map(normalizeItem);
    const normalizedActive = normalized.filter(i => !i.removed);
    const librarySource = includeRemoved ? rawAll : rawActive;
    
    const moviesInStremio = rawActive.filter(i => i.type === 'movie');
    const seriesInStremio = rawActive.filter(i => i.type === 'series' || i.type === 'show');
    addLog(`   Film: ${moviesInStremio.length}, Serie: ${seriesInStremio.length}`);

    const warnings = [];
    
    // NUKE - Pulisci tutto
    try {
      await Promise.all([
        supabaseRpc('sync_push_library', { p_items: [] }, token),
        supabaseRpc('sync_push_watched_items', { p_items: [] }, token),
        supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token),
      ]);
      const delHeaders = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' };
      await Promise.allSettled([
        fetch(`${SUPABASE_URL}/rest/v1/watched_items?user_id=eq.${ownerId}`, { method: 'DELETE', headers: delHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/watch_progress?user_id=eq.${ownerId}`, { method: 'DELETE', headers: delHeaders }),
      ]);
      addLog('✅ Nuke OK');
    } catch(e) { addLog(`⚠️ Nuke: ${e.message}`); }

    // LIBRARY
    const lp = buildLibraryPayload(librarySource);
    try { await pushLibrary(lp, token); addLog(`✅ Library: ${lp.length}`); }
    catch(e) { addLog(`❌ Library: ${e.message}`); warnings.push(e.message); }

    // PROGRESS (Continue Watching) - solo quelli attivi in Stremio
    const pp = buildWatchProgressPayload(normalizedActive);
    try { await pushWatchProgress(pp, token); addLog(`✅ CW: ${pp.length}`); }
    catch(e) { addLog(`⚠️ CW: ${e.message}`); warnings.push(e.message); }

    // ================= PUSH TITLE-LEVEL WATCHED (FILM + SERIE) =================
    const titleLevelWatched = buildWatchedPayload(normalized);
    addLog(`🎬 Title-level da pushare: ${titleLevelWatched.length} (film:${titleLevelWatched.filter(i=>i.content_type==='movie').length} serie:${titleLevelWatched.filter(i=>i.content_type==='series').length})`);
    
    let titleLevelPushed = 0;
    if (titleLevelWatched.length > 0) {
      titleLevelPushed = await pushWatchedItems(titleLevelWatched, token);
      addLog(`✅ Title-level pushati: ${titleLevelPushed}`);
    }

    // ================= LOGICA EPISODI: TUTTE LE SERIE, SOLO ULTIMO EPISODIO =================
    const allSeries = normalized.filter(i => 
      (i.type === 'series' || i.type === 'show') && 
      !i.removed
    );

    let allEpisodesToPush = [];

    if (allSeries.length === 0) {
      addLog('📺 Nessuna serie trovata.');
    } else {
      addLog(`📺 Trovate ${allSeries.length} serie, analizzo stato...`);

      allEpisodesToPush = [];
      const progressMarkers = [];

      for (const series of allSeries) {
        try {
          const cid = extractContentId(series.id);
          if (!cid) continue;
          
          const watchedAt = toMs(series.state.lastWatched || series.mtime) || Date.now();
          const { videoId, timeOffset, duration, watchedField, timesWatched, flaggedWatched, watchedBool } = series.state;
          
          // Determina se la serie è considerata "vista" (title-level)
          const pct = duration > 0 ? (timeOffset / duration) : 0;
          const isTitleWatched = watchedBool || timesWatched > 0 || flaggedWatched > 0 || pct >= 0.80;
          
          // Se non è vista, salta (non pushare nulla)
          if (!isTitleWatched && !watchedField) {
            addLog(`  ⚠️ Serie "${series.name}" - non marcata come vista, salto`);
            continue;
          }
          
          // Aggiungi SEMPRE il title-level (badge serie) se è vista
          allEpisodesToPush.push({
            content_id: cid,
            content_type: 'series',
            title: cid,
            season: null,
            episode: null,
            watched_at: watchedAt
          });
          
          // Decodifica episodi visti dal bitfield (se presente)
          let watchedEpisodes = [];
          let totalEpisodes = 0;
          let isComplete = false;
          
          if (watchedField) {
            try {
              const wf = parseWatchedField(watchedField);
              if (wf) {
                const rawVids = await fetchCinemetaVideos(series.id);
                if (rawVids?.length) {
                  const sorted = sortVideos(rawVids.map(normalizeVideo)).filter(v => v.id);
                  if (sorted.length) {
                    totalEpisodes = sorted.length;
                    const flags = resolveWatchedFlags(wf, sorted.map(v => v.id));
                    
                    for (let i = 0; i < sorted.length; i++) {
                      if (flags[i] && sorted[i].season && sorted[i].episode) {
                        watchedEpisodes.push({
                          content_id: cid,
                          content_type: 'series',
                          title: cid,
                          season: sorted[i].season,
                          episode: sorted[i].episode,
                          watched_at: watchedAt
                        });
                      }
                    }
                    
                    isComplete = totalEpisodes > 0 && watchedEpisodes.length === totalEpisodes;
                  }
                }
              }
            } catch(e) {
              addLog(`  ⚠️ Errore decodifica bitfield per ${series.name}: ${e.message}`);
            }
          }
          
          if (isComplete) {
            addLog(`  ✅ Serie COMPLETA "${series.name}" (${watchedEpisodes.length}/${totalEpisodes} ep) → solo title-level, NESSUN episodio`);
            // Non pushare NESSUN episodio
          } else if (watchedEpisodes.length > 0 || videoId) {
            // Serie incompleta: trova l'ULTIMO episodio (quello su cui ti sei fermato)
            let lastSeason = null;
            let lastEpisode = null;
            let lastPosition = 0;
            let lastDuration = 0;
            
            // PRIMA PRIORITÀ: usa videoId dallo stato (episodio corrente in CW)
            if (videoId) {
              const { season, episode } = parseSE(videoId);
              if (season && episode) {
                lastSeason = season;
                lastEpisode = episode;
                lastPosition = timeOffset;
                lastDuration = duration;
                const posPercent = lastDuration > 0 ? Math.round((lastPosition / lastDuration) * 100) : 0;
                addLog(`  🟡 Serie "${series.name}" (CW: S${lastSeason}E${lastEpisode} ${posPercent}%) → push solo questo episodio`);
              }
            }
            
            // FALLBACK: trova l'ultimo episodio nel bitfield (per indice/ordine)
            if (!lastSeason && watchedEpisodes.length > 0) {
              const lastEp = watchedEpisodes.reduce((prev, curr) => {
                if (curr.season > prev.season) return curr;
                if (curr.season === prev.season && curr.episode > prev.episode) return curr;
                return prev;
              }, watchedEpisodes[0]);
              lastSeason = lastEp.season;
              lastEpisode = lastEp.episode;
              addLog(`  🟡 Serie "${series.name}" (fallback: ultimo ep S${lastSeason}E${lastEpisode}) → push solo questo episodio`);
            }
            
            // Se abbiamo un episodio, pushalo e crea marker CW
            if (lastSeason && lastEpisode) {
              // Pusha SOLO l'ultimo episodio
              allEpisodesToPush.push({
                content_id: cid,
                content_type: 'series',
                title: cid,
                season: lastSeason,
                episode: lastEpisode,
                watched_at: watchedAt
              });
              
              // Marker CW per quell'episodio con la posizione corretta
              progressMarkers.push({
                user_id: ownerId,
                content_id: cid,
                content_type: 'series',
                video_id: `${cid}:${lastSeason}:${lastEpisode}`,
                season: lastSeason,
                episode: lastEpisode,
                position: lastPosition > 0 ? lastPosition : 999999,
                duration: lastDuration > 0 ? lastDuration : 1000000,
                last_watched: watchedAt,
                progress_key: `${cid}_s${lastSeason}e${lastEpisode}`
              });
            } else if (watchedEpisodes.length > 0) {
              addLog(`  ⚠️ Serie "${series.name}" - impossibile determinare ultimo episodio (${watchedEpisodes.length} eps visti ma senza posizione)`);
            }
          } else if (watchedEpisodes.length === 0 && !videoId) {
            addLog(`  ⚠️ Serie "${series.name}" - marcata vista ma senza episodi, solo title-level`);
          }
        } catch (e) {
          addLog(`  ❌ Errore su serie ${series.id}: ${e.message}`);
        }
      }

      const finalPayload = dedupeWatched(allEpisodesToPush);
      addLog(`📤 Episodi da pushare: ${finalPayload.length} (titoli + solo ultimi episodi)`);

      if (finalPayload.length > 0) {
        const pushed = await pushWatchedEpisodes(finalPayload, token, ownerId);
        addLog(`✅ Episodi pushati: ${pushed}`);
      }

      if (progressMarkers.length > 0) {
        const existingCW = await getNuvioWatchProgress(token);
        const allMarkers = [...existingCW, ...progressMarkers];
        await supabaseRpc('sync_push_watch_progress', { p_entries: allMarkers }, token).catch(err => {
          addLog(`⚠️ Marker CW: ${err.message}`);
        });
        addLog(`📌 Marker CW pushati: ${progressMarkers.length}`);
      }
    }

    // Verifica finale con PAGINAZIONE per leggere TUTTI i record
    try {
      const dbLib = await getNuvioLibrary(token);
      const dbCW  = await getNuvioWatchProgress(token);
      const allWatched = await getAllWatchedItems(token, ownerId);
      
      const dbMovies   = allWatched.filter(i => i.content_type === 'movie' && i.season == null).length;
      const dbSeries   = allWatched.filter(i => i.content_type === 'series' && i.season == null).length;
      const dbEpisodes = allWatched.filter(i => i.season != null).length;
      
      addLog(`📊 FINALE: lib=${dbLib.length} watched=${allWatched.length} (film:${dbMovies} serie:${dbSeries} ep:${dbEpisodes}) CW=${dbCW.length}`);
      
      const titleLevelSample = allWatched.filter(i => i.season == null).slice(0, 10);
      if (titleLevelSample.length) {
        addLog(`   Title-level sample: ${titleLevelSample.map(t => `${t.content_type}:${t.content_id}`).join(', ')}`);
      }
      
      const episodeSample = allWatched.filter(i => i.season != null).slice(0, 5);
      if (episodeSample.length) {
        addLog(`   Episodi sample: ${episodeSample.map(e => `${e.content_id}:S${e.season}E${e.episode}`).join(', ')}`);
      }
    } catch(e) { addLog(`⚠️ Verifica DB: ${e.message}`); }

    addLog('✅ SYNC COMPLETO!');
    res.json({
      success: true, warnings, log,
      message: `✅ SYNC OK!\nLibrary:${lp.length} · Title-level:${titleLevelPushed} · Episodi:${allEpisodesToPush?.length || 0} · CW:${pp.length}`,
    });
    
  } catch(e) { 
    addLog(`💥 ${e.message}`); 
    res.status(500).json({ success: false, error: e.message, log }); 
  }
});

// ============================================================
// ALTRI ENDPOINT (completi)
// ============================================================

app.post('/force-all-badges', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail||!stremioPassword||!nuvioEmail||!nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  try {
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
    const we = await buildWatchedEpisodesPayload(norm, 5, addLog);
    const aw = dedupeWatched([...wt, ...we]);
    await pushWatchedItems(aw, token);
    addLog(`✅ Watched: ${aw.length}`);
    res.json({ success: true, log, message: `🎉 ${aw.length} badge!`, stats: { watchedTitles: wt.length, watchedEpisodes: we.length, total: aw.length } });
  } catch (e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

app.post('/reset-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  res.json({ success: true, message: '✅ Reset avviato. Attendi 5 secondi poi fai Carica Nuvio per verificare.', before: '?', after: 0 });
  setImmediate(async () => {
    try {
      const session = await supabaseLogin(nuvioEmail, nuvioPassword);
      const token   = session.access_token;
      const ownerId = await getEffectiveOwnerId(token);
      await supabaseRpc('sync_push_watched_items', { p_items: [] }, token);
      await supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token);
      await Promise.allSettled([
        fetch(SUPABASE_URL + '/rest/v1/watched_items?user_id=eq.' + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
        fetch(SUPABASE_URL + '/rest/v1/watch_progress?user_id=eq.' + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
      ]);
    } catch(e) { console.error('reset-watched background error:', e.message); }
  });
});

app.post('/reset-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword, nuvioToken } = req.body;
  if (!nuvioToken && (!nuvioEmail || !nuvioPassword)) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const token = nuvioToken || (await supabaseLogin(nuvioEmail, nuvioPassword)).access_token;
    const ownerId  = await getEffectiveOwnerId(token);
    await Promise.all([
      supabaseRpc('sync_push_library', { p_items: [] }, token),
      supabaseRpc('sync_push_watched_items', { p_items: [] }, token),
      supabaseRpc('sync_push_watch_progress', { p_entries: [] }, token),
      fetch(SUPABASE_URL + '/rest/v1/watched_items?user_id=eq.'  + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
      fetch(SUPABASE_URL + '/rest/v1/watch_progress?user_id=eq.' + ownerId, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=minimal' } }),
    ]);
    res.json({ success: true, message: '✅ Library + watched + progress azzerati', before: '?' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/mark-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId, contentType, title, watched = true } = req.body;
  if (!nuvioEmail || !nuvioPassword || !contentId || !contentType) 
    return res.status(400).json({ success: false, error: 'Parametri richiesti' });

  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);

    const baseHeaders = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Prefer': 'return=minimal'
    };

    const filterQ = `content_id=eq.${encodeURIComponent(contentId)}&content_type=eq.${encodeURIComponent(contentType)}&season=is.null&episode=is.null`;
    await fetch(`${SUPABASE_URL}/rest/v1/watched_items?${filterQ}`, {
      method: 'DELETE',
      headers: baseHeaders
    }).catch(e => console.warn('DELETE title-level fallito (ignorato):', e.message));

    if (contentType === 'series') {
      await fetch(`${SUPABASE_URL}/rest/v1/watched_items?content_id=eq.${encodeURIComponent(contentId)}&content_type=eq.series&season=eq.1&episode=eq.1`, {
        method: 'DELETE',
        headers: baseHeaders
      }).catch(() => {});
    }

    if (watched) {
      await pushWatchedItems([{
        content_id: contentId,
        content_type: contentType,
        title: contentId,
        season: null,
        episode: null,
        watched_at: Date.now()
      }], token);

      if (contentType === 'series') {
        await pushSeriesProxyEpisodes([{
          content_id: contentId,
          content_type: 'series',
          title: contentId,
          watched_at: Date.now()
        }], token, ownerId);
      }
    } else {
      if (contentType === 'series') {
        await fetch(`${SUPABASE_URL}/rest/v1/watched_items?content_id=eq.${encodeURIComponent(contentId)}&content_type=eq.series&season=is.not.null`, {
          method: 'DELETE',
          headers: baseHeaders
        }).catch(() => {});
      }
    }

    res.json({ success: true, message: `✅ "${title || contentId}" ${watched ? 'marcato come visto' : 'badge rimosso'}` });
  } catch (e) {
    console.error('Errore in mark-watched:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/add-to-nuvio', async (req, res) => {
  const { nuvioEmail, nuvioPassword, item } = req.body;
  if (!nuvioEmail || !nuvioPassword || !item) return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    const cid     = extractContentId(item._id || item.id || item.content_id || '');
    const ct      = normalizeType(item.type || item.content_type || 'movie');
    if (!cid) return res.status(400).json({ success: false, error: 'ID non valido' });
    const built = buildLibraryPayload([item])[0];
    if (!built) return res.status(400).json({ success: false, error: 'Impossibile costruire payload' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/library_items`, { method: 'POST', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ ...built, user_id: ownerId, profile_id: 1 }) });
    if (!r.ok) {
      const current = await getNuvioLibrary(token);
      const exists = current.some(i => String(i.content_id) === cid && String(i.content_type) === ct);
      if (exists) return res.json({ success: true, message: `"${item.name}" è già nella libreria Nuvio` });
      await pushLibrary([...current.map(i => ({ content_id: i.content_id, content_type: i.content_type, name: i.name||'', poster: i.poster||null, poster_shape: i.poster_shape||'POSTER', background: i.background||null, release_info: i.release_info||'', imdb_rating: i.imdb_rating||null, genres: i.genres||[], addon_base_url: null, added_at: i.added_at||Date.now() })), built], token);
    }
    res.json({ success: true, message: `✅ "${item.name||cid}" aggiunto alla libreria Nuvio` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/remove-from-nuvio', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId, contentType } = req.body;
  if (!nuvioEmail || !nuvioPassword || !contentId) return res.status(400).json({ success: false, error: 'Parametri mancanti' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    let filterQ = `content_id=eq.${encodeURIComponent(contentId)}`;
    if (contentType) filterQ += `&content_type=eq.${encodeURIComponent(contentType)}`;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/library_items?${filterQ}`, { method: 'DELETE', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Prefer': 'return=minimal' } });
    if (!r.ok) {
      const current  = await getNuvioLibrary(token);
      const filtered = current.filter(i => !(String(i.content_id) === contentId && (!contentType || String(i.content_type) === contentType)));
      if (filtered.length === current.length) return res.json({ success: true, message: 'Item non trovato nella libreria Nuvio' });
      await pushLibrary(filtered.map(i => ({ content_id: i.content_id, content_type: i.content_type, name: i.name||'', poster: i.poster||null, poster_shape: i.poster_shape||'POSTER', background: i.background||null, release_info: i.release_info||'', imdb_rating: i.imdb_rating||null, genres: i.genres||[], addon_base_url: null, added_at: i.added_at||Date.now() })), token);
    }
    res.json({ success: true, message: `✅ Rimosso dalla libreria Nuvio` });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/debug-raw-stremio', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const auth   = await stremioLogin(email, password);
    const rawAll = await getStremioLibraryRaw(auth.token);
    const norm   = rawAll.map(normalizeItem);
    const moviesWatched = norm.filter(i => i.type === 'movie' && (i.state.watchedBool || i.state.timesWatched > 0 || i.state.flaggedWatched > 0 || (i.state.duration > 0 && i.state.timeOffset / i.state.duration >= 0.80)));
    const seriesWatched = norm.filter(i => (i.type === 'series' || i.type === 'show') && (i.state.watchedBool || i.state.timesWatched > 0 || i.state.flaggedWatched > 0 || i.state.watchedField));
    const inProgress    = norm.filter(i => i.state.timeOffset > 0 && i.state.duration > 0 && !i.removed && (i.state.timeOffset / i.state.duration) >= 0.03 && (i.state.timeOffset / i.state.duration) <= 0.92);
    res.json({ success: true, summary: { total: rawAll.length, active: rawAll.filter(i => !i.removed && !i.temp).length, removed: rawAll.filter(i => i.removed).length, movies: rawAll.filter(i => i.type === 'movie').length, series: rawAll.filter(i => i.type === 'series' || i.type === 'show').length, moviesWatched: moviesWatched.length, seriesWatched: seriesWatched.length, inProgress: inProgress.length, seriesWithBitfield: norm.filter(i => i.state.watchedField).length } });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message).slice(0, 200) }); }
});

app.post('/debug-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  const log = [];
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    log.push(`Owner: ${await getEffectiveOwnerId(token).catch(() => '?')}`);
    const [library, watched, progress] = await Promise.all([getNuvioLibrary(token), getNuvioWatchedItems(token), getNuvioWatchProgress(token)]);
    log.push(`Library:${library.length} Watched:${watched.length} Progress:${progress.length}`);
    res.json({ success: true, log, library: library.slice(0,20), watched: watched.slice(0,10), total: library.length });
  } catch (e) { res.status(500).json({ success: false, log, error: e.message }); }
});

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
    res.json({ success: true, log, sample: { wt: wt.slice(0,3), pr: pr.slice(0,3) } });
  } catch (e) { log.push(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

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

app.post('/check-nuvio-watched', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId } = req.body;
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const items   = await getNuvioWatchedItems(session.access_token);
    const result  = { success: true, total: items.length, movies: items.filter(i=>i.content_type==='movie'&&i.season==null).length, seriesLevel: items.filter(i=>i.content_type==='series'&&i.season==null).length, episodes: items.filter(i=>i.season!=null&&i.episode!=null).length, sample: items.slice(0,10) };
    if (contentId) result.specific = items.filter(i=>i.content_id===contentId||i.content_id.includes(contentId));
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/debug-stremio-library', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth  = await stremioLogin(email, password);
    const items = await getStremioLibraryRaw(auth.token);
    const norm  = items.map(normalizeItem);
    const inPr  = norm.filter(i => i.state.timeOffset > 0 && i.state.duration > 0 && !i.removed);
    res.json({ success: true, rows_count: items.length, inProgress: inPr.length, sample: items.slice(0,3), progressSample: inPr.slice(0,5).map(i => ({ id: i.id, name: i.name, type: i.type, pct: Math.round(i.state.timeOffset/i.state.duration*100)+'%', videoId: i.state.videoId })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/debug-sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  try {
    const [sa, ns] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const [si, nl] = await Promise.all([getStremioLibraryRaw(sa.token).then(i=>i.filter(x=>!x.removed&&!x.temp)), getNuvioLibrary(ns.access_token)]);
    res.json({ success: true, stats: { stremio: si.length, nuvio: nl.length } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/debug-full-sync', async (req, res) => {
  const { nuvioEmail, nuvioPassword, contentId = 'tt0111161' } = req.body;
  const log = []; const addLog = m => { console.log(m); log.push(m); };
  if (!nuvioEmail||!nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    addLog(`Owner: ${await getEffectiveOwnerId(token).catch(() => '?')}`);
    try { await supabaseRpc('sync_push_watched_items', { p_items: [{ content_id: contentId, content_type: 'movie', title: contentId, season: null, episode: null, watched_at: Date.now() }] }, token); const w = await getNuvioWatchedItems(token); addLog(`Watched: ${w.some(i=>i.content_id===contentId)?'✅':'❌'}`); } catch (e) { addLog(`Watched ❌: ${e.message}`); }
    try { await supabaseRpc('sync_push_library', { p_items: [{ content_id: contentId, content_type: 'movie', name: 'Test', poster: null, poster_shape: 'POSTER', added_at: Date.now() }] }, token); const l = await getNuvioLibrary(token); addLog(`Library: ${l.some(i=>i.content_id===contentId)?'✅':'❌'}`); } catch (e) { addLog(`Library ❌: ${e.message}`); }
    try { await supabaseRpc('sync_push_watch_progress', { p_entries: [{ content_id: contentId, content_type: 'movie', video_id: contentId, season: null, episode: null, position: 120000, duration: 240000, last_watched: Date.now(), progress_key: contentId }] }, token); addLog('Progress ✅'); } catch (e) { addLog(`Progress ❌: ${e.message}`); }
    res.json({ success: true, log });
  } catch (e) { addLog(`💥 ${e.message}`); res.status(500).json({ success: false, log, error: e.message }); }
});

app.post('/nuvio-stats-fast', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    async function countTable(table) {
      try {
        const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?user_id=eq.' + ownerId + '&select=id', { method: 'GET', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Prefer': 'count=exact', 'Range': '0-0' } });
        const contentRange = r.headers.get('content-range');
        if (contentRange) { const parts = contentRange.split('/'); if (parts[1] && parts[1] !== '*') return parseInt(parts[1], 10); }
        const data = await r.json();
        return Array.isArray(data) ? data.length : '?';
      } catch { return '?'; }
    }
    const [library, watched, progress] = await Promise.all([countTable('library_items'), countTable('watched_items'), countTable('watch_progress')]);
    res.json({ success: true, ownerId, counts: { library, watched, progress }, message: library === 0 ? '⚠️ Library VUOTA' : watched === 0 ? '⚠️ Watched VUOTO' : '✅ DB OK' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/tmdb-poster', async (req, res) => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(204).end();
  const { title, year, type } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const ep   = type === 'movie' ? `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year||''}&language=it-IT` : `https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=it-IT`;
    const r    = await fetch(ep);
    const data = await r.json();
    const url  = data.results?.[0]?.poster_path ? `https://image.tmdb.org/t/p/w185${data.results[0].poster_path}` : null;
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ url });
  } catch { res.status(500).json({ url: null }); }
});

app.post('/diagnose', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Tutte e 4 le credenziali richieste' });
  const L = []; const log = m => { console.log('[diag]', m); L.push(m); };
  try {
    const [stAuth, nvSess] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const token   = nvSess.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    log(`✅ Stremio OK | Nuvio owner: ${ownerId}`);
    const rawAll = await getStremioLibraryRaw(stAuth.token);
    const norm   = rawAll.map(normalizeItem);
    const active = norm.filter(i => !i.removed && !i.temp);
    log(`Totale: ${rawAll.length} | Attivi: ${active.length}`);
    const [nvLib, nvWatched, nvProgress] = await Promise.all([getNuvioLibrary(token), getNuvioWatchedItems(token), getNuvioWatchProgress(token)]);
    log(`Nuvio — library:${nvLib.length} watched:${nvWatched.length} progress:${nvProgress.length}`);
    res.json({ success: true, log: L, stats: { stremio: { total: rawAll.length, active: active.length }, nuvio: { library: nvLib.length, watched: nvWatched.length, progress: nvProgress.length } } });
  } catch(e) { L.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log: L }); }
});

app.post('/diagnose-series', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  const L = []; const log = m => { console.log('[diag-series]', m); L.push(m); };
  try {
    const [stAuth, nvSess] = await Promise.all([stremioLogin(stremioEmail, stremioPassword), supabaseLogin(nuvioEmail, nuvioPassword)]);
    const token = nvSess.access_token;
    const rawAll = await getStremioLibraryRaw(stAuth.token);
    const norm   = rawAll.map(normalizeItem);
    const series = norm.filter(i => (i.type==='series'||i.type==='show') && !i.removed && !i.temp);
    log(`Serie totali: ${series.length}`);
    const withBitfield = series.filter(i => i.state.watchedField);
    log(`Serie con watchedField: ${withBitfield.length}`);
    res.json({ success: true, log: L });
  } catch(e) { L.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log: L }); }
});

async function resolveToken(body) {
  if (body.nuvioToken) return body.nuvioToken;
  const s = await supabaseLogin(body.nuvioEmail, body.nuvioPassword);
  return s.access_token;
}

app.post('/do-push-library', async (req, res) => {
  const { nuvioEmail, nuvioPassword, items } = req.body;
  if (!nuvioEmail || !nuvioPassword || !Array.isArray(items)) return res.status(400).json({ success: false, error: 'nuvioEmail, nuvioPassword, items richiesti' });
  try { const { access_token } = await supabaseLogin(nuvioEmail, nuvioPassword); await pushLibrary(items, access_token); res.json({ success: true, pushed: items.length }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/do-push-library-append', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items richiesti' });
  try { const token = await resolveToken(req.body); await pushLibrary(items, token); res.json({ success: true, pushed: items.length }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/do-push-watched-append', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items richiesti' });
  try {
    const token   = await resolveToken(req.body);
    const ownerId = await getEffectiveOwnerId(token);
    const BATCH = 200; let pushed = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH).map(item => ({ 
        user_id: ownerId, 
        content_id: item.content_id, 
        content_type: item.content_type, 
        title: item.content_id, 
        season: item.season != null ? Number(item.season) : null, 
        episode: item.episode != null ? Number(item.episode) : null, 
        watched_at: Number(item.watched_at) || Date.now(), 
        profile_id: 1 
      }));
      const r = await fetch(`${SUPABASE_URL}/rest/v1/watched_items`, { method: 'POST', headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(slice) });
      if (r.ok) pushed += slice.length;
    }
    res.json({ success: true, pushed });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/do-push-progress', async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ success: false, error: 'entries richiesti' });
  try { const token = await resolveToken(req.body); await pushWatchProgress(entries, token); res.json({ success: true, pushed: entries.length }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/do-push-watched', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items richiesti' });
  try { const token = await resolveToken(req.body); await supabaseRpc('sync_push_watched_items', { p_items: items }, token); res.json({ success: true, pushed: items.length }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/debug-db-raw', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const L = []; const log = m => { console.log(m); L.push(m); };
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const userId  = session.user?.id;
    const ownerId = await getEffectiveOwnerId(token);
    log(`userId:  ${userId}`); log(`ownerId: ${ownerId}`);
    const rpcWatched  = await getNuvioWatchedItems(token);
    const rpcProgress = await getNuvioWatchProgress(token);
    const rpcLibrary  = await getNuvioLibrary(token);
    log(`RPC watched:  ${rpcWatched.length}`); log(`RPC progress: ${rpcProgress.length}`); log(`RPC library:  ${rpcLibrary.length}`);
    res.json({ success: true, log: L, counts: { rpcWatched: rpcWatched.length, rpcProgress: rpcProgress.length, rpcLibrary: rpcLibrary.length } });
  } catch(e) { L.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log: L }); }
});

app.post('/debug-watched-match', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  const L = []; const log = m => { console.log(m); L.push(m); };
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const [rpcWatched, rpcLibrary] = await Promise.all([getNuvioWatchedItems(token), getNuvioLibrary(token)]);
    const libSeriesIds = new Set(rpcLibrary.filter(i => i.content_type === 'series').map(i => i.content_id));
    const watchedSeries = rpcWatched.filter(i => i.content_type === 'series');
    const seriesMatch   = watchedSeries.filter(w => libSeriesIds.has(w.content_id));
    const seriesMissing = watchedSeries.filter(w => !libSeriesIds.has(w.content_id));
    log(`Serie watched con match in library: ${seriesMatch.length}/${watchedSeries.length}`);
    if (seriesMissing.length > 0) seriesMissing.forEach(w => log(`  ⚠️ ${w.content_id} | "${w.title}"`));
    else log('✅ Tutte le serie watched hanno match in library!');
    res.json({ success: true, log: L, stats: { seriesMatch: seriesMatch.length, seriesMissing: seriesMissing.length } });
  } catch(e) { L.push(`💥 ${e.message}`); res.status(500).json({ success: false, error: e.message, log: L }); }
});

app.post('/do-push-episode-markers', async (req, res) => {
  const { episodes } = req.body;
  if (!Array.isArray(episodes)) return res.status(400).json({ success: false, error: 'episodes richiesti' });
  try {
    const token = await resolveToken(req.body);
    const currentCW = await getNuvioWatchProgress(token);
    const MARKER_MS = 5400000;
    const markers = episodes.filter(ep => ep.season != null && ep.episode != null).map(ep => ({ content_id: ep.content_id, content_type: ep.content_type || 'series', video_id: `${ep.content_id}:${ep.season}:${ep.episode}`, season: ep.season, episode: ep.episode, position: MARKER_MS, duration: MARKER_MS, last_watched: ep.watched_at || Date.now(), progress_key: `${ep.content_id}_s${ep.season}e${ep.episode}` }));
    const cwKeys = new Set(currentCW.map(e => e.progress_key));
    const filteredMarkers = markers.filter(m => !cwKeys.has(m.progress_key));
    const allEntries = [...currentCW, ...filteredMarkers];
    await supabaseRpc('sync_push_watch_progress', { p_entries: allEntries }, token);
    res.json({ success: true, pushed: allEntries.length, cw: currentCW.length, markers: filteredMarkers.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/get-stremio-addons', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Credenziali richieste' });
  try {
    const auth = await stremioLogin(email, password);
    const r = await fetch(`${STREMIO_API}/api/addonCollectionGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': STREMIO_UA },
      body: JSON.stringify({ authKey: auth.token, type: 'AddonCollection', id: 'addon_collection' }),
    });
    if (!r.ok) throw new Error(`addonCollectionGet HTTP ${r.status}`);
    const data = await r.json();
    const raw = data?.result?.addons || data?.result || [];
    const addons = (Array.isArray(raw) ? raw : []).map((a, i) => ({
      id:          a.manifest?.id || String(i),
      name:        a.manifest?.name || a.name || '',
      version:     a.manifest?.version || '',
      description: a.manifest?.description || '',
      manifestUrl: a.transportUrl
        ? (a.transportUrl.endsWith('manifest.json') ? a.transportUrl : a.transportUrl.replace(/\/?$/, '/manifest.json'))
        : '',
      logo:        a.manifest?.logo || a.manifest?.icon || a.manifest?.background || null,
      types:       a.manifest?.types || [],
      sort_order:  i,
    })).filter(a => a.manifestUrl);
    res.json({ success: true, addons });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/get-nuvio-addons', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.json({ success: false, error: 'Credenziali richieste' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    const hdr = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` };

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/addons?select=url,name,sort_order&user_id=eq.${encodeURIComponent(ownerId)}&order=sort_order.asc`,
      { method: 'GET', headers: hdr }
    );
    if (!r.ok) { const t = await r.text(); throw new Error(`Addons REST ${r.status}: ${t.slice(0,150)}`); }
    const rows = await r.json();

    const addons = await Promise.all((Array.isArray(rows) ? rows : []).map(async (row, i) => {
      let name = row.name || row.url || '';
      let logo = null;
      let types = [];
      let id = '';
      try {
        const mr = await fetch(row.url, { signal: AbortSignal.timeout(4000) });
        if (mr.ok) { const m = await mr.json(); name = m.name || name; logo = m.logo || null; types = m.types || []; id = m.id || ''; }
      } catch {}
      return { id, name, manifestUrl: row.url, logo, types, sort_order: row.sort_order ?? i };
    }));

    res.json({ success: true, addons: addons.filter(a => a.manifestUrl) });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/push-addons-to-nuvio', async (req, res) => {
  const { nuvioEmail, nuvioPassword, addons } = req.body;
  if (!nuvioEmail || !nuvioPassword || !Array.isArray(addons)) return res.status(400).json({ success: false, error: 'Parametri richiesti' });
  try {
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const token   = session.access_token;
    const ownerId = await getEffectiveOwnerId(token);
    const hdr = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` };

    const p_addons = addons
      .filter(a => a.manifestUrl)
      .map((a, i) => ({ url: a.manifestUrl, sort_order: a.sort_order ?? i }));

    await supabaseRpc('sync_push_addons', { p_addons }, token);

    const verify = await fetch(
      `${SUPABASE_URL}/rest/v1/addons?select=url,sort_order&user_id=eq.${encodeURIComponent(ownerId)}&order=sort_order.asc`,
      { method: 'GET', headers: hdr }
    );
    const written = verify.ok ? (await verify.json()) : [];

    res.json({
      success: true,
      pushed: p_addons.length,
      verified: Array.isArray(written) ? written.length : '?',
      message: `✅ ${p_addons.length} addon inviati, ${Array.isArray(written) ? written.length : '?'} nel DB`,
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/debug-watched-state', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Credenziali richieste' });
  try {
    const auth   = await stremioLogin(email, password);
    const rawAll = await getStremioLibraryRaw(auth.token);
    const norm   = rawAll.map(normalizeItem);

    const series = norm.filter(i => i.type === 'series' || i.type === 'show');
    const withBitfield = series.filter(i => i.state.watchedField);
    const withTW = series.filter(i => i.state.timesWatched > 0);
    const withFW = series.filter(i => i.state.flaggedWatched > 0);
    const withBool = series.filter(i => i.state.watchedBool);

    const movies = norm.filter(i => i.type === 'movie');
    const mWithTW = movies.filter(i => i.state.timesWatched > 0);
    const mWithBool = movies.filter(i => i.state.watchedBool);
    const mWithPct = movies.filter(i => i.state.duration > 0 && i.state.timeOffset / i.state.duration >= 0.80);

    const seriesSample = series.slice(0, 10).map(i => ({
      id: i.id, name: i.name,
      timesWatched: i.state.timesWatched,
      flaggedWatched: i.state.flaggedWatched,
      watchedBool: i.state.watchedBool,
      watchedField: i.state.watchedField ? i.state.watchedField.slice(0, 30) + '...' : null,
      rawWatched: (() => {
        const raw = rawAll.find(r => (r._id || r.id) === i.id);
        const w = raw?.state?.watched;
        if (w === null || w === undefined) return 'null/undefined';
        if (typeof w === 'boolean') return `boolean:${w}`;
        if (typeof w === 'string') return `string[${w.length}]:${w.slice(0,40)}`;
        return `${typeof w}:${JSON.stringify(w).slice(0,40)}`;
      })(),
    }));

    const wtPayload = buildWatchedPayload(norm);

    res.json({
      success: true,
      summary: {
        totalItems: rawAll.length,
        totalSeries: series.length,
        seriesWithBitfield: withBitfield.length,
        seriesWithTimesWatched: withTW.length,
        seriesWithFlaggedWatched: withFW.length,
        seriesWithWatchedBool: withBool.length,
        moviesWithTimesWatched: mWithTW.length,
        moviesWithWatchedBool: mWithBool.length,
        moviesWithPct80: mWithPct.length,
        buildWatchedPayloadResult: wtPayload.length,
        wtMovies: wtPayload.filter(i => i.content_type === 'movie').length,
        wtSeries: wtPayload.filter(i => i.content_type === 'series').length,
      },
      seriesSample,
      wtSample: wtPayload.slice(0, 10),
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/backups', (req, res) => res.json({ backups: [] }));
app.post('/restore', (req, res) => res.status(400).json({ success: false, error: 'Non disponibile.' }));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ============================================================
// Helper per buildWatchedEpisodesPayload (usato in alcuni endpoint)
// ============================================================
async function buildWatchedEpisodesPayload(normalizedItems, concurrency = 5, onProgress) {
  const seriesWithField = normalizedItems.filter(i => (i.type === 'series' || i.type === 'show') && i.state.watchedField);
  if (!seriesWithField.length) return [];
  if (onProgress) onProgress(`Recupero ${seriesWithField.length} serie da Cinemeta...`);
  const queue = [...seriesWithField];
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
    const cid = extractContentId(item.id);
    if (!cid) continue;
    const watchedAt = toMs(item.state.lastWatched || item.mtime);
    const bySeason = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i];
      if (v.season == null || v.episode == null) continue;
      if (!bySeason.has(v.season)) bySeason.set(v.season, { total: 0, watchedCount: 0, lastWatchedEp: null });
      const s = bySeason.get(v.season);
      s.total++;
      if (flags[i]) { s.watchedCount++; s.lastWatchedEp = v; }
    }
    const totalEps   = [...bySeason.values()].reduce((a, s) => a + s.total, 0);
    const watchedEps = [...bySeason.values()].reduce((a, s) => a + s.watchedCount, 0);
    if (watchedEps === 0) continue;
    const completionRatio = totalEps > 0 ? watchedEps / totalEps : 0;
    const cwPct = item.state.duration > 0 ? (item.state.timeOffset / item.state.duration) * 100 : 0;
    const isInCW = cwPct >= 3 && cwPct <= 92;
    for (const [season, data] of bySeason) {
      if (data.watchedCount === 0) continue;
      if (onProgress) onProgress(`  ${data.watchedCount === data.total ? '✅' : '📺'} "${item.name}" S${season}: ${data.watchedCount}/${data.total} ep`);
    }
    payload.push({ content_id: cid, content_type: 'series', title: item.name||'', season: null, episode: null, watched_at: watchedAt });
    let epCount = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (!flags[i]) continue;
      const v = sorted[i];
      if (v.season == null || v.episode == null) continue;
      payload.push({ content_id: cid, content_type: 'series', title: item.name||'', season: v.season, episode: v.episode, watched_at: watchedAt });
      epCount++;
    }
    if (onProgress) onProgress(`  ${Math.round(completionRatio*100)}%${isInCW?' (CW)':''} → title-level + ${epCount} ep`);
  }
  if (onProgress) onProgress(`${payload.length} entries totali`);
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

module.exports = app;
