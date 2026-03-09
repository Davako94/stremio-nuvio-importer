const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Configurazione Supabase (solo anon key, niente service key)
const SUPABASE_URL = 'https://tupmspjgifldbheqzmbk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1cG1zcGpnaWZsZGJoZXF6bWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDQyNjU4MTAsImV4cCI6MjAxOTg0MTgxMH0.F5k4q8d9GjLkQyP2VX3wF1zF6HjLkQyP2VX3wF1zF6H';

// ============================================
// CONFIGURAZIONE CORS MIGLIORATA (RISOLVE "FAILED TO FETCH")
// ============================================
const corsOptions = {
  origin: true, // Permette qualsiasi origine (in produzione, puoi restringere)
  credentials: true, // Fondamentale per permettere l'invio di cookie/autenticazione
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Middleware per gestire manualmente i CORS headers su tutte le risposte
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  
  // Rispondi immediatamente alle richieste OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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
// VERIFICA E LOGIN (EMAIL + ID + PASSWORD)
// ============================================
app.post('/verify-account', async (req, res) => {
  // Aggiungi header CORS anche qui per sicurezza
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }

  try {
    const { email, ownerId, password } = req.body;

    if (!email || !ownerId || !password) {
      return res.status(400).json({ error: 'Email, ID e password richiesti' });
    }

    // Validazione UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(ownerId)) {
      return res.status(400).json({ error: 'Formato ID non valido' });
    }

    // Inizializza client Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // 1. Prova il login con email e password
    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (loginError) {
      console.error('Errore login:', loginError);
      
      // Messaggi user-friendly
      if (loginError.message.includes('Invalid login credentials')) {
        return res.status(401).json({ error: 'Email o password non corretti' });
      }
      return res.status(401).json({ error: loginError.message });
    }

    if (!loginData.session) {
      return res.status(401).json({ error: 'Login fallito' });
    }

    const user = loginData.user;
    const session = loginData.session;

    console.log(`✅ Login effettuato: ${user.email} (${user.id})`);

    // Restituiamo il token al frontend
    res.json({ 
      valid: true, 
      token: session.access_token,
      userId: user.id,
      email: user.email
    });

  } catch (error) {
    console.error('Errore verifica:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IMPORTA BACKUP (USA IL TOKEN OTTENUTO)
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  // Aggiungi header CORS
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }

  try {
    // Il token arriva nell'header Authorization
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Non autenticato' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    // 1. Legge il file backup
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    // 2. Inizializza client con il token dell'utente
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    // 3. Verifica che il token sia ancora valido
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    
    if (userError || !user) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Sessione scaduta. Rifai il login.' });
    }

    console.log(`👤 Import per: ${user.email} (${user.id})`);

    // 4. Converte il backup
    const { library, progress, watched } = convertStremioBackup(backupData);
    const results = {};

    // 5. Importa la libreria
    if (library.length > 0) {
      console.log(`📦 Importando ${library.length} film/serie...`);
      
      const { error: libError } = await supabase.rpc('sync_push_library', {
        p_items: library
      });
      
      if (libError) {
        console.error('Errore push library:', libError);
        throw new Error('Errore durante l\'import della libreria');
      }
      
      results.library = library.length;
    }

    // 6. Importa i progressi
    if (progress.length > 0) {
      console.log(`⏱️ Importando ${progress.length} progressi...`);
      
      const { error: progError } = await supabase.rpc('sync_push_watch_progress', {
        p_entries: progress
      });
      
      if (progError) {
        console.error('Errore push progress:', progError);
        // Non blocchiamo tutto, solo log
      } else {
        results.progress = progress.length;
      }
    }

    // 7. Importa i watched
    if (watched.length > 0) {
      console.log(`👁️ Importando ${watched.length} elementi visti...`);
      
      const { error: watchError } = await supabase.rpc('sync_push_watched_items', {
        p_items: watched
      });
      
      if (watchError) {
        console.error('Errore push watched:', watchError);
      } else {
        results.watched = watched.length;
      }
    }

    // 8. Pulisce file temporaneo
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ Importati ${results.library || 0} film/serie, ${results.progress || 0} progressi, ${results.watched || 0} visti`,
      results
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
  // Aggiungi header CORS
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }

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
  console.log(`✅ Metodo: email + ID + password con CORS migliorato`);
});