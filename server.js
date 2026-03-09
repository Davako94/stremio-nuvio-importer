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
    description: "Importazione definitiva della libreria Stremio su NUVIO",
    version: "1.2.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "stremio-importer", name: "📦 Importer" }],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
  res.json(manifest);
});

// ============================================
// LOGICA DI CONVERSIONE (IBRIDA ANTI-CANCELLAZIONE)
// ============================================
app.post('/convert', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 Analisi backup Stremio per conversione Nuvio...');

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const stremioData = JSON.parse(fileContent);

    const library = [];
    const now = Date.now();
    
    // Usiamo un timestamp futuro per "bloccare" gli elementi localmente
    const futureTimestamp = now + 500000;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach((item) => {
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
        
        // LOGICA DI PROTEZIONE LOCALE
        inLibrary: true,
        _isDirty: false,       // Non provare a caricarlo (evita errore RLS)
        _isNew: false,         // Consideralo già esistente
        _needsSync: false,     // Non forzare il sync
        _isDeleted: false,
        lastUpdatedAt: futureTimestamp, 
        addedToLibraryAt: now,

        behaviorHints: {
          defaultVideoId: item._id,
          hasScheduledVideos: false
        }
      };

      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);
    });

    // Struttura Backup NUVIO ottimizzata per il mantenimento dei dati
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: now,
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local", 
      data: {
        library: library,
        // Svuotiamo le code per impedire all'app di confrontarsi col cloud immediatamente
        syncQueue: [], 
        tombStones: {}, 
        settings: {
          // Diciamo all'app che l'ultimo sync è avvenuto nel futuro
          // Questo impedisce il download dal cloud che piallerebbe il locale
          lastSyncTimestamp: futureTimestamp + 100000 
        },
        watchProgress: {},
        installedAddons: [],
        watchedItems: [],
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
        syncQueueCount: 0
      }
    };

    if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
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
  console.log(`\n🚀 NUVIO Importer - READY`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔗 URL: https://stremio-nuvio-importer.onrender.com/`);
});