const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

// Credenziali Supabase (dal tuo .env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
// LOGIN CON SUPABASE (EMAIL + PASSWORD)
// ============================================
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password richiesti' });
    }

    console.log(`🔐 Tentativo login per: ${email}`);

    // Inizializza Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // TENTATIVO DI LOGIN DIRETTO SU SUPABASE
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      console.error('❌ Errore login Supabase:', error);
      
      if (error.message.includes('Invalid login credentials')) {
        return res.status(401).json({ error: 'Email o password non corretti' });
      }
      return res.status(401).json({ error: error.message });
    }

    const user = data.user;
    const session = data.session;

    console.log(`✅ Login riuscito su Supabase: ${user.email} (${user.id})`);

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

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const backupData = JSON.parse(fileContent);

    // Inizializza Supabase con il token
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });

    // Verifica token
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    
    if (userError || !user) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Token non valido' });
    }

    console.log(`👤 Import per: ${user.email}`);

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

    // Importa su Supabase
    const results = {};

    if (libraryItems.length > 0) {
      const { error: pushError } = await supabase.rpc('sync_push_library', {
        p_items: libraryItems
      });
      
      if (pushError) {
        console.error('❌ Errore push:', pushError);
        throw new Error('Errore durante l\'import');
      }
      
      results.library = libraryItems.length;
    }

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `✅ Importati ${results.library || 0} elementi in NUVIO!`,
      stats: { total: movieCount + seriesCount }
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
  console.log(`🌐 URL pubblico: https://stremio-nuvio-importer.onrender.com/\n`);
});