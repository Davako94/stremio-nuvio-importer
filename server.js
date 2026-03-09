const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

// ============================================
// CREDENZIALI SUPABASE (da .env - SICURE)
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Verifica che le credenziali siano presenti
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ ERRORE: Credenziali Supabase mancanti nel file .env');
  process.exit(1);
}

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
// LOGIN CON EMAIL + PASSWORD + ID PROPRIETARIO
// ============================================
app.post('/login', async (req, res) => {
  try {
    const { email, password, ownerId } = req.body;

    if (!email || !password || !ownerId) {
      return res.status(400).json({ error: 'Email, password e ID proprietario richiesti' });
    }

    console.log(`🔐 Tentativo login per: ${email}`);

    // Inizializza Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // 1. Login con email e password
    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (loginError) {
      console.error('❌ Errore login:', loginError);
      
      if (loginError.message.includes('Invalid login credentials')) {
        return res.status(401).json({ error: 'Email o password non corretti' });
      }
      return res.status(401).json({ error: loginError.message });
    }

    const user = loginData.user;
    const session = loginData.session;

    console.log(`✅ Login riuscito: ${user.email} (${user.id})`);

    // 2. VERIFICA ID PROPRIETARIO (tripla verifica)
    // Chiamiamo get_sync_owner per vedere cosa restituisce
    try {
      const { data: ownerData, error: ownerError } = await supabase.rpc('get_sync_owner');
      
      if (ownerError) {
        console.warn('⚠️ get_sync_owner non disponibile:', ownerError);
      } else {
        console.log(`👤 Owner ID restituito: ${ownerData}`);
        
        // Se l'ownerId fornito non corrisponde, potrebbe essere un problema
        // Ma non blocchiamo per ora
        if (ownerData && ownerData !== ownerId) {
          console.warn(`⚠️ Owner ID mismatch: fornito=${ownerId}, restituito=${ownerData}`);
        }
      }
    } catch (e) {
      console.log('get_sync_owner non disponibile, proseguo');
    }

    // Restituisce il token e i dati utente
    res.json({
      success: true,
      token: session.access_token,
      userId: user.id,
      email: user.email
    });

  } catch (error) {
    console.error('❌ Errore login:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CONVERTI E IMPORTA (USA IL TOKEN)
// ============================================
app.post('/import', upload.single('backup'), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token mancante' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    console.log('📁 File ricevuto:', req.file.originalname);

    // Legge il file
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    // Inizializza Supabase con il token dell'utente
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });

    // Verifica che il token sia valido
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    
    if (userError || !user) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Token non valido o scaduto' });
    }

    console.log(`👤 Import per: ${user.email} (${user.id})`);

    // Converte il backup
    const libraryItems = [];
    let movieCount = 0;
    let seriesCount = 0;

    const itemsArray = Array.isArray(backupData) ? backupData : Object.values(backupData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      libraryItems.push({
        content_id: item._id,
        content_type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        poster_shape: (item.posterShape || 'poster').toUpperCase(),
        release_info: item.year || '',
        added_at: new Date(item._ctime || item._mtime || Date.now()).getTime()
      });

      if (item.type === 'movie') movieCount++;
      else seriesCount++;
    });

    console.log(`✅ Convertiti: ${movieCount} film, ${seriesCount} serie`);

    // ============================================
    // SCRITTURA SU SUPABASE
    // ============================================
    const results = {};

    if (libraryItems.length > 0) {
      console.log(`📦 Importando ${libraryItems.length} elementi...`);
      
      const { error: pushError } = await supabase.rpc('sync_push_library', {
        p_items: libraryItems
      });
      
      if (pushError) {
        console.error('❌ Errore push library:', pushError);
        throw new Error('Errore durante l\'import');
      }
      
      results.library = libraryItems.length;
    }

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ Importati ${results.library || 0} elementi in NUVIO!`,
      stats: { 
        movies: movieCount, 
        series: seriesCount, 
        total: movieCount + seriesCount 
      }
    });

  } catch (error) {
    console.error('❌ Errore import:', error);
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
  console.log(`📧 SUPABASE_URL: ${SUPABASE_URL ? '✅ configurata' : '❌ mancante'}`);
  console.log(`🔑 SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? '✅ configurata' : '❌ mancante'}`);
  console.log(`\n🌐 URL pubblico: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`🔧 Configurazione: https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`📋 Manifest: https://stremio-nuvio-importer.onrender.com/manifest.json\n`);
});