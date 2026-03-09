const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Configurazione Supabase (valori reali di NUVIO)
const SUPABASE_URL = 'https://tupmspjgifldbheqzmbk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1cG1zcGpnaWZsZGJoZXF6bWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDQyNjU4MTAsImV4cCI6MjAxOTg0MTgxMH0.F5k4q8d9GjLkQyP2VX3wF1zF6HjLkQyP2VX3wF1zF6H';

// Middleware
app.use(cors({
  origin: true, // Permette richieste da qualsiasi origine (incluso il WebView di NUVIO)
  credentials: true // Fondamentale per permettere l'invio dei cookie di sessione
}));
app.use(express.json());
app.use(express.static('public'));

// ============================================
// HOME PAGE - Reindirizza a configure
// ============================================
app.get('/', (req, res) => {
  res.redirect('/configure');
});

// ============================================
// HEALTH CHECK (per Render)
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
// MANIFEST DELL'ADDON (CON LOGO AGGIUNTO)
// ============================================
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "community.stremio-nuvio-importer",
    name: "Stremio Backup Importer",
    description: "Importa la tua libreria Stremio in NUVIO con un click",
    version: "1.0.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg", // <-- LOGO AGGIUNTO
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
// ENDPOINT SESSIONE (RIMOSSO - Non più necessario)
// ============================================
// L'endpoint /session è stato rimosso perché la verifica dell'autenticazione
// avviene direttamente durante l'import, usando i cookie di sessione.

// ============================================
// IMPORTA BACKUP (MODIFICATO PER USARE I COOKIE)
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    // Legge il file di backup
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    // Inizializza il client Supabase
    // NOTA: Non passiamo token, ma confidiamo che i cookie di sessione
    // vengano inviati automaticamente dal browser/WebView.
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          // Aggiungiamo un header generico per identificare il client
          'X-Client-Info': 'stremio-importer'
        }
      }
    });

    // Tenta di ottenere l'utente per verificare che la sessione sia valida
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      // Se non riusciamo a ottenere l'utente, la sessione non è valida
      console.warn('Tentativo di import senza sessione valida');
      // Pulisce il file temporaneo prima di uscire
      fs.unlinkSync(req.file.path);
      return res.status(401).json({
        error: 'Sessione NUVIO non valida. Assicurati di aver aperto NUVIO in questa finestra e riprova.'
      });
    }

    console.log(`👤 Import per utente: ${user.email || user.id}`);

    // Ottiene l'owner effettivo (per device linked)
    const { data: ownerId, error: ownerError } = await supabase.rpc('get_sync_owner');
    if (ownerError) {
      console.warn('Impossibile ottenere owner ID, procedo comunque:', ownerError.message);
    } else {
      console.log(`👑 Owner ID: ${ownerId}`);
    }

    // Converte il backup
    const { library, progress, watched } = convertStremioBackup(backupData);
    const results = {};

    // Push library
    if (library.length > 0) {
      console.log(`📦 Importando ${library.length} film/serie...`);
      const { error } = await supabase.rpc('sync_push_library', { p_items: library });
      if (error) throw error;
      results.library = library.length;
    }

    // Push progress
    if (progress.length > 0) {
      console.log(`⏱️ Importando ${progress.length} progressi...`);
      const { error } = await supabase.rpc('sync_push_watch_progress', { p_entries: progress });
      if (error) throw error;
      results.progress = progress.length;
    }

    // Push watched
    if (watched.length > 0) {
      console.log(`👁️ Importando ${watched.length} elementi visti...`);
      const { error } = await supabase.rpc('sync_push_watched_items', { p_items: watched });
      if (error) throw error;
      results.watched = watched.length;
    }

    // Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ Importati ${library.length} film/serie, ${progress.length} progressi, ${watched.length} visti`,
      results
    });

  } catch (error) {
    console.error('❌ Errore importazione:', error);

    // Pulisce file temporaneo in caso di errore
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }

    // Gestione errori specifici di Supabase/Auth
    if (error.message?.includes('JWT') || error.message?.includes('auth')) {
      return res.status(401).json({
        error: 'Sessione scaduta. Apri NUVIO, ricarica la pagina e riprova.'
      });
    }

    res.status(500).json({
      error: error.message || 'Errore durante importazione'
    });
  }
});

// ============================================
// CATALOGO (richiesto da NUVIO)
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
// CONVERTER (invariato)
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
  console.log(`📋 Manifest (con logo): https://stremio-nuvio-importer.onrender.com/manifest.json\n`);
});