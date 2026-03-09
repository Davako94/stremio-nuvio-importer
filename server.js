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
// CONVERTI BACKUP - VERSIONE "NUVIOSYNC-READY"
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
    
    let movieCount = 0;
    let seriesCount = 0;

    // Timestamp identico per tutti (sembrerà una sincronizzazione unica)
    const syncTimestamp = Date.now() - 1000 * 60 * 5; // 5 minuti fa
    
    // Genera un ID dispositivo fittizio ma coerente
    const deviceId = 'device_' + Math.random().toString(36).substring(2, 15);
    
    // Crea un "sync token" fittizio
    const syncToken = 'sync_' + Math.random().toString(36).substring(2, 20);

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const originalId = item._id;
      const imdbId = originalId.split(':')[0];
      
      // ============================================
      // LIBRARY ITEM con dati di sync
      // ============================================
      const libraryItem = {
        id: originalId,
        _id: originalId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: syncTimestamp,
        inLibrary: true,
        isSaved: true,
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        imdb_id: imdbId,
        
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        
        // DATI PER IL SYNC (FONDAMENTALI!)
        syncData: {
          deviceId: deviceId,
          syncToken: syncToken,
          syncedAt: syncTimestamp,
          version: 2,
          lastModified: syncTimestamp
        },
        
        // Flag per il sync
        isSynced: true,
        syncVersion: 2,
        
        // Per evitare conflitti
        conflictResolution: 'local'
      };

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // PROGRESSI con dati di sync
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        const progressKey = `@user:local:@watch_progress:${item.type}:${originalId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: syncTimestamp,
          videoId: originalId,
          syncData: {
            deviceId: deviceId,
            syncToken: syncToken,
            syncedAt: syncTimestamp
          }
        };

        continueWatching.push({
          id: originalId,
          type: item.type,
          name: item.name || '',
          poster: item.poster || '',
          currentTime: timeOffset,
          duration: duration,
          lastWatched: syncTimestamp,
          progress: (timeOffset / duration) * 100,
          videoId: originalId,
          imdb_id: imdbId,
          syncData: {
            deviceId: deviceId,
            syncToken: syncToken
          }
        });
      }
    });

    // ============================================
    // STATO DEL SYNC (FONDAMENTALE!)
    // ============================================
    const syncState = {
      enabled: true,
      lastSync: syncTimestamp,
      lastFullSync: syncTimestamp,
      deviceId: deviceId,
      syncToken: syncToken,
      syncVersion: 2,
      
      // Stato del sync per tipo
      librarySync: {
        lastSync: syncTimestamp,
        syncedItems: library.map(item => item.id),
        totalItems: library.length
      },
      
      progressSync: {
        lastSync: syncTimestamp,
        syncedItems: Object.keys(watchProgress)
      },
      
      // Evita che Nuvio faccia un full sync
      incrementalSync: {
        enabled: true,
        lastIncremental: syncTimestamp,
        changes: []
      },
      
      // Dati cloud fittizi (già sincronizzati)
      cloudData: {
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        lastModified: syncTimestamp,
        checksum: 'checksum_' + Math.random().toString(36).substring(2, 10)
      }
    };

    // ============================================
    // BACKUP COMPLETO
    // ============================================
    const nuvioBackup = {
      version: "2.0.0", // Versione più alta per far sembrare più recente
      timestamp: syncTimestamp,
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      
      // STATO DEL SYNC GLOBALE
      sync: syncState,
      
      data: {
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it",
          
          // Impostazioni sync
          syncEnabled: true,
          autoSync: false, // Importante: false per non far ripartire sync automatico
          syncInterval: 0,
          lastSyncAttempt: syncTimestamp
        },
        
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        
        // Dati di sync ridondanti (Nuvio li cerca)
        syncData: syncState,
        cloudSync: syncState.cloudData,
        syncState: syncState,
        
        installedAddons: [],
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        continueWatchingRemoved: {},
        contentDuration: {},
        syncQueue: [],
        traktSettings: null,
        simklSettings: null,
        tombStones: {},
        deleted: {},
        removedFromLibrary: {},
        
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
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        
        // Metadati di sync
        syncVersion: 2,
        lastSync: syncTimestamp,
        deviceId: deviceId,
        syncToken: syncToken
      }
    };

    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`🔄 Sync simulato: ${syncTimestamp}`);
    console.log(`📱 Device ID: ${deviceId}`);
    console.log(`🔑 Sync Token: ${syncToken}`);

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
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/\n`);
});