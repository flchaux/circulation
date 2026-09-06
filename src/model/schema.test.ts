import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, defaultDemand } from './defaults'
import { PROJECT_FORMAT, PROJECT_VERSION, type NetEdge, type NetNode, type Network, type Project } from './types'
import { validateProject } from './schema'

/* ------------------------------------------------------------------ */
/*  Projet de test construit à la main                                 */
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

function makeNetwork(): Network {
  const centre = node('n0', 0, 0)
  const north = node('nN', 0, 100, true)
  const south = node('nS', 0, -100, true)
  return {
    nodes: { n0: centre, nN: north, nS: south },
    edges: {
      eNin: edge('eNin', north, centre, { reverseOf: 'eNout' }),
      eNout: edge('eNout', centre, north, { reverseOf: 'eNin' }),
      eSin: edge('eSin', south, centre, { reverseOf: 'eSout' }),
      eSout: edge('eSout', centre, south, { reverseOf: 'eSin' }),
    },
    controls: {
      n0: { nodeId: 'n0', type: 'signals', controllerId: 'c1' },
    },
    controllers: {
      c1: {
        id: 'c1',
        name: 'Carrefour central',
        nodeIds: ['n0'],
        mode: 'fixed',
        offset: 0,
        amber: 3,
        allRed: 2,
        phases: [{
          id: 'p1', name: 'Axe principal', green: 30, movements: { 'eNin>eSout': 'protected' },
          minGreen: 7, maxGreen: 60, gap: 3,
        }],
        actuated: { skipEmpty: true },
      },
    },
  }
}

function makeProject(): Project {
  const network = makeNetwork()
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: {
      id: 'p1',
      name: 'Veauche',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commune: { nom: 'Veauche', code: '42323', codesPostaux: ['42340'], population: 8975 },
      center: { lon: 4.29, lat: 45.5616 },
      attribution: '© les contributeurs OpenStreetMap (ODbL)',
    },
    network,
    demand: defaultDemand(network, 7),
    settings: { ...DEFAULT_SETTINGS },
    changes: [{ at: '2026-01-02T00:00:00.000Z', label: 'Import' }],
  }
}

/* ------------------------------------------------------------------ */

describe('validateProject — aller-retour', () => {
  it('reconstruit à l’identique un projet sérialisé', () => {
    const project = makeProject()
    const result = validateProject(JSON.parse(JSON.stringify(project)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project).toEqual(project)
  })

  it('conserve référence et derniers résultats', () => {
    const project = makeProject()
    const results = {
      seed: 7, durationS: 3600, warmupS: 600, intervalS: 300, reachedS: 4200, completed: true,
      network: {
        entered: 100, exited: 90, inCirculation: 10, notInjected: 0, totalDelayS: 500, meanDelayS: 5,
        meanTravelTimeS: 60, vehKm: 12.5,
      },
      edges: {
        eNin: {
          entered: 10, exited: 9, flowVehH: 9, meanSpeedKmh: 45, meanTravelTimeS: 8,
          totalDelayS: 10, meanDelayS: 1, maxQueue: 3, meanQueue: 0.5, saturation: 0.2,
        },
      },
      exits: { nS: { count: 9, flowVehH: 9, meanTravelTimeS: 60, meanDelayS: 5 } },
      intersections: { n0: { approaches: { eNin: { vehicles: 9, meanDelayS: 1, maxQueue: 3 } } } },
      series: {
        times: [0, 300],
        edges: { eNin: { flow: [0, 9], delay: [0, 1], queue: [0, 0.5] } },
        exits: { nS: { count: [0, 9] } },
        network: { entered: [0, 100], exited: [0, 90], inCirculation: [0, 10], meanDelay: [0, 5] },
      },
      warnings: ['3 véhicules sans itinéraire'],
    }
    const withReference: Project = {
      ...project,
      lastResults: results,
      reference: {
        frozenAt: '2026-01-03T00:00:00.000Z',
        label: 'Référence',
        network: project.network,
        demand: project.demand,
        settings: project.settings,
        results,
      },
    }
    const result = validateProject(JSON.parse(JSON.stringify(withReference)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project).toEqual(withReference)
  })

  it('ne modifie pas la valeur reçue', () => {
    const raw = JSON.parse(JSON.stringify(makeProject())) as Record<string, unknown>
    const copy = JSON.parse(JSON.stringify(raw))
    validateProject(raw)
    expect(raw).toEqual(copy)
  })
})

describe('validateProject — enveloppe et migration', () => {
  it('refuse une valeur qui n’est pas un objet', () => {
    expect(validateProject('bonjour')).toEqual({ ok: false, errors: [expect.stringContaining('objet JSON')] })
  })

  it('refuse un format étranger', () => {
    const result = validateProject({ format: 'autre-chose', version: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('Format inattendu')
  })

  it('refuse une version future', () => {
    const result = validateProject({ ...makeProject(), version: PROJECT_VERSION + 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('version plus récente')
  })

  it('signale l’absence de migration depuis une version inconnue', () => {
    const result = validateProject({ ...makeProject(), version: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('Version de projet illisible')
  })
})

describe('validateProject — fichier invalide', () => {
  it('signale les références croisées cassées, en français', () => {
    const project = makeProject()
    const broken = JSON.parse(JSON.stringify(project)) as Project
    broken.network.edges.eNin.from = 'nFantome'
    broken.network.controls.n0.controllerId = 'cFantome'
    broken.network.edges.eSin.highway = 'autoroute' as never
    delete (broken.meta as Partial<Project['meta']>).center
    const result = validateProject(broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual([
      expect.stringContaining('origine de la projection'),
      expect.stringContaining('nœud inconnu'),
      expect.stringContaining('classe de voie inconnue'),
      expect.stringContaining('feux sans contrôleur connu'),
    ])
  })

  it('limite le nombre d’erreurs affichées', () => {
    const project = makeProject()
    const broken = JSON.parse(JSON.stringify(project)) as Project
    for (let i = 0; i < 40; i++) {
      broken.network.edges[`bad${i}`] = { ...broken.network.edges.eNin, id: `bad${i}`, from: 'nFantome' }
    }
    const result = validateProject(broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(21)
    expect(result.errors[20]).toContain('autre(s) erreur(s)')
  })
})

describe('validateProject — normalisations', () => {
  it('reconstruit une géométrie absente et recalcule les longueurs', () => {
    const project = makeProject()
    const raw = JSON.parse(JSON.stringify(project)) as Project
    delete (raw.network.edges.eNin as Partial<NetEdge>).geometry
    raw.network.edges.eNout.length = 12345
    raw.network.edges.eSin.geometry = [[9, 9], [1, 1], [-9, -9]]
    const result = validateProject(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.network.edges.eNin.geometry).toEqual([[0, 100], [0, 0]])
    expect(result.project.network.edges.eNin.length).toBeCloseTo(100, 6)
    expect(result.project.network.edges.eNout.length).toBeCloseTo(100, 6)
    // Les extrémités sont recalées sur les nœuds, les points intermédiaires conservés.
    expect(result.project.network.edges.eSin.geometry).toEqual([[0, -100], [1, 1], [0, 0]])
  })

  it('complète les réglages absents et force le pas de temps à 1 s', () => {
    const project = makeProject()
    const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>
    raw.settings = { durationMin: 30, dt: 5, criticalGap: { stop: 8 } }
    const result = validateProject(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.settings).toEqual({
      ...DEFAULT_SETTINGS,
      durationMin: 30,
      dt: 1,
      criticalGap: { ...DEFAULT_SETTINGS.criticalGap, stop: 8 },
    })
  })

  it('complète le journal et les valeurs de demande absents', () => {
    const raw = JSON.parse(JSON.stringify(makeProject())) as Record<string, unknown>
    delete raw.changes
    raw.demand = { entries: { nN: { flow: 500 } } }
    const result = validateProject(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.changes).toEqual([])
    expect(result.project.demand.entries.nN).toEqual({ flow: 500, enabled: true, estimated: false })
    expect(result.project.demand.destinationMode).toBe('weights')
    expect(result.project.demand.internal.enabled).toBe(false)
  })

  it('signale une section obligatoire absente', () => {
    const raw = JSON.parse(JSON.stringify(makeProject())) as Record<string, unknown>
    delete raw.demand
    const result = validateProject(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('demande manquante')
  })

  it('abandonne silencieusement les régulations de nœuds disparus', () => {
    const raw = JSON.parse(JSON.stringify(makeProject())) as Project
    raw.network.controls.nFantome = { nodeId: 'nFantome', type: 'stop' }
    const result = validateProject(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.network.controls.nFantome).toBeUndefined()
  })
})
