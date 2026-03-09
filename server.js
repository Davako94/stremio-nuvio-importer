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
// ROTTE DI NAVIGAZIONE
// ============================================
app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// MANIFEST DELL'ADDON (Standard Stremio/Nuvio)
// ============================================
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-importer",
    name: "Stremio → NUVIO Importer",
    description: "Converti il backup di Stremio nel formato nativo di NUVIO",
    version: "1.0.2",
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
// LOGICA DI CONVERSIONE ANTI-CANCELLAZIONE
// ============================================
app.post('/convert', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 Conversione file:', req.file.originalname);

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const stremioData = JSON.parse(fileContent);

    const library = [];
    const watchProgress = {};
    const now = Date.now();
    
    // Impostiamo un timestamp molto nel futuro per assicurarci che 
    // questi dati "vincano" su eventuali dati vecchi nel database.
    const futureUpdate = now + 100000; 
    
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const libraryItem = {
        id: item._id,
        contentId: item._id,
        type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        posterShape: (item.posterShape || 'poster').toLowerCase(),
        year: item.year || '',
        releaseInfo: item.year || '',
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        // --- LOGICA "SILENT SYNC" ---
        // Diciamo all'app che l'item è già sincronizzato (_isDirty: false)
        // così l'app non prova a fare l'upload immediato che verrebbe bloccato dalle RLS.
        inLibrary: true,
        _isDirty: false,           
        _isNew: false,             
        _needsSync: false,
        lastUpdatedAt: futureUpdate, 
        addedToLibraryAt: new Date(item._ctime || item._mtime || now).getTime(),

        behaviorHints: {
          defaultVideoId: item._id,
          hasScheduledVideos: false
        }
      };

      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // Progressi di visione impostati come "già salvati"
      if (item.state?.timeOffset > 0) {
        const progressKey = `watch_progress:${item.type}:${item._id}`;
        watchProgress[progressKey] = {
          currentTime: item.state.timeOffset,
          duration: item.state.duration || 0,
          lastUpdated: futureUpdate,
          _isDirty: false
        };
      }
    });

    // Struttura Backup NUVIO con Scope Utente
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: now,
      appVersion: "1.0.0",
      platform: "android",
      userScope: "user", // "user" indica che il backup appartiene a una sessione cloud
      data: {
        settings: {},
        installedAddons: [],
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        library: library,
        watchProgress: watchProgress,
        watchedItems: [],
        continueWatchingRemoved: {},
        contentDuration: {},
        syncQueue: [], // Coda vuota per evitare tentativi di sync fallimentari
        traktSettings: null,
        simklSettings: null,
        tombStones: {}, // Reset delle cancellazioni passate
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
        downloadsCount: 0,
        addonsCount: 0
      }
    };

    // Pulizia file temporaneo
    if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
        total: library.length
      }
    });

  } catch (error) {
    console.error('❌ Errore:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 NUVIO Importer (Anti-Delete Version)`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔗 URL: https://stremio-nuvio-importer.onrender.com/`);
});