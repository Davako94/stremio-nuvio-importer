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
// CONVERTI BACKUP - VERSIONE CON STREAMS E METADATI COMPLETI
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
    const streams = {}; // <-- NOVITÀ: streams per ogni film/serie
    const metaMap = {}; // <-- NOVITÀ: mappa dei metadati completi
    
    let movieCount = 0;
    let seriesCount = 0;

    const oneMinuteAgo = Date.now() - 60 * 1000;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const cleanId = item._id.replace(/[^a-zA-Z0-9]/g, '_');
      
      // ============================================
      // METADATI COMPLETI (per evitare 404)
      // ============================================
      const metaItem = {
        id: cleanId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        background: item.background || item.poster || '',
        logo: item.logo || '',
        description: item.description || 'Descrizione non disponibile',
        releaseInfo: item.year ? String(item.year) : '',
        imdbRating: item.imdbRating || 'N/A',
        genres: item.genres || [],
        cast: item.cast || [],
        directors: item.directors || [],
        writers: item.writers || [],
        runtime: item.runtime || 'N/A',
        
        // Per serie TV
        totalSeasons: item.totalSeasons || 1,
        totalEpisodes: item.totalEpisodes || 0,
        
        // Video associati (FONDAMENTALE per evitare 404!)
        videos: item.videos || [{
          id: cleanId,
          title: item.name || 'Senza titolo',
          released: new Date().toISOString(),
          season: 1,
          episode: 1,
          available: true
        }],
        
        // Streams (FONDAMENTALE per evitare 404!)
        streams: item.streams || [{
          url: 'https://v2.vidsrc.me/embed/' + cleanId.split(':')[1] || cleanId,
          name: 'Auto Stream',
          description: 'Stream automatico'
        }]
      };

      // Salva nei metadati globali
      metaMap[cleanId] = metaItem;
      
      // ============================================
      // STREAMS (per evitare 404)
      // ============================================
      streams[cleanId] = metaItem.streams;

      // ============================================
      // LIBRARY ITEM
      // ============================================
      const libraryItem = {
        id: cleanId,
        type: item.type,
        name: item.name || 'Senza titolo',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year ? String(item.year) : '',
        releaseInfo: item.year ? String(item.year) : '',
        addedToLibraryAt: oneMinuteAgo,
        inLibrary: true,
        isSaved: true,
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        
        // Riferimento ai metadati completi
        meta: metaItem,
        
        // Streams inclusi direttamente
        streams: metaItem.streams,
        
        // Link ai video
        videos: metaItem.videos
      };

      library.push(libraryItem);

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
          lastUpdated: oneMinuteAgo,
          videoId: cleanId
        };

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
            videoId: cleanId,
            streams: metaItem.streams,
            meta: metaItem
          });
        }
      }
    });

    // ============================================
    // BACKUP COMPLETO - CON TUTTO QUELLO CHE SERVE
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      data: {
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it"
        },
        
        // DATI PRINCIPALI
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        
        // METADATI E STREAMS (FONDAMENTALI!)
        meta: metaMap,
        streams: streams,
        metaCache: metaMap,
        metaStorage: metaMap,
        
        // Aggiunte per evitare 404
        videoStreams: streams,
        streamCache: streams,
        
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
          subtitleOutlineWidth: 3,
          subtitleAlign: "center",
          subtitleBottomOffset: 20
        }
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        streamsCount: Object.keys(streams).length
      }
    };

    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);
    console.log(`🎬 Streams generati: ${Object.keys(streams).length}`);
    console.log(`📁 Backup creato con metadati completi`);

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        streams: Object.keys(streams).length,
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