import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, defaultDemand } from '@/model/defaults'
import type { NetEdge, NetNode, Network, Project } from '@/model/types'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'
import type { CommuneDetail, OsmExtract } from '@/geo/types'
import type { FromWorker, SimClientFactory, ToWorker } from '@/engine/protocol'
import {
  deleteLibraryProject, flushAutosave, getCachedExtract, listLibrary, loadCurrentProject, loadLibraryProject,
  projectFileName, putCachedExtract, saveCurrentProject, saveLibraryProject, scheduleAutosave,
} from './persistence'
import { createAppStore } from './store'

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function edge(id: string, from: NetNode, to: NetNode): NetEdge {
  return {
    id,
    from: from.id,
    to: to.id,
    highway: 'residential',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(to.x - from.x, to.y - from.y),
    geometry: [[from.x, from.y], [to.x, to.y]],
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
  }
}

/** Rue à double sens entre deux nœuds frontières et un nœud intérieur. */
function smallNetwork(): Network {
  const west = node('nW', -100, 0, true)
  const centre = node('n0', 0, 0)
  const east = node('nE', 100, 0, true)
  const edges: Record<string, NetEdge> = {
    a: edge('a', west, centre),
    b: edge('b', centre, east),
    c: edge('c', east, centre),
    d: edge('d', centre, west),
  }
  return { nodes: { nW: west, n0: centre, nE: east }, edges, controls: {}, controllers: {} }
}

function makeProject(id = 'p-test', name = 'Veauche'): Project {
  const network = smallNetwork()
  const at = '2026-01-01T00:00:00.000Z'
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: {
      id,
      name,
      createdAt: at,
      updatedAt: at,
      commune: { nom: 'Veauche', code: '42323', codesPostaux: ['42340'] },
      center: { lon: 4.29, lat: 45.5616 },
      attribution: 'test',
    },
    network,
    demand: defaultDemand(network),
    settings: { ...DEFAULT_SETTINGS },
    changes: [],
  }
}

function makeExtract(code = '42323'): OsmExtract {
  const commune: CommuneDetail = {
    nom: 'Veauche',
    code,
    codesPostaux: ['42340'],
    centre: { type: 'Point', coordinates: [4.29, 45.5616] },
    contour: { type: 'Polygon', coordinates: [[[4.28, 45.55], [4.3, 45.55], [4.3, 45.57], [4.28, 45.55]]] },
  }
  return {
    format: 'circulation-osm-extract',
    version: 1,
    extractedAt: '2026-01-01T00:00:00.000Z',
    attribution: 'test',
    commune,
    osm: { elements: [{ type: 'node', id: 1, lat: 45.56, lon: 4.29 }] },
  }
}

function createFakeEngine() {
  const sent: ToWorker[] = []
  let listener: ((msg: FromWorker) => void) | null = null
  const factory: SimClientFactory = (onMessage) => {
    listener = onMessage
    return { send: (msg) => { sent.push(msg) }, dispose: () => {} }
  }
  return { sent, factory, emit: (msg: FromWorker) => listener?.(msg) }
}

/* ------------------------------------------------------------------ */

describe('cache des extraits OSM', () => {
  it('enregistre et relit un extrait par code INSEE', async () => {
    expect(await getCachedExtract('99999')).toBeUndefined()
    const extract = makeExtract()
    await putCachedExtract(extract)
    const cached = await getCachedExtract('42323')
    expect(cached?.commune.nom).toBe('Veauche')
    expect(cached?.osm.elements).toHaveLength(1)
  })
})

describe('projet courant', () => {
  it('fait un aller-retour par IndexedDB', async () => {
    const project = makeProject('p-current', 'Projet courant')
    await saveCurrentProject(project)
    const loaded = await loadCurrentProject()
    expect(loaded).toEqual(project)
  })

  it('écrit après une temporisation et à la demande', async () => {
    const project = makeProject('p-debounce', 'Différé')
    scheduleAutosave(project)
    await flushAutosave()
    expect((await loadCurrentProject())?.meta.name).toBe('Différé')
  })
})

describe('bibliothèque de projets', () => {
  it('enregistre, liste, relit et supprime', async () => {
    const first = makeProject('lib-1', 'Premier')
    const second = makeProject('lib-2', 'Second')
    await saveLibraryProject(first)
    const index = await saveLibraryProject(second)
    expect(index.map((e) => e.id).sort()).toEqual(['lib-1', 'lib-2'])
    expect(index.find((e) => e.id === 'lib-2')).toMatchObject({ name: 'Second', commune: 'Veauche', edgeCount: 4 })
    expect((await loadLibraryProject('lib-1'))?.meta.name).toBe('Premier')

    const afterDelete = await deleteLibraryProject('lib-1')
    expect(afterDelete.map((e) => e.id)).toEqual(['lib-2'])
    expect(await loadLibraryProject('lib-1')).toBeNull()
    expect((await listLibrary()).map((e) => e.id)).toEqual(['lib-2'])
  })
})

describe('autosauvegarde du store', () => {
  let engine: ReturnType<typeof createFakeEngine>
  let store: ReturnType<typeof createAppStore>

  beforeEach(async () => {
    engine = createFakeEngine()
    store = createAppStore({ persist: true, createClient: engine.factory })
    store.getState().loadProject(makeProject('p-store', 'Store'))
    await flushAutosave()
  })

  it('écrit le projet après une action annulable', async () => {
    store.getState().setSeed(4321)
    await flushAutosave()
    expect((await loadCurrentProject())?.demand.seed).toBe(4321)

    store.getState().undo()
    await flushAutosave()
    expect((await loadCurrentProject())?.demand.seed).toBe(42)
  })

  it('écrit après un renommage et à la fin d’une simulation, jamais sur une frame', async () => {
    store.getState().setProjectName('Renommé')
    await flushAutosave()
    expect((await loadCurrentProject())?.meta.name).toBe('Renommé')

    // Un jalon connu permet de vérifier qu'une frame n'écrit rien.
    await saveCurrentProject(makeProject('p-jalon', 'Jalon'))
    store.getState().simStart()
    engine.emit({
      type: 'frame',
      frame: {
        time: 30,
        vehicles: new Float32Array(),
        controllers: [],
        counts: { inCirculation: 0, entered: 0, exited: 0, waitingAtEntries: 0 },
      },
    })
    await flushAutosave()
    expect((await loadCurrentProject())?.meta.name).toBe('Jalon')

    engine.emit({
      type: 'done',
      results: {
        seed: 1, durationS: 60, warmupS: 0, intervalS: 60, reachedS: 60, completed: true,
        network: {
          entered: 3, exited: 3, inCirculation: 0, notInjected: 0, totalDelayS: 0, meanDelayS: 0,
          meanTravelTimeS: 5, vehKm: 0.3,
        },
        edges: {}, exits: {}, intersections: {},
        series: {
          times: [0], edges: {}, exits: {},
          network: { entered: [3], exited: [3], inCirculation: [0], meanDelay: [0] },
        },
        warnings: [],
      },
    })
    await flushAutosave()
    const stored = await loadCurrentProject()
    expect(stored?.meta.name).toBe('Renommé')
    expect(stored?.lastResults?.network.exited).toBe(3)
  })
})

describe('bootstrap', () => {
  it('reprend le projet courant sans toucher au réseau ni aux démonstrations', async () => {
    await saveCurrentProject(makeProject('p-boot', 'Projet repris'))
    await saveLibraryProject(makeProject('lib-boot', 'En bibliothèque'))
    const engine = createFakeEngine()
    const store = createAppStore({ persist: true, createClient: engine.factory })
    let fetched = 0
    globalThis.fetch = (() => {
      fetched++
      return Promise.reject(new Error('aucun accès réseau attendu'))
    }) as typeof fetch

    await store.getState().bootstrap()
    expect(fetched).toBe(0)
    expect(store.getState().project?.meta.name).toBe('Projet repris')
    expect(store.getState().library.some((e) => e.id === 'lib-boot')).toBe(true)
    expect(store.getState().canUndo).toBe(false)

    // Idempotent : un second appel ne recharge rien.
    store.getState().setProjectName('Modifié')
    await store.getState().bootstrap()
    expect(store.getState().project?.meta.name).toBe('Modifié')
    await flushAutosave()
  })
})

describe('nom de fichier d’export', () => {
  it('utilise le nom de la commune et la date du jour', () => {
    const name = projectFileName(makeProject())
    expect(name).toMatch(/^circulation-veauche-\d{4}-\d{2}-\d{2}\.json$/)
  })
})
