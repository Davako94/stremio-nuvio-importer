# 📦 Stremio NUVIO Importer

<div align="center">
  <img src="https://i.imgur.com/AIZFSRF.jpeg" alt="Stremio to NUVIO Logo" width="120" height="120"/>
  <h3>Importa la tua libreria Stremio in NUVIO con un click</h3>
  <p><i>Plug & Play • Nessuna configurazione richiesta</i></p>

  <p>
    <a href="https://stremio-nuvio-importer.onrender.com/configure"><strong>🌐 Apri l'Importer</strong></a> •
    <a href="https://stremio-nuvio-importer.onrender.com/manifest.json"><strong>📦 Installa in NUVIO</strong></a>
  </p>
</div>

---

## 📋 Indice
- [Cos'è?](#-cosè)
- [Come funziona](#-come-funziona)
- [Requisiti](#-requisiti)
- [Installazione Rapida](#-installazione-rapida)
- [Guida all'uso](#-guida-alluso)
  - [1️⃣ Ottieni il backup da Stremio](#1️⃣-ottieni-il-backup-da-stremio)
  - [2️⃣ Importa in NUVIO](#2️⃣-importa-in-nuvio)
- [Cosa viene importato](#-cosa-viene-importato)
- [Domande Frequenti](#-domande-frequenti-faq)
- [Supporto](#-supporto)

---

## 🎯 Cos'è?

**Stremio NUVIO Importer** è un addon ufficiale per **NUVIO** che ti permette di portare tutta la tua libreria di film e serie da **Stremio** con un semplice click.

Niente più aggiunte manuali: carichi il file di backup e i tuoi contenuti compaiono magicamente in NUVIO, su tutti i tuoi dispositivi.

---

## ✨ Come funziona

1. **Esporti** la tua libreria da Stremio usando uno dei tool amici della community
2. **Carichi** il file in questo addon
3. **I tuoi film e serie** vengono aggiunti automaticamente a NUVIO
4. **La magia** della sincronizzazione integrata di NUVIO li rende disponibili su tutti i tuoi dispositivi

Nessuna configurazione tecnica. Nessun account extra. Funziona e basta.

---

## ✅ Requisiti

- Un account **NUVIO** (gratuito o a pagamento)
- Un file di backup della tua libreria **Stremio** (vedi sotto come ottenerlo)
- Una connessione internet

---

## 🚀 Installazione Rapida

### Aggiungi l'addon in NUVIO (consigliato)

1. Apri **NUVIO** sul tuo dispositivo (Android, iOS, Web, TV)
2. Vai nella sezione **Addon**
3. Clicca su **"Aggiungi addon"** e inserisci questo indirizzo:
   ```
   https://stremio-nuvio-importer.onrender.com/manifest.json
   ```
4. Conferma l'installazione

**Fatto!** L'addon ora è nella tua lista.

---

## 📖 Guida all'uso

### 1️⃣ Ottieni il backup da Stremio

Puoi usare uno di questi due strumenti gratuiti creati dalla community. Entrambi fanno la stessa cosa: generano un file `.json` con la tua libreria.

#### **Opzione A – StremThru Sidekick** (consigliato per la semplicità)
1. Vai su [**StremThru Sidekick**](https://stremthru.elfhosted.com/stremio/sidekick/?addon_operation=manage)
2. Accedi con il tuo account Stremio
3. Nel menu, scegli **Libreria → Backup**
4. Clicca su **"Esporta"** e salva il file sul tuo dispositivo

#### **Opzione B – Stremio Manager (by Bestia)**
1. Vai su [**Stremio Manager**](https://stremio-manager.com/auth)
2. Fai il login (puoi anche usare l'accesso come ospite)
3. Vai su **Libreria → Backup**
4. Clicca su **"Crea backup"** e scarica il file

> **Nota:** Entrambi i tool generano lo stesso tipo di file. Il nostro addon li riconosce entrambi senza problemi.

### 2️⃣ Importa in NUVIO

#### **Metodo consigliato – Dall'interno di NUVIO**
1. Apri NUVIO e vai nella sezione **Addon**
2. Trova l'addon **Stremio Backup Importer** nella lista
3. Clicca su **"Configura"** (si aprirà una pagina web dentro l'app)
4. Nella pagina:
   - Clicca sull'area di caricamento
   - Seleziona il file `.json` che hai scaricato da Stremio
   - Clicca su **"Importa Libreria"**
5. In pochi secondi vedrai un riepilogo degli elementi importati

#### **Metodo alternativo – Dal browser**
Se preferisci usare un browser (o non hai installato l'addon):
1. Apri [**https://stremio-nuvio-importer.onrender.com/configure**](https://stremio-nuvio-importer.onrender.com/configure)
2. **Importante:** Devi aver aperto NUVIO almeno una volta su quel dispositivo, perché la connessione viene riconosciuta automaticamente
3. Carica il file e attendi la conferma

---

## 📊 Cosa viene importato

| Tipo | Descrizione |
|------|-------------|
| 🎬 **Film** | Tutti i film presenti nella tua libreria Stremio |
| 📺 **Serie TV** | Tutte le serie TV |
| ⏱️ **Progressi** | Il punto esatto in cui ti eri fermato *(opzionale, se presenti nel backup)* |
| ✅ **Visti** | I film e le serie che avevi già segnato come visti *(opzionale)* |

---

## ❓ Domande Frequenti (FAQ)

### ❔ L'addon è gratis?
**Sì**, completamente gratuito e sempre lo sarà.

### ❔ I miei dati sono al sicuro?
**Assolutamente sì.** Il file che carichi viene usato solo per l'importazione e viene cancellato immediatamente dopo. Nessuno conserva una copia dei tuoi dati.

### ❔ Posso importare lo stesso file più volte?
**Sì, ma senza preoccupazioni.** L'addon controlla se un film o una serie è già presente nella tua libreria NUVIO e non crea duplicati.

### ❔ Il mio backup di Stremio contiene anche canali YouTube, eventi sportivi o canali TV. Vengono importati?
Per ora l'addon importa solo **film e serie TV**, che sono la stragrande maggioranza della libreria. Gli altri tipi di contenuti potrebbero essere supportati in futuro.

### ❔ Dopo l'importazione, i film si vedono su tutti i miei dispositivi?
**Certo!** NUVIO sincronizza automaticamente la libreria su tutti i dispositivi dove hai effettuato l'accesso (telefono, tablet, TV, web). Una volta importati, i tuoi film sono ovunque.

### ❔ L'addon funziona se non ho ancora aperto NUVIO?
No, devi aver aperto NUVIO almeno una volta su quel dispositivo. È così che l'addon ti riconosce e sa su quale account importare i film.

### ❔ Il servizio è sempre attivo?
L'addon è ospitato su un servizio gratuito. Se non viene usato per un po', può mettersi in "pausa" e riattivarsi in 20-30 secondi al primo accesso. Dopo quel piccolo attimo, tutto funziona normalmente.

---

## 🛠️ Supporto

- **Hai un problema con l'importazione?** Apri una segnalazione su [GitHub]
- **Vuoi contribuire allo sviluppo?** Benvenuto! Il progetto è aperto a tutti

---

<div align="center">
  <p>Made with ❤️ per la community di NUVIO</p>
  <p>
    <a href="https://stremio-nuvio-importer.onrender.com">🌐 Importer</a> •
    <a href="https://stremio-nuvio-importer.onrender.com/manifest.json">📦 Addon</a> •
  </p>
</div>

