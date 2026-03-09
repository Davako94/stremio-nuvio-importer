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
  res.redirect('/convert');
});

// ============================================
// PAGINA DI CONVERSIONE
// ============================================
app.get('/convert', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// MANIFEST DELL'ADDON
// ============================================
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-converter",
    name: "Stremio → NUVIO Converter",
    description: "Converti il backup di Stremio nel formato di NUVIO",
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
// CONVERTI BACKUP
// ============================================
app.post('/convert', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 File ricevuto:', req.file.originalname);

    // Legge il file
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const stremioData = JSON.parse(fileContent);

    // Converte nel formato NUVIO
    const nuvioLibrary = [];
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      // Salta elementi rimossi o temporanei
      if (item.removed || item.temp) return;
      
      // Accetta solo film e serie
      if (item.type !== 'movie' && item.type !== 'series') return;

      // Mappa i campi da Stremio a NUVIO
      nuvioLibrary.push({
        id: item._id,
        type: item.type,
        name: item.name || 'Sconosciuto',
        poster: item.poster || '',
        posterShape: item.posterShape || 'poster',
        year: item.year || '',
        addedToLibraryAt: new Date(item._ctime || item._mtime || Date.now()).getTime()
      });

      if (item.type === 'movie') movieCount++;
      else seriesCount++;
    });

    // Crea l'oggetto backup NUVIO
    const nuvioBackup = {
      library: nuvioLibrary
    };

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);

    // Restituisce il file convertito
    res.json({
      success: true,
      data: nuvioBackup,
      stats: { 
        movies: movieCount, 
        series: seriesCount, 
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
  console.log(`🔧 Convertitore: https://stremio-nuvio-converter.onrender.com/convert`);
  console.log(`📋 Manifest: https://stremio-nuvio-converter.onrender.com/manifest.json\n`);
});