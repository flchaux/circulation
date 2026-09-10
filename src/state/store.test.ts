import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, defaultDemand } from '@/model/defaults'
import { controllerCycle, controllerMovements } from '@/model/signals'
import type { NetEdge, NetNode, Network, Project, SimResults } from '@/model/types'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'
import type { FromWorker, SimClientFactory, ToWorker } from '@/engine/protocol'
import { createAppStore } from './store'
import type { AppState } from './storeTypes'

/* ------------------------------------------------------------------ */
/*  Réseaux et projet de test (ni osm2graph ni moteur réel)            */
/* ------------------------------------------------------------------ */

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function edge(id: string, from: NetNode, to: NetNode, extra: Partial<NetEdge> = {}): NetEdge {
  const geometry: [number, number][] = [[from.x, from.y], [to.x, to.y]]
  return {
    id,
    from: from.id,
    to: to.id,
    highway: 'residential',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(to.x - from.x, to.y - from.y),
    geometry,
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
    ...extra,
  }
}

/** Deux tronçons à double sens entre `a` et `b`, identifiants `<a><b>` et `<b><a>`. */
function twoWay(edges: Record<string, NetEdge>, a: NetNode, b: NetNode): void {
  const forward = `${a.id}${b.id}`
  const backward = `${b.id}${a.id}`
  edges[forward] = edge(forward, a, b, { reverseOf: backward })
  edges[backward] = edge(backward, b, a, { reverseOf: forward })
}

/** Croisement en croix : nœud central `n0`, quatre branches frontières à 100 m. */
function crossNetwork(): Network {
  const centre = node('n0', 0, 0)
  const branches = [node('nN', 0, 100, true), node('nS', 0, -100, true), node('nE', 100, 0, true), node('nW', -100, 0, true)]
  const nodes: Record<string, NetNode> = { n0: centre }
  const edges: Record<string, NetEdge> = {}
  for (const branch of branches) {
    nodes[branch.id] = branch
    twoWay(edges, branch, centre)
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Axe est-ouest à deux carrefours (onde verte) : nW —200m— n1 —300m— n2 —200m— nE. */
function corridorNetwork(): Network {
  const west = node('nW', -200, 0, true)
  const n1 = node('n1', 0, 0)
  const n2 = node('n2', 300, 0)
  const east = node('nE', 500, 0, true)
  const nodes = { nW: west, n1, n2, nE: east }
  const edges: Record<string, NetEdge> = {}
  twoWay(edges, west, n1)
  twoWay(edges, n1, n2)
  twoWay(edges, n2, east)
  return { nodes, edges, controls: {}, controllers: {} }
}

function makeProject(network: Network): Project {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: {
      id: 'test',
      name: 'Projet de test',
      createdAt: at,
      updatedAt: at,
      center: { lon: 4.29, lat: 45.5616 },
      attribution: 'test',
    },
    network,
    demand: defaultDemand(network),
    settings: { ...DEFAULT_SETTINGS },
    changes: [],
  }
}

/** Client moteur factice : enregistre les messages envoyés et permet d'en simuler la réception. */
function createFakeEngine() {
  const sent: ToWorker[] = []
  let listener: ((msg: FromWorker) => void) | null = null
  let disposed = 0
  const factory: SimClientFactory = (onMessage) => {
    listener = onMessage
    return {
      send: (msg) => { sent.push(msg) },
      dispose: () => { disposed++ },
    }
  }
  return {
    sent,
    factory,
    get disposed() { return disposed },
    get created() { return listener !== null },
    emit(msg: FromWorker) { listener?.(msg) },
    types() { return sent.map((m) => m.type) },
  }
}

function setup(network: Network = crossNetwork()) {
  const engine = createFakeEngine()
  const store = createAppStore({ persist: false, createClient: engine.factory })
  store.getState().loadProject(makeProject(network))
  return { engine, store, s: (): AppState => store.getState() }
}

type Store = ReturnType<typeof setup>['store']

/**
 * Photo des données du projet qui doivent revenir à l'identique après une annulation.
 * La comparaison est structurelle : l'ordre des clés d'un enregistrement change quand une entrée
 * supprimée est réinsérée par les patches inverses, ce qui n'a aucune importance.
 */
function snapshot(store: Store): unknown {
  const p = store.getState().project
  if (!p) return null
  return { network: p.network, demand: p.demand, settings: p.settings, reference: p.reference }
}

/** Applique une action annulable puis vérifie l'aller-retour annuler / rétablir. */
function expectUndoRedo(store: Store, apply: () => void, assertApplied: () => void): void {
  const before = snapshot(store)
  const historyBefore = store.getState().project?.changes.length ?? 0
  apply()
  const after = snapshot(store)
  expect(after).not.toEqual(before)
  assertApplied()
  expect(store.getState().canUndo).toBe(true)
  expect(store.getState().project?.changes).toHaveLength(historyBefore + 1)

  store.getState().undo()
  expect(snapshot(store)).toEqual(before)
  expect(store.getState().project?.changes).toHaveLength(historyBefore)
  expect(store.getState().canRedo).toBe(true)

  store.getState().redo()
  expect(snapshot(store)).toEqual(after)
  assertApplied()
  expect(store.getState().canRedo).toBe(false)
}

/* ------------------------------------------------------------------ */

describe('chargement de projet', () => {
  it('assainit le réseau, resynchronise la demande et vide l’historique', () => {
    const { store, s } = setup()
    expect(s().project?.network.nodes.n0).toBeDefined()
    expect(Object.keys(s().project?.demand.entries ?? {}).sort()).toEqual(['nE', 'nN', 'nS', 'nW'])
    expect(s().canUndo).toBe(false)
    expect(s().dirty).toBe(false)
    expect(s().sim.stale).toBe(true)

    s().setSeed(99)
    expect(s().canUndo).toBe(true)
    store.getState().loadProject(makeProject(crossNetwork()))
    expect(s().canUndo).toBe(false)
    expect(s().canRedo).toBe(false)
  })

  it('supprime la demande devenue orpheline après une suppression de nœud', () => {
    const { s } = setup()
    s().deleteNode('nN')
    expect(s().project?.demand.entries.nN).toBeUndefined()
    expect(s().project?.demand.exits.nN).toBeUndefined()
    s().undo()
    expect(s().project?.demand.entries.nN).toBeDefined()
  })
})

describe('annuler / rétablir par famille d’action', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  it('déplacement de nœud (fin de glisser)', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => {
      s().beginNodeDrag('n0')
      s().dragNode('n0', 12.345, 6)
      s().endNodeDrag('n0')
    }, () => {
      expect(s().project?.network.nodes.n0.x).toBe(12.35)
      expect(s().project?.network.edges.nNn0.geometry[1]).toEqual([12.35, 6])
    })
  })

  it('fusion de nœuds', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().mergeNodes('nW', 'n0'), () => {
      expect(s().project?.network.nodes.nW).toBeUndefined()
      expect(s().project?.network.edges.nWn0).toBeUndefined()
      expect(s().project?.demand.entries.nW).toBeUndefined()
    })
  })

  it('suppression de tronçon', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().deleteEdge('nNn0'), () => {
      expect(s().project?.network.edges.nNn0).toBeUndefined()
      expect(s().project?.network.edges.n0nN.reverseOf).toBeUndefined()
    })
  })

  it('ajout de tronçon', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().addEdge('nN', 'nE', { twoWay: true, highway: 'tertiary', lanes: 2, maxspeed: 30 }),
      () => {
        expect(s().project?.network.edges.x1.highway).toBe('tertiary')
        expect(s().project?.network.edges.x1r.reverseOf).toBe('x1')
      })
  })

  it('attributs de tronçon (avec report sur le sens opposé)', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().updateEdge('nNn0', { lanes: 3, maxspeed: 30, closed: true }, true), () => {
      const edges = s().project?.network.edges
      expect(edges?.nNn0.lanes).toBe(3)
      expect(edges?.nNn0.estimated).toEqual({ lanes: false, maxspeed: false })
      expect(edges?.n0nN.maxspeed).toBe(30)
      expect(edges?.n0nN.closed).toBe(true)
    })
  })

  it('sens du tronçon (inversion)', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().setEdgeDirection('nNn0', 'reverse'), () => {
      const e = s().project?.network.edges.nNn0
      expect(e?.from).toBe('n0')
      expect(e?.to).toBe('nN')
      expect(s().project?.network.edges.n0nN).toBeUndefined()
    })
  })

  it('interdiction de tourner', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().setBannedTurn('nNn0', 'n0nS', true), () => {
      expect(s().project?.network.edges.nNn0.bannedTo).toEqual(['n0nS'])
    })
  })

  it('régulation d’un nœud (création du plan de feux)', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().setNodeControl('n0', { type: 'signals' }), () => {
      const control = s().project?.network.controls.n0
      expect(control?.type).toBe('signals')
      const controller = s().project?.network.controllers[control?.controllerId ?? '']
      expect(controller?.phases.length).toBeGreaterThan(0)
      expect(controllerCycle(controller!)).toBeGreaterThan(0)
    })
  })

  it('régulation d’un nœud (stop avec approches)', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().setNodeControl('n0', { type: 'stop', yieldEdges: ['nNn0'] }), () => {
      expect(s().project?.network.controls.n0).toEqual({ nodeId: 'n0', type: 'stop', yieldEdges: ['nNn0'] })
    })
  })

  it('édition des phases', () => {
    const { store, s } = ctx
    s().setNodeControl('n0', { type: 'signals' })
    const controllerId = s().project?.network.controls.n0.controllerId as string
    expectUndoRedo(store, () => s().updatePhase(controllerId, 'p1', { green: 42, name: 'Nord-Sud' }), () => {
      const phase = s().project?.network.controllers[controllerId].phases[0]
      expect(phase?.green).toBe(42)
      expect(phase?.name).toBe('Nord-Sud')
    })
    const initialPhases = s().project?.network.controllers[controllerId].phases.length as number
    expectUndoRedo(store, () => s().addPhase(controllerId), () => {
      const phases = s().project?.network.controllers[controllerId].phases
      expect(phases).toHaveLength(initialPhases + 1)
      expect(phases?.[initialPhases].id).toBe(`p${initialPhases + 1}`)
    })
    const added = `p${initialPhases + 1}`
    expectUndoRedo(store, () => s().setPhaseMovement(controllerId, added, 'nNn0>n0nS', 'permitted'), () => {
      expect(s().project?.network.controllers[controllerId].phases[initialPhases].movements['nNn0>n0nS'])
        .toBe('permitted')
    })
    expectUndoRedo(store, () => s().movePhase(controllerId, added, -1), () => {
      expect(s().project?.network.controllers[controllerId].phases[initialPhases - 1].id).toBe(added)
    })
    expectUndoRedo(store, () => s().removePhase(controllerId, added), () => {
      expect(s().project?.network.controllers[controllerId].phases).toHaveLength(initialPhases)
    })
    expectUndoRedo(store, () => s().updateController(controllerId, { mode: 'actuated', offset: 12 }), () => {
      expect(s().project?.network.controllers[controllerId].mode).toBe('actuated')
      expect(s().project?.network.controllers[controllerId].offset).toBe(12)
    })
    expectUndoRedo(store, () => s().resetControllerPlan(controllerId), () => {
      expect(s().project?.network.controllers[controllerId].phases[0].name).toBe('Axe principal')
    })
  })

  it('demande : entrée, sortie, facteur, graine, OD et trafic interne', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().updateEntry('nN', { flow: 900 }), () => {
      expect(s().project?.demand.entries.nN.flow).toBe(900)
      expect(s().project?.demand.entries.nN.estimated).toBe(false)
    })
    expectUndoRedo(store, () => s().updateExit('nS', { weight: 3 }), () => {
      expect(s().project?.demand.exits.nS.weight).toBe(3)
    })
    expectUndoRedo(store, () => s().setGlobalFactor(1.4), () => {
      expect(s().project?.demand.globalFactor).toBe(1.4)
    })
    expectUndoRedo(store, () => s().setSeed(1234), () => {
      expect(s().project?.demand.seed).toBe(1234)
    })
    expectUndoRedo(store, () => s().setDestinationMode('od'), () => {
      expect(s().project?.demand.destinationMode).toBe('od')
    })
    expectUndoRedo(store, () => s().setOdShare('nN', 'nS', 0.8), () => {
      expect(s().project?.demand.od.nN).toEqual({ nS: 0.8 })
    })
    expectUndoRedo(store, () => s().clearOd(), () => {
      expect(s().project?.demand.od).toEqual({})
    })
    expectUndoRedo(store, () => s().updateInternal({ enabled: true, generationRate: 120 }), () => {
      expect(s().project?.demand.internal).toMatchObject({ enabled: true, generationRate: 120 })
    })
  })

  it('import CSV de la demande', () => {
    const { store, s } = ctx
    let report = { entries: 0, exits: 0, odCells: 0, unknown: [] as string[] }
    expectUndoRedo(store, () => { report = s().importDemandCsv('entree;debit\nnN;750\n', 'compte.csv') }, () => {
      expect(s().project?.demand.entries.nN.flow).toBe(750)
      expect(s().project?.demand.csvImport).toMatchObject({ fileName: 'compte.csv', rows: 1 })
    })
    expect(report).toEqual({ entries: 1, exits: 0, odCells: 0, unknown: [] })
  })

  it('réglages de simulation', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().updateSettings({ durationMin: 15, dynamicRouting: false }), () => {
      expect(s().project?.settings.durationMin).toBe(15)
      expect(s().project?.settings.dynamicRouting).toBe(false)
    })
  })

  it('attributs de nœud', () => {
    const { store, s } = ctx
    expectUndoRedo(store, () => s().updateNode('n0', { label: 'Place centrale', miniRoundabout: true }), () => {
      expect(s().project?.network.nodes.n0.label).toBe('Place centrale')
      expect(s().project?.network.nodes.n0.miniRoundabout).toBe(true)
    })
  })

  it('n’empile rien pour une action sans effet', () => {
    const { s } = ctx
    s().setNodeControl('n0', { type: 'signals' })
    const controllerId = s().project?.network.controls.n0.controllerId as string
    const before = s().project
    s().updateEdge('nNn0', { lanes: 1 })
    s().setSeed(before!.demand.seed)
    s().setBannedTurn('nNn0', 'n0nS', false)
    s().updateEntry('inconnu', { flow: 10 })
    s().updateController(controllerId, { mode: 'fixed' })
    s().setNodeControl('n0', { type: 'signals' })
    s().updatePhase(controllerId, 'p1', { green: before!.network.controllers[controllerId].phases[0].green })
    expect(s().project).toBe(before)
    expect(s().project?.changes).toHaveLength(1)
  })

  it('limite l’historique à 100 entrées', () => {
    const { s } = ctx
    for (let i = 1; i <= 105; i++) s().setSeed(i)
    for (let i = 0; i < 100; i++) s().undo()
    expect(s().canUndo).toBe(false)
    // Les cinq plus anciennes modifications ne sont plus annulables : la graine ne revient pas à sa valeur initiale.
    expect(s().project?.demand.seed).toBe(5)
  })
})

describe('glisser hors du projet', () => {
  it('ne touche ni au projet, ni à l’historique, ni à `stale`', () => {
    const { engine, s } = setup()
    s().simStart()
    engine.emit({ type: 'ready', edgeIndex: ['nNn0'], endTime: 4200, warnings: [] })
    expect(s().sim.stale).toBe(false)

    const before = s().project
    s().beginNodeDrag('n0')
    s().dragNode('n0', 5, 7, 'nN')
    expect(s().drag).toEqual({ nodeId: 'n0', x: 5, y: 7, dropOn: 'nN' })
    expect(s().project).toBe(before)
    expect(s().canUndo).toBe(false)
    expect(s().sim.stale).toBe(false)

    s().cancelNodeDrag()
    expect(s().drag).toBeNull()
    expect(s().project).toBe(before)
  })

  it('n’empile rien si la position finale est inchangée', () => {
    const { s } = setup()
    const before = s().project
    s().beginNodeDrag('n0')
    s().dragNode('n0', 0, 0)
    s().endNodeDrag('n0')
    expect(s().project).toBe(before)
    expect(s().canUndo).toBe(false)
    expect(s().drag).toBeNull()
  })

  it('fusionne le nœud déposé sur une cible', () => {
    const { s } = setup()
    s().beginNodeDrag('nW')
    s().dragNode('nW', 0, 0, 'n0')
    s().endNodeDrag('nW')
    expect(s().project?.network.nodes.nW).toBeUndefined()
    expect(s().canUndo).toBe(true)
    expect(s().project?.changes[0].label).toContain('Fusion')
  })
})

describe('regroupement de carrefours sous un même contrôleur', () => {
  /** Deux carrefours à feux voisins sur le même axe, chacun avec son contrôleur. */
  function deuxFeux() {
    const ctx = setup(corridorNetwork())
    ctx.s().setNodeControl('n1', { type: 'signals' })
    ctx.s().setNodeControl('n2', { type: 'signals' })
    const net = ctx.s().project!.network
    const c1 = net.controls.n1?.controllerId ?? ''
    const c2 = net.controls.n2?.controllerId ?? ''
    expect(c1 && c2 && c1 !== c2).toBeTruthy()
    return { ...ctx, c1, c2 }
  }

  it('reprend le nœud à son ancien contrôleur, qui disparaît faute de nœud', () => {
    const { store, s, c1, c2 } = deuxFeux()
    expectUndoRedo(store, () => s().setControllerNodes(c1, ['n1', 'n2']), () => {
      const net = s().project!.network
      expect(net.controllers[c1].nodeIds).toEqual(['n1', 'n2'])
      // Un nœud n'appartient qu'à un contrôleur : le second n'a plus rien à piloter.
      expect(net.controllers[c2]).toBeUndefined()
      expect(net.controls.n2).toEqual({ nodeId: 'n2', type: 'signals', controllerId: c1 })
    })
  })

  it('cesse de compter comme branche le tronçon intérieur au regroupement', () => {
    const { s, c1 } = deuxFeux()
    const avant = controllerMovements(s().project!.network, s().project!.network.controllers[c1])
    expect(avant.some((m) => m.from === 'nWn1')).toBe(true)

    s().setControllerNodes(c1, ['n1', 'n2'])
    const net = s().project!.network
    const apres = controllerMovements(net, net.controllers[c1])
    // Les mouvements des deux nœuds sont réunis, sauf ceux qui arrivent par le tronçon central :
    // à l'intérieur d'un carrefour regroupé, ce n'est pas une approche.
    expect(apres.some((m) => m.from === 'n1n2' || m.from === 'n2n1')).toBe(false)
    expect(apres.some((m) => m.from === 'nWn1')).toBe(true)
    expect(apres.some((m) => m.from === 'nEn2')).toBe(true)
  })

  it('rend sa régulation ordinaire au nœud retiré du regroupement', () => {
    const { s, c1 } = deuxFeux()
    s().setControllerNodes(c1, ['n1', 'n2'])
    s().setControllerNodes(c1, ['n1'])
    const net = s().project!.network
    expect(net.controllers[c1].nodeIds).toEqual(['n1'])
    expect(net.controls.n2).toBeUndefined()
  })
})

describe('purge des sélections mortes', () => {
  it('efface sélection, survol et nœuds d’outil disparus', () => {
    const { s } = setup()
    s().select({ kind: 'node', id: 'nN' })
    s().setHover({ kind: 'edge', id: 'nNn0' })
    s().setTool('greenwave')
    s().toolClickNode('nN')
    expect(s().ui.toolNodes).toEqual(['nN'])

    s().deleteNode('nN')
    expect(s().selection).toBeNull()
    expect(s().hover).toBeNull()
    expect(s().ui.toolNodes).toEqual([])
  })

  it('recentre la carte à la demande', () => {
    const { s } = setup()
    const before = s().ui.revealCounter
    s().select({ kind: 'edge', id: 'nNn0' }, { reveal: true })
    expect(s().ui.revealCounter).toBe(before + 1)
    expect(s().selection).toEqual({ kind: 'edge', id: 'nNn0' })
  })
})

describe('onde verte', () => {
  it('décale les contrôleurs du temps de parcours libre', () => {
    const { s } = setup(corridorNetwork())
    s().setNodeControl('n1', { type: 'signals' })
    s().setNodeControl('n2', { type: 'signals' })
    const first = s().project?.network.controls.n1.controllerId as string
    const second = s().project?.network.controls.n2.controllerId as string

    const result = s().applyGreenWave('nW', 'nE')
    expect(result.path).toEqual(['nW', 'n1', 'n2', 'nE'])
    expect(result.controllers).toBe(2)
    const controllers = s().project?.network.controllers
    expect(controllers?.[first].offset).toBe(0)
    // 300 m à 50 km/h = 21,6 s, modulo le temps de cycle du second contrôleur.
    expect(controllers?.[second].offset).toBeCloseTo(21.6 % controllerCycle(controllers![second]), 6)
    s().undo()
    expect(s().project?.network.controllers[second].offset).toBe(0)
  })

  it('signale un trajet sans carrefour à feux', () => {
    const { s } = setup(corridorNetwork())
    const result = s().applyGreenWave('nW', 'nE')
    expect(result.controllers).toBe(0)
    expect(s().error).toContain('carrefours à feux')
  })

  it('enchaîne deux clics avec l’outil « ajouter un tronçon »', () => {
    const { s } = setup()
    s().setUi({ addEdgeOptions: { twoWay: false, highway: 'residential', lanes: 1, maxspeed: 50 } })
    s().setTool('addEdge')
    s().toolClickNode('nN')
    s().toolClickNode('nE')
    expect(s().ui.toolNodes).toEqual([])
    expect(s().project?.network.edges.x1).toMatchObject({ from: 'nN', to: 'nE' })
  })
})

describe('simulation', () => {
  function results(): SimResults {
    return {
      seed: 1, durationS: 60, warmupS: 0, intervalS: 60, reachedS: 60, completed: true,
      network: {
        entered: 5, exited: 5, inCirculation: 0, notInjected: 0, totalDelayS: 0, meanDelayS: 0,
        meanTravelTimeS: 10, vehKm: 1,
      },
      edges: {}, exits: {}, intersections: {},
      series: { times: [0], edges: {}, exits: {}, network: { entered: [5], exited: [5], inCirculation: [0], meanDelay: [0] } },
      warnings: [],
    }
  }

  it('n’instancie le client qu’au premier démarrage puis initialise le moteur', () => {
    const { engine, s } = setup()
    expect(engine.created).toBe(false)
    s().simStart()
    expect(engine.created).toBe(true)
    expect(engine.types()).toEqual(['init', 'run'])
    expect(s().sim.stale).toBe(false)

    engine.emit({ type: 'ready', edgeIndex: ['nNn0', 'n0nN'], endTime: 4200, warnings: ['essai'] })
    expect(s().sim.edgeIndex).toEqual(['nNn0', 'n0nN'])
    expect(s().sim.endTime).toBe(4200)
    expect(s().sim.warnings).toEqual(['essai'])

    // Un second démarrage ne réinitialise pas le moteur.
    s().simStart()
    expect(engine.types()).toEqual(['init', 'run', 'run'])
  })

  it('écrit frames et statistiques hors historique', () => {
    const { engine, s } = setup()
    s().simStart()
    const project = s().project
    engine.emit({ type: 'frame', frame: { time: 12, vehicles: new Float32Array([1, 0, 5, 0]), controllers: [], counts: { inCirculation: 1, entered: 1, exited: 0, waitingAtEntries: 0 } } })
    expect(s().sim.time).toBe(12)
    expect(s().sim.frame?.vehicles).toHaveLength(4)
    engine.emit({ type: 'stats', results: results() })
    expect(s().sim.results?.network.entered).toBe(5)
    expect(s().project).toBe(project)
    expect(s().dirty).toBe(false)
    expect(s().canUndo).toBe(false)
    expect(s().project?.lastResults).toBeUndefined()
  })

  it('fige les résultats dans le projet à la fin de la simulation', () => {
    const { engine, s } = setup()
    s().simStart()
    engine.emit({ type: 'done', results: results() })
    expect(s().sim.status).toBe('done')
    expect(s().project?.lastResults?.network.exited).toBe(5)
    expect(s().dirty).toBe(true)
    expect(s().canUndo).toBe(false) // les résultats ne sont pas annulables
  })

  it('met à jour les feux à chaud et marque `stale` pour les autres éditions', () => {
    const { engine, s } = setup()
    s().simStart()
    engine.emit({ type: 'ready', edgeIndex: [], endTime: 4200, warnings: [] })
    // La mise à jour à chaud n'a de sens que pendant une exécution : le moteur signale qu'il tourne.
    engine.emit({ type: 'status', status: 'running', time: 0, endTime: 4200, stepsPerSecond: 0 })
    engine.sent.length = 0

    s().setNodeControl('n0', { type: 'signals' })
    expect(engine.types()).toEqual(['updateSignals'])
    expect(s().sim.stale).toBe(false)

    const controllerId = s().project?.network.controls.n0.controllerId as string
    s().updatePhase(controllerId, 'p1', { green: 25 })
    expect(engine.types()).toEqual(['updateSignals', 'updateSignals'])
    expect(s().sim.stale).toBe(false)

    s().deleteEdge('nNn0')
    expect(engine.types()).toEqual(['updateSignals', 'updateSignals'])
    expect(s().sim.stale).toBe(true)

    // La simulation suivante repart d'un `init`.
    engine.sent.length = 0
    s().simStart()
    expect(engine.types()).toEqual(['init', 'run'])
  })

  it('rejoue depuis zéro quand les feux changent hors exécution', () => {
    const { engine, s } = setup()
    s().simStart()
    engine.emit({ type: 'ready', edgeIndex: [], endTime: 4200, warnings: [] })
    engine.emit({ type: 'status', status: 'running', time: 0, endTime: 4200, stepsPerSecond: 0 })
    engine.emit({ type: 'done', results: results() })
    expect(s().sim.status).toBe('done')
    engine.sent.length = 0

    // Simulation terminée : un changement de feux ne peut pas être appliqué à chaud.
    s().setNodeControl('n0', { type: 'signals' })
    expect(engine.types()).toEqual([])
    expect(s().sim.stale).toBe(true)

    // Le lancement suivant réinitialise le moteur avec le nouveau plan, sans quoi la comparaison
    // référence/variante rejouerait les résultats précédents.
    s().simRunFast()
    expect(engine.types()).toEqual(['init', 'runFast'])
  })

  it('réinitialise aussi après une simulation terminée sans modification', () => {
    const { engine, s } = setup()
    s().simStart()
    engine.emit({ type: 'ready', edgeIndex: [], endTime: 4200, warnings: [] })
    engine.emit({ type: 'done', results: results() })
    engine.sent.length = 0
    s().simStart()
    expect(engine.types()).toEqual(['init', 'run'])
  })

  it('relaie vitesse, pause, pas à pas et erreurs', () => {
    const { engine, s } = setup()
    s().simSetSpeed(500)
    expect(s().sim.speed).toBe(120)
    s().simStep(30)
    expect(engine.types()).toEqual(['init', 'step'])
    s().simPause()
    s().simRunFast()
    expect(s().sim.fast).toBe(true)
    expect(engine.types()).toEqual(['init', 'step', 'pause', 'runFast'])
    engine.emit({ type: 'error', message: 'moteur en panne' })
    expect(s().error).toBe('moteur en panne')
    expect(s().sim.status).toBe('idle')
  })
})

describe('référence et export', () => {
  it('fige puis efface la référence sans passer par l’historique', () => {
    const { s } = setup()
    s().freezeReference('Avant travaux')
    expect(s().project?.reference?.label).toBe('Avant travaux')
    expect(s().project?.reference?.network).toBe(s().project?.network)
    expect(s().canUndo).toBe(false)
    s().clearReference()
    expect(s().project?.reference).toBeUndefined()
  })

  it('exporte et réimporte le projet à l’identique', () => {
    const { s } = setup()
    s().setNodeControl('n0', { type: 'signals' })
    s().updateEntry('nN', { flow: 640 })
    const json = s().exportProjectJson()

    const other = setup()
    other.s().importProjectJson(json)
    expect(other.s().error).toBeNull()
    expect(other.s().project?.network).toEqual(s().project?.network)
    expect(other.s().project?.demand).toEqual(s().project?.demand)
    expect(other.s().canUndo).toBe(false)
  })

  it('refuse un JSON illisible ou invalide, en français', () => {
    const { s } = setup()
    const before = s().project
    s().importProjectJson('{ ceci n’est pas du json')
    expect(s().error).toContain('JSON valide')
    s().clearError()
    s().importProjectJson('{"format":"autre","version":1}')
    expect(s().error).toContain('Format inattendu')
    expect(s().project).toBe(before)
  })

  it('renomme le projet hors historique', () => {
    const { s } = setup()
    s().setProjectName('Veauche — variante feux')
    expect(s().project?.meta.name).toBe('Veauche — variante feux')
    expect(s().canUndo).toBe(false)
    expect(s().dirty).toBe(true)
  })
})
