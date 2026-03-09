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
// MANIFEST DELL'ADDON
// ============================================
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-importer",
    name: "Stremio → NUVIO Importer",
    description: "Automazione catalogo: importa Stremio come azioni utente",
    version: "1.1.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "stremio-importer", name: "📦 Importer" }],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
  res.json(manifest);
});

// ============================================
// LOGICA DI CONVERSIONE (AUTOMAZIONE CATALOGO)
// ============================================
app.post('/convert', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 Avvio automazione catalogo per:', req.file.originalname);

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const stremioData = JSON.parse(fileContent);

    const library = [];
    const syncQueue = [];
    const now = Date.now();
    
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach((item, index) => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      // Creiamo un timestamp incrementale per simulare un'attività umana reale
      // Un'azione ogni 50ms per non intasare l'engine di Nuvio
      const simulatedTime = now + (index * 50);

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
        inLibrary: true,
        
        // FLAG DI AUTOMAZIONE
        // Diciamo che l'item è "sporco" (da salvare) ma con un timestamp recentissimo
        _isDirty: true,
        _isNew: true,
        _needsSync: true,
        lastUpdatedAt: simulatedTime,
        addedToLibraryAt: simulatedTime,

        behaviorHints: {
          defaultVideoId: item._id,
          hasScheduledVideos: false
        }
      };

      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      // Inseriamo l'azione nella CODA DI SINCRONIZZAZIONE
      // Questo "costringe" l'app a processare l'aggiunta verso il server
      syncQueue.push({
        id: `import_${item._id}`,
        table: 'library',
        action: 'INSERT',
        data: libraryItem,
        timestamp: simulatedTime
      });

      if (item.type === 'movie') movieCount++;
      else seriesCount++;
    });

    // Costruzione del pacchetto di ripristino
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: now,
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local", 
      data: {
        library: library,
        syncQueue: syncQueue, // L'automazione risiede qui
        settings: {
          lastSyncTimestamp: 0 // Forza l'app a riconsiderare lo stato del database
        },
        watchProgress: {},
        installedAddons: [],
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: [],
        downloads: [],
        watchedItems: [],
        continueWatchingRemoved: {},
        contentDuration: {},
        traktSettings: null,
        simklSettings: null,
        tombStones: {}, // Pulizia totale per evitare che vecchie cancellazioni blocchino l'import
        subtitles: {
          subtitleSize: 28,
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
        syncQueueCount: syncQueue.length,
        stats: { movies: movieCount, series: seriesCount }
      }
    };

    if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }

    console.log(`✅ Automazione creata: ${library.length} azioni in coda.`);

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        total: library.length
      }
    });

  } catch (error) {
    console.error('❌ Errore durante l\'automazione:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 NUVIO Importer - MODALITÀ AUTOMAZIONE`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔗 URL: https://stremio-nuvio-importer.onrender.com/`);
});