const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Il server ora serve SOLO:
// - La pagina configure.html (statica)
// - Il manifest Stremio
// - Il catalogo placeholder
//
// L'importazione avviene DIRETTAMENTE nel browser → Supabase
// senza passare per questo server. Questo elimina completamente
// il problema "failed to fetch".

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);

app.get('/configure', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'configure.html'))
);

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'community.stremio-nuvio-importer',
    name: 'Stremio Backup Importer',
    description: 'Importa la tua libreria Stremio in NUVIO con un click',
    version: '1.0.0',
    logo: 'https://i.imgur.com/AIZFSRF.jpeg',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: [{ type: 'movie', id: 'stremio-import', name: '📦 Stremio Importer' }],
    behaviorHints: { configurable: true, configurationRequired: false },
  });
});

app.get('/catalog/movie/stremio-import.json', (req, res) => {
  res.json({
    metas: [{
      id: 'stremio-importer',
      type: 'movie',
      name: 'Stremio Importer',
      poster: 'https://via.placeholder.com/300x450/00a8ff/ffffff?text=Stremio%2BImporter',
      description: 'Apri la pagina di configurazione per importare il tuo backup Stremio',
    }],
  });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio NUVIO Importer — porta ${PORT}`);
  console.log(`🌐 https://stremio-nuvio-importer.onrender.com/configure`);
  console.log(`ℹ️  Import avviene lato browser → Supabase (nessun proxy)\n`);
});