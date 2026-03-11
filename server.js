const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// IMPORTANTE: Installa questo pacchetto su Render!
// npm install @supabase/supabase-js
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIGURAZIONE SUPABASE (VERI DATI DA HTTPTOOLKIT!)
// ============================================
const SUPABASE_URL = 'https://dpyhjjcoabcglfmgecug.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRweWhqamNvYWJjZ2xmbWdlY3VnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODYyNDcsImV4cCI6MjA4NjM2MjI0N30.U-3QSNDdpsnvRk_7ZL419AFTOtggHJJcmkodxeXjbkg';

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-importer",
    name: "Stremio → NUVIO Importer",
    description: "Converti il backup di Stremio nel formato nativo di NUVIO",
    version: "1.0.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
      {
        type: "movie",
        id: "stremio-importer",
        name: "📦 Importer"
      }
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
  res.json(manifest);
});

// ============================================
// ENDPOINT PER TESTARE LOGIN (CON SUPABASE VERO!)
// ============================================
app.post('/test-login', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ 
      success: false, 
      message: '❌ Inserisci email e password' 
    });
  }

  try {
    console.log(`🔐 Test login per: ${email}`);
    
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      console.log(`❌ Login fallito per ${email}: ${error.message}`);
      return res.json({
        success: false,
        message: `❌ ${error.message}`
      });
    }

    console.log(`✅ Login riuscito per: ${email}`);
    res.json({ 
      success: true, 
      message: `✅ Login riuscito! Benvenuto ${data.user.email}` 
    });
    
  } catch (error) {
    console.error('❌ Errore test login:', error);
    res.json({ 
      success: false, 
      message: `❌ Errore: ${error.message}` 
    });
  }
});

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  
  // Login
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: email,
    password: password
  });

  if (authError) {
    throw new Error(`Login fallito: ${authError.message}`);
  }

  console.log(`✅ Login riuscito, user ID: ${authData.user.id}`);

  // Prepara i library items nel formato che Nuvio si aspetta
  const libraryItems = items.map(item => ({
    content_id: item.id.split(':')[0],
    content_type: item.type,
    name: item.name || '',
    poster: item.poster || '',
    poster_shape: 'POSTER',
    background: item.background || '',
    description: item.description || '',
    release_info: item.year || '',
    imdb_rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
    genres: item.genres || [],
    addon_base_url: '',
    added_at: Date.now()
  }));

  console.log(`📦 Push di ${libraryItems.length} items...`);

  // Chiama sync_push_library
  const { error: pushError } = await supabase.rpc('sync_push_library', {
    p_items: libraryItems
  });

  if (pushError) {
    throw new Error(`Push fallito: ${pushError.message}`);
  }

  console.log(`✅ Push completato!`);
  return libraryItems.length;
}

// ============================================
// FUNZIONE PER ESTRARRE ADDONS
// ============================================
function extractAddonsFromNuvioBackup(backup) {
  let addons = [];
  
  const searchPaths = [
    { obj: backup, path: 'data.addons' },
    { obj: backup, path: 'addons' },
    { obj: backup, path: 'data.installedAddons' },
    { obj: backup, path: 'installedAddons' }
  ];
  
  for (const { obj, path } of searchPaths) {
    const parts = path.split('.');
    let current = obj;
    let valid = true;
    
    for (const part of parts) {
      if (current && current[part]) {
        current = current[part];
      } else {
        valid = false;
        break;
      }
    }
    
    if (valid && Array.isArray(current) && current.length > 0) {
      addons = current;
      console.log(`🔌 Trovati ${addons.length} addons in ${path}`);
      break;
    }
  }
  
  return addons;
}

// ============================================
// ENDPOINT PER ESTRARRE ADDONS
// ============================================
app.post('/extract-addons', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    const content = fs.readFileSync(req.file.path, 'utf8');
    const backup = JSON.parse(content);

    const addons = extractAddonsFromNuvioBackup(backup);
    const addonOrder = backup.data?.addonOrder || [];
    const settings = backup.data?.settings || {};
    const subtitles = backup.data?.subtitles || {};

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      addons: addons,
      addonOrder: addonOrder,
      settings: settings,
      subtitles: subtitles,
      count: addons.length
    });

  } catch (error) {
    console.error('❌ Errore estrazione addons:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PRINCIPALE DI CONVERSIONE (CON PUSH REALE!)
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
    if (existingFile) {
      console.log('📁 File backup Nuvio esistente ricevuto:', existingFile.originalname);
    }

    // Leggi backup Stremio
    const stremioContent = fs.readFileSync(stremioFile.path, 'utf8');
    const stremioData = JSON.parse(stremioContent);

    // Leggi backup Nuvio esistente (se fornito)
    const existingNuvioBackup = existingFile ? 
      JSON.parse(fs.readFileSync(existingFile.path, 'utf8')) : null;

    // ============================================
    // ESTRAI ADDONS DAL BACKUP ESISTENTE
    // ============================================
    let existingAddons = [];
    let existingAddonOrder = [];
    let existingLocalScrapers = {};
    let existingSettings = {
      libraryView: "grid",
      theme: "dark",
      language: "it"
    };
    let existingSubtitles = {
      subtitleSize: 28,
      subtitleBackground: false,
      subtitleTextColor: "#FFFFFF",
      subtitleBgOpacity: 0.7,
      subtitleTextShadow: true,
      subtitleOutline: true,
      subtitleOutlineColor: "#000000",
      subtitleOutlineWidth: 3,
      subtitleAlign: "center",
      subtitleBottomOffset: 20
    };

    if (existingNuvioBackup && existingNuvioBackup.data) {
      const extractedAddons = extractAddonsFromNuvioBackup(existingNuvioBackup);
      if (extractedAddons.length > 0) {
        existingAddons = extractedAddons;
        console.log(`🔌 Preservati ${existingAddons.length} addons`);
      }
      
      if (existingNuvioBackup.data.addonOrder) {
        existingAddonOrder = existingNuvioBackup.data.addonOrder;
      }
      
      if (existingNuvioBackup.data.localScrapers) {
        existingLocalScrapers = existingNuvioBackup.data.localScrapers;
      }
      
      if (existingNuvioBackup.data.settings) {
        existingSettings = {
          ...existingSettings,
          ...existingNuvioBackup.data.settings
        };
      }
      
      if (existingNuvioBackup.data.subtitles) {
        existingSubtitles = {
          ...existingSubtitles,
          ...existingNuvioBackup.data.subtitles
        };
      }
    }

    // ============================================
    // CONVERTI I FILM DA STREMIO
    // ============================================
    const library = [];
    const watchProgress = {};
    const continueWatching = [];
    
    let movieCount = 0;
    let seriesCount = 0;

    const oneMinuteAgo = Date.now() - 60 * 1000;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const originalId = item._id;
      const imdbId = originalId.split(':')[0];
      
      const libraryItem = {
        id: originalId,
        _id: originalId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: oneMinuteAgo,
        inLibrary: true,
        isSaved: true,
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        imdb_id: imdbId,
        tmdb_id: item.tmdb_id || '',
        
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        
        season: item.season || (originalId.includes(':') ? originalId.split(':')[1] : null),
        episode: item.episode || (originalId.includes(':') ? originalId.split(':')[2] : null)
      };

      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        const progressKey = `@user:local:@watch_progress:${item.type}:${originalId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: oneMinuteAgo,
          videoId: originalId
        };

        if (item.type === 'movie') {
          continueWatching.push({
            id: originalId,
            type: item.type,
            name: item.name || '',
            poster: item.poster || '',
            year: item.year || '',
            currentTime: timeOffset,
            duration: duration,
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: originalId,
            imdb_id: imdbId
          });
        } else if (item.type === 'series') {
          continueWatching.push({
            id: originalId,
            type: 'episode',
            name: item.name || '',
            poster: item.poster || '',
            season: item.state.season || originalId.split(':')[1],
            episode: item.state.episode || originalId.split(':')[2],
            currentTime: timeOffset,
            duration: duration,
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: originalId,
            imdb_id: imdbId,
            seriesId: originalId.split(':')[0]
          });
        }
      }
    });

    // ============================================
    // PRESERVA ALTRI DATI
    // ============================================
    let existingDownloads = [];
    let existingApiKeys = {};
    let existingTraktSettings = null;
    let existingSimklSettings = null;
    let existingSyncQueue = [];
    let existingContentDuration = {};
    
    if (existingNuvioBackup && existingNuvioBackup.data) {
      existingDownloads = existingNuvioBackup.data.downloads || [];
      existingApiKeys = existingNuvioBackup.data.apiKeys || {};
      existingTraktSettings = existingNuvioBackup.data.traktSettings || null;
      existingSimklSettings = existingNuvioBackup.data.simklSettings || null;
      existingSyncQueue = existingNuvioBackup.data.syncQueue || [];
      existingContentDuration = existingNuvioBackup.data.contentDuration || {};
    }

    // ============================================
    // PUSH CLOUD REALE (se richiesto)
    // ============================================
    let cloudPushResult = null;
    
    if (email && password && skipCloudPush !== 'true') {
      try {
        const pushedCount = await pushLibraryToSupabase(email, password, library);
        cloudPushResult = {
          success: true,
          count: pushedCount,
          message: `✅ ${pushedCount} film caricati sul cloud!`
        };
      } catch (pushError) {
        console.error('❌ Errore push cloud:', pushError);
        cloudPushResult = {
          success: false,
          error: pushError.message,
          message: `❌ Push fallito: ${pushError.message}`
        };
      }
    }

    // ============================================
    // BACKUP COMPLETO
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      data: {
        settings: existingSettings,
        addons: existingAddons,
        addonOrder: existingAddonOrder,
        localScrapers: existingLocalScrapers,
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        downloads: existingDownloads,
        apiKeys: existingApiKeys,
        traktSettings: existingTraktSettings,
        simklSettings: existingSimklSettings,
        syncQueue: existingSyncQueue,
        contentDuration: existingContentDuration,
        removedAddons: [],
        continueWatchingRemoved: {},
        tombStones: {},
        deleted: {},
        removedFromLibrary: {},
        subtitles: existingSubtitles
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        addonsCount: existingAddons.length
      }
    };

    // Pulisci file temporanei
    fs.unlinkSync(stremioFile.path);
    if (existingFile) {
      fs.unlinkSync(existingFile.path);
    }

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`🔌 Preservati ${existingAddons.length} addons`);

    let message = existingAddons.length > 0 ? 
      `✅ Preservati ${existingAddons.length} addons!` : 
      'Nessun addon da preservare (carica un backup Nuvio esistente per mantenerli)';

    res.json({
      success: true,
      data: nuvioBackup,
      cloudPush: cloudPushResult,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        addonsPreserved: existingAddons.length,
        total: library.length
      },
      message: message
    });

  } catch (error) {
    console.error('❌ Errore conversione:', error);
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (CON SUPABASE VERO!)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json`);
  console.log(`\n✅ SUPABASE CONFIGURATO:`);
  console.log(`   URL: ${SUPABASE_URL}`);
  console.log(`   ANON_KEY: ${SUPABASE_ANON_KEY.substring(0, 20)}...`);
  console.log(`\n✨ Ora il push cloud FUNZIONA DAVVERO!\n`);
});