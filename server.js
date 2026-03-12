const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http = require('http');

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
// SUPABASE CONFIGURAZIONE (NUVIO)
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dpyhjjcoabcglfmgecug.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRweWhqamNvYWJjZ2xmbWdlY3VnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3ODYyNDcsImV4cCI6MjA4NjM2MjI0N30.U-3QSNDdpsnvRk_7ZL419AFTOtggHJJcmkodxeXjbkg';

// ============================================
// FUNZIONI SUPABASE (NUVIO)
// ============================================
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function supabaseLogin(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email, password
  });
  if (error) throw error;
  return data;
}

async function getNuvioLibrary(accessToken) {
  const { data, error } = await supabase.rpc('sync_pull_library', {}, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (error) throw error;
  return data || [];
}

async function pushLibraryToSupabase(accessToken, items) {
  // DEDUPLICA
  const uniqueItems = new Map();
  
  items.forEach(item => {
    const contentId = item.id.split(':')[0];
    if (!uniqueItems.has(contentId)) {
      uniqueItems.set(contentId, {
        content_id: contentId,
        content_type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        poster_shape: 'POSTER',
        background: item.background || '',
        description: item.description || '',
        release_info: item.year || '',
        imdb_rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
        genres: item.genres || [],
        addon_base_url: '',
        added_at: Date.now()
      });
    }
  });

  const libraryItems = Array.from(uniqueItems.values());
  
  const { error } = await supabase.rpc('sync_push_library', { 
    p_items: libraryItems 
  }, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  
  if (error) throw error;
  return libraryItems;
}

// ============================================
// FUNZIONI STREMIO API (DAL PCAP!)
// ============================================
const STREMIO_API = 'https://api.strem.io';
const STREMIO_IPS = ['104.17.88.107', '104.17.89.107'];

// Funzione per fare richieste API a Stremio
async function stremioRequest(endpoint, method = 'GET', body = null, authToken = null) {
  const url = `${STREMIO_API}${endpoint}`;
  
  const headers = {
    'User-Agent': 'Stremio/4.4.142 (Linux;android 13)',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers,
      timeout: 10000
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Login a Stremio
async function stremioLogin(email, password) {
  try {
    const response = await stremioRequest('/api/auth/login', 'POST', {
      email,
      password
    });
    
    if (response && response.token) {
      return { token: response.token, user: response.user };
    }
    throw new Error('Login fallito');
  } catch (error) {
    console.error('❌ Stremio login error:', error.message);
    throw error;
  }
}

// Ottieni la library completa
async function getStremioLibrary(authToken) {
  try {
    const response = await stremioRequest('/api/library', 'GET', null, authToken);
    
    if (response && response.items) {
      return response.items.map(item => ({
        _id: item.id,
        type: item.type,
        name: item.name,
        poster: item.poster,
        year: item.year,
        description: item.description,
        genres: item.genres,
        imdbRating: item.imdbRating,
        totalSeasons: item.totalSeasons,
        totalEpisodes: item.totalEpisodes
      }));
    }
    return [];
  } catch (error) {
    console.error('❌ Stremio library error:', error.message);
    return [];
  }
}

// Ottieni continue watching
async function getStremioContinueWatching(authToken) {
  try {
    const response = await stremioRequest('/api/continueWatching', 'GET', null, authToken);
    
    if (response && response.items) {
      return response.items.map(item => ({
        _id: item.id,
        type: item.type,
        name: item.name,
        season: item.season,
        episode: item.episode,
        progress: (item.timeOffset / item.duration) * 100,
        timeOffset: item.timeOffset,
        duration: item.duration,
        lastWatched: item.lastWatched
      }));
    }
    return [];
  } catch (error) {
    console.error('❌ Stremio continue watching error:', error.message);
    return [];
  }
}

// Ottieni watched history
async function getStremioWatchedHistory(authToken) {
  try {
    const response = await stremioRequest('/api/watched', 'GET', null, authToken);
    
    if (response && response.items) {
      return response.items.map(item => ({
        _id: item.id,
        type: item.type,
        watchedAt: item.watchedAt
      }));
    }
    return [];
  } catch (error) {
    console.error('❌ Stremio watched history error:', error.message);
    return [];
  }
}

// ============================================
// ENDPOINT: LOGIN STREMIO (TEST)
// ============================================
app.post('/test-stremio-login', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const auth = await stremioLogin(email, password);
    res.json({ 
      success: true, 
      message: `✅ Login Stremio riuscito per ${auth.user?.email || email}` 
    });
  } catch (error) {
    res.json({ 
      success: false, 
      message: `❌ Login fallito: ${error.message}` 
    });
  }
});

// ============================================
// ENDPOINT: OTTIENI DATI STREMIO (ANTEPRIMA)
// ============================================
app.post('/get-stremio-data', express.json(), async (req, res) => {
  const { email, password } = req.body;

  try {
    const auth = await stremioLogin(email, password);
    
    const [library, continueWatching, watchedHistory] = await Promise.all([
      getStremioLibrary(auth.token),
      getStremioContinueWatching(auth.token),
      getStremioWatchedHistory(auth.token)
    ]);

    res.json({
      success: true,
      library,
      continueWatching,
      watchedHistory,
      stats: {
        movies: library.filter(i => i.type === 'movie').length,
        series: library.filter(i => i.type === 'series').length,
        continueWatching: continueWatching.length,
        watched: watchedHistory.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: OTTIENI DATI NUVIO
// ============================================
app.post('/get-nuvio-data', express.json(), async (req, res) => {
  const { email, password } = req.body;

  try {
    const auth = await supabaseLogin(email, password);
    const library = await getNuvioLibrary(auth.session.access_token);

    res.json({
      success: true,
      library,
      stats: {
        total: library.length,
        movies: library.filter(i => i.content_type === 'movie').length,
        series: library.filter(i => i.content_type === 'series').length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC DIRETTO
// ============================================
app.post('/sync', express.json(), async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;

  try {
    // 1. Login Stremio
    console.log('🔐 Login Stremio...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    
    // 2. Ottieni library Stremio
    console.log('📚 Recupero library Stremio...');
    const stremioLibrary = await getStremioLibrary(stremioAuth.token);
    
    // 3. Login Nuvio
    console.log('🔐 Login Nuvio...');
    const nuvioAuth = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioAuth.session.access_token;

    // 4. Ottieni library Nuvio attuale
    console.log('☁️ Recupero library Nuvio...');
    const currentNuvioLibrary = await getNuvioLibrary(accessToken);
    
    // 5. Crea backup automatico
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(backupDir, `${backupId}.json`), 
      JSON.stringify(currentNuvioLibrary, null, 2)
    );

    // 6. Trova nuovi items (non già presenti)
    const existingIds = new Set(currentNuvioLibrary.map(i => i.content_id));
    const newItems = stremioLibrary.filter(item => {
      const contentId = item._id.split(':')[0];
      return !existingIds.has(contentId);
    });

    // 7. Push nuovi items a Nuvio
    console.log(`📤 Push di ${newItems.length} nuovi items...`);
    const pushedItems = await pushLibraryToSupabase(accessToken, newItems);

    res.json({
      success: true,
      backupId,
      stats: {
        existing: currentNuvioLibrary.length,
        new: newItems.length,
        pushed: pushedItems.length
      },
      message: `✅ Sync completato! Aggiunti ${pushedItems.length} nuovi film/serie. Backup creato con ID: ${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP
// ============================================
app.post('/restore', express.json(), async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;

  try {
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup non trovato' });
    }

    const backupLibrary = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    const nuvioAuth = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioAuth.session.access_token;

    // Push del backup completo
    const restored = await pushLibraryToSupabase(accessToken, backupLibrary.map(item => ({
      id: item.content_id,
      type: item.content_type,
      name: item.name,
      poster: item.poster,
      year: item.release_info,
      description: item.description,
      genres: item.genres,
      imdbRating: item.imdb_rating?.toString()
    })));

    res.json({
      success: true,
      message: `✅ Backup ripristinato! ${restored.length} film/serie.`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT: LISTA BACKUP
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupsDir)) {
    return res.json({ backups: [] });
  }

  const backups = fs.readdirSync(backupsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      id: f.replace('.json', ''),
      date: new Date(parseInt(f.replace('.json', ''))).toLocaleString()
    }))
    .sort((a, b) => b.id - a.id);

  res.json({ backups });
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Direct Sync (con API vere!)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`\n✅ API Stremio configurate:`);
  console.log(`   • Endpoint: ${STREMIO_API}`);
  console.log(`   • IPs: ${STREMIO_IPS.join(', ')}`);
  console.log(`\n✨ Funzionalità:`);
  console.log(`   • Login Stremio reale (dalle API trovate nel PCAP)`);
  console.log(`   • Backup automatico PRIMA di ogni sync`);
  console.log(`   • Push intelligente (solo nuovi film)`);
  console.log(`   • Ripristino con un click\n`);
});
