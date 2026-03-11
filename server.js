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

app.get('/', (req, res) => { res.redirect('/configure'); });
app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });
app.get('/configure', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.get('/manifest.json', (req, res) => {
  res.json({
    id: "community.stremio-nuvio-importer",
    name: "Stremio → NUVIO Importer",
    description: "Converti il backup di Stremio nel formato nativo di NUVIO",
    version: "1.0.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "stremio-importer", name: "📦 Importer" }],
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});

// ============================================
// SUPABASE CONFIGURAZIONE DA VARIABILI D'AMBIENTE
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
  const session = await supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  return session; // { access_token, refresh_token, user, ... }
}

async function supabaseRpc(functionName, payload, accessToken) {
  return await supabaseRequest(`/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    body: payload || {},
    authToken: accessToken,
  });
}

// ============================================
// ENDPOINT PER TESTARE LOGIN
// ============================================
app.post('/test-login', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, message: '❌ Inserisci email e password' });
  }

  if (!isSupabaseConfigured()) {
    return res.json({ 
      success: false, 
      message: '❌ Supabase non configurato sul server. Contatta l\'amministratore.' 
    });
  }

  try {
    console.log(`🔐 Test login per: ${email}`);
    const session = await supabaseLogin(email, password);
    console.log(`✅ Login riuscito per: ${session.user?.email}`);
    res.json({ success: true, message: `✅ Login riuscito! Benvenuto ${session.user?.email}` });
  } catch (error) {
    console.error('❌ Errore test login:', error.message);
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE (CON DEDUPLICA!)
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;
  console.log(`✅ Login riuscito, user ID: ${session.user?.id}`);

  // PASSO 1: DEDUPLICA - usa un Map con content_id come chiave
  const uniqueItems = new Map();
  
  items.forEach(item => {
    const contentId = item.id.split(':')[0]; // Prendi l'IMDB ID puro
    if (!uniqueItems.has(contentId)) {
      uniqueItems.set(contentId, {
        content_id: contentId,
        content_type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        poster_shape: 'POSTER',
        background: item.banner || item.background || '',
        description: item.description || '',
        release_info: item.year || '',
        imdb_rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
        genres: item.genres || [],
        addon_base_url: '',
        added_at: Date.now()
      });
    } else {
      console.log(`⚠️ Trovato duplicato saltato: ${contentId} - ${item.name}`);
    }
  });

  // Converti il Map in array
  const libraryItems = Array.from(uniqueItems.values());

  console.log(`📦 Push di ${libraryItems.length} items unici (su ${items.length} totali)`);

  // Chiama sync_push_library
  await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);

  console.log(`✅ Push completato!`);
  return libraryItems.length;
}

// ============================================
// FUNZIONE PER ESTRARRE ADDONS
// ============================================
function extractAddonsFromNuvioBackup(backup) {
  let addons = [];
  if (backup.data && backup.data.addons && Array.isArray(backup.data.addons)) {
    addons = backup.data.addons;
    console.log(`🔌 Trovati ${addons.length} addons in data.addons`);
  }
  if (addons.length === 0 && backup.addons && Array.isArray(backup.addons)) {
    addons = backup.addons;
    console.log(`🔌 Trovati ${addons.length} addons in root.addons`);
  }
  if (addons.length === 0 && backup.data?.installedAddons && Array.isArray(backup.data.installedAddons)) {
    addons = backup.data.installedAddons;
    console.log(`🔌 Trovati ${addons.length} addons in data.installedAddons`);
  }
  return addons;
}

// ============================================
// ENDPOINT PER ESTRARRE ADDONS
// ============================================
app.post('/extract-addons', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const backup = JSON.parse(content);
    const addons = extractAddonsFromNuvioBackup(backup);
    fs.unlinkSync(req.file.path);
    res.json({
      success: true,
      addons,
      addonOrder: backup.data?.addonOrder || [],
      settings: backup.data?.settings || {},
      subtitles: backup.data?.subtitles || {},
      count: addons.length
    });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PRINCIPALE DI CONVERSIONE
// ============================================
app.post('/convert', upload.fields([
  { name: 'backup', maxCount: 1 },
  { name: 'existing', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files || !req.files['backup']) {
      return res.status(400).json({ error: 'Nessun file backup Stremio caricato' });
    }

    const stremioFile = req.files['backup'][0];
    const existingFile = req.files['existing'] ? req.files['existing'][0] : null;

    // Leggi email/password dal body
    const { email, password, skipCloudPush } = req.body;

    console.log('📁 File Stremio ricevuto:', stremioFile.originalname);
    if (email) console.log(`👤 Utente: ${email}`);
    if (existingFile) console.log('📁 File backup Nuvio esistente ricevuto:', existingFile.originalname);

    // Leggi backup Stremio
    const stremioContent = fs.readFileSync(stremioFile.path, 'utf8');
    const stremioData = JSON.parse(stremioContent);

    // Leggi backup Nuvio esistente (se fornito)
    const existingNuvioBackup = existingFile ? JSON.parse(fs.readFileSync(existingFile.path, 'utf8')) : null;

    // ============================================
    // ESTRAI ADDONS DAL BACKUP ESISTENTE
    // ============================================
    let existingAddons = [];
    let existingAddonOrder = [];
    let existingLocalScrapers = {};
    let existingSettings = { libraryView: "grid", theme: "dark", language: "it" };
    let existingSubtitles = {
      subtitleSize: 28, subtitleBackground: false, subtitleTextColor: "#FFFFFF",
      subtitleBgOpacity: 0.7, subtitleTextShadow: true, subtitleOutline: true,
      subtitleOutlineColor: "#000000", subtitleOutlineWidth: 3, subtitleAlign: "center", subtitleBottomOffset: 20
    };

    if (existingNuvioBackup?.data) {
      const extractedAddons = extractAddonsFromNuvioBackup(existingNuvioBackup);
      if (extractedAddons.length > 0) existingAddons = extractedAddons;
      if (existingNuvioBackup.data.addonOrder) existingAddonOrder = existingNuvioBackup.data.addonOrder;
      if (existingNuvioBackup.data.localScrapers) existingLocalScrapers = existingNuvioBackup.data.localScrapers;
      if (existingNuvioBackup.data.settings) existingSettings = { ...existingSettings, ...existingNuvioBackup.data.settings };
      if (existingNuvioBackup.data.subtitles) existingSubtitles = { ...existingSubtitles, ...existingNuvioBackup.data.subtitles };
    }

    // ============================================
    // CONVERTI I FILM DA STREMIO
    // ============================================
    const library = [];
    const watchProgress = {};
    const continueWatching = [];
    let movieCount = 0, seriesCount = 0;

    const oneMinuteAgo = Date.now() - 60 * 1000;
    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);

    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const originalId = item._id;
      const imdbId = originalId.split(':')[0];
      
      const libraryItem = {
        id: originalId, _id: originalId, type: item.type,
        name: item.name || 'Senza titolo', poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '', releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: oneMinuteAgo, inLibrary: true, isSaved: true,
        description: item.description || '', imdbRating: item.imdbRating || '',
        genres: item.genres || [], imdb_id: imdbId, tmdb_id: item.tmdb_id || '',
        totalEpisodes: item.totalEpisodes || 0, totalSeasons: item.totalSeasons || 0,
        season: item.season || (originalId.includes(':') ? originalId.split(':')[1] : null),
        episode: item.episode || (originalId.includes(':') ? originalId.split(':')[2] : null)
      };
      
      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;
      
      library.push(libraryItem);
      
      if (item.type === 'movie') movieCount++; else seriesCount++;

      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        const progressKey = `@user:local:@watch_progress:${item.type}:${originalId}`;
        
        watchProgress[progressKey] = { 
          currentTime: timeOffset, duration, lastUpdated: oneMinuteAgo, videoId: originalId 
        };

        const cwItem = {
          id: originalId, name: item.name || '', poster: item.poster || '', year: item.year || '',
          currentTime: timeOffset, duration, lastWatched: oneMinuteAgo,
          progress: (timeOffset / duration) * 100, videoId: originalId, imdb_id: imdbId
        };
        
        if (item.type === 'movie') {
          continueWatching.push({ ...cwItem, type: item.type });
        } else {
          continueWatching.push({
            ...cwItem, type: 'episode',
            season: item.state.season || originalId.split(':')[1],
            episode: item.state.episode || originalId.split(':')[2],
            seriesId: originalId.split(':')[0]
          });
        }
      }
    });

    // ============================================
    // PRESERVA ALTRI DATI
    // ============================================
    let existingDownloads = [], existingApiKeys = {}, existingTraktSettings = null;
    let existingSimklSettings = null, existingSyncQueue = [], existingContentDuration = {};

    if (existingNuvioBackup?.data) {
      existingDownloads = existingNuvioBackup.data.downloads || [];
      existingApiKeys = existingNuvioBackup.data.apiKeys || {};
      existingTraktSettings = existingNuvioBackup.data.traktSettings || null;
      existingSimklSettings = existingNuvioBackup.data.simklSettings || null;
      existingSyncQueue = existingNuvioBackup.data.syncQueue || [];
      existingContentDuration = existingNuvioBackup.data.contentDuration || {};
    }

    // ============================================
    // PUSH CLOUD REALE (se richiesto e configurato)
    // ============================================
    let cloudPushResult = null;
    
    if (email && password && skipCloudPush !== 'true') {
      if (!isSupabaseConfigured()) {
        cloudPushResult = {
          success: false,
          error: 'Supabase non configurato',
          message: '❌ Push cloud non disponibile: Supabase non configurato sul server'
        };
      } else {
        try {
          const pushedCount = await pushLibraryToSupabase(email, password, library);
          cloudPushResult = {
            success: true,
            count: pushedCount,
            message: `✅ ${pushedCount} film/serie unici caricati sul cloud!`
          };
        } catch (pushError) {
          console.error('❌ Errore push cloud:', pushError.message);
          cloudPushResult = {
            success: false,
            error: pushError.message,
            message: `❌ Push fallito: ${pushError.message}`
          };
        }
      }
    }

    // ============================================
    // BACKUP COMPLETO
    // ============================================
    const nuvioBackup = {
      version: "1.0.0", timestamp: Date.now(), appVersion: "1.0.0",
      platform: "android", userScope: "local",
      data: {
        settings: existingSettings, addons: existingAddons,
        addonOrder: existingAddonOrder, localScrapers: existingLocalScrapers,
        library, watchProgress, continueWatching,
        downloads: existingDownloads, apiKeys: existingApiKeys,
        traktSettings: existingTraktSettings, simklSettings: existingSimklSettings,
        syncQueue: existingSyncQueue, contentDuration: existingContentDuration,
        removedAddons: [], continueWatchingRemoved: {}, tombStones: {}, deleted: {},
        removedFromLibrary: {}, subtitles: existingSubtitles
      },
      metadata: {
        totalItems: library.length, libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length, addonsCount: existingAddons.length
      }
    };

    // Pulisci file temporanei
    fs.unlinkSync(stremioFile.path);
    if (existingFile) fs.unlinkSync(existingFile.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`🔌 Preservati ${existingAddons.length} addons`);

    let message = existingAddons.length > 0 
      ? `✅ Preservati ${existingAddons.length} addons!` 
      : 'Nessun addon da preservare (carica un backup Nuvio esistente per mantenerli)';

    res.json({
      success: true,
      data: nuvioBackup,
      cloudPush: cloudPushResult,
      stats: { 
        movies: movieCount, series: seriesCount,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        addonsPreserved: existingAddons.length, total: library.length
      },
      message: message
    });

  } catch (error) {
    console.error('❌ Errore conversione:', error);
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PER VERIFICARE STATO SUPABASE
// ============================================
app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    url: SUPABASE_URL ? SUPABASE_URL.replace(/https?:\/\//, '').split('.')[0] + '...' : null,
    message: isSupabaseConfigured()
      ? '✅ Supabase configurato — push cloud disponibile'
      : '⚠️ Supabase non configurato — imposta SUPABASE_URL e SUPABASE_ANON_KEY su Render'
  });
});

// ============================================
// DEBUG BACKUP
// ============================================
app.post('/debug-backup', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const backup = JSON.parse(content);
    const structure = {
      rootKeys: Object.keys(backup), hasData: !!backup.data,
      dataKeys: backup.data ? Object.keys(backup.data) : [],
      addonsLocations: []
    };
    if (backup.data?.addons) {
      structure.addonsLocations.push({
        path: 'data.addons', count: backup.data.addons.length,
        sample: backup.data.addons[0] ? { id: backup.data.addons[0].id, name: backup.data.addons[0].name } : null
      });
    }
    fs.unlinkSync(req.file.path);
    res.json({ success: true, structure });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (CON DEDUPLICA!)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`☁️  Push cloud: ${isSupabaseConfigured() ? '✅ ATTIVO' : '⚠️  NON CONFIGURATO'}`);
  if (!isSupabaseConfigured()) {
    console.log(`   → Per abilitare, imposta su Render:`);
    console.log(`     SUPABASE_URL=${SUPABASE_URL || 'https://tuo-progetto.supabase.co'}`);
    console.log(`     SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY ? '***' : 'your-anon-key'}`);
  } else {
    console.log(`   → URL: ${SUPABASE_URL.replace(/https?:\/\//, '').split('.')[0]}...`);
  }
  console.log(`\n✅ Endpoint attivi:`);
  console.log(`   • POST /test-login - Test credenziali`);
  console.log(`   • POST /extract-addons - Estrai addons da backup`);
  console.log(`   • POST /convert - Conversione principale`);
  console.log(`   • GET /supabase-status - Stato configurazione`);
  console.log(`\n🔄 NOVITÀ: Deduplica automatica dei film per evitare errori di conflitto!\n`);
});