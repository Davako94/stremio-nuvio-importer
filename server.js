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

// ============================================
// HOME PAGE - Reindirizza a configure
// ============================================
app.get('/', (req, res) => {
  res.redirect('/configure');
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ============================================
// PAGINA DI CONFIGURAZIONE
// ============================================
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// MANIFEST DELL'ADDON
// ============================================
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
// CONVERTI BACKUP (VERSIONE FINALE - ANTI SCOMPARSA)
// ============================================
app.post('/convert', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 File ricevuto:', req.file.originalname);

    // Legge il backup di Stremio
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const stremioData = JSON.parse(fileContent);

    // Converte nel formato NUVIO
    const library = [];
    const watchProgress = {};
    const continueWatching = [];
    const contentDuration = {}; // NUOVO!
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      // Salta elementi rimossi o temporanei
      if (item.removed || item.temp) return;
      
      // Accetta solo film e serie
      if (item.type !== 'movie' && item.type !== 'series') return;

      // ID pulito (senza caratteri speciali)
      const cleanId = item._id.replace(/[^a-zA-Z0-9]/g, '_');
      
      // ============================================
      // 1. LIBRARY ITEMS (STRUTTURA COMPLETA)
      // ============================================
      const libraryItem = {
        id: cleanId,
        _id: cleanId, // Doppio ID per sicurezza
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: new Date(item._ctime || item._mtime || Date.now()).getTime(),
        inLibrary: true,
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        // Campi per serie TV
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        episodesWatched: item.episodesWatched || 0,
        
        // Campi essenziali
        links: [],
        streams: [],
        isWatched: false,
        isInWatchlist: true, // CAMBIATO: mettiamo in watchlist
        userData: {
          lastWatched: item.state?.lastWatched || null,
          watchTime: item.state?.timeOffset || 0
        },
        
        behaviorHints: {
          defaultVideoId: cleanId,
          hasScheduledVideos: false
        }
      };

      // Campi extra
      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // 2. WATCH PROGRESS E CONTINUE WATCHING
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        // Progresso
        const progressKey = `@user:local:@watch_progress:${item.type}:${cleanId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: new Date(item.state.lastWatched || Date.now()).getTime(),
          videoId: cleanId // AGGIUNTO!
        };

        // Content duration
        contentDuration[`${item.type}:${cleanId}`] = duration;

        // Continue watching
        if (item.type === 'movie') {
          continueWatching.push({
            id: cleanId,
            type: item.type,
            name: item.name || '',
            poster: item.poster || '',
            year: item.year || '',
            currentTime: timeOffset,
            duration: duration,
            lastWatched: item.state.lastWatched || Date.now(),
            progress: (timeOffset / duration) * 100,
            videoId: cleanId // AGGIUNTO!
          });
        } else if (item.type === 'series' && item.state.season && item.state.episode) {
          continueWatching.push({
            id: cleanId,
            type: 'episode',
            name: item.name || '',
            poster: item.poster || '',
            season: item.state.season,
            episode: item.state.episode,
            currentTime: timeOffset,
            duration: duration,
            lastWatched: item.state.lastWatched || Date.now(),
            progress: (timeOffset / duration) * 100,
            videoId: `${cleanId}:${item.state.season}:${item.state.episode}` // ID specifico episodio
          });
        }
      }
    });

    // ============================================
    // 3. DATI CLOUD SIMULATI (ANTI SOVRASCRITTURA)
    // ============================================
    const cloudData = {
      library: library,
      watchProgress: watchProgress,
      continueWatching: continueWatching,
      contentDuration: contentDuration,
      lastSync: Date.now()
    };

    // ============================================
    // 4. BACKUP COMPLETO
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      user: { // AGGIUNTO: dati utente finti
        id: "local-user-123",
        name: "Utente Locale",
        email: "locale@nuvio.local",
        authToken: "local-token-456"
      },
      data: {
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it",
          autoPlay: true
        },
        installedAddons: [],
        localScrapers: {},
        apiKeys: {
          trakt: null,
          simkl: null
        },
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        
        // DATI PRINCIPALI
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        watchedItems: [],
        contentDuration: contentDuration, // AGGIUNTO!
        
        // Dati cloud simulati (FONDAMENTALE!)
        cloud: cloudData,
        cloudSync: {
          enabled: true,
          lastSync: Date.now(),
          syncedLibrary: library,
          syncedProgress: watchProgress
        },
        
        continueWatchingRemoved: {},
        syncQueue: [],
        traktSettings: null,
        simklSettings: null,
        tombStones: {},
        subtitles: {
          subtitleSize: 28,
          subtitleBackground: false,
          subtitleTextColor: "#FFFFFF",
          subtitleBgOpacity: 0.7,
          subtitleTextShadow: true,
          subtitleOutline: true,
          subtitleOutlineColor: "#000000",
          subtitleOutlineWidth: 3,
          subtitleAlign: "center",
          subtitleBottomOffset: 20,
          subtitleLetterSpacing: 0,
          subtitleLineHeightMultiplier: 1.2
        }
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        contentDurationCount: Object.keys(contentDuration).length,
        downloadsCount: 0,
        addonsCount: 0
      }
    };

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);
    console.log(`▶️ Continue Watching: ${continueWatching.length}`);
    console.log(`📁 Backup creato con ${library.length} elementi`);
    console.log(`☁️ Dati cloud simulati aggiunti`);

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        total: movieCount + seriesCount
      }
    });

  } catch (error) {
    console.error('❌ Errore conversione:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PER DOWNLOAD DIRETTO
// ============================================
app.get('/download-sample', (req, res) => {
  const sampleBackup = {
    version: "1.0.0",
    timestamp: Date.now(),
    appVersion: "1.0.0",
    platform: "android",
    userScope: "local",
    user: {
      id: "local-user-123",
      name: "Utente Locale",
      email: "locale@nuvio.local",
      authToken: "local-token-456"
    },
    data: {
      settings: {
        libraryView: "grid",
        theme: "dark",
        language: "it",
        autoPlay: true
      },
      installedAddons: [],
      library: [],
      watchProgress: {},
      continueWatching: [],
      watchedItems: [],
      contentDuration: {},
      downloads: [],
      localScrapers: {},
      apiKeys: {},
      addonOrder: [],
      removedAddons: [],
      cloud: {
        library: [],
        watchProgress: {},
        continueWatching: [],
        contentDuration: {},
        lastSync: Date.now()
      },
      cloudSync: {
        enabled: true,
        lastSync: Date.now(),
        syncedLibrary: [],
        syncedProgress: {}
      },
      continueWatchingRemoved: {},
      contentDuration: {},
      syncQueue: [],
      traktSettings: null,
      simklSettings: null,
      tombStones: {},
      subtitles: {
        subtitleSize: 28,
        subtitleBackground: false,
        subtitleTextColor: "#FFFFFF",
        subtitleBgOpacity: 0.7,
        subtitleTextShadow: true,
        subtitleOutline: true,
        subtitleOutlineColor: "#000000",
        subtitleOutlineWidth: 3,
        subtitleAlign: "center",
        subtitleBottomOffset: 20,
        subtitleLetterSpacing: 0,
        subtitleLineHeightMultiplier: 1.2
      }
    },
    metadata: {
      totalItems: 0,
      libraryCount: 0,
      watchProgressCount: 0,
      continueWatchingCount: 0,
      contentDurationCount: 0,
      downloadsCount: 0,
      addonsCount: 0
    }
  };

  res.json(sampleBackup);
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json`);
  console.log(`📤 Endpoint POST: /convert (per upload)`);
  console.log(`📎 Endpoint GET: /download-sample (per test)\n`);
});