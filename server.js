const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Configurazione Supabase
const SUPABASE_URL = 'https://tupmspjgifldbheqzmbk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1cG1zcGpnaWZsZGJoZXF6bWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDQyNjU4MTAsImV4cCI6MjAxOTg0MTgxMH0.F5k4q8d9GjLkQyP2VX3wF1zF6HjLkQyP2VX3wF1zF6H';

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
// VERIFICA ACCOUNT (EMAIL + ID)
// ============================================
app.post('/verify-account', async (req, res) => {
  try {
    const { email, ownerId } = req.body;

    if (!email || !ownerId) {
      return res.status(400).json({ error: 'Email e ID richiesti' });
    }

    // Validazioni base
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(ownerId)) {
      return res.status(400).json({ error: 'Formato ID non valido' });
    }

    // Inizializza client Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Qui dovremmo verificare che l'email esista e sia associata all'ID
    // Purtroppo non possiamo fare query dirette sugli utenti senza autenticazione
    // Ma possiamo provare a fare un login con magic link? Non abbiamo password...
    
    // Per ora, accettiamo qualsiasi combinazione e salviamo in una lista temporanea
    // In produzione, dovremmo avere un database di utenti verificati
    
    console.log(`📧 Tentativo verifica: ${email} - ${ownerId}`);
    
    // TODO: Implementare vera verifica con Supabase Admin API
    // Per ora, simuliamo una verifica riuscita
    
    res.json({ valid: true, message: 'Account verificato (simulazione)' });

  } catch (error) {
    console.error('Errore verifica:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IMPORTA BACKUP
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  try {
    const { email, ownerId } = req.body;
    
    if (!email || !ownerId) {
      return res.status(400).json({ error: 'Email e ID richiesti' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    // Inizializza client Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Qui dovremmo autenticarci come l'utente con quell'email
    // Ma senza password non possiamo
    
    // Soluzione: usare il servizio di autenticazione di Supabase con magic link?
    // O usare una service key? (sconsigliato)
    
    // Per ora, convertiamo il backup e simuliamo l'import
    const { library, progress, watched } = convertStremioBackup(backupData);
    
    console.log(`📦 Import simulato per ${email}:`, {
      library: library.length,
      progress: progress.length,
      watched: watched.length
    });

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ SIMULAZIONE: Importati ${library.length} film/serie, ${progress.length} progressi, ${watched.length} visti`,
      results: { library: library.length, progress: progress.length, watched: watched.length }
    });

  } catch (error) {
    console.error('❌ Errore importazione:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CATALOGO
// ============================================
app.get('/catalog/movie/stremio-import.json', (req, res) => {
  res.json({
    metas: [{
      id: 'stremio-importer',
      type: 'movie',
      name: 'Stremio Importer',
      poster: 'https://via.placeholder.com/300x450/00a8ff/ffffff?text=Stremio+Importer',
      description: 'Apri la pagina di configurazione per importare il tuo backup Stremio'
    }]
  });
});

// ============================================
// CONVERTER
// ============================================
function convertStremioBackup(items) {
  const library = [];
  const progress = [];
  const watched = [];

  const itemsArray = Array.isArray(items) ? items : Object.values(items);

  itemsArray.forEach(item => {
    if (item.removed || item.temp) return;
    if (item.type !== 'movie' && item.type !== 'series') return;

    library.push({
      content_id: item._id,
      content_type: item.type,
      name: item.name || '',
      poster: item.poster || '',
      poster_shape: (item.posterShape || 'poster').toUpperCase(),
      release_info: item.year || '',
      added_at: new Date(item._ctime || item._mtime || Date.now()).getTime()
    });

    if (item.state?.timeOffset > 0) {
      progress.push({
        content_id: item._id,
        content_type: item.type,
        video_id: item.state.video_id || item._id,
        season: null,
        episode: null,
        position: (item.state.timeOffset || 0) * 1000,
        duration: (item.state.duration || 0) * 1000,
        last_watched: new Date(item.state.lastWatched || item._mtime).getTime(),
        progress_key: item._id
      });
    }

    const isWatched = 
      item.state?.flaggedWatched === 1 || 
      item.state?.timesWatched > 0 ||
      (item.state?.watched && item.state.watched !== '');

    if (isWatched) {
      watched.push({
        content_id: item._id,
        content_type: item.type,
        title: item.name || '',
        season: null,
        episode: null,
        watched_at: new Date(item.state?.lastWatched || item._mtime).getTime()
      });
    }
  });

  return { library, progress, watched };
}

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