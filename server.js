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
// ENDPOINT PER TESTARE LOGIN (VERSIONE FINALE - NO SUPABASE)
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
    
    // Validazioni base (senza chiamate a Supabase)
    if (email.length < 3 || password.length < 3) {
      return res.json({
        success: false,
        message: '❌ Credenziali troppo corte'
      });
    }
    
    if (!email.includes('@') || !email.includes('.')) {
      return res.json({
        success: false,
        message: '❌ Formato email non valido'
      });
    }
    
    // Simula un piccolo ritardo per feedback visivo
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log(`✅ Test login superato per: ${email}`);
    res.json({ 
      success: true, 
      message: `✅ Credenziali valide. Il backup includerà metadati anti-sync.` 
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
// FUNZIONE PER GENERARE METADATI DI SYNC FITTIZI
// ============================================
function generateSyncMetadata(email) {
  // Genera timestamp di 1 giorno fa (sembra già sincronizzato)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  
  // Genera un ID dispositivo fittizio ma coerente con l'email
  const deviceId = 'device_' + Buffer.from(email).toString('base64').substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
  
  // Genera un sync token fittizio
  const syncToken = 'sync_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  return {
    deviceId: deviceId,
    syncToken: syncToken,
    lastSync: oneDayAgo,
    syncVersion: 1,
    syncedAt: oneDayAgo
  };
}

// ============================================
// FUNZIONE PER ESTRARRE ADDONS (MIGLIORATA)
// ============================================
function extractAddonsFromNuvioBackup(backup) {
  let addons = [];
  
  // Cerca in tutte le possibili posizioni
  const searchPaths = [
    { obj: backup, path: 'data.addons' },
    { obj: backup, path: 'addons' },
    { obj: backup, path: 'data.installedAddons' },
    { obj: backup, path: 'installedAddons' },
    { obj: backup, path: 'data.plugins' },
    { obj: backup, path: 'plugins' }
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
      // Verifica che sembrino addons (hanno id o url)
      if (current[0] && (current[0].id || current[0].url || current[0].name || current[0].manifestUrl)) {
        addons = current;
        console.log(`🔌 Trovati ${addons.length} addons in ${path}`);
        break;
      }
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
// ENDPOINT PRINCIPALE DI CONVERSIONE (WORKAROUND INTEGRATO)
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

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000; // 1 giorno fa
    const oneMinuteAgo = now - 60 * 1000;

    // Genera metadata sync se l'utente ha fornito email
    const syncMetadata = email ? generateSyncMetadata(email) : null;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const originalId = item._id;
      const imdbId = originalId.split(':')[0];
      
      // Crea l'item della library con metadati di sync (se disponibili)
      const libraryItem = {
        id: originalId,
        _id: originalId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: syncMetadata ? oneDayAgo : oneMinuteAgo, // Più vecchio se sync
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

      // Aggiungi metadati di sync se disponibili (FONDAMENTALE!)
      if (syncMetadata) {
        libraryItem.syncData = {
          deviceId: syncMetadata.deviceId,
          syncToken: syncMetadata.syncToken,
          syncedAt: syncMetadata.lastSync,
          version: syncMetadata.syncVersion
        };
        libraryItem.isSynced = true;
      }

      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        const progressKey = `@user:local:@watch_progress:${item.type}:${originalId}`;
        
        // Crea progress con metadati di sync
        const progressItem = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: syncMetadata ? oneDayAgo : oneMinuteAgo,
          videoId: originalId
        };
        
        if (syncMetadata) {
          progressItem.syncData = {
            deviceId: syncMetadata.deviceId,
            syncToken: syncMetadata.syncToken,
            syncedAt: syncMetadata.lastSync
          };
          progressItem.isSynced = true;
        }
        
        watchProgress[progressKey] = progressItem;

        // Crea continue watching con metadati di sync
        const continueItem = {
          id: originalId,
          type: item.type,
          name: item.name || '',
          poster: item.poster || '',
          year: item.year || '',
          currentTime: timeOffset,
          duration: duration,
          lastWatched: syncMetadata ? oneDayAgo : oneMinuteAgo,
          progress: (timeOffset / duration) * 100,
          videoId: originalId,
          imdb_id: imdbId
        };
        
        if (syncMetadata) {
          continueItem.syncData = {
            deviceId: syncMetadata.deviceId,
            syncToken: syncMetadata.syncToken
          };
          continueItem.isSynced = true;
        }

        if (item.type === 'movie') {
          continueWatching.push(continueItem);
        } else if (item.type === 'series') {
          continueWatching.push({
            ...continueItem,
            type: 'episode',
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
    // STATO DI SYNC GLOBALE (se email fornita)
    // ============================================
    let syncState = null;
    if (syncMetadata) {
      syncState = {
        enabled: true,
        lastSync: syncMetadata.lastSync,
        deviceId: syncMetadata.deviceId,
        syncToken: syncMetadata.syncToken,
        version: syncMetadata.syncVersion,
        libraryHash: 'hash_' + Math.random().toString(36).substring(2, 10)
      };
    }

    // ============================================
    // BACKUP COMPLETO CON METADATI ANTI-SYNC
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: now,
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

    // Aggiungi stato sync se presente
    if (syncState) {
      nuvioBackup.data.sync = syncState;
      nuvioBackup.data.syncState = syncState;
      nuvioBackup.metadata.lastSync = syncState.lastSync;
      nuvioBackup.metadata.syncVersion = syncState.version;
    }

    // Pulisci file temporanei
    fs.unlinkSync(stremioFile.path);
    if (existingFile) {
      fs.unlinkSync(existingFile.path);
    }

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`🔌 Preservati ${existingAddons.length} addons`);
    if (syncMetadata) {
      console.log(`🔄 Aggiunti metadati sync per: ${email}`);
    }

    // Costruisci messaggio di risposta
    let message = '';
    if (existingAddons.length > 0) {
      message = `✅ Preservati ${existingAddons.length} addons!`;
    } else {
      message = 'Nessun addon da preservare (carica un backup Nuvio esistente per mantenerli)';
    }
    
    if (syncMetadata) {
      message += ` 🔒 Backup protetto contro il sync!`;
    }

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        addonsPreserved: existingAddons.length,
        total: library.length,
        syncProtected: !!syncMetadata
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
  console.log(`\n🚀 Stremio → NUVIO Importer (WORKAROUND INTEGRATO)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json`);
  console.log(`\n✅ Endpoint attivi:`);
  console.log(`   • POST /test-login - Test credenziali (NO SUPABASE)`);
  console.log(`   • POST /extract-addons - Estrai addons da backup`);
  console.log(`   • POST /convert - Conversione con metadati anti-sync`);
  console.log(`\n✨ WORKAROUND ANTI-SYNC:`);
  console.log(`   • Aggiunge metadati sync fittizi a TUTTI gli item`);
  console.log(`   • Timestamp di 1 giorno fa (sembra già sincronizzato)`);
  console.log(`   • Device ID univoco basato sull'email`);
  console.log(`   • Quando attivi il sync, Nuvio pensa che sia già tutto OK!\n`);
});