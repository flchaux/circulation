/**
 * Point d'entrée : monte l'application dans `#root`, démarre le store (chargement du projet courant
 * ou de la démonstration) et force l'écriture de l'autosauvegarde en attente avant la fermeture de l'onglet.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import { App } from '@/ui/App'
import { useAppStore } from '@/state/store'
import { flushAutosave } from '@/state/persistence'

const container = document.getElementById('root')
if (!container) throw new Error("L'élément #root est absent de index.html.")

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// `bootstrap()` est idempotent ; il est appelé ici, hors React, pour ne pas dépendre du double montage de StrictMode.
void useAppStore.getState().bootstrap()

/**
 * Point d'accès au store depuis la console du navigateur et depuis les tests de bout en bout
 * (`window.__circulation.store.getState()`). Aucun code applicatif ne l'utilise.
 */
declare global {
  interface Window {
    __circulation?: { store: typeof useAppStore; map?: unknown; projection?: unknown }
  }
}
window.__circulation = { ...window.__circulation, store: useAppStore }

// L'autosauvegarde est débattue de 800 ms : la fermeture de l'onglet ne doit pas perdre la dernière modification.
window.addEventListener('beforeunload', () => {
  void flushAutosave()
})
