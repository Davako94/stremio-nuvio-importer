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
// HOME PAGE
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
// CONVERTI BACKUP (VERSIONE CON FLAG SALVATO)
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
    const savedItems = {}; // <-- NOVITÀ: oggetto per i "salvati"
    const watchProgress = {};
    const continueWatching = [];
    const contentDuration = {};
    const metaCache = {};
    
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      // Salta elementi rimossi o temporanei
      if (item.removed || item.temp) return;
      
      // Accetta solo film e serie
      if (item.type !== 'movie' && item.type !== 'series') return;

      // ID pulito
      const cleanId = item._id.replace(/[^a-zA-Z0-9]/g, '_');
      
      // ============================================
      // FLAG SALVATO (FONDAMENTALE!)
      // ============================================
      // Simula che l'utente abbia cliccato "salva" per ogni item
      savedItems[cleanId] = {
        id: cleanId,
        type: item.type,
        savedAt: new Date(item._ctime || item._mtime || Date.now()).getTime(),
        source: "stremio-import"
      };

      // ============================================
      // 1. METADATI COMPLETI
      // ============================================
      const metaItem = {
        id: cleanId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        background: item.background || item.poster || '',
        logo: item.logo || '',
        description: item.description || '',
        releaseInfo: item.year ? String(item.year) : '',
        imdbRating: item.imdbRating || '0',
        genres: item.genres || [],
        cast: item.cast || [],
        directors: item.directors || [],
        writers: item.writers || [],
        runtime: item.runtime || '',
        country: item.country || '',
        language: item.language || '',
        awards: item.awards || '',
        trailer: item.trailer || '',
        links: item.links || [],
        
        totalSeasons: item.totalSeasons || 0,
        totalEpisodes: item.totalEpisodes || 0,
        seasons: item.seasons || [],
        videos: item.videos || [],
        
        // Flag salvato anche nei metadati
        isSaved: true,
        savedAt: savedItems[cleanId].savedAt,
        
        behaviorHints: {
          defaultVideoId: cleanId,
          hasScheduledVideos: false
        }
      };

      // ============================================
      // 2. LIBRARY ITEM (CON FLAG DI SALVATAGGIO)
      // ============================================
      const libraryItem = {
        id: cleanId,
        _id: cleanId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: savedItems[cleanId].savedAt,
        inLibrary: true,
        
        // FLAG FONDAMENTALI!
        isSaved: true,           // <-- DICE CHE È SALVATO
        isInWatchlist: true,     // <-- DICE CHE È IN WATCHLIST
        isFavorite: true,        // <-- DICE CHE È PREFERITO
        
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        episodesWatched: item.episodesWatched || 0,
        
        links: [],
        streams: [],
        isWatched: false,
        
        userData: {
          lastWatched: item.state?.lastWatched || null,
          watchTime: item.state?.timeOffset || 0,
          isSaved: true,          // <-- ANCHE QUI
          savedAt: savedItems[cleanId].savedAt
        },
        
        behaviorHints: {
          defaultVideoId: cleanId,
          hasScheduledVideos: false
        },
        
        meta: metaItem
      };

      library.push(libraryItem);

      // ============================================
      // 3. CACHE METADATI
      // ============================================
      metaCache[`meta:${item.type}:${cleanId}`] = metaItem;
      metaCache[`catalog:${item.type}:${cleanId}`] = metaItem;
      metaCache[`detail:${item.type}:${cleanId}`] = metaItem;

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // 4. PROGRESSI (se presenti)
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        const progressKey = `@user:local:@watch_progress:${item.type}:${cleanId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: new Date(item.state.lastWatched || Date.now()).getTime(),
          videoId: cleanId,
          isSaved: true
        };

        contentDuration[`${item.type}:${cleanId}`] = duration;

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
            videoId: cleanId,
            isSaved: true,
            meta: metaItem
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
            videoId: `${cleanId}:${item.state.season}:${item.state.episode}`,
            isSaved: true,
            meta: metaItem
          });
        }
      }
    });

    // ============================================
    // 5. BACKUP COMPLETO CON FLAG SALVATI
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      user: {
        id: "local-user-123",
        name: "Utente Locale",
        email: "locale@nuvio.local"
      },
      data: {
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it",
          autoPlay: true
        },
        installedAddons: [
          {
            id: "community.stremio-nuvio-importer",
            name: "📦 Importer",
            version: "1.0.0",
            enabled: true
          }
        ],
        
        // DATI PRINCIPALI
        library: library,
        
        // OGGETTO SALVATI (FONDAMENTALE!)
        saved: savedItems,
        savedItems: savedItems,
        watchlist: savedItems,
        favorites: savedItems,
        
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        watchedItems: [],
        contentDuration: contentDuration,
        
        metaCache: metaCache,
        metaStorage: metaCache,
        
        // Dati cloud con flag salvati
        cloud: {
          library: library,
          saved: savedItems,
          watchProgress: watchProgress,
          continueWatching: continueWatching,
          contentDuration: contentDuration,
          metaCache: metaCache,
          lastSync: Date.now()
        },
        
        cloudSync: {
          enabled: true,
          lastSync: Date.now(),
          syncedLibrary: library,
          syncedSaved: savedItems,
          syncedProgress: watchProgress,
          syncedMeta: metaCache
        },
        
        localScrapers: {},
        apiKeys: {},
        addonOrder: ["community.stremio-nuvio-importer"],
        removedAddons: [],
        downloads: [],
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
        savedCount: Object.keys(savedItems).length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        contentDurationCount: Object.keys(contentDuration).length,
        metaCacheCount: Object.keys(metaCache).length,
        downloadsCount: 0,
        addonsCount: 1
      }
    };

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`💾 Salvati: ${Object.keys(savedItems).length}`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);
    console.log(`▶️ Continue Watching: ${continueWatching.length}`);
    console.log(`💾 Metadati in cache: ${Object.keys(metaCache).length}`);
    console.log(`📁 Backup creato con ${library.length} elementi`);

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        saved: Object.keys(savedItems).length,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        metaCache: Object.keys(metaCache).length,
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
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json\n`);
});