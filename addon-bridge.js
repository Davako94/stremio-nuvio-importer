/**
 * addon-bridge.js
 * 
 * QUESTO FILE DEVE ESSERE INCLUSO NELL'ADDON LATO NUVIO
 * NON FA PARTE DEL SERVER, MA DELL'ADDON CHE VIENE INSTALLATO IN NUVIO
 * 
 * Percorso nell'addon: /src/bridge/addon-bridge.js
 */

import { mmkvStorage } from '../services/mmkvStorage';
import { DeviceEventEmitter } from 'react-native';

/**
 * Bridge per la comunicazione tra la WebView di configurazione e l'addon
 * @param {Object} webviewRef - Riferimento alla WebView
 * @returns {Object} Metodi per gestire la comunicazione
 */
export function setupAddonBridge(webviewRef) {
  
  /**
   * Gestisce i messaggi ricevuti dalla WebView
   */
  const handleMessage = async (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      switch (message.type) {
        case 'IMPORT_LIBRARY':
          await handleImportLibrary(message.data);
          break;
          
        case 'PING':
          sendToWebview({ type: 'PONG' });
          break;
          
        default:
          console.log('Messaggio sconosciuto:', message.type);
      }
    } catch (error) {
      console.error('Errore nel bridge:', error);
      sendToWebview({
        type: 'ERROR',
        message: error.message
      });
    }
  };

  /**
   * Salva la libreria direttamente in MMKV
   */
  const handleImportLibrary = async (libraryData) => {
    try {
      // Ottieni lo scope corrente (utente)
      const scope = await mmkvStorage.getItem('@user:current') || 'local';
      const libraryKey = `@user:${scope}:stremio-library`;
      
      // Salva i dati convertiti
      await mmkvStorage.setItem(libraryKey, JSON.stringify(libraryData));
      
      // Mantieni compatibilità con vecchie versioni
      await mmkvStorage.setItem('stremio-library', JSON.stringify(libraryData));
      
      // Notifica che la libreria è cambiata
      DeviceEventEmitter.emit('libraryChanged');
      
      // Invia conferma alla webview
      sendToWebview({
        type: 'IMPORT_SUCCESS',
        count: Object.keys(libraryData).length
      });
      
      console.log('✅ Libreria importata con successo in MMKV');
      
    } catch (error) {
      console.error('❌ Errore nel salvare in MMKV:', error);
      sendToWebview({
        type: 'IMPORT_ERROR',
        message: error.message
      });
    }
  };

  /**
   * Invia un messaggio alla WebView
   */
  const sendToWebview = (message) => {
    if (webviewRef.current) {
      webviewRef.current.postMessage(JSON.stringify(message));
    }
  };

  /**
   * Inietta il codice JavaScript nella WebView per abilitare la comunicazione
   */
  const injectedJavaScript = `
    (function() {
      window.nuvioBridge = {
        sendMessage: function(data) {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(data));
          }
        },
        isReady: true
      };
      
      console.log('✅ Bridge NUVIO pronto');
      
      // Avvisa l'addon che la webview è pronta
      setTimeout(() => {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'WEBVIEW_READY' }));
        }
      }, 500);
    })();
  `;

  return {
    handleMessage,
    sendToWebview,
    injectedJavaScript
  };
}

/**
 * Componente WebView configurato con il bridge
 * Esempio di utilizzo nel tuo componente React Native:
 * 
 * import React, { useRef } from 'react';
 * import { WebView } from 'react-native-webview';
 * import { setupAddonBridge } from './bridge/addon-bridge';
 * 
 * const ConfigScreen = () => {
 *   const webviewRef = useRef(null);
 *   const bridge = setupAddonBridge(webviewRef);
 *   
 *   return (
 *     <WebView
 *       ref={webviewRef}
 *       source={{ uri: 'https://stremio-nuvio-importer.onrender.com/configure' }}
 *       onMessage={bridge.handleMessage}
 *       injectedJavaScript={bridge.injectedJavaScript}
 *     />
 *   );
 * };
 */