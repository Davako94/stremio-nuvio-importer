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
// CONVERTI BACKUP - VERSIONE CON ID ORIGINALI
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

    const oneMinuteAgo = Date.now() - 60 * 1000;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      // IMPORTANTE: NON MODIFICARE L'ID!
      const originalId = item._id;  // Mantieni l'ID originale di Stremio (es. "tt1234567:en" o "tt9876543:1:5")
      
      // Estrai l'ID base IMDB per gli addon
      const imdbId = originalId.split(':')[0]; // Prende "tt1234567" da "tt1234567:en"
      
      // ============================================
      // LIBRARY ITEM CON ID ORIGINALE
      // ============================================
      const libraryItem = {
        id: originalId,  // <-- USIAMO L'ID ORIGINALE!
        _id: originalId,
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
        
        // Campi extra per gli addon
        imdb_id: imdbId,  // <-- AGGIUNTO: ID IMDB puro
        tmdb_id: item.tmdb_id || '',
        
        // Per serie TV
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        
        // Se è un episodio, aggiungi season/episode
        season: item.season || (originalId.includes(':') ? originalId.split(':')[1] : null),
        episode: item.episode || (originalId.includes(':') ? originalId.split(':')[2] : null)
      };

      // Aggiungi campi extra se presenti
      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

      // ============================================
      // PROGRESSI
      // ============================================
      if (item.state?.timeOffset > 0) {
        const timeOffset = item.state.timeOffset;
        const duration = item.state.duration || 3600;
        
        const progressKey = `@user:local:@watch_progress:${item.type}:${originalId}`;
        watchProgress[progressKey] = {
          currentTime: timeOffset,
          duration: duration,
          lastUpdated: oneMinuteAgo,
          videoId: originalId
        };

        if (item.type === 'movie') {
          continueWatching.push({
            id: originalId,
            type: item.type,
            name: item.name || '',
            poster: item.poster || '',
            year: item.year || '',
            currentTime: timeOffset,
            duration: duration,
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: originalId,
            imdb_id: imdbId  // <-- AGGIUNTO
          });
        } else if (item.type === 'series') {
          // Per serie, usa l'ID completo dell'episodio
          const episodeId = originalId; // Già contiene season:episode
          continueWatching.push({
            id: episodeId,
            type: 'episode',
            name: item.name || '',
            poster: item.poster || '',
            season: item.state.season || originalId.split(':')[1],
            episode: item.state.episode || originalId.split(':')[2],
            currentTime: timeOffset,
            duration: duration,
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: episodeId,
            imdb_id: imdbId,  // <-- AGGIUNTO
            seriesId: originalId.split(':')[0] // ID della serie
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
      data: {
        settings: {
          libraryView: "grid",
          theme: "dark",
          language: "it"
        },
        
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        
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
        continueWatchingCount: continueWatching.length
      }
    };

    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);
    console.log(`📁 Backup creato con ID ORIGINALI mantenuti`);

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