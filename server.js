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
// CONVERTI BACKUP - VERSIONE "NON SINCRONIZZATA"
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

    // Timestamp recente (1 minuto fa - sembra appena aggiunto)
    const oneMinuteAgo = Date.now() - 60 * 1000;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const cleanId = item._id.replace(/[^a-zA-Z0-9]/g, '_');
      
      // ============================================
      // LIBRARY ITEM - SOLO DATI LOCALI, NESSUN SYNC
      // ============================================
      const libraryItem = {
        id: cleanId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: oneMinuteAgo,  // Sembra appena aggiunto
        inLibrary: true,                  // In libreria
        isSaved: true,                     // Salvato
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        // Flag per serie TV
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        
        // NIENTE FLAG DI SYNC - isSynced NON C'È
        // NIENTE syncData
        // NIENTE timestamp vecchi
      };

      // Aggiungi campi extra se presenti
      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // PROGRESSI (se presenti)
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        // Progresso
        const progressKey = `@user:local:@watch_progress:${item.type}:${cleanId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: oneMinuteAgo,  // Recente
          videoId: cleanId
        };

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
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: cleanId
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
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: `${cleanId}:${item.state.season}:${item.state.episode}`
          });
        }
      }
    });

    // ============================================
    // BACKUP COMPLETO - SENZA ALCUN DATO DI SYNC
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      data: {
        // SOLO SETTINGS BASE - NESSUN SYNC
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it"
          // NESSUN syncEnabled, lastSync, ecc.
        },
        
        // SOLO DATI LOCALI
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        
        // TUTTE LE SEZIONI DI SYNC RIMOSSE:
        // - NESSUN traktSettings
        // - NESSUN cloud
        // - NESSUN cloudSync
        // - NESSUN sync
        // - NESSUN saved/savedItems/watchlist/favorites (ridondanti)
        
        // SOLO campi necessari e vuoti
        installedAddons: [],
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        continueWatchingRemoved: {},
        contentDuration: {},
        syncQueue: [],
        simklSettings: null,
        tombStones: {},           // Vuoto - nessuna rimozione
        deleted: {},               // Vuoto - nessuna rimozione
        removedFromLibrary: {},    // Vuoto - nessuna rimozione
        
        // Sottotitoli (default)
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
          subtitleBottomOffset: 20
        }
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length
        // NESSUN syncCount, lastSync, ecc.
      }
    };

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);
    console.log(`📁 Backup creato - NESSUN dato di sync incluso`);

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
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json\n`);
});