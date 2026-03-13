const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIG SUPABASE
// ============================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ============================================
// SUPABASE HELPERS
// Il JWT identifica l'utente — NON serve mai p_profile_id.
// Le RPC di Nuvio usano auth.uid() internamente.
// ============================================
async function supabaseLogin(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Login fallito (${res.status})`);
  }
  return data.access_token;
}

async function rpc(accessToken, fnName, payload = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    const msg = (parsed && (parsed.message || parsed.error)) || text || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return parsed;
}

// ============================================
// STREMIO HELPERS
// ============================================
const STREMIO_API = 'https://api.strem.io';

async function stremioLogin(email, password) {
  const res = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, facebook: false, type: 'login' }),
  });
  const data = await res.json();
  if (!res.ok || !data?.result?.authKey) {
    throw new Error(data?.error?.message || 'Login Stremio fallito');
  }
  return data.result.authKey;
}

async function stremioGetLibrary(authKey) {
  const res = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey, collection: 'libraryItem', ids: [], all: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stremio library errore ${res.status}`);

  let items = [];
  if (Array.isArray(data?.result)) items = data.result;
  else if (Array.isArray(data?.result?.items)) items = data.result.items;

  return items.filter(i => {
    const id = i._id || i.id;
    const type = i.type || '';
    return id && (type === 'movie' || type === 'series');
  });
}

// ============================================
// UTILS
// ============================================
function toMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1_000_000_000_000 ? Math.trunc(n * 1000) : Math.trunc(n);
  }
  const p = Date.parse(s);
  return Number.isFinite(p) ? p : 0;
}

function toInt(v, fallback = 0) {
  const n = Number(v || 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function normItem(raw) {
  const id = raw._id || raw.id;
  const s = raw.state || {};
  return {
    id,
    type: raw.type || '',
    name: raw.name || '',
    poster: raw.poster || null,
    removed: Boolean(raw.removed),
    temp: Boolean(raw.temp),
    ctime: raw._ctime || raw.ctime || null,
    mtime: raw._mtime || raw.mtime || null,
    state: {
      timeOffset: toInt(s.timeOffset ?? s.time_offset),
      duration: toInt(s.duration),
      lastWatched: s.lastWatched ?? s.last_watched ?? null,
      videoId: s.video_id ?? s.videoId ?? null,
      timesWatched: toInt(s.timesWatched ?? s.times_watched),
      flaggedWatched: toInt(s.flaggedWatched ?? s.flagged_watched),
      watchedField: typeof s.watched === 'string' ? s.watched : null,
    },
  };
}

// ============================================
// PAYLOAD BUILDERS
// ============================================

// Library: tutti gli item attivi + i rimossi che risultano visti (per il badge)
function buildLibraryPayload(items, watchedIds) {
  const seen = new Map();
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie' && item.type !== 'series') continue;
    if (item.temp) continue;
    const id = String(item.id);
    // Includi rimossi SOLO se sono visti — altrimenti il badge sparisce
    if (item.removed && !watchedIds.has(id)) continue;

    const addedAt = toMs(item.ctime) || toMs(item.mtime) || Date.now();
    const isWatched = watchedIds.has(id);
    const lw = toMs(item.state.lastWatched) || (isWatched ? Date.now() : null);

    seen.set(id, {
      content_id: id,
      content_type: item.type,
      name: item.name || '',
      poster: item.poster || null,
      poster_shape: 'POSTER',
      background: null,
      description: null,
      release_info: null,
      imdb_rating: null,
      genres: [],
      addon_base_url: null,
      added_at: addedAt,
      // Campi badge — inviati sempre, usati se lo schema li supporta
      times_watched: isWatched ? Math.max(1, item.state.timesWatched || 1) : (item.state.timesWatched || 0),
      flagged_watched: isWatched ? Math.max(1, item.state.flaggedWatched || 1) : (item.state.flaggedWatched || 0),
      last_watched: lw,
    });
  }
  return Array.from(seen.values());
}

// Watch progress (continue watching)
function buildProgressPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id) continue;
    if (item.type !== 'movie' && item.type !== 'series') continue;
    if (item.state.timeOffset <= 0 || item.state.duration <= 0) continue;
    if (item.removed && !item.temp) continue;

    const videoId = item.state.videoId || item.id;
    const parts = String(videoId).split(':');
    let season = null, episode = null;
    if (parts.length >= 3) {
      season = toInt(parts[parts.length - 2]) || null;
      episode = toInt(parts[parts.length - 1]) || null;
    }
    const lw = toMs(item.state.lastWatched) || toMs(item.mtime) || Date.now();

    payload.push({
      content_id: String(item.id),
      content_type: item.type,
      video_id: String(videoId),
      season,
      episode,
      position: item.state.timeOffset,
      duration: item.state.duration,
      last_watched: lw,
      progress_key: item.type === 'movie'
        ? String(item.id)
        : (season != null && episode != null
          ? `${item.id}_s${season}e${episode}`
          : `${item.id}_${videoId}`),
    });
  }
  return payload;
}

// Film visti (timesWatched > 0 o flaggedWatched > 0)
function buildWatchedMoviesPayload(items) {
  const payload = [];
  for (const item of items) {
    if (!item.id || item.type !== 'movie') continue;
    if (item.state.timesWatched <= 0 && item.state.flaggedWatched <= 0) continue;
    payload.push({
      content_id: String(item.id),
      content_type: 'movie',
      title: item.name || String(item.id),
      season: null,
      episode: null,
      watched_at: toMs(item.state.lastWatched) || toMs(item.mtime) || Date.now(),
    });
  }
  return payload;
}

// Decodifica bitfield episodi visti
function parseWatchedField(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(':');
  if (parts.length < 3) return null;
  const bitfield = parts.pop();
  const anchorLength = Number(parts.pop());
  if (!Number.isFinite(anchorLength)) return null;
  return { anchorVideo: parts.join(':'), anchorLength: Math.trunc(anchorLength), bitfield };
}

function decodeBitfield(encoded, lengthBits) {
  const buf = zlib.inflateSync(Buffer.from(encoded, 'base64'));
  const values = Array.from(buf);
  const need = Math.ceil(lengthBits / 8);
  while (values.length < need) values.push(0);
  return values;
}

function bitGet(values, idx) {
  return ((values[Math.floor(idx / 8)] >> (idx % 8)) & 1) !== 0;
}

function computeWatchedFlags(wf, videoIds) {
  const anchorIdx = videoIds.indexOf(wf.anchorVideo);
  if (anchorIdx === -1) {
    try {
      const vals = decodeBitfield(wf.bitfield, videoIds.length);
      return videoIds.map((_, i) => bitGet(vals, i));
    } catch { return new Array(videoIds.length).fill(false); }
  }
  const vals = decodeBitfield(wf.bitfield, videoIds.length);
  const offset = wf.anchorLength - anchorIdx - 1;
  if (offset === 0) return videoIds.map((_, i) => bitGet(vals, i));
  return videoIds.map((_, i) => {
    const prev = i + offset;
    return prev >= 0 && prev < wf.anchorLength ? bitGet(vals, prev) : false;
  });
}

async function fetchVideos(id) {
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(id)}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.meta?.videos) ? data.meta.videos : null;
  } catch { return null; }
}

async function buildWatchedEpisodesPayload(items, concurrency = 6) {
  const seriesItems = items.filter(i => i.type === 'series' && i.state.watchedField);
  if (!seriesItems.length) return [];

  const queue = [...seriesItems];
  const videosMap = new Map();

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item?.id) continue;
      const videos = await fetchVideos(item.id);
      if (videos?.length) videosMap.set(item.id, videos);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const payload = [];
  for (const item of seriesItems) {
    const rawVideos = videosMap.get(item.id);
    if (!rawVideos?.length) continue;

    const normalized = rawVideos
      .map(v => ({
        id: v.id,
        season: Number.isFinite(Number(v.season)) ? Number(v.season) : null,
        episode: Number.isFinite(Number(v.episode)) ? Number(v.episode) : null,
        released: v.released ? Date.parse(String(v.released)) : -1,
      }))
      .filter(v => v.id)
      .sort((a, b) => {
        if ((a.season ?? -1) !== (b.season ?? -1)) return (a.season ?? -1) - (b.season ?? -1);
        if ((a.episode ?? -1) !== (b.episode ?? -1)) return (a.episode ?? -1) - (b.episode ?? -1);
        return a.released - b.released;
      });

    const wf = parseWatchedField(item.state.watchedField);
    if (!wf) continue;

    let flags;
    try { flags = computeWatchedFlags(wf, normalized.map(v => v.id)); } catch { continue; }

    const watchedAt = toMs(item.state.lastWatched) || toMs(item.mtime) || Date.now();

    for (let i = 0; i < normalized.length; i++) {
      if (!flags[i]) continue;
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
  return payload;
}

// ============================================
// ENDPOINT: HEALTH
// ============================================
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ============================================
// ENDPOINT: SYNC PRINCIPALE
// Stremio → Nuvio 1:1
// Body: { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword,
//         includeWatchedEpisodes?, dryRun? }
// ============================================
app.post('/sync', async (req, res) => {
  const {
    stremioEmail, stremioPassword,
    nuvioEmail, nuvioPassword,
    includeWatchedEpisodes = false,
    dryRun = false,
  } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ error: 'Credenziali mancanti' });
  }

  const log = [];
  const L = msg => { console.log(msg); log.push(msg); };

  try {
    // ── Stremio ──────────────────────────────
    L('🔐 Login Stremio...');
    const stremioKey = await stremioLogin(stremioEmail, stremioPassword);
    L('✅ Login Stremio OK');

    L('📚 Caricamento library Stremio...');
    const rawItems = await stremioGetLibrary(stremioKey);
    const items = rawItems.map(normItem);
    L(`📊 Stremio: ${items.length} item totali (inclusi rimossi)`);

    // Film visti
    const watchedMovies = buildWatchedMoviesPayload(items);
    L(`🎬 Film visti: ${watchedMovies.length}`);

    // Episodi visti
    let watchedEpisodes = [];
    if (includeWatchedEpisodes) {
      L('📺 Recupero episodi da Cinemeta...');
      watchedEpisodes = await buildWatchedEpisodesPayload(items, 6);
      L(`📺 Episodi visti: ${watchedEpisodes.length}`);
    }

    // Deduplicazione watched
    const watchedMap = new Map();
    for (const w of [...watchedMovies, ...watchedEpisodes]) {
      const key = `${w.content_id}::${w.season ?? ''}::${w.episode ?? ''}`;
      const prev = watchedMap.get(key);
      if (!prev || w.watched_at > prev.watched_at) watchedMap.set(key, w);
    }
    const watchedPayload = Array.from(watchedMap.values());

    // Set degli ID visti (per includere nella library e per il badge)
    const watchedIds = new Set(watchedPayload.map(w => w.content_id));

    // Library
    const libraryPayload = buildLibraryPayload(items, watchedIds);
    L(`📦 Library: ${libraryPayload.length} item (${watchedIds.size} con badge watched)`);

    // Watch progress
    const progressPayload = buildProgressPayload(items);
    L(`⏩ Watch progress: ${progressPayload.length} item`);

    if (dryRun) {
      return res.json({
        dryRun: true, log,
        stats: {
          stremio_total: items.length,
          library: libraryPayload.length,
          watched_movies: watchedMovies.length,
          watched_episodes: watchedEpisodes.length,
          watched_total: watchedPayload.length,
          progress: progressPayload.length,
        },
      });
    }

    // ── Nuvio ─────────────────────────────────
    L('🔐 Login Nuvio...');
    // IMPORTANTE: il JWT identifica l'utente.
    // Le RPC Nuvio usano auth.uid() — NON si passa p_profile_id.
    const token = await supabaseLogin(nuvioEmail, nuvioPassword);
    L('✅ Login Nuvio OK');

    // 1. Library (contiene badge via times_watched/flagged_watched)
    L(`☁️  Push library (${libraryPayload.length} item)...`);
    await rpc(token, 'sync_push_library', { p_items: libraryPayload });
    L('✅ Library pushata');

    await new Promise(r => setTimeout(r, 400));

    // 2. Watch progress
    if (progressPayload.length > 0) {
      L(`⏩ Push watch progress (${progressPayload.length} item)...`);
      try {
        await rpc(token, 'sync_push_watch_progress', { p_entries: progressPayload });
        L('✅ Watch progress pushato');
      } catch (err) {
        L(`⚠️  Watch progress errore (non bloccante): ${err.message}`);
      }
    }

    // 3. Watched items — senza p_profile_id, auth.uid() nel JWT fa da chiave
    if (watchedPayload.length > 0) {
      L(`🏅 Push watched items (${watchedPayload.length} item)...`);
      await rpc(token, 'sync_push_watched_items', { p_items: watchedPayload });
      L('✅ Watched items pushati');
    }

    // ── Verifica ──────────────────────────────
    await new Promise(r => setTimeout(r, 400));
    L('🔍 Verifica post-sync...');

    const [nuvioLib, nuvioWat] = await Promise.all([
      rpc(token, 'sync_pull_library', {}).catch(() => []),
      rpc(token, 'sync_pull_watched_items', {}).catch(() => []),
    ]);

    const nuvioLibArr = Array.isArray(nuvioLib) ? nuvioLib : [];
    const nuvioWatArr = Array.isArray(nuvioWat) ? nuvioWat : [];
    const libIdSet = new Set(nuvioLibArr.map(i => i.content_id));
    const missingInLib = watchedPayload.filter(w => !libIdSet.has(w.content_id)).length;

    L(`✅ Nuvio dopo sync: ${nuvioLibArr.length} in library, ${nuvioWatArr.length} watched`);
    if (missingInLib > 0) {
      L(`⚠️  ${missingInLib} watched senza entry in library (badge non visibile per questi)`);
    } else if (watchedPayload.length > 0) {
      L(`🎉 Tutti i watched hanno entry in library — i badge dovrebbero essere visibili`);
    }

    res.json({
      success: true,
      log,
      stats: {
        stremio_total: items.length,
        pushed_library: libraryPayload.length,
        pushed_watched_movies: watchedMovies.length,
        pushed_watched_episodes: watchedEpisodes.length,
        pushed_watched_total: watchedPayload.length,
        pushed_progress: progressPayload.length,
        nuvio_library_after: nuvioLibArr.length,
        nuvio_watched_after: nuvioWatArr.length,
        badge_missing_in_library: missingInLib,
      },
    });

  } catch (err) {
    L(`💥 ERRORE: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, log });
  }
});

// ============================================
// ENDPOINT: STATO NUVIO
// ============================================
app.post('/nuvio-status', async (req, res) => {
  const { nuvioEmail, nuvioPassword } = req.body;
  if (!nuvioEmail || !nuvioPassword) return res.status(400).json({ error: 'Credenziali mancanti' });
  try {
    const token = await supabaseLogin(nuvioEmail, nuvioPassword);
    const [library, watched] = await Promise.all([
      rpc(token, 'sync_pull_library', {}).catch(() => []),
      rpc(token, 'sync_pull_watched_items', {}).catch(() => []),
    ]);
    const lib = Array.isArray(library) ? library : [];
    const wat = Array.isArray(watched) ? watched : [];
    res.json({
      library_count: lib.length,
      watched_count: wat.length,
      watched_movies: wat.filter(w => !w.season && !w.episode).length,
      watched_episodes: wat.filter(w => w.season != null && w.episode != null).length,
      library_sample: lib.slice(0, 3),
      watched_sample: wat.slice(0, 3),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ENDPOINT: STATO STREMIO
// ============================================
app.post('/stremio-status', async (req, res) => {
  const { stremioEmail, stremioPassword } = req.body;
  if (!stremioEmail || !stremioPassword) return res.status(400).json({ error: 'Credenziali mancanti' });
  try {
    const key = await stremioLogin(stremioEmail, stremioPassword);
    const rawItems = await stremioGetLibrary(key);
    const items = rawItems.map(normItem);
    res.json({
      total: items.length,
      movies: items.filter(i => i.type === 'movie' && !i.removed && !i.temp).length,
      series: items.filter(i => i.type === 'series' && !i.removed && !i.temp).length,
      watched_movies: buildWatchedMoviesPayload(items).length,
      series_with_watched_field: items.filter(i => i.type === 'series' && i.state.watchedField).length,
      in_progress: buildProgressPayload(items).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// AVVIO
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → Nuvio Sync`);
  console.log(`📦 Porta: ${PORT}`);
  console.log(`☁️  Supabase: ${SUPABASE_URL ? '✅ ' + SUPABASE_URL : '❌ SUPABASE_URL mancante'}`);
  console.log(`\nEndpoint attivi:`);
  console.log(`  POST /sync            ← sync completo Stremio → Nuvio`);
  console.log(`  POST /nuvio-status    ← legge stato attuale Nuvio`);
  console.log(`  POST /stremio-status  ← legge stato attuale Stremio`);
  console.log(`  GET  /health\n`);
});
