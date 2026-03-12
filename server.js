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

app.get('/manifest.json', (req, res) => {
  res.json({
    id: "community.stremio-nuvio-importer",
    name: "Stremio → NUVIO Importer",
    description: "Converti il backup di Stremio nel formato nativo di NUVIO",
    version: "1.0.0",
    logo: "https://i.imgur.com/AIZFSRF.jpeg",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "stremio-importer", name: "📦 Importer" }],
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});

// ============================================
// SUPABASE CONFIGURAZIONE DA VARIABILI D'AMBIENTE
// ============================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function supabaseRequest(path, { method = 'GET', body, authToken } = {}) {
  const headers = { 'apikey': SUPABASE_ANON_KEY };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  if (!res.ok) {
    const msg = parsed?.message || parsed?.msg || parsed?.error_description || parsed?.error || text || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return parsed;
}

async function supabaseLogin(email, password) {
  const session = await supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  return session;
}

async function supabaseRpc(functionName, payload, accessToken) {
  return await supabaseRequest(`/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    body: payload || {},
    authToken: accessToken,
  });
}

// ============================================
// FUNZIONI STREMIO API
// ============================================
const STREMIO_API = 'https://api.strem.io';

async function stremioLogin(email, password) {
  try {
    const response = await fetch(`${STREMIO_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    const data = await response.json();
    if (!data || !data.token) {
      throw new Error('Login fallito: credenziali non valide');
    }
    return data;
  } catch (error) {
    console.error('❌ Stremio login error:', error.message);
    throw error;
  }
}

async function getStremioLibrary(authToken) {
  try {
    const response = await fetch(`${STREMIO_API}/api/library`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const data = await response.json();
    return data.items || [];
  } catch (error) {
    console.error('❌ Stremio library error:', error.message);
    return [];
  }
}

async function getStremioContinueWatching(authToken) {
  try {
    const response = await fetch(`${STREMIO_API}/api/continueWatching`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const data = await response.json();
    return data.items || [];
  } catch (error) {
    console.error('❌ Stremio continue watching error:', error.message);
    return [];
  }
}

async function getStremioWatchedHistory(authToken) {
  try {
    const response = await fetch(`${STREMIO_API}/api/watched`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const data = await response.json();
    return data.items || [];
  } catch (error) {
    console.error('❌ Stremio watched history error:', error.message);
    return [];
  }
}

// ============================================
// ENDPOINT PER TESTARE LOGIN NUVIO
// ============================================
app.post('/test-login', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, message: '❌ Inserisci email e password' });
  }

  if (!isSupabaseConfigured()) {
    return res.json({ 
      success: false, 
      message: '❌ Supabase non configurato sul server. Contatta l\'amministratore.' 
    });
  }

  try {
    console.log(`🔐 Test login Nuvio per: ${email}`);
    const session = await supabaseLogin(email, password);
    console.log(`✅ Login Nuvio riuscito per: ${session.user?.email}`);
    res.json({ success: true, message: `✅ Login Nuvio riuscito! Benvenuto ${session.user?.email}` });
  } catch (error) {
    console.error('❌ Errore test login Nuvio:', error.message);
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT PER OTTENERE DATI NUVIO
// ============================================
app.post('/get-nuvio-data', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const session = await supabaseLogin(email, password);
    const library = await supabaseRpc('sync_pull_library', {}, session.access_token);
    
    res.json({
      success: true,
      library: library || [],
      stats: {
        total: library?.length || 0,
        movies: library?.filter(i => i.content_type === 'movie').length || 0,
        series: library?.filter(i => i.content_type === 'series').length || 0
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT PER TESTARE LOGIN STREMIO
// ============================================
app.post('/test-stremio-login', express.json(), async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, message: '❌ Inserisci email e password' });
  }

  try {
    console.log(`🔐 Test login Stremio per: ${email}`);
    const auth = await stremioLogin(email, password);
    console.log(`✅ Login Stremio riuscito per: ${email}`);
    res.json({ success: true, message: `✅ Login Stremio riuscito!` });
  } catch (error) {
    console.error('❌ Errore test login Stremio:', error.message);
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT PER OTTENERE DATI STREMIO
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
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE (CON DEDUPLICA!)
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;
  console.log(`✅ Login riuscito, user ID: ${session.user?.id}`);

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
  console.log(`📦 Push di ${libraryItems.length} items unici`);

  await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
  return libraryItems.length;
}

// ============================================
// ENDPOINT PER SYNC DIRETTO
// ============================================
app.post('/sync', express.json(), async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;

  try {
    console.log('🚀 Avvio sync diretto...');
    
    // 1. Login Stremio e ottieni library
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const stremioLibrary = await getStremioLibrary(stremioAuth.token);
    
    // 2. Login Nuvio e ottieni library attuale
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const currentNuvioLibrary = await supabaseRpc('sync_pull_library', {}, accessToken) || [];
    
    // 3. Crea backup automatico
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(backupDir, `${backupId}.json`),
      JSON.stringify(currentNuvioLibrary, null, 2)
    );
    
    // 4. Trova nuovi items
    const existingIds = new Set(currentNuvioLibrary.map(i => i.content_id));
    const newItems = stremioLibrary.filter(item => {
      const contentId = item.id?.split(':')[0] || item._id?.split(':')[0];
      return !existingIds.has(contentId);
    });
    
    // 5. Push nuovi items
    const pushedCount = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, newItems);

    res.json({
      success: true,
      backupId,
      stats: {
        existing: currentNuvioLibrary.length,
        new: newItems.length,
        pushed: pushedCount
      },
      message: `✅ Sync completato! Aggiunti ${pushedCount} nuovi film/serie. Backup creato con ID: ${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT PER RIPRISTINO BACKUP
// ============================================
app.post('/restore', express.json(), async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;

  try {
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup non trovato' });
    }

    const backupLibrary = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    // Login Nuvio
    const session = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = session.access_token;

    // Prepara items per il push
    const items = backupLibrary.map(item => ({
      id: item.content_id,
      type: item.content_type,
      name: item.name,
      poster: item.poster,
      year: item.release_info,
      description: item.description,
      genres: item.genres,
      imdbRating: item.imdb_rating?.toString()
    }));

    // Push del backup completo
    const restored = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, items);

    res.json({
      success: true,
      message: `✅ Backup ripristinato! ${restored} film/serie.`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT PER LISTA BACKUP
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  
  if (!fs.existsSync(backupsDir)) {
    return res.json({ backups: [] });
  }

  try {
    const files = fs.readdirSync(backupsDir);
    const backups = files
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        id: f.replace('.json', ''),
        date: new Date(parseInt(f.replace('.json', ''))).toLocaleString()
      }))
      .sort((a, b) => b.id - a.id);

    res.json({ backups });
  } catch (error) {
    console.error('Errore lettura backup:', error);
    res.json({ backups: [] });
  }
});

// ============================================
// ENDPOINT PER VERIFICARE STATO SUPABASE
// ============================================
app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    url: SUPABASE_URL ? SUPABASE_URL.replace(/https?:\/\//, '').split('.')[0] + '...' : null,
    message: isSupabaseConfigured()
      ? '✅ Supabase configurato — push cloud disponibile'
      : '⚠️ Supabase non configurato — imposta SUPABASE_URL e SUPABASE_ANON_KEY su Render'
  });
});

// ============================================
// ENDPOINT PER ESTRARRE ADDONS (BACKWARD COMPATIBILITY)
// ============================================
app.post('/extract-addons', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const backup = JSON.parse(content);
    
    let addons = [];
    if (backup.data?.addons) addons = backup.data.addons;
    else if (backup.addons) addons = backup.addons;
    else if (backup.data?.installedAddons) addons = backup.data.installedAddons;
    
    fs.unlinkSync(req.file.path);
    res.json({ success: true, addons, count: addons.length });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT DI CONVERSIONE (BACKWARD COMPATIBILITY)
// ============================================
app.post('/convert', upload.fields([
  { name: 'backup', maxCount: 1 },
  { name: 'existing', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files || !req.files['backup']) {
      return res.status(400).json({ error: 'Nessun file backup Stremio caricato' });
    }

    const stremioFile = req.files['backup'][0];
    const existingFile = req.files['existing'] ? req.files['existing'][0] : null;
    const { email, password, skipCloudPush } = req.body;

    // Leggi backup Stremio
    const stremioContent = fs.readFileSync(stremioFile.path, 'utf8');
    const stremioData = JSON.parse(stremioContent);

    // Converti i film
    const library = [];
    const itemsArray = Array.isArray(stremioData) ? stremioData : Object.values(stremioData);
    
    itemsArray.forEach(item => {
      if (item.removed || item.temp) return;
      if (item.type !== 'movie' && item.type !== 'series') return;

      const originalId = item._id;
      const imdbId = originalId.split(':')[0];
      
      library.push({
        id: originalId,
        type: item.type,
        name: item.name || '',
        poster: item.poster || '',
        year: item.year ? String(item.year) : '',
        description: item.description || '',
        imdbRating: item.imdbRating || '',
        genres: item.genres || [],
        imdb_id: imdbId
      });
    });

    // Push cloud se richiesto
    let cloudPushResult = null;
    if (email && password && skipCloudPush !== 'true' && isSupabaseConfigured()) {
      try {
        const pushedCount = await pushLibraryToSupabase(email, password, library);
        cloudPushResult = { success: true, count: pushedCount };
      } catch (pushError) {
        cloudPushResult = { success: false, error: pushError.message };
      }
    }

    // Crea backup Nuvio
    const nuvioBackup = {
      version: "1.0.0",
      timestamp: Date.now(),
      appVersion: "1.0.0",
      platform: "android",
      userScope: "local",
      data: { library }
    };

    fs.unlinkSync(stremioFile.path);
    if (existingFile) fs.unlinkSync(existingFile.path);

    res.json({
      success: true,
      data: nuvioBackup,
      cloudPush: cloudPushResult,
      stats: { total: library.length }
    });

  } catch (error) {
    console.error('❌ Errore conversione:', error);
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE COMPLETA)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com/`);
  console.log(`☁️  Push cloud: ${isSupabaseConfigured() ? '✅ ATTIVO' : '⚠️  NON CONFIGURATO'}`);
  
  if (!isSupabaseConfigured()) {
    console.log(`   → Per abilitare, imposta su Render:`);
    console.log(`     SUPABASE_URL=URL_DEL_TUO_PROGETTO`);
    console.log(`     SUPABASE_ANON_KEY=LA_TUA_ANON_KEY`);
  }
  
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • /test-login - Test login Nuvio`);
  console.log(`   • /get-nuvio-data - Ottieni library Nuvio`);
  console.log(`   • /test-stremio-login - Test login Stremio`);
  console.log(`   • /get-stremio-data - Ottieni library Stremio`);
  console.log(`   • /sync - Sync diretto Stremio → Nuvio`);
  console.log(`   • /backups - Lista backup disponibili`);
  console.log(`   • /restore - Ripristina un backup`);
  console.log(`   • /convert - Conversione backup (legacy)`);
  console.log(`   • /extract-addons - Estrai addons (legacy)`);
  console.log(`\n✨ NOVITÀ: Sync diretto con login Stremio!\n`);
});
