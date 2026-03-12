const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => { res.redirect('/configure'); });
app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });
app.get('/configure', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ============================================
// CONFIGURAZIONE SUPABASE DA VARIABILI D'AMBIENTE
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Verifica che le variabili siano configurate
function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// ============================================
// ENDPOINT PER VERIFICARE STATO SUPABASE
// ============================================
app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() 
      ? '✅ Supabase configurato' 
      : '❌ Supabase NON configurato (mancano SUPABASE_URL e SUPABASE_ANON_KEY)'
  });
});

// ============================================
// FUNZIONI SUPABASE (NUVIO)
// ============================================
async function supabaseLogin(email, password) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase non configurato sul server');
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function getNuvioLibrary(accessToken) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase non configurato sul server');
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.rpc('sync_pull_library', {}, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (error) throw error;
  return data || [];
}

// ============================================
// ENDPOINT PER TESTARE LOGIN NUVIO
// ============================================
app.post('/test-login', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  if (!isSupabaseConfigured()) {
    return res.json({ 
      success: false, 
      message: '❌ Supabase non configurato. Contatta l\'amministratore.' 
    });
  }
  
  try {
    await supabaseLogin(email, password);
    res.json({ success: true, message: `✅ Login Nuvio riuscito per ${email}` });
  } catch (error) {
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT PER OTTENERE DATI NUVIO
// ============================================
app.post('/get-nuvio-data', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  if (!isSupabaseConfigured()) {
    return res.json({ 
      success: false, 
      error: 'Supabase non configurato. Contatta l\'amministratore.' 
    });
  }
  
  try {
    const auth = await supabaseLogin(email, password);
    const library = await getNuvioLibrary(auth.session.access_token);
    
    res.json({
      success: true,
      library: library,
      stats: {
        total: library.length,
        movies: library.filter(i => i.content_type === 'movie').length,
        series: library.filter(i => i.content_type === 'series').length
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT PER TESTARE LOGIN STREMIO (SIMULATO)
// ============================================
app.post('/test-stremio-login', express.json(), (req, res) => {
  const { email } = req.body;
  console.log('🧪 Test Stremio per:', email);
  
  // Per ora accetta qualsiasi credenziale
  res.json({ 
    success: true, 
    message: `✅ Login Stremio simulato per ${email}` 
  });
});

// ============================================
// ENDPOINT PER OTTENERE DATI STREMIO (SIMULATI)
// ============================================
app.post('/get-stremio-data', express.json(), (req, res) => {
  console.log('📚 Richiesta dati Stremio');
  
  // Dati di esempio basati sul tuo backup
  res.json({
    success: true,
    library: [
      {
        _id: "tt0137523",
        type: "movie",
        name: "Fight Club",
        poster: "https://image.tmdb.org/t/p/w500/poster.jpg",
        year: "1999",
        description: "Un insonne depresso e un venditore di sapone anarchico creano un club di combattimenti clandestini.",
        genres: ["Dramma", "Thriller"],
        imdbRating: "8.8"
      },
      {
        _id: "tt0455275",
        type: "series",
        name: "Prison Break",
        poster: "https://image.tmdb.org/t/p/w500/poster.jpg",
        year: "2005",
        description: "Un uomo si fa incarcerare per far evadere il fratello condannato a morte.",
        genres: ["Azione", "Dramma", "Thriller"],
        imdbRating: "8.3",
        totalSeasons: 5,
        totalEpisodes: 88
      },
      {
        _id: "tt0460649",
        type: "series",
        name: "How I Met Your Mother",
        poster: "https://image.tmdb.org/t/p/w500/poster.jpg",
        year: "2005",
        description: "Ted Mosby racconta ai figli la storia di come ha conosciuto la loro madre.",
        genres: ["Commedia", "Romance"],
        imdbRating: "8.3",
        totalSeasons: 9,
        totalEpisodes: 208
      },
      {
        _id: "tt0386676",
        type: "series",
        name: "The Office",
        poster: "https://image.tmdb.org/t/p/w500/poster.jpg",
        year: "2005",
        description: "La vita quotidiana degli impiegati della Dunder Mifflin.",
        genres: ["Commedia"],
        imdbRating: "9.0",
        totalSeasons: 9,
        totalEpisodes: 201
      }
    ],
    continueWatching: [
      {
        _id: "tt0455275:3:10",
        type: "series",
        name: "Prison Break - Stagione 3 Episodio 10",
        season: 3,
        episode: 10,
        progress: 65,
        timeOffset: 1170,
        duration: 1800,
        lastWatched: Date.now()
      }
    ],
    watchedHistory: [],
    stats: {
      movies: 1,
      series: 3,
      continueWatching: 1,
      watched: 0
    }
  });
});

// ============================================
// ENDPOINT PER BACKUP
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  
  // Crea directory se non esiste
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    return res.json({ backups: [] });
  }
  
  try {
    const files = fs.readdirSync(backupsDir);
    const backups = files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const id = f.replace('.json', '');
        return {
          id: id,
          date: new Date(parseInt(id)).toLocaleString()
        };
      })
      .sort((a, b) => b.id - a.id);
    
    res.json({ backups });
  } catch (error) {
    console.error('Errore lettura backup:', error);
    res.json({ backups: [] });
  }
});

// ============================================
// ENDPOINT PER SYNC
// ============================================
app.post('/sync', express.json(), async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  
  if (!isSupabaseConfigured()) {
    return res.status(500).json({ 
      success: false, 
      error: 'Supabase non configurato. Contatta l\'amministratore.' 
    });
  }
  
  try {
    console.log(`🔄 Sync: ${stremioEmail} → ${nuvioEmail}`);
    
    // 1. Login Nuvio e ottieni library attuale
    const nuvioAuth = await supabaseLogin(nuvioEmail, nuvioPassword);
    const currentLibrary = await getNuvioLibrary(nuvioAuth.session.access_token);
    
    // 2. Crea backup automatico
    const backupId = Date.now().toString();
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(backupsDir, `${backupId}.json`),
      JSON.stringify(currentLibrary, null, 2)
    );
    
    // 3. Simula push di nuovi film (per ora)
    const existingIds = new Set(currentLibrary.map(i => i.content_id));
    
    // Dati Stremio simulati
    const stremioLibrary = [
      { id: "tt0137523", name: "Fight Club", type: "movie" },
      { id: "tt0455275", name: "Prison Break", type: "series" },
      { id: "tt0460649", name: "How I Met Your Mother", type: "series" },
      { id: "tt0386676", name: "The Office", type: "series" }
    ];
    
    const newItems = stremioLibrary.filter(item => !existingIds.has(item.id));
    
    console.log(`📊 Trovati ${newItems.length} nuovi film/serie`);
    
    res.json({
      success: true,
      backupId,
      stats: {
        existing: currentLibrary.length,
        new: newItems.length,
        pushed: newItems.length
      },
      message: `✅ Sync completato! Aggiunti ${newItems.length} nuovi film/serie. Backup creato con ID: ${backupId}`
    });
    
  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// ENDPOINT PER RIPRISTINO
// ============================================
app.post('/restore', express.json(), async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;
  
  if (!isSupabaseConfigured()) {
    return res.status(500).json({ 
      success: false, 
      error: 'Supabase non configurato. Contatta l\'amministratore.' 
    });
  }
  
  try {
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ 
        success: false, 
        error: 'Backup non trovato' 
      });
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    
    // Qui andrebbe il vero push a Supabase
    // Per ora simuliamo
    
    res.json({
      success: true,
      message: `✅ Backup ${backupId} ripristinato (simulato)`
    });
    
  } catch (error) {
    console.error('❌ Errore ripristino:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`\n📊 Stato Supabase: ${isSupabaseConfigured() ? '✅ CONFIGURATO' : '❌ NON CONFIGURATO'}`);
  if (!isSupabaseConfigured()) {
    console.log(`   ⚠️  Imposta SUPABASE_URL e SUPABASE_ANON_KEY su Render`);
  }
  console.log(`\n✅ Endpoint disponibili:`);
  console.log(`   • POST /test-login - Login Nuvio (reale)`);
  console.log(`   • POST /get-nuvio-data - Dati Nuvio (reali)`);
  console.log(`   • POST /test-stremio-login - Login Stremio (simulato)`);
  console.log(`   • POST /get-stremio-data - Dati Stremio (simulati)`);
  console.log(`   • POST /sync - Sync (simulato)`);
  console.log(`   • POST /restore - Ripristino (simulato)`);
  console.log(`   • GET /backups - Lista backup`);
  console.log(`   • GET /supabase-status - Stato Supabase\n`);
});
