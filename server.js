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
// CONVERTI BACKUP - VERSIONE CON SINCRONIZZAZIONE FITTIZIA
// ============================================
app.post('/convert', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 File ricevuto:', req.file.originalname);

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const stremioData = JSON.parse(fileContent);

    const library = [];
    const watchProgress = {};
    const continueWatching = [];
    const contentDuration = {};
    const metaCache = {};
    const syncData = {}; // <-- NOVITÀ: dati di sincronizzazione
    
    let movieCount = 0;
    let seriesCount = 0;

    // Data fittizia di 1 mese fa (per far sembrare tutto già sincronizzato)
    const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const cleanId = item._id.replace(/[^a-zA-Z0-9]/g, '_');
      
      // ============================================
      // DATI DI SINCRONIZZAZIONE (FONDAMENTALI!)
      // ============================================
      syncData[cleanId] = {
        id: cleanId,
        type: item.type,
        syncedAt: oneMonthAgo,
        syncSource: "trakt",
        syncId: `trakt-${Math.random().toString(36).substring(7)}`,
        lastModified: oneMonthAgo,
        version: 1
      };

      // ============================================
      // METADATI
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
        
        totalSeasons: item.totalSeasons || 0,
        totalEpisodes: item.totalEpisodes || 0,
        
        // Flag importanti
        isSaved: true,
        isInLibrary: true,
        isSynced: true,
        syncData: syncData[cleanId],
        
        behaviorHints: {
          defaultVideoId: cleanId,
          hasScheduledVideos: false
        }
      };

      // ============================================
      // LIBRARY ITEM
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
        addedToLibraryAt: oneMonthAgo, // <-- 1 mese fa!
        inLibrary: true,
        
        // TUTTI I FLAG POSSIBILI
        isSaved: true,
        isInWatchlist: true,
        isFavorite: true,
        isSynced: true,
        syncVersion: 1,
        
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
          lastWatched: item.state?.lastWatched || oneMonthAgo,
          watchTime: item.state?.timeOffset || 0,
          isSaved: true,
          savedAt: oneMonthAgo,
          syncedAt: oneMonthAgo
        },
        
        syncData: syncData[cleanId],
        meta: metaItem
      };

      library.push(libraryItem);
      metaCache[`meta:${item.type}:${cleanId}`] = metaItem;

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // PROGRESSI
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        const progressKey = `@user:local:@watch_progress:${item.type}:${cleanId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: oneMonthAgo, // <-- 1 mese fa!
          videoId: cleanId,
          isSynced: true,
          syncVersion: 1
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
            lastWatched: oneMonthAgo, // <-- 1 mese fa!
            progress: (timeOffset / duration) * 100,
            videoId: cleanId,
            isSynced: true,
            syncData: syncData[cleanId],
            meta: metaItem
          });
        }
      }
    });

    // ============================================
    // BACKUP COMPLETO
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
        email: "locale@nuvio.local",
        trakt: {  // <-- Dati Trakt fittizi
          username: "imported_user",
          lastSync: oneMonthAgo,
          syncEnabled: true
        }
      },
      data: {
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it",
          autoPlay: true,
          syncEnabled: true,
          lastSync: oneMonthAgo
        },
        installedAddons: [],
        
        // DATI CON TIMESTAMP VECCHI
        library: library,
        saved: syncData,
        savedItems: syncData,
        watchlist: syncData,
        favorites: syncData,
        
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        contentDuration: contentDuration,
        metaCache: metaCache,
        
        // DATI DI SINCRONIZZAZIONE (FONDAMENTALI!)
        sync: {
          lastSync: oneMonthAgo,
          lastFullSync: oneMonthAgo,
          syncQueue: [],
          conflicts: [],
          version: 1,
          data: syncData
        },
        
        traktSettings: {
          username: "imported_user",
          lastSync: oneMonthAgo,
          syncWatched: true,
          syncCollection: true,
          syncWatchlist: true,
          syncRatings: true
        },
        
        cloud: {
          library: library,
          saved: syncData,
          lastSync: oneMonthAgo,
          version: 1
        },
        
        cloudSync: {
          enabled: true,
          lastSync: oneMonthAgo,
          syncedLibrary: library,
          syncedSaved: syncData,
          version: 1
        },
        
        // Altri campi
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        continueWatchingRemoved: {},
        syncQueue: [],
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
          subtitleOutlineWidth: 3
        }
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        savedCount: Object.keys(syncData).length,
        syncCount: Object.keys(syncData).length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        lastSync: oneMonthAgo
      }
    };

    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`🔄 Dati sincronizzati (fittizi): ${Object.keys(syncData).length}`);
    console.log(`📁 Backup creato con timestamp: ${new Date(oneMonthAgo).toLocaleDateString()}`);

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        saved: Object.keys(syncData).length,
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
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/\n`);
});