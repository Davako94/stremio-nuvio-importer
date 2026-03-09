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
// HOME PAGE
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
// PAGINA DI CONFIGURAZIONE
// ============================================
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// ============================================
// MANIFEST DELL'ADDON
// ============================================
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-importer",
    name: "Stremio Backup Importer",
    description: "Importa la tua libreria Stremio in NUVIO con un click",
    version: "1.0.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
      {
        type: "movie",
        id: "stremio-import",
        name: "📦 Stremio Importer"
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
// CONVERTI E RESTITUISCI DATI
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 File ricevuto:', req.file.originalname);

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    // Converte nel formato NUVIO
    const libraryObject = {};
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(backupData) ? backupData : Object.values(backupData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const key = `${item.type}:${item._id}`;
      
      libraryObject[key] = {
        id: item._id,
        type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        posterShape: (item.posterShape || 'poster').toLowerCase(),
        releaseInfo: item.year || '',
        inLibrary: true,
        addedToLibraryAt: new Date(item._ctime || item._mtime || Date.now()).getTime()
      };

      if (item.type === 'movie') movieCount++;
      else seriesCount++;
    });

    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);

    // Restituisce i dati - l'addon li riceverà e li scriverà
    res.json({
      success: true,
      data: libraryObject,
      stats: { 
        movies: movieCount, 
        series: seriesCount, 
        total: movieCount + seriesCount 
      }
    });

  } catch (error) {
    console.error('❌ Errore:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL pubblico: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json\n`);
});