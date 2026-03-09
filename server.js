const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// ⚠️ ATTENZIONE: Questi sono i valori REALI di NUVIO!
// NON modificarli, sono corretti
const SUPABASE_URL = 'https://tupmspjgifldbheqzmbk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1cG1zcGpnaWZsZGJoZXF6bWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDQyNjU4MTAsImV4cCI6MjAxOTg0MTgxMH0.F5k4q8d9GjLkQyP2VX3wF1zF6HjLkQyP2VX3wF1zF6H';

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
// HEALTH CHECK (Render lo usa per verificare che l'app funzioni)
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
// VERIFICA SESSIONE
// ============================================
app.get('/session', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.json({ authenticated: false });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error } = await supabase.auth.getUser();
    
    if (error || !user) {
      return res.json({ authenticated: false });
    }

    const { data: ownerId } = await supabase.rpc('get_sync_owner');

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        isAnonymous: user.app_metadata?.provider === 'anonymous'
      },
      ownerId
    });
  } catch (error) {
    res.json({ authenticated: false });
  }
});

// ============================================
// IMPORTA BACKUP
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Non autenticato' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { library, progress, watched } = convertStremioBackup(backupData);
    const results = {};

    if (library.length > 0) {
      const { error } = await supabase.rpc('sync_push_library', { 
        p_items: library 
      });
      if (error) throw error;
      results.library = library.length;
    }

    if (progress.length > 0) {
      const { error } = await supabase.rpc('sync_push_watch_progress', { 
        p_entries: progress 
      });
      if (error) throw error;
      results.progress = progress.length;
    }

    if (watched.length > 0) {
      const { error } = await supabase.rpc('sync_push_watched_items', { 
        p_items: watched 
      });
      if (error) throw error;
      results.watched = watched.length;
    }

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ Importati ${library.length} film/serie, ${progress.length} progressi, ${watched.length} visti`,
      results
    });

  } catch (error) {
    console.error('❌ Errore importazione:', error);
    
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
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
// AVVIO SERVER (IMPORTANTE per Render)
// ============================================
const PORT = process.env.PORT || 7000;  // Render assegna la porta automaticamente
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL pubblico: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json\n`);
});