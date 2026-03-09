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
// CONVERTI BACKUP (VERSIONE CORRETTA PER NUVIO)
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
    const continueWatching = []; // IMPORTANTE!
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      // Salta elementi rimossi o temporanei
      if (item.removed || item.temp) return;
      
      // Accetta solo film e serie
      if (item.type !== 'movie' && item.type !== 'series') return;

      // ============================================
      // 1. LIBRARY ITEMS (STRUTTURA CORRETTA)
      // ============================================
      const libraryItem = {
        id: item._id,
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
        
        // Campi per serie TV (FONDAMENTALI!)
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        episodesWatched: item.episodesWatched || 0,
        
        // Campi essenziali per NUVIO
        links: [],
        streams: [],
        isWatched: false,
        isInWatchlist: false,
        userData: null,
        
        // Campi che NUVIO si aspetta
        behaviorHints: {
          defaultVideoId: item._id,
          hasScheduledVideos: false
        }
      };

      // Aggiungi campo banner se presente
      if (item.background) {
        libraryItem.banner = item.background;
      }

      // Aggiungi campo logo se presente
      if (item.logo) {
        libraryItem.logo = item.logo;
      }

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // 2. WATCH PROGRESS E CONTINUE WATCHING
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600; // default 1 ora se manca
        
        // Progresso per singolo video
        const progressKey = `@user:local:@watch_progress:${item.type}:${item._id}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: new Date(item.state.lastWatched || Date.now()).getTime()
        };

        // Aggiungi a continueWatching (FONDAMENTALE!)
        if (item.type === 'movie') {
          continueWatching.push({
            id: item._id,
            type: item.type,
            name: item.name || '',
            poster: item.poster || '',
            year: item.year || '',
            currentTime: timeOffset,
            duration: duration,
            lastWatched: item.state.lastWatched || Date.now(),
            progress: (timeOffset / duration) * 100
          });
        } else if (item.type === 'series' && item.state.season && item.state.episode) {
          // Per serie, aggiungi l'episodio specifico
          continueWatching.push({
            id: item._id,
            type: 'episode', // IMPORTANTE: tipo 'episode' per serie
            name: item.name || '',
            poster: item.poster || '',
            season: item.state.season,
            episode: item.state.episode,
            currentTime: timeOffset,
            duration: duration,
            lastWatched: item.state.lastWatched || Date.now(),
            progress: (timeOffset / duration) * 100
          });
        }
      }
    });

    // ============================================
    // 3. CREA IL BACKUP NUVIO COMPLETO
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      data: {
        settings: {},
        installedAddons: [],
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        
        // DATI PRINCIPALI
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching, // AGGIUNTO!
        watchedItems: [],
        
        // Altri campi necessari
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
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length, // AGGIUNTO!
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

    // Restituisce il file convertito
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
// ENDPOINT PER DOWNLOAD DIRETTO (opzionale)
// ============================================
app.get('/download-sample', (req, res) => {
  const sampleBackup = {
    version: "1.0.0",
    timestamp: Date.now(),
    appVersion: "1.0.0",
    platform: "android",
    userScope: "local",
    data: {
      settings: {},
      installedAddons: [],
      library: [],
      watchProgress: {},
      continueWatching: [], // AGGIUNTO ANCHE QUI
      watchedItems: [],
      downloads: [],
      localScrapers: {},
      apiKeys: {},
      addonOrder: [],
      removedAddons: [],
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
      continueWatchingCount: 0, // AGGIUNTO ANCHE QUI
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