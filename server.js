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
// PAGINA DI CONFIGURAZIONE (e conversione)
// ============================================
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// MANIFEST DELL'ADDON
// ============================================
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-converter",
    name: "Stremio → NUVIO Converter",
    description: "Converti il backup di Stremio nel formato nativo di NUVIO",
    version: "1.0.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
      {
        type: "movie",
        id: "stremio-converter",
        name: "📦 Convertitore"
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
// CONVERTI BACKUP (POST)
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
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      // Salta elementi rimossi o temporanei
      if (item.removed || item.temp) return;
      
      // Accetta solo film e serie
      if (item.type !== 'movie' && item.type !== 'series') return;

      // ============================================
      // 1. LIBRARY ITEMS
      // ============================================
      library.push({
        id: item._id,
        type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year || '',
        releaseInfo: item.year || '',
        addedToLibraryAt: new Date(item._ctime || item._mtime || Date.now()).getTime(),
        inLibrary: true,
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || []
      });

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // 2. WATCH PROGRESS (se presente)
      // ============================================
      if (item.state?.timeOffset > 0) {
        const progressKey = `@user:local:@watch_progress:${item.type}:${item._id}`;
        watchProgress[progressKey] = {
          currentTime: item.state.timeOffset,
          duration: item.state.duration || 0,
          lastUpdated: new Date(item.state.lastWatched || Date.now()).getTime()
        };
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
        library: library,
        watchProgress: watchProgress,
        watchedItems: [],
        downloads: [],
        localScrapers: {},
        apiKeys: {},
        addonOrder: [],
        removedAddons: []
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        downloadsCount: 0,
        addonsCount: 0
      }
    };

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);

    // Restituisce il file convertito
    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
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
  console.log(`\n🚀 Stremio → NUVIO Converter`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-converter.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-converter.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-converter.onrender.com/manifest.json\n`);
  console.log(`📤 Endpoint POST: /convert (per upload)`);
});