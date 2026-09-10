/**
 * Store applicatif (§6 de docs/ARCHITECTURE.md) : Zustand + immer avec patches pour l'historique.
 *
 * Trois familles d'écriture :
 *  - `editNetwork(label, fn)` : modification topologique. `fn` est une fonction **pure** sur le réseau
 *    (src/state/edits.ts) ; `sanitizeNetwork` puis `reconcileDemand` sont calculés hors immer, puis recopiés
 *    dans le brouillon entrée par entrée (`syncRecord`) pour que les patches restent minimaux.
 *  - `commit(label, recipe, kind)` : recette immer directe (demande, réglages, plans de feux).
 *  - écritures hors historique : `frame`/`stats` du moteur, glisser en cours, interface.
 * Seules les deux premières empilent une entrée d'historique, journalisent la modification et déclenchent
 * l'autosauvegarde.
 */
import { create } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import { applyPatches, castDraft, enablePatches, produce, produceWithPatches, type Draft, type Patch } from 'immer'
import type {
  ControllerId, Demand, EdgeId, NetEdge, Network, NodeControl, NodeId, Project, SignalController, SignalPhase,
} from '@/model/types'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'
import { ATTRIBUTION, DEFAULT_SETTINGS, DEFAULT_SIGNAL_TIMING, defaultDemand, reconcileDemand } from '@/model/defaults'
import { buildAdjacency } from '@/model/geometry'
import { completeSignalPlans, controllerCycle, createDefaultSignalPlan, nextControllerId } from '@/model/signals'
import { validateProject } from '@/model/schema'
import type { FromWorker, SimClientFactory, SimClientLike } from '@/engine/protocol'
import { shortestPathNodes } from '@/engine/routing'
import { NB_ITINERAIRES, itinerairesLesPlusCourts } from '@/engine/itineraires'
import { SimClient } from '@/engine/client'
import type { OsmExtract } from '@/geo/types'
import { importDossierFeux as lireDossierFeux } from '@/geo/dossierFeux'
import type {
  AppState, AppStoreOptions, CsvImportReport, DossierImportReport, Selection, SimState, UiState,
} from './storeTypes'
import * as edits from './edits'
import * as persistence from './persistence'
import { parseDemandCsv, serializeDemandCsv } from './csv'

enablePatches()

/** Profondeur de l'historique (§6). */
const HISTORY_LIMIT = 100

/** Au-delà, l'import affiche un avertissement de lenteur. */
const LARGE_NETWORK_EDGES = 5000

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
}

const INITIAL_UI: UiState = {
  tab: 'ville',
  colorMode: 'class',
  showVehicles: true,
  showLabels: true,
  showBaseMap: true,
  baseMapOpacity: 1,
  tool: 'select',
  toolNodes: [],
  addEdgeOptions: { twoWay: true, highway: 'residential', lanes: 1, maxspeed: 50 },
  planApercu: {},
  itineraires: null,
  revealCounter: 0,
}

const INITIAL_SIM: SimState = {
  status: 'idle',
  time: 0,
  endTime: 0,
  speed: 10,
  fast: false,
  stepsPerSecond: 0,
  frame: null,
  edgeIndex: [],
  results: null,
  warnings: [],
  stale: true,
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Laisse le navigateur peindre l'indicateur d'activité avant un calcul long. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Recopie `next` dans le brouillon immer en ne touchant que les entrées réellement modifiées : une entrée
 * d'historique ne contient jamais une copie complète du réseau. La comparaison se fait sur `base` (valeurs
 * finalisées) et non sur le brouillon, dont la lecture créerait un proxy par entrée.
 */
function syncRecord<T>(draft: Record<string, T>, base: Record<string, T>, next: Record<string, T>): void {
  for (const key of Object.keys(base)) if (!(key in next)) delete draft[key]
  for (const key of Object.keys(next)) if (base[key] !== next[key]) draft[key] = next[key]
}

/** Le brouillon n'est manipulé qu'en écriture de valeurs déjà finalisées : le voir comme un `Network` suffit. */
function syncNetwork(draft: Draft<Project>, base: Network, next: Network): void {
  const d = draft.network as unknown as Network
  syncRecord(d.nodes, base.nodes, next.nodes)
  syncRecord(d.edges, base.edges, next.edges)
  syncRecord(d.controls, base.controls, next.controls)
  syncRecord(d.controllers, base.controllers, next.controllers)
}

/**
 * Idem pour la demande. Seuls les champs que `reconcileDemand` et l'import CSV peuvent modifier sont alignés ;
 * les autres (trafic interne, trace d'import) sont écrits directement par l'action concernée.
 */
function syncDemand(draft: Draft<Project>, base: Demand, next: Demand): void {
  const d = draft.demand as unknown as Demand
  syncRecord(d.entries, base.entries, next.entries)
  syncRecord(d.exits, base.exits, next.exits)
  syncRecord(d.od, base.od, next.od)
  if (base.destinationMode !== next.destinationMode) d.destinationMode = next.destinationMode
  if (base.seed !== next.seed) d.seed = next.seed
  if (base.globalFactor !== next.globalFactor) d.globalFactor = next.globalFactor
}

/* ------------------------------------------------------------------ */
/*  Transformations pures utilisées par les actions du store           */
/* ------------------------------------------------------------------ */

function sameYieldEdges(a?: EdgeId[], b?: EdgeId[]): boolean {
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0)
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Change la régulation d'un nœud, en créant/défaisant le contrôleur de feux associé. */
function applyNodeControl(network: Network, nodeId: NodeId, control: Omit<NodeControl, 'nodeId'>): Network {
  if (!network.nodes[nodeId]) return network
  const previous = network.controls[nodeId]
  if (previous && previous.type === control.type && sameYieldEdges(previous.yieldEdges, control.yieldEdges)
    && (control.type !== 'signals' || !control.controllerId || previous.controllerId === control.controllerId)) {
    return network
  }
  const controls = { ...network.controls }
  const controllers = { ...network.controllers }

  // Le nœud quitte son contrôleur précédent (supprimé s'il devient vide).
  if (previous?.type === 'signals' && previous.controllerId && controllers[previous.controllerId]) {
    const old = controllers[previous.controllerId]
    const nodeIds = old.nodeIds.filter((n) => n !== nodeId)
    if (nodeIds.length) controllers[old.id] = { ...old, nodeIds }
    else delete controllers[old.id]
  }

  if (control.type === 'signals') {
    let controllerId = control.controllerId
    if (controllerId && controllers[controllerId]) {
      const c = controllers[controllerId]
      if (!c.nodeIds.includes(nodeId)) controllers[controllerId] = { ...c, nodeIds: [...c.nodeIds, nodeId] }
    } else {
      controllerId = nextControllerId(controllers, nodeId)
      const plan = createDefaultSignalPlan(network, [nodeId])
      controllers[controllerId] = { id: controllerId, ...plan }
    }
    controls[nodeId] = { nodeId, type: 'signals', controllerId }
  } else {
    const next: NodeControl = { nodeId, type: control.type }
    if (control.yieldEdges?.length) next.yieldEdges = [...control.yieldEdges]
    controls[nodeId] = next
  }
  return { ...network, controls, controllers }
}

/**
 * Deux contrôleurs ont-ils les mêmes réglages hors phases (test de non-modification) ?
 *
 * Les données de dossier (groupes, inter-verts, plans, calendrier) sont comparées par identité : le
 * contrôleur modifié étant construit par `{ ...current, ...patch }`, un champ absent du correctif garde
 * sa référence. Sans elles, un correctif ne portant que sur un dossier serait pris pour un non-changement
 * et jeté en silence.
 */
function sameControllerHeader(a: SignalController, b: SignalController): boolean {
  return a.name === b.name && a.mode === b.mode && a.offset === b.offset && a.amber === b.amber
    && a.allRed === b.allRed && a.actuated.skipEmpty === b.actuated.skipEmpty
    && a.nodeIds.length === b.nodeIds.length && a.nodeIds.every((n, i) => n === b.nodeIds[i])
    && a.groups === b.groups && a.interGreen === b.interGreen && a.amberByGroup === b.amberByGroup
    && a.plans === b.plans && a.schedule === b.schedule && a.source === b.source
}

/**
 * Applique un correctif de contrôleur ; un changement de `nodeIds` entraîne celui des régulations de nœud.
 *
 * Un nœud n'appartient qu'à un contrôleur : celui qui le reçoit le retire des autres, et un contrôleur
 * qui perdrait tous ses nœuds disparaît. Sans cela deux contrôleurs piloteraient les mêmes mouvements,
 * chacun avec ses phases, et le carrefour aurait deux plans de feux simultanés.
 */
function applyControllerPatch(
  network: Network,
  id: ControllerId,
  patch: Partial<Omit<SignalController, 'id' | 'phases'>>,
): Network {
  const current = network.controllers[id]
  if (!current) return network
  const next: SignalController = { ...current, ...patch, id: current.id, phases: current.phases }
  if (patch.nodeIds) next.nodeIds = [...new Set(patch.nodeIds.filter((n) => network.nodes[n]))]
  let changed = !sameControllerHeader(current, next)

  let controls = network.controls
  if (patch.nodeIds) {
    const kept = new Set(next.nodeIds)
    const updated = { ...network.controls }
    let controlsChanged = false
    for (const nodeId of current.nodeIds) {
      if (!kept.has(nodeId) && updated[nodeId]?.controllerId === id) {
        delete updated[nodeId]
        controlsChanged = true
      }
    }
    for (const nodeId of next.nodeIds) {
      const existing = updated[nodeId]
      if (existing?.type === 'signals' && existing.controllerId === id) continue
      updated[nodeId] = { nodeId, type: 'signals', controllerId: id }
      controlsChanged = true
    }
    if (controlsChanged) {
      controls = updated
      changed = true
    }
  }
  if (!changed) return network

  const controllers = { ...network.controllers, [id]: next }
  if (patch.nodeIds) {
    const repris = new Set(next.nodeIds)
    for (const autre of Object.values(network.controllers)) {
      if (autre.id === id) continue
      const restants = autre.nodeIds.filter((n) => !repris.has(n))
      if (restants.length === autre.nodeIds.length) continue
      // Un contrôleur sans nœud ne pilote plus rien : il disparaît avec le regroupement.
      if (restants.length) controllers[autre.id] = { ...autre, nodeIds: restants }
      else delete controllers[autre.id]
    }
  }
  return { ...network, controllers, controls }
}

/**
 * Réseau tel que le moteur doit le voir : un plan de feux imposé depuis l'interface (`ui.planApercu`)
 * prend la place du calendrier horaire du contrôleur concerné.
 *
 * Le plan retenu passe en tête de `plans` et le calendrier est retiré : `activePlan` (model/signals.ts)
 * renvoie alors ce plan quelle que soit l'heure simulée. Sans plan imposé, le réseau du projet est renvoyé
 * tel quel — un projet sans plans horaires n'est jamais recopié.
 */
function networkWithForcedPlans(network: Network, planApercu: Record<ControllerId, string>): Network {
  let controllers: Record<ControllerId, SignalController> | null = null
  for (const [id, planId] of Object.entries(planApercu)) {
    const controller = network.controllers[id]
    const plans = controller?.plans
    const plan = plans?.find((p) => p.id === planId)
    if (!controller || !plans || !plan) continue
    const { schedule: _calendrier, ...reste } = controller
    controllers ??= { ...network.controllers }
    controllers[id] = { ...reste, plans: [plan, ...plans.filter((p) => p.id !== plan.id)] }
  }
  return controllers ? { ...network, controllers } : network
}

/** Tronçon le plus court reliant directement deux nœuds (onde verte). */
function edgeBetween(edgesFrom: NetEdge[] | undefined, to: NodeId): NetEdge | undefined {
  let best: NetEdge | undefined
  for (const e of edgesFrom ?? []) {
    if (e.to !== to || e.closed) continue
    if (!best || e.length < best.length) best = e
  }
  return best
}

/* ------------------------------------------------------------------ */
/*  Fabrique du store                                                  */
/* ------------------------------------------------------------------ */

export function createAppStore(opts: AppStoreOptions = {}): UseBoundStore<StoreApi<AppState>> {
  const persist = opts.persist ?? true
  const makeClient: SimClientFactory = opts.createClient ?? ((onMessage) => new SimClient(onMessage))

  let past: HistoryEntry[] = []
  let future: HistoryEntry[] = []
  let client: SimClientLike | null = null
  /** Le moteur détient une simulation construite sur le projet courant. */
  let engineReady = false
  let bootstrapPromise: Promise<void> | null = null

  return create<AppState>()((set, get) => {
    /* ---------------- utilitaires internes ---------------- */

    /** Purge des identifiants disparus (sélection, survol, outils). */
    function purge(state: AppState, project: Project): Partial<AppState> {
      const alive = (s: Selection): boolean => {
        if (!s) return false
        if (s.kind === 'node') return !!project.network.nodes[s.id]
        if (s.kind === 'edge') return !!project.network.edges[s.id]
        return !!project.network.controllers[s.id]
      }
      const out: Partial<AppState> = {}
      if (state.selection && !alive(state.selection)) out.selection = null
      if (state.hover && !alive(state.hover)) out.hover = null
      let ui = state.ui
      const toolNodes = state.ui.toolNodes.filter((id) => project.network.nodes[id])
      if (toolNodes.length !== state.ui.toolNodes.length) ui = { ...ui, toolNodes }
      // Un plan imposé sur un contrôleur (ou un plan) disparu — annulation d'un import, suppression du
      // carrefour — n'a plus d'objet : il est retiré comme la sélection.
      const planApercu: Record<ControllerId, string> = {}
      for (const [id, planId] of Object.entries(state.ui.planApercu)) {
        if (project.network.controllers[id]?.plans?.some((p) => p.id === planId)) planApercu[id] = planId
      }
      if (Object.keys(planApercu).length !== Object.keys(state.ui.planApercu).length) ui = { ...ui, planApercu }
      // Itinéraires : un nœud disparu les vide, un réseau modifié les périme. Les laisser affichés après
      // une fermeture de rue ou un changement de vitesse ferait lire des temps qui ne valent plus, sur des
      // tronçons qui ne sont peut-être plus praticables.
      const apercu = state.ui.itineraires
      if (apercu) {
        if (!project.network.nodes[apercu.from] || !project.network.nodes[apercu.to]) {
          ui = { ...ui, itineraires: null }
        } else if (!apercu.perime && state.project?.network !== project.network) {
          ui = { ...ui, itineraires: { ...apercu, perime: true, actif: -1 } }
        }
      }
      if (ui !== state.ui) out.ui = ui
      return out
    }

    function autosave(project: Project): void {
      if (!persist) return
      persistence.scheduleAutosave(project, (message) => set({ error: message }))
    }

    /**
     * Publie un projet issu d'une action annulable : purge des sélections, drapeaux d'historique,
     * mise à jour à chaud des feux si possible (sinon `sim.stale`), autosauvegarde.
     */
    function publish(next: Project, kind: 'signals' | 'plain'): void {
      // Mise à jour « à chaud » : seulement pendant une exécution en cours. Simulation à l'arrêt ou terminée,
      // un changement de feux doit rendre l'état périmé, sinon le prochain lancement rejouerait les résultats
      // précédents sans tenir compte du nouveau plan (comparaison référence/variante faussée).
      const running = get().sim.status === 'running' || get().sim.status === 'paused'
      const hot = kind === 'signals' && client !== null && engineReady && running && !get().sim.stale
      if (hot && client) {
        const vue = networkWithForcedPlans(next.network, get().ui.planApercu)
        client.send({ type: 'updateSignals', controllers: vue.controllers, controls: vue.controls })
      }
      set((s) => ({
        project: next,
        ...purge(s, next),
        canUndo: past.length > 0,
        canRedo: future.length > 0,
        dirty: true,
        sim: hot ? s.sim : { ...s.sim, stale: true },
      }))
      autosave(next)
    }

    function pushHistory(entry: HistoryEntry): void {
      past.push(entry)
      if (past.length > HISTORY_LIMIT) past.shift()
      future = []
    }

    /** Recette immer directe (demande, réglages, plans de feux). Renvoie faux si rien n'a changé. */
    function commit(
      label: string,
      recipe: (draft: Draft<Project>) => void,
      kind: 'signals' | 'plain' = 'plain',
    ): boolean {
      const base = get().project
      if (!base) return false
      const [afterRecipe, patches, inverse] = produceWithPatches(base, recipe)
      if (!patches.length) return false
      const at = nowIso()
      const [next, patches2, inverse2] = produceWithPatches(afterRecipe, (draft) => {
        draft.changes.push({ at, label })
        draft.meta.updatedAt = at
      })
      pushHistory({ label, patches: [...patches, ...patches2], inverse: [...inverse2, ...inverse] })
      publish(next, kind)
      return true
    }

    /**
     * Modification topologique : `fn` est pure (src/state/edits.ts), son résultat est assaini puis la demande
     * resynchronisée — le tout hors immer. Renvoie faux si rien n'a changé (aucune entrée d'historique).
     */
    function editNetwork(label: string, fn: (network: Network) => Network, kind: 'signals' | 'plain' = 'plain'): boolean {
      const base = get().project
      if (!base) return false
      const assaini = edits.sanitizeNetwork(fn(base.network))
      if (assaini === base.network) return false
      // Une modification de topologie peut ajouter des mouvements à un carrefour à feux (fusion de nœuds,
      // nouveau tronçon, inversion de sens). Sans cette complétion ils resteraient au rouge en permanence
      // et bloqueraient leur approche, sans autre signal que l'anomalie affichée dans le panneau Feux.
      const { network, added } = completeSignalPlans(assaini)
      const demand = reconcileDemand(network, base.demand)
      const libelle = added > 0
        ? `${label} (plan de feux complété : ${added} mouvement${added > 1 ? 's' : ''})`
        : label
      return commit(libelle, (draft) => {
        syncNetwork(draft, base.network, network)
        syncDemand(draft, base.demand, demand)
      }, kind)
    }

    /** Écriture hors historique (nom du projet, référence, résultats finaux). */
    function writeProject(recipe: (draft: Draft<Project>) => void): void {
      const base = get().project
      if (!base) return
      const next = produce(base, recipe)
      if (next === base) return
      set((s) => ({ project: next, ...purge(s, next), dirty: true }))
      autosave(next)
    }

    /* ---------------- moteur ---------------- */

    function handleEngineMessage(msg: FromWorker): void {
      switch (msg.type) {
        case 'ready':
          set((s) => ({
            sim: {
              ...s.sim,
              edgeIndex: msg.edgeIndex,
              endTime: msg.endTime,
              warnings: msg.warnings,
              results: null,
              stale: false,
            },
          }))
          break
        case 'frame':
          // Hors immer : aucune entrée d'historique, aucune autosauvegarde.
          set((s) => ({ sim: { ...s.sim, frame: msg.frame, time: msg.frame.time } }))
          break
        case 'status':
          set((s) => ({
            sim: {
              ...s.sim,
              status: msg.status,
              time: msg.time,
              endTime: msg.endTime,
              stepsPerSecond: msg.stepsPerSecond,
              fast: msg.status === 'running' ? s.sim.fast : false,
            },
          }))
          break
        case 'stats':
          set((s) => ({ sim: { ...s.sim, results: msg.results } }))
          break
        case 'done':
          set((s) => ({ sim: { ...s.sim, results: msg.results, status: 'done', fast: false } }))
          // Seul `done` fige les résultats dans le projet (et déclenche l'autosauvegarde).
          writeProject((draft) => {
            draft.lastResults = castDraft(msg.results)
          })
          break
        case 'error':
          set((s) => ({ error: msg.message, sim: { ...s.sim, status: 'idle', fast: false } }))
          break
      }
    }

    /** Client moteur, créé au premier démarrage ; (ré)initialise la simulation si le projet a changé. */
    function ensureEngine(): SimClientLike | null {
      const project = get().project
      if (!project) return null
      if (!client) client = makeClient(handleEngineMessage)
      // Une simulation terminée doit repartir de zéro au prochain lancement.
      if (!engineReady || get().sim.stale || get().sim.status === 'done') {
        // Le moteur reçoit le réseau vu par l'interface : plans de feux imposés compris (§14.4).
        const network = networkWithForcedPlans(project.network, get().ui.planApercu)
        client.send({
          type: 'init',
          payload: { network, demand: project.demand, settings: project.settings },
        })
        engineReady = true
        set((s) => ({ sim: { ...s.sim, stale: false, time: 0, results: null, frame: null } }))
      }
      return client
    }

    /** Chargement de commune en cours, interruptible par `cancelLoad`. */
    let loadController: AbortController | null = null

    /* ---------------- état initial + actions ---------------- */

    return {
      project: null,
      selection: null,
      hover: null,
      drag: null,
      ui: INITIAL_UI,
      sim: INITIAL_SIM,
      canUndo: false,
      canRedo: false,
      busy: { active: false, message: '', cancellable: false },
      error: null,
      library: [],
      dirty: false,
      dossierRapport: null,

      /* --------- Projet --------- */

      bootstrap(): Promise<void> {
        if (bootstrapPromise) return bootstrapPromise
        bootstrapPromise = (async () => {
          await get().refreshLibrary()
          if (persist) {
            const saved = await persistence.loadCurrentProject()
            if (saved) {
              get().loadProject(saved)
              return
            }
          }
          await get().loadDemo('veauche')
        })()
        return bootstrapPromise
      },

      async loadCommune(commune, options): Promise<void> {
        // Un chargement de commune peut durer plusieurs dizaines de secondes (Overpass) : il doit rester interruptible.
        loadController?.abort()
        const controller = new AbortController()
        loadController = controller
        const signal = controller.signal
        set({ busy: { active: true, message: `Chargement de ${commune.nom}…`, cancellable: true }, error: null })
        try {
          const { fetchCommune } = await import('@/geo/communes')
          const detail = await fetchCommune(commune.code, signal)
          let extract = options?.refresh ? undefined : await persistence.getCachedExtract(commune.code)
          if (!extract) {
            set({ busy: { active: true, message: 'Téléchargement des données OpenStreetMap…', cancellable: true } })
            const { fetchOsmExtract } = await import('@/geo/overpass')
            extract = await fetchOsmExtract(detail, {
              signal,
              onProgress: (message) => set({ busy: { active: true, message, cancellable: true } }),
            })
            try {
              await persistence.putCachedExtract(extract)
            } catch {
              // Le cache est facultatif : une base indisponible ne doit pas empêcher le chargement.
            }
          }
          await get().loadExtract(extract)
        } catch (e) {
          // Une annulation demandée par l'utilisateur n'est pas une erreur à afficher en rouge.
          if (signal.aborted) set({ error: null })
          else set({ error: `Chargement de ${commune.nom} impossible : ${errorMessage(e)}` })
        } finally {
          if (loadController === controller) loadController = null
          set({ busy: { active: false, message: '', cancellable: false } })
        }
      },

      cancelLoad(): void {
        loadController?.abort()
        loadController = null
        set({ busy: { active: false, message: '', cancellable: false } })
      },

      async loadExtract(extract: OsmExtract): Promise<void> {
        set({ busy: { active: true, message: 'Construction du réseau…', cancellable: false }, error: null })
        try {
          await yieldToBrowser()
          const { osm2graph } = await import('@/geo/osm2graph')
          const { network, warnings, stats } = osm2graph(extract)
          const edgeCount = Object.keys(network.edges).length
          const allWarnings = edgeCount > LARGE_NETWORK_EDGES
            ? [`Réseau de ${edgeCount} tronçons (> ${LARGE_NETWORK_EDGES}) : la simulation peut être lente`, ...warnings]
            : warnings
          const at = nowIso()
          const commune = extract.commune
          const project: Project = {
            format: PROJECT_FORMAT,
            version: PROJECT_VERSION,
            meta: {
              id: persistence.newProjectId(),
              name: commune.nom,
              createdAt: at,
              updatedAt: at,
              commune: {
                nom: commune.nom,
                code: commune.code,
                codesPostaux: [...commune.codesPostaux],
                ...(commune.population !== undefined ? { population: commune.population } : {}),
              },
              center: { lon: commune.centre.coordinates[0], lat: commune.centre.coordinates[1] },
              contour: commune.contour,
              extractedAt: extract.extractedAt,
              attribution: extract.attribution || ATTRIBUTION,
              import: { stats, warnings: allWarnings },
            },
            network,
            demand: defaultDemand(network),
            settings: { ...DEFAULT_SETTINGS },
            changes: [],
          }
          get().loadProject(project)
        } catch (e) {
          set({ error: `Construction du réseau impossible : ${errorMessage(e)}` })
        } finally {
          set({ busy: { active: false, message: '', cancellable: false } })
        }
      },

      async loadDemo(slug: string): Promise<void> {
        set({ busy: { active: true, message: 'Chargement de la démonstration…', cancellable: false }, error: null })
        try {
          const response = await fetch(`./demo/${slug}.osm.json`)
          if (!response.ok) throw new Error(`fichier introuvable (${response.status})`)
          const extract = (await response.json()) as OsmExtract
          await get().loadExtract(extract)
        } catch (e) {
          set({ error: `Démonstration « ${slug} » indisponible : ${errorMessage(e)}` })
        } finally {
          set({ busy: { active: false, message: '', cancellable: false } })
        }
      },

      loadProject(project: Project): void {
        const assaini = edits.sanitizeNetwork(project.network)
        // Un projet enregistré avant la complétion automatique peut contenir des mouvements laissés au rouge
        // par une ancienne fusion de nœuds. On les rattache à l'ouverture et on le consigne dans le journal :
        // un mouvement jamais vert bloque son approche et n'est jamais un réglage voulu.
        const { network, added } = completeSignalPlans(assaini)
        const demand = reconcileDemand(network, project.demand)
        const changes = added > 0
          ? [...project.changes, {
              at: nowIso(),
              label: `Plan de feux complété à l’ouverture : ${added} mouvement${added > 1 ? 's' : ''} rattaché${added > 1 ? 's' : ''} à une phase`,
            }]
          : project.changes
        const next: Project = { ...project, network, demand, changes }
        past = []
        future = []
        engineReady = false
        client?.send({ type: 'pause' })
        set((s) => ({
          project: next,
          selection: null,
          hover: null,
          drag: null,
          // Les plans imposés désignaient les carrefours du projet précédent : ils n'ont plus de sens ici.
          ui: { ...s.ui, toolNodes: [], planApercu: {}, itineraires: null },
          sim: { ...INITIAL_SIM, speed: s.sim.speed },
          canUndo: false,
          canRedo: false,
          dirty: false,
          error: null,
          // Idem pour un import de dossiers : ses carrefours candidats appartenaient à l'autre réseau.
          dossierRapport: null,
        }))
        autosave(next)
      },

      setProjectName(name: string): void {
        writeProject((draft) => {
          draft.meta.name = name
        })
      },

      exportProjectJson(): string {
        const project = get().project
        return project ? JSON.stringify(project) : ''
      },

      importProjectJson(text: string): void {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          set({ error: "Fichier illisible : ce n'est pas un document JSON valide." })
          return
        }
        const result = validateProject(parsed)
        if (!result.ok) {
          set({ error: `Import impossible :\n${result.errors.join('\n')}` })
          return
        }
        get().loadProject(result.project)
      },

      async saveToLibrary(): Promise<void> {
        const project = get().project
        if (!project) return
        try {
          const library = await persistence.saveLibraryProject(project)
          set({ library, dirty: false })
        } catch (e) {
          set({ error: `Enregistrement impossible : ${errorMessage(e)}` })
        }
      },

      async refreshLibrary(): Promise<void> {
        set({ library: await persistence.listLibrary() })
      },

      async loadFromLibrary(id: string): Promise<void> {
        const project = await persistence.loadLibraryProject(id)
        if (!project) {
          set({ error: 'Projet introuvable ou illisible dans la bibliothèque.' })
          return
        }
        get().loadProject(project)
      },

      async deleteFromLibrary(id: string): Promise<void> {
        try {
          set({ library: await persistence.deleteLibraryProject(id) })
        } catch (e) {
          set({ error: `Suppression impossible : ${errorMessage(e)}` })
        }
      },

      /* --------- Édition du réseau --------- */

      beginNodeDrag(id: NodeId): void {
        const node = get().project?.network.nodes[id]
        if (!node) return
        set({ drag: { nodeId: id, x: node.x, y: node.y, dropOn: null } })
      },

      dragNode(id: NodeId, x: number, y: number, dropOn?: NodeId | null): void {
        const drag = get().drag
        if (!drag || drag.nodeId !== id) return
        set({ drag: { nodeId: id, x, y, dropOn: dropOn ?? null } })
      },

      endNodeDrag(id: NodeId, dropOn?: NodeId): void {
        const drag = get().drag
        set({ drag: null })
        const project = get().project
        if (!drag || drag.nodeId !== id || !project) return
        const target = dropOn ?? drag.dropOn
        if (target && target !== id && project.network.nodes[target]) {
          editNetwork('Fusion de deux nœuds', (network) => edits.mergeNodes(network, id, target))
          return
        }
        editNetwork("Déplacement d'un nœud", (network) => edits.moveNode(network, id, drag.x, drag.y))
      },

      cancelNodeDrag(): void {
        set({ drag: null })
      },

      addNode(x, y, label): void {
        const base = get().project
        if (!base) return
        // L'identifiant est lu avant l'écriture : `editNetwork` ne renvoie que le succès, et la
        // sélection du nœud posé est ce qui le rend modifiable sans avoir à le retrouver au clic.
        const id = edits.nextNodeId(base.network)
        if (!editNetwork("Pose d'un nœud", (network) => edits.addNode(network, x, y, label))) return
        get().select({ kind: 'node', id })
      },

      updateNode(id, patch): void {
        editNetwork('Modification du nœud', (network) => {
          const node = network.nodes[id]
          if (!node) return network
          const next = { ...node, ...patch }
          if (next.label === node.label && !!next.miniRoundabout === !!node.miniRoundabout) return network
          if (!next.miniRoundabout) delete next.miniRoundabout
          if (!next.label) delete next.label
          return { ...network, nodes: { ...network.nodes, [id]: next } }
        })
      },

      mergeNodes(sourceId: NodeId, targetId: NodeId): void {
        editNetwork('Fusion de deux nœuds', (network) => edits.mergeNodes(network, sourceId, targetId))
      },

      deleteNode(id: NodeId): void {
        editNetwork("Suppression d'un nœud", (network) => edits.deleteNode(network, id))
      },

      deleteEdge(id: EdgeId): void {
        editNetwork("Suppression d'un tronçon", (network) => edits.deleteEdge(network, id))
      },

      addEdge(from, to, options): void {
        editNetwork("Ajout d'un tronçon", (network) => edits.addEdge(network, from, to, options))
      },

      updateEdge(id, patch, applyToReverse): void {
        editNetwork("Modification d'un tronçon", (network) => {
          const edge = network.edges[id]
          if (!edge) return network
          const targets = [edge]
          if (applyToReverse && edge.reverseOf && network.edges[edge.reverseOf]) targets.push(network.edges[edge.reverseOf])
          const nextEdges: Record<EdgeId, NetEdge> = {}
          for (const target of targets) {
            const next: NetEdge = { ...target, ...patch }
            // Une valeur saisie n'est plus une estimation.
            if (patch.lanes !== undefined || patch.maxspeed !== undefined) {
              next.estimated = {
                lanes: patch.lanes !== undefined ? false : target.estimated.lanes,
                maxspeed: patch.maxspeed !== undefined ? false : target.estimated.maxspeed,
              }
            }
            if (next.name === undefined) delete next.name
            const unchanged = next.name === target.name && next.highway === target.highway
              && next.lanes === target.lanes && next.maxspeed === target.maxspeed && next.closed === target.closed
              && next.estimated.lanes === target.estimated.lanes && next.estimated.maxspeed === target.estimated.maxspeed
            if (!unchanged) nextEdges[target.id] = next
          }
          if (!Object.keys(nextEdges).length) return network
          return { ...network, edges: { ...network.edges, ...nextEdges } }
        })
      },

      setEdgeDirection(id, mode): void {
        const labels = { oneway: 'Passage en sens unique', reverse: 'Inversion du sens', twoway: 'Passage à double sens' }
        editNetwork(labels[mode], (network) => edits.setEdgeDirection(network, id, mode))
      },

      setBannedTurn(from, to, banned): void {
        editNetwork(banned ? 'Interdiction de tourner' : 'Mouvement rétabli',
          (network) => edits.setBannedTurn(network, from, to, banned))
      },

      setNodeControl(nodeId, control): void {
        editNetwork('Changement de régulation', (network) => applyNodeControl(network, nodeId, control), 'signals')
      },

      updateController(id, patch): void {
        editNetwork('Modification des feux', (network) => applyControllerPatch(network, id, patch), 'signals')
      },

      setControllerNodes(id, nodeIds): void {
        editNetwork('Regroupement de feux', (network) => applyControllerPatch(network, id, { nodeIds }), 'signals')
      },

      updatePhase(controllerId, phaseId, patch): void {
        commit("Modification d'une phase", (draft) => {
          const phase = draft.network.controllers[controllerId]?.phases.find((p) => p.id === phaseId)
          if (!phase) return
          Object.assign(phase, patch)
        }, 'signals')
      },

      setPhaseMovement(controllerId, phaseId, key, kind): void {
        commit('Mouvement de phase', (draft) => {
          const phase = draft.network.controllers[controllerId]?.phases.find((p) => p.id === phaseId)
          if (!phase) return
          if (kind === null) delete phase.movements[key]
          else phase.movements[key] = kind
        }, 'signals')
      },

      addPhase(controllerId): void {
        commit("Ajout d'une phase", (draft) => {
          const controller = draft.network.controllers[controllerId]
          if (!controller) return
          let max = 0
          for (const p of controller.phases) {
            const m = /^p(\d+)$/.exec(p.id)
            if (m) max = Math.max(max, Number(m[1]))
          }
          const phase: SignalPhase = {
            id: `p${max + 1}`,
            name: `Phase ${controller.phases.length + 1}`,
            green: DEFAULT_SIGNAL_TIMING.minGreen * 2,
            movements: {},
            minGreen: DEFAULT_SIGNAL_TIMING.minGreen,
            maxGreen: DEFAULT_SIGNAL_TIMING.maxGreen,
            gap: DEFAULT_SIGNAL_TIMING.gap,
          }
          controller.phases.push(phase)
        }, 'signals')
      },

      removePhase(controllerId, phaseId): void {
        commit("Suppression d'une phase", (draft) => {
          const controller = draft.network.controllers[controllerId]
          if (!controller) return
          const index = controller.phases.findIndex((p) => p.id === phaseId)
          if (index >= 0) controller.phases.splice(index, 1)
        }, 'signals')
      },

      movePhase(controllerId, phaseId, direction): void {
        commit('Ordre des phases', (draft) => {
          const controller = draft.network.controllers[controllerId]
          if (!controller) return
          const index = controller.phases.findIndex((p) => p.id === phaseId)
          const target = index + direction
          if (index < 0 || target < 0 || target >= controller.phases.length) return
          const [phase] = controller.phases.splice(index, 1)
          controller.phases.splice(target, 0, phase)
        }, 'signals')
      },

      resetControllerPlan(controllerId): void {
        const project = get().project
        const controller = project?.network.controllers[controllerId]
        if (!project || !controller) return
        const plan = createDefaultSignalPlan(project.network, controller.nodeIds)
        // Détacher le dossier fait partie du retour au plan par défaut : les groupes, les inter-verts, les
        // plans horaires et le calendrier décrivaient les phases qui disparaissent. Les laisser en place
        // donnerait des plans renvoyant à des phases inexistantes et des groupes ne commandant plus rien,
        // sous une origine annonçant toujours le dossier.
        const label = controller.source
          ? `Plan de feux régénéré (${controller.source} détaché)`
          : 'Plan de feux régénéré'
        commit(label, (draft) => {
          const target = draft.network.controllers[controllerId]
          if (!target) return
          target.phases = castDraft(plan.phases)
          target.amber = plan.amber
          target.allRed = plan.allRed
          delete target.groups
          delete target.interGreen
          delete target.amberByGroup
          delete target.plans
          delete target.schedule
          delete target.source
        }, 'signals')
      },

      applyGreenWave(fromNode, toNode): { controllers: number; path: NodeId[] } {
        const project = get().project
        if (!project) return { controllers: 0, path: [] }
        const path = shortestPathNodes(project.network, fromNode, toNode)
        if (path.length < 2) {
          set({ error: 'Aucun itinéraire entre ces deux nœuds : onde verte impossible.' })
          return { controllers: 0, path: [] }
        }
        // Temps de parcours libres cumulés le long du chemin.
        const adjacency = buildAdjacency(project.network)
        const times: number[] = [0]
        for (let i = 1; i < path.length; i++) {
          const edge = edgeBetween(adjacency.outgoing.get(path[i - 1]), path[i])
          const seconds = edge ? (edge.length / Math.max(1, edge.maxspeed)) * 3.6 : 0
          times.push(times[i - 1] + seconds)
        }
        // Contrôleurs rencontrés dans l'ordre du trajet.
        const stops: { id: ControllerId; time: number }[] = []
        const seen = new Set<ControllerId>()
        for (let i = 0; i < path.length; i++) {
          const control = project.network.controls[path[i]]
          if (control?.type !== 'signals' || !control.controllerId) continue
          if (seen.has(control.controllerId)) continue
          seen.add(control.controllerId)
          stops.push({ id: control.controllerId, time: times[i] })
        }
        if (stops.length < 2) {
          set({ error: 'Moins de deux carrefours à feux sur ce trajet : aucune onde verte à calculer.' })
          return { controllers: stops.length, path }
        }
        const offsets = new Map<ControllerId, number>()
        let previous = project.network.controllers[stops[0].id].offset
        for (let k = 1; k < stops.length; k++) {
          const controller = project.network.controllers[stops[k].id]
          const cycle = controllerCycle(controller)
          const raw = previous + (stops[k].time - stops[k - 1].time)
          const offset = cycle > 0 ? ((raw % cycle) + cycle) % cycle : 0
          const rounded = Math.round(offset * 10) / 10
          offsets.set(controller.id, rounded)
          previous = rounded
        }
        commit('Onde verte', (draft) => {
          for (const [id, offset] of offsets) {
            const controller = draft.network.controllers[id]
            if (controller) controller.offset = offset
          }
        }, 'signals')
        return { controllers: stops.length, path }
      },

      /* ---------------- Itinéraires ---------------- */

      calculerItineraires(fromNode: NodeId, toNode: NodeId): void {
        const project = get().project
        if (!project?.network.nodes[fromNode] || !project.network.nodes[toNode]) return
        const chemins = itinerairesLesPlusCourts(project.network, fromNode, toNode, {
          count: NB_ITINERAIRES,
          settings: project.settings,
        })
        set((s) => ({
          ui: { ...s.ui, itineraires: { from: fromNode, to: toNode, chemins, perime: false, actif: -1 } },
          error: chemins.length
            ? s.error
            : 'Aucun itinéraire ne relie ces deux nœuds : sens uniques, interdictions de tourner ou tronçons fermés les séparent.',
        }))
      },

      recalculerItineraires(): void {
        const apercu = get().ui.itineraires
        if (apercu) get().calculerItineraires(apercu.from, apercu.to)
      },

      effacerItineraires(): void {
        set((s) => (s.ui.itineraires ? { ui: { ...s.ui, itineraires: null } } : {}))
      },

      setItineraireActif(rang: number): void {
        set((s) => {
          const apercu = s.ui.itineraires
          if (!apercu) return {}
          const actif = rang >= 0 && rang < apercu.chemins.length ? rang : -1
          if (actif === apercu.actif) return {}
          return { ui: { ...s.ui, itineraires: { ...apercu, actif } } }
        })
      },

      importDossierFeux(controllerId: ControllerId, contenu: string): DossierImportReport {
        const project = get().project
        const bilanVide = (avertissements: string[]): DossierImportReport => (
          { controllerId, applique: false, dossierId: '', groupes: 0, avertissements }
        )
        if (!project) return bilanVide(['Aucun projet chargé.'])
        // L'exploitant a désigné le carrefour : l'importeur n'a plus à le reconnaître, seulement à
        // rattacher les groupes du dossier aux mouvements de ce carrefour-là. Il ne lève jamais : un
        // fichier illisible ressort en avertissements (§14).
        const resultat = lireDossierFeux(contenu, { network: project.network, controllerId })
        const avertissements = [...resultat.avertissements]
        if (resultat.groupesNonRattaches.length) {
          const groupes = resultat.groupesNonRattaches.join(', ')
          avertissements.push(`Groupe(s) ${groupes} : aucun mouvement de ce carrefour ne leur correspond ; ils ne commandent rien. Vérifiez que le dossier est bien celui de ce carrefour.`)
        }
        const controller = resultat.controller
        if (!controller) {
          const bilan = bilanVide(avertissements)
          set({ dossierRapport: { ...bilan, dossierId: resultat.dossierId } })
          return get().dossierRapport as DossierImportReport
        }
        // Le dossier remplace le plan du contrôleur en place : même identifiant, mêmes nœuds, donc aucune
        // régulation à changer. Les autres carrefours ne sont pas touchés.
        const applique = editNetwork(
          `Dossier ${resultat.dossierId} appliqué à ${controller.name}`,
          (network) => ({ ...network, controllers: { ...network.controllers, [controller.id]: controller } }),
          'signals',
        )
        if (!applique) {
          avertissements.push('Le dossier décrit exactement le plan déjà en place : rien n’a changé.')
        }
        const bilan: DossierImportReport = {
          controllerId,
          applique: true,
          dossierId: resultat.dossierId,
          groupes: resultat.groupesRattaches,
          avertissements,
        }
        set({ dossierRapport: bilan })
        return bilan
      },

      setActivePlan(controllerId, planId): void {
        const state = get()
        const controller = state.project?.network.controllers[controllerId]
        if (!controller) return
        const retenu = planId && controller.plans?.some((p) => p.id === planId) ? planId : null
        if ((state.ui.planApercu[controllerId] ?? null) === retenu) return
        const planApercu = { ...state.ui.planApercu }
        if (retenu) planApercu[controllerId] = retenu
        else delete planApercu[controllerId]
        set((s) => ({ ui: { ...s.ui, planApercu } }))
        // Même règle que pour une modification de feux : appliqué à chaud pendant une exécution, sinon
        // l'état devient périmé et le prochain lancement repart avec le plan choisi.
        const project = get().project
        const running = state.sim.status === 'running' || state.sim.status === 'paused'
        if (project && client && engineReady && running && !state.sim.stale) {
          const vue = networkWithForcedPlans(project.network, planApercu)
          client.send({ type: 'updateSignals', controllers: vue.controllers, controls: vue.controls })
        } else {
          set((s) => ({ sim: { ...s.sim, stale: true } }))
        }
      },

      /* --------- Demande --------- */

      updateEntry(nodeId, patch): void {
        commit("Modification d'une entrée", (draft) => {
          const entry = draft.demand.entries[nodeId]
          if (!entry) return
          Object.assign(entry, patch)
          if (patch.flow !== undefined) entry.estimated = patch.estimated ?? false
        })
      },

      updateExit(nodeId, patch): void {
        commit("Modification d'une sortie", (draft) => {
          const exit = draft.demand.exits[nodeId]
          if (!exit) return
          Object.assign(exit, patch)
        })
      },

      setGlobalFactor(factor): void {
        commit('Intensité globale du trafic', (draft) => {
          draft.demand.globalFactor = Math.max(0, factor)
        })
      },

      setSeed(seed): void {
        commit('Graine aléatoire', (draft) => {
          draft.demand.seed = Math.round(seed)
        })
      },

      setDestinationMode(mode): void {
        commit('Mode de destination', (draft) => {
          draft.demand.destinationMode = mode
        })
      },

      setOdShare(entryId, exitId, share): void {
        commit('Matrice origine-destination', (draft) => {
          const od = draft.demand.od
          if (share > 0) {
            if (!od[entryId]) od[entryId] = {}
            od[entryId][exitId] = share
          } else if (od[entryId]) {
            delete od[entryId][exitId]
            if (!Object.keys(od[entryId]).length) delete od[entryId]
          }
        })
      },

      clearOd(): void {
        commit('Matrice origine-destination effacée', (draft) => {
          draft.demand.od = {}
        })
      },

      updateInternal(patch): void {
        commit('Trafic interne', (draft) => {
          Object.assign(draft.demand.internal, patch)
        })
      },

      importDemandCsv(text: string, fileName: string): CsvImportReport {
        const project = get().project
        if (!project) return { entries: 0, exits: 0, odCells: 0, unknown: [] }
        const { demand, report } = parseDemandCsv(text, project.demand, project.network)
        const rows = report.entries + report.exits + report.odCells
        const at = nowIso()
        commit('Import CSV de la demande', (draft) => {
          syncDemand(draft, project.demand, demand)
          draft.demand.csvImport = { fileName, importedAt: at, rows }
        })
        return report
      },

      exportDemandCsv(): string {
        const project = get().project
        return project ? serializeDemandCsv(project.demand, project.network) : ''
      },

      /* --------- Réglages --------- */

      updateSettings(patch): void {
        commit('Réglages de simulation', (draft) => {
          Object.assign(draft.settings, patch)
        })
      },

      /* --------- Référence --------- */

      freezeReference(label?: string): void {
        const state = get()
        const project = state.project
        if (!project) return
        const results = state.sim.results ?? project.lastResults
        const frozenAt = nowIso()
        writeProject((draft) => {
          draft.reference = castDraft({
            frozenAt,
            label: label ?? `Référence du ${new Date(frozenAt).toLocaleString('fr-FR')}`,
            network: project.network,
            demand: project.demand,
            settings: project.settings,
            ...(results ? { results } : {}),
          })
        })
      },

      clearReference(): void {
        writeProject((draft) => {
          delete draft.reference
        })
      },

      /* --------- Simulation --------- */

      simStart(): void {
        const engine = ensureEngine()
        engine?.send({ type: 'run', speed: get().sim.speed })
        set((s) => ({ sim: { ...s.sim, fast: false } }))
      },

      simPause(): void {
        client?.send({ type: 'pause' })
      },

      simReset(): void {
        if (client && engineReady) client.send({ type: 'reset' })
        set((s) => ({ sim: { ...s.sim, time: 0, results: null, frame: null, fast: false, status: 'idle' } }))
      },

      simStep(steps: number): void {
        const engine = ensureEngine()
        engine?.send({ type: 'step', steps })
      },

      simSetSpeed(speed: number): void {
        const clamped = Math.max(1, Math.min(120, speed))
        set((s) => ({ sim: { ...s.sim, speed: clamped } }))
        client?.send({ type: 'setSpeed', speed: clamped })
      },

      simRunFast(): void {
        const engine = ensureEngine()
        engine?.send({ type: 'runFast' })
        set((s) => ({ sim: { ...s.sim, fast: true } }))
      },

      /* --------- Historique et interface --------- */

      undo(): void {
        const base = get().project
        const entry = past.pop()
        if (!base || !entry) return
        future.push(entry)
        const next = applyPatches(base, entry.inverse)
        set((s) => ({
          project: next,
          ...purge(s, next),
          canUndo: past.length > 0,
          canRedo: true,
          dirty: true,
          sim: { ...s.sim, stale: true },
        }))
        autosave(next)
      },

      redo(): void {
        const base = get().project
        const entry = future.pop()
        if (!base || !entry) return
        past.push(entry)
        const next = applyPatches(base, entry.patches)
        set((s) => ({
          project: next,
          ...purge(s, next),
          canUndo: true,
          canRedo: future.length > 0,
          dirty: true,
          sim: { ...s.sim, stale: true },
        }))
        autosave(next)
      },

      select(selection: Selection, options): void {
        set((s) => ({
          selection,
          ui: options?.reveal ? { ...s.ui, revealCounter: s.ui.revealCounter + 1 } : s.ui,
        }))
      },

      setHover(selection: Selection): void {
        set({ hover: selection })
      },

      setTab(tab): void {
        set((s) => ({ ui: { ...s.ui, tab } }))
      },

      setColorMode(mode): void {
        set((s) => ({ ui: { ...s.ui, colorMode: mode } }))
      },

      setUi(patch): void {
        set((s) => ({ ui: { ...s.ui, ...patch } }))
      },

      setTool(tool): void {
        set((s) => ({ ui: { ...s.ui, tool, toolNodes: [] } }))
      },

      toolClickNode(nodeId: NodeId): void {
        const state = get()
        if (!state.project?.network.nodes[nodeId]) return
        if (state.ui.tool === 'select') {
          state.select({ kind: 'node', id: nodeId })
          return
        }
        const toolNodes = state.ui.toolNodes.includes(nodeId) ? state.ui.toolNodes : [...state.ui.toolNodes, nodeId]
        if (toolNodes.length < 2) {
          set((s) => ({ ui: { ...s.ui, toolNodes } }))
          return
        }
        const [from, to] = toolNodes
        set((s) => ({ ui: { ...s.ui, toolNodes: [] } }))
        if (state.ui.tool === 'greenwave') state.applyGreenWave(from, to)
        else if (state.ui.tool === 'itineraires') state.calculerItineraires(from, to)
        else state.addEdge(from, to, state.ui.addEdgeOptions)
      },

      clearError(): void {
        set({ error: null })
      },

      setError(message: string): void {
        set({ error: message })
      },
    }
  })
}

/** Instance utilisée par l'application (le Worker n'est créé qu'au premier démarrage de simulation). */
export const useAppStore = createAppStore()
