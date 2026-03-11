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
// FUNZIONE PER LEGGERE IL BACKUP ESISTENTE
// ============================================
async function readExistingBackup(existingBackupPath) {
  if (!existingBackupPath || !fs.existsSync(existingBackupPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(existingBackupPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.log('⚠️ Errore lettura backup esistente:', e.message);
    return null;
  }
}

// ============================================
// FUNZIONE PER ESTRARRE ADDONS (CORRETTA!)
// ============================================
function extractAddonsFromNuvioBackup(backup) {
  let addons = [];
  
  // Nel backup Nuvio, gli addons sono in data.addons (dalla documentazione)
  if (backup.data && backup.data.addons && Array.isArray(backup.data.addons)) {
    addons = backup.data.addons;
    console.log(`🔌 Trovati ${addons.length} addons in data.addons`);
  }
  
  // Fallback: cerca anche in altre posizioni comuni
  if (addons.length === 0 && backup.addons && Array.isArray(backup.addons)) {
    addons = backup.addons;
    console.log(`🔌 Trovati ${addons.length} addons in root.addons`);
  }
  
  if (addons.length === 0 && backup.data && backup.data.installedAddons && Array.isArray(backup.data.installedAddons)) {
    addons = backup.data.installedAddons;
    console.log(`🔌 Trovati ${addons.length} addons in data.installedAddons (fallback)`);
  }
  
  return addons;
}

// ============================================
// CONVERTI BACKUP - VERSIONE CORRETTA
// ============================================
app.post('/convert', upload.fields([
  { name: 'backup', maxCount: 1 },           // Backup Stremio
  { name: 'existing', maxCount: 1 }           // Backup Nuvio esistente (opzionale)
]), async (req, res) => {
  try {
    if (!req.files || !req.files['backup']) {
      return res.status(400).json({ error: 'Nessun file backup Stremio caricato' });
    }

    const stremioFile = req.files['backup'][0];
    const existingFile = req.files['existing'] ? req.files['existing'][0] : null;

    console.log('📁 File Stremio ricevuto:', stremioFile.originalname);
    if (existingFile) {
      console.log('📁 File backup Nuvio esistente ricevuto:', existingFile.originalname);
    }

    // Leggi backup Stremio
    const stremioContent = fs.readFileSync(stremioFile.path, 'utf8');
    const stremioData = JSON.parse(stremioContent);

    // Leggi backup Nuvio esistente (se fornito)
    const existingNuvioBackup = existingFile ? 
      JSON.parse(fs.readFileSync(existingFile.path, 'utf8')) : null;

    // ============================================
    // ESTRAI ADDONS DAL BACKUP ESISTENTE
    // ============================================
    let existingAddons = [];
    let existingAddonOrder = [];
    let existingLocalScrapers = {};
    let existingSettings = {
      libraryView: "grid",
      theme: "dark",
      language: "it"
    };
    let existingSubtitles = {
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
    };

    if (existingNuvioBackup && existingNuvioBackup.data) {
      // ADDONS - usa la funzione specifica
      const extractedAddons = extractAddonsFromNuvioBackup(existingNuvioBackup);
      if (extractedAddons.length > 0) {
        existingAddons = extractedAddons;
        console.log(`🔌 Preservati ${existingAddons.length} addons`);
      }
      
      // Preserva l'ordine degli addons
      if (existingNuvioBackup.data.addonOrder) {
        existingAddonOrder = existingNuvioBackup.data.addonOrder;
      }
      
      // Preserva gli scrapers locali
      if (existingNuvioBackup.data.localScrapers) {
        existingLocalScrapers = existingNuvioBackup.data.localScrapers;
      }
      
      // Preserva le impostazioni
      if (existingNuvioBackup.data.settings) {
        existingSettings = {
          ...existingSettings,
          ...existingNuvioBackup.data.settings
        };
      }
      
      // Preserva i sottotitoli
      if (existingNuvioBackup.data.subtitles) {
        existingSubtitles = {
          ...existingSubtitles,
          ...existingNuvioBackup.data.subtitles
        };
      }
    }

    // ============================================
    // CONVERTI I FILM DA STREMIO
    // ============================================
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

      const originalId = item._id;
      const imdbId = originalId.split(':')[0];
      
      const libraryItem = {
        id: originalId,
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
        
        imdb_id: imdbId,
        tmdb_id: item.tmdb_id || '',
        
        totalEpisodes: item.totalEpisodes || 0,
        totalSeasons: item.totalSeasons || 0,
        
        season: item.season || (originalId.includes(':') ? originalId.split(':')[1] : null),
        episode: item.episode || (originalId.includes(':') ? originalId.split(':')[2] : null)
      };

      if (item.background) libraryItem.banner = item.background;
      if (item.logo) libraryItem.logo = item.logo;

      library.push(libraryItem);

      if (item.type === 'movie') movieCount++;
      else seriesCount++;

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
            imdb_id: imdbId
          });
        } else if (item.type === 'series') {
          continueWatching.push({
            id: originalId,
            type: 'episode',
            name: item.name || '',
            poster: item.poster || '',
            season: item.state.season || originalId.split(':')[1],
            episode: item.state.episode || originalId.split(':')[2],
            currentTime: timeOffset,
            duration: duration,
            lastWatched: oneMinuteAgo,
            progress: (timeOffset / duration) * 100,
            videoId: originalId,
            imdb_id: imdbId,
            seriesId: originalId.split(':')[0]
          });
        }
      }
    });

    // ============================================
    // SE C'ERA UN BACKUP VECCHIO, PRESERVA ALTRI DATI
    // ============================================
    let existingDownloads = [];
    let existingApiKeys = {};
    let existingTraktSettings = null;
    let existingSimklSettings = null;
    let existingSyncQueue = [];
    let existingContentDuration = {};
    
    if (existingNuvioBackup && existingNuvioBackup.data) {
      existingDownloads = existingNuvioBackup.data.downloads || [];
      existingApiKeys = existingNuvioBackup.data.apiKeys || {};
      existingTraktSettings = existingNuvioBackup.data.traktSettings || null;
      existingSimklSettings = existingNuvioBackup.data.simklSettings || null;
      existingSyncQueue = existingNuvioBackup.data.syncQueue || [];
      existingContentDuration = existingNuvioBackup.data.contentDuration || {};
    }

    // ============================================
    // BACKUP COMPLETO - NEL FORMATO CORRETTO
    // ============================================
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      data: {
        // IMPOSTAZIONI (preservate)
        settings: existingSettings,
        
        // ADDONS (preservati!) - nel formato corretto data.addons
        addons: existingAddons,
        addonOrder: existingAddonOrder,
        localScrapers: existingLocalScrapers,
        
        // LIBRARY (nuova)
        library: library,
        watchProgress: watchProgress,
        continueWatching: continueWatching,
        
        // ALTRI DATI (preservati)
        downloads: existingDownloads,
        apiKeys: existingApiKeys,
        traktSettings: existingTraktSettings,
        simklSettings: existingSimklSettings,
        syncQueue: existingSyncQueue,
        contentDuration: existingContentDuration,
        
        // CAMPI VUOTI MA NECESSARI
        removedAddons: [],
        continueWatchingRemoved: {},
        tombStones: {},
        deleted: {},
        removedFromLibrary: {},
        
        // SOTTOTITOLI (preservati)
        subtitles: existingSubtitles
      },
      metadata: {
        totalItems: library.length,
        libraryCount: library.length,
        watchProgressCount: Object.keys(watchProgress).length,
        continueWatchingCount: continueWatching.length,
        addonsCount: existingAddons.length
      }
    };

    // Pulisci file temporanei
    fs.unlinkSync(stremioFile.path);
    if (existingFile) {
      fs.unlinkSync(existingFile.path);
    }

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);
    console.log(`🔌 Preservati ${existingAddons.length} addons`);
    console.log(`📊 Progressi: ${Object.keys(watchProgress).length}`);
    console.log(`📁 Backup creato con TUTTI i dati originali preservati`);

    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount,
        progress: Object.keys(watchProgress).length,
        continueWatching: continueWatching.length,
        addonsPreserved: existingAddons.length,
        total: library.length
      },
      message: existingAddons.length > 0 ? 
        `✅ Preservati ${existingAddons.length} addons!` : 
        'Nessun addon da preservare (carica un backup Nuvio esistente per mantenerli)'
    });

  } catch (error) {
    console.error('❌ Errore conversione:', error);
    // Pulisci tutti i file
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PER ESTRARRE ADDONS DA UN BACKUP
// ============================================
app.post('/extract-addons', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    const content = fs.readFileSync(req.file.path, 'utf8');
    const backup = JSON.parse(content);

    // Usa la stessa funzione di estrazione
    const addons = extractAddonsFromNuvioBackup(backup);
    const addonOrder = backup.data?.addonOrder || [];
    const settings = backup.data?.settings || {};
    const subtitles = backup.data?.subtitles || {};

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      addons: addons,
      addonOrder: addonOrder,
      settings: settings,
      subtitles: subtitles,
      count: addons.length
    });

  } catch (error) {
    console.error('❌ Errore estrazione addons:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT DEBUG PER ANALIZZARE STRUTTURA
// ============================================
app.post('/debug-backup', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    const content = fs.readFileSync(req.file.path, 'utf8');
    const backup = JSON.parse(content);

    const structure = {
      rootKeys: Object.keys(backup),
      hasData: !!backup.data,
      dataKeys: backup.data ? Object.keys(backup.data) : [],
      addonsLocations: []
    };

    // Cerca specificamente gli addons
    if (backup.data && backup.data.addons) {
      structure.addonsLocations.push({
        path: 'data.addons',
        count: backup.data.addons.length,
        sample: backup.data.addons[0] ? {
          id: backup.data.addons[0].id,
          name: backup.data.addons[0].name
        } : null
      });
    }

    if (backup.data && backup.data.installedAddons) {
      structure.addonsLocations.push({
        path: 'data.installedAddons',
        count: backup.data.installedAddons.length,
        sample: backup.data.installedAddons[0] ? {
          id: backup.data.installedAddons[0].id,
          name: backup.data.installedAddons[0].name
        } : null
      });
    }

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      structure: structure,
      message: `Trovati ${structure.addonsLocations[0]?.count || 0} addons`
    });

  } catch (error) {
    console.error('❌ Errore debug:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PER SALVARE CREDENZIALI SUPABASE (OPZIONALE)
// ============================================
app.post('/save-supabase-config', express.json(), (req, res) => {
  const { url, anonKey } = req.body;
  
  if (!url || !anonKey) {
    return res.status(400).json({ error: 'URL e Anon Key richiesti' });
  }

  // Salva in un file di configurazione (opzionale)
  const config = { supabaseUrl: url, supabaseAnonKey: anonKey };
  fs.writeFileSync('supabase-config.json', JSON.stringify(config, null, 2));
  
  res.json({ success: true, message: 'Configurazione salvata' });
});

// ============================================
// ENDPOINT PER LEGGERE CONFIGURAZIONE SUPABASE
// ============================================
app.get('/get-supabase-config', (req, res) => {
  try {
    if (fs.existsSync('supabase-config.json')) {
      const config = JSON.parse(fs.readFileSync('supabase-config.json', 'utf8'));
      res.json({ success: true, config });
    } else {
      res.json({ success: false, message: 'Nessuna configurazione trovata' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (con preservazione addons)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json`);
  console.log(`\n✨ NOVITÀ:`);
  console.log(`   • Preserva gli addons da data.addons (formato corretto!)`);
  console.log(`   • Mantiene impostazioni, sottotitoli e progressi`);
  console.log(`   • Endpoint /save-supabase-config per configurare Supabase`);
  console.log(`   • Endpoint /debug-backup per analizzare la struttura\n`);
});