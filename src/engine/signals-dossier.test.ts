/**
 * Moteur de feux nourri par un dossier de carrefour (§14 de docs/ARCHITECTURE.md) : inter-verts par couple
 * de groupes, plans horaires suivant l'heure simulée, verts piétons qui ferment les mouvements sécants.
 * Les contrôleurs sans donnée de dossier doivent se comporter exactement comme avant.
 */
import { describe, expect, it } from 'vitest'
import type { Demand, NetEdge, NetNode, Network, SignalController, SignalPhase, SimSettings } from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import { buildGraph } from './routing'
import type { SignalClock, SignalProbe } from './signals'
import { SIG_AMBER, SIG_GREEN_PERMITTED, SIG_GREEN_PROTECTED, SIG_RED, SignalEngine } from './signals'
import { Simulation } from './simulation'

/* ----------------------------- Fabriques ----------------------------- */

function edge(nodes: Record<string, NetNode>, id: string, from: string, to: string): NetEdge {
  const a = nodes[from]
  const b = nodes[to]
  return {
    id, from, to, reverseOf: undefined, highway: 'residential', lanes: 1, maxspeed: 50,
    length: Math.hypot(b.x - a.x, b.y - a.y),
    geometry: [[a.x, a.y], [b.x, b.y]],
    roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
  }
}

/** Carrefour en croix, quatre branches à double sens de 200 m, centre `c`. */
function cross(controller: SignalController): Network {
  const nodes: Record<string, NetNode> = {
    c: { id: 'c', x: 0, y: 0, boundary: false },
    n: { id: 'n', x: 0, y: 200, boundary: true },
    s: { id: 's', x: 0, y: -200, boundary: true },
    e: { id: 'e', x: 200, y: 0, boundary: true },
    w: { id: 'w', x: -200, y: 0, boundary: true },
  }
  const edges: Record<string, NetEdge> = {}
  for (const b of ['n', 's', 'e', 'w']) {
    edges[`${b}_in`] = { ...edge(nodes, `${b}_in`, b, 'c'), reverseOf: `${b}_out` }
    edges[`${b}_out`] = { ...edge(nodes, `${b}_out`, 'c', b), reverseOf: `${b}_in` }
  }
  return {
    nodes,
    edges,
    controls: { c: { nodeId: 'c', type: 'signals', controllerId: controller.id } },
    controllers: { [controller.id]: controller },
  }
}

/**
 * Interdit les mouvements que le plan ne dessert pas, pour que le courant opposé est → ouest s'écoule au
 * lieu de rester bloqué derrière un véhicule qui attend un vert qui ne vient jamais.
 */
function courantOppose(net: Network): Network {
  const edges = { ...net.edges }
  edges.e_in = { ...edges.e_in, bannedTo: ['n_out', 's_out'] }
  edges.w_in = { ...edges.w_in, bannedTo: ['s_out'] }
  return { ...net, edges }
}

function phase(id: string, name: string, green: number, o: Partial<SignalPhase> = {}): SignalPhase {
  return { id, name, green, movements: {}, minGreen: 7, maxGreen: 60, gap: 3, ...o }
}

const V1 = { id: 'V1', type: 'vehicule' as const, movements: ['w_in>e_out', 'e_in>w_out', 'w_in>n_out'] }
const V2 = { id: 'V2', type: 'vehicule' as const, movements: ['s_in>n_out', 'n_in>s_out'] }
const P1 = { id: 'P1', type: 'pieton' as const, movements: ['w_in>n_out'], recall: true }

/** Contrôleur imité d'un dossier : deux phases en groupes, matrice d'inter-verts asymétrique. */
function dossier(o: Partial<SignalController> = {}): SignalController {
  return {
    id: 'ctl',
    name: 'Carrefour dossier',
    nodeIds: ['c'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    phases: [
      phase('p1', 'Est-ouest', 20, { groups: ['V1', 'P1'] }),
      phase('p2', 'Nord-sud', 25, { groups: ['V2'] }),
    ],
    groups: [V1, V2, P1],
    interGreen: { V1: { V2: 6 }, P1: { V2: 8 }, V2: { V1: 7 } },
    amberByGroup: { V1: 3, V2: 5 },
    source: 'dossier VE005',
    actuated: { skipEmpty: false },
    ...o,
  }
}

/* ----------------------------- Banc d'essai ----------------------------- */

/** Le mode fixe n'interroge pas le trafic : une sonde vide suffit. */
const IDLE: SignalProbe = { lastActivity: () => -Infinity, queueLength: () => 0 }

interface Segment { phase: number; state: string; from: number; length: number }

function harness(network: Network, clock?: SignalClock) {
  const graph = buildGraph(network)
  const engine = new SignalEngine(graph, network, clock)
  const index = (key: string): number => {
    const i = graph.movementOf.get(key)
    if (i === undefined) throw new Error(`mouvement inconnu ${key}`)
    return i
  }
  return {
    engine,
    /** Avance le moteur à `t` et renvoie l'état publié du contrôleur unique. */
    at(t: number) {
      engine.update(t, IDLE)
      return engine.states(t)[0]
    },
    state: (key: string): number => engine.state[index(key)],
    since: (key: string): number => engine.since[index(key)],
    /** Part de vert d'un tronçon sous le plan en vigueur (dénominateur de la saturation). */
    share: (edgeId: string): number => engine.greenShareByEdge()[graph.edgeIds.indexOf(edgeId)],
    /** Suites de secondes consécutives passées dans le même état, seconde par seconde. */
    segments(seconds: number): Segment[] {
      const segs: Segment[] = []
      for (let t = 0; t < seconds; t++) {
        const s = this.at(t)
        const last = segs[segs.length - 1]
        if (last && last.phase === s.phaseIndex && last.state === s.state) last.length++
        else segs.push({ phase: s.phaseIndex, state: s.state, from: t, length: 1 })
      }
      return segs
    },
  }
}

function demandOf(entries: Record<string, number>, exits: Record<string, number>): Demand {
  const d: Demand = {
    seed: 2026, globalFactor: 1, entries: {}, exits: {}, destinationMode: 'weights', od: {},
    internal: { enabled: false, generationRate: 0, internalDestinationShare: 0, entryInternalShare: 0 },
  }
  for (const [id, flow] of Object.entries(entries)) d.entries[id] = { flow, enabled: true, estimated: false }
  for (const [id, weight] of Object.entries(exits)) d.exits[id] = { weight, enabled: true }
  return d
}

function settingsOf(o: Partial<SimSettings> = {}): SimSettings {
  return { ...DEFAULT_SETTINGS, durationMin: 20, warmupMin: 0, dynamicRouting: false, ...o }
}

/* ----------------------------- Inter-verts ----------------------------- */

describe('inter-verts issus du dossier', () => {
  it('applique une durée différente selon la transition, et le jaune du groupe qui perd le vert', () => {
    const h = harness(cross(dossier()))
    // Cycle = 20 (V1) + 8 (V1/P1 → V2, jaune V1 = 3) + 25 (V2) + 7 (V2 → V1, jaune V2 = 5) = 60 s.
    expect(h.segments(120)).toEqual([
      { phase: 0, state: 'green', from: 0, length: 20 },
      { phase: 0, state: 'amber', from: 20, length: 3 },
      { phase: 0, state: 'allred', from: 23, length: 5 },
      { phase: 1, state: 'green', from: 28, length: 25 },
      { phase: 1, state: 'amber', from: 53, length: 5 },
      { phase: 1, state: 'allred', from: 58, length: 2 },
      { phase: 0, state: 'green', from: 60, length: 20 },
      { phase: 0, state: 'amber', from: 80, length: 3 },
      { phase: 0, state: 'allred', from: 83, length: 5 },
      { phase: 1, state: 'green', from: 88, length: 25 },
      { phase: 1, state: 'amber', from: 113, length: 5 },
      { phase: 1, state: 'allred', from: 118, length: 2 },
    ])
  })

  it('sans matrice, la durée entre phases redevient constante', () => {
    const h = harness(cross(dossier({ interGreen: undefined, amberByGroup: undefined })))
    const segs = h.segments(60)
    expect(segs.map((s) => `${s.state}:${s.length}`))
      .toEqual(['green:20', 'amber:3', 'allred:2', 'green:25', 'amber:3', 'allred:2', 'green:5'])
  })

  it('un groupe vert dans les deux phases ne s’éteint pas pendant l’inter-vert', () => {
    // V1 reste ouvert de p1 à p2 (aucune case V1→…) : la transition est nulle et le vert n'est pas coupé.
    const controller = dossier({
      phases: [
        phase('p1', 'Est-ouest', 10, { groups: ['V1'] }),
        phase('p2', 'Est-ouest + piétons', 10, { groups: ['V1', 'P1'] }),
        phase('p3', 'Nord-sud', 10, { groups: ['V2'] }),
      ],
      interGreen: { V1: { V2: 6 }, P1: { V2: 6 }, V2: { V1: 6 } },
    })
    const h = harness(cross(controller))
    for (let t = 0; t < 20; t++) {
      h.at(t)
      expect(h.state('w_in>e_out'), `t=${t}`).toBe(SIG_GREEN_PROTECTED)
    }
    // Le vert n'ayant jamais été interrompu, le temps perdu au démarrage n'est pas réappliqué.
    expect(h.since('w_in>e_out')).toBe(0)
    // Le tourne-à-gauche, lui, perd sa protection dès que le vert piéton s'ouvre en p2 : il reste vert et
    // cède aux piétons (§14.5), il ne se ferme pas.
    h.at(9)
    expect(h.state('w_in>n_out')).toBe(SIG_GREEN_PROTECTED)
    h.at(10)
    expect(h.state('w_in>n_out')).toBe(SIG_GREEN_PERMITTED)
  })
})

/* ----------------------------- Plans horaires ----------------------------- */

describe('plans horaires', () => {
  /** Deux plans sans matrice : cycle 50 s en pointe (verts 20 s), 30 s en heure creuse (verts 10 s). */
  function planned(o: Partial<SignalController> = {}): SignalController {
    return dossier({
      interGreen: undefined,
      amberByGroup: undefined,
      plans: [
        { id: 'jour', name: 'Pointe', cycle: 0, offset: 0, phases: { p1: { green: 20 }, p2: { green: 20 } } },
        { id: 'creuse', name: 'Creuse', cycle: 0, offset: 0, phases: { p1: { green: 10 }, p2: { green: 10 } } },
      ],
      schedule: [
        { planId: 'jour', fromMin: 7 * 60, toMin: 9 * 60, days: [] },
        { planId: 'creuse', fromMin: 9 * 60, toMin: 20 * 60, days: [] },
      ],
      ...o,
    })
  }

  it('bascule de plan à l’heure dite, mais seulement en fin de cycle', () => {
    // Départ à 8 h 58 : la bascule est due à t = 120 s, la fin de cycle suivante est à t = 150 s.
    const h = harness(cross(planned()), { startTimeOfDayMin: 8 * 60 + 58, dayOfWeek: 2 })
    const segs = h.segments(220)
    const parDebut = new Map(segs.map((s) => [s.from, s]))
    // Cycle de pointe : 20 + 3 + 2 par phase.
    expect(parDebut.get(100)).toEqual({ phase: 0, state: 'green', from: 100, length: 20 })
    // À t = 120 l'heure de bascule est passée, mais la phase en cours va à son terme (avec le plan de pointe :
    // orange puis rouge intégral ; avec le plan creux, τ = 20 serait déjà le vert de la phase 2).
    expect(parDebut.get(120)).toEqual({ phase: 0, state: 'amber', from: 120, length: 3 })
    expect(parDebut.get(123)).toEqual({ phase: 0, state: 'allred', from: 123, length: 2 })
    expect(parDebut.get(125)).toEqual({ phase: 1, state: 'green', from: 125, length: 20 })
    // Fin de cycle à t = 150 : le plan creux prend le relais, cycle 30 s.
    expect(parDebut.get(150)).toEqual({ phase: 0, state: 'green', from: 150, length: 10 })
    expect(parDebut.get(165)).toEqual({ phase: 1, state: 'green', from: 165, length: 10 })
    expect(parDebut.get(180)).toEqual({ phase: 0, state: 'green', from: 180, length: 10 })
  })

  it('applique dès le départ le plan de l’heure de démarrage', () => {
    const h = harness(cross(planned()), { startTimeOfDayMin: 10 * 60, dayOfWeek: 2 })
    expect(h.segments(30).map((s) => s.length)).toEqual([10, 3, 2, 10, 3, 2])
  })

  it('suit une plage qui franchit minuit et le changement de jour', () => {
    const nuit = planned({
      plans: [
        { id: 'jour', name: 'Jour', cycle: 0, offset: 0, phases: { p1: { green: 20 }, p2: { green: 20 } } },
        { id: 'nuit', name: 'Nuit', cycle: 0, offset: 0, phases: { p1: { green: 5 }, p2: { green: 5 } } },
      ],
      schedule: [{ planId: 'nuit', fromMin: 22 * 60, toMin: 6 * 60, days: [] }],
    })
    // Départ à 21 h 59 : aucune plage ne couvre l'heure, le premier plan s'applique (cycle 50 s).
    const soir = harness(cross(nuit), { startTimeOfDayMin: 21 * 60 + 59, dayOfWeek: 2 })
    const segs = soir.segments(160)
    expect(segs.find((s) => s.from === 50)).toEqual({ phase: 0, state: 'green', from: 50, length: 20 })
    // 22 h tombe à t = 60 s ; la fin de cycle suivante (t = 100 s) fait passer au plan de nuit (cycle 20 s).
    expect(segs.find((s) => s.from === 100)).toEqual({ phase: 0, state: 'green', from: 100, length: 5 })
    expect(segs.find((s) => s.from === 120)).toEqual({ phase: 0, state: 'green', from: 120, length: 5 })
  })

  /** Plage de nuit réservée à un jour : elle appartient au jour où elle commence (voir `scheduleCovers`). */
  function nuitDuDimanche(): SignalController {
    return planned({
      plans: [
        { id: 'jour', name: 'Jour', cycle: 0, offset: 0, phases: { p1: { green: 20 }, p2: { green: 20 } } },
        { id: 'nuit', name: 'Nuit du dimanche', cycle: 0, offset: 0, phases: { p1: { green: 5 }, p2: { green: 5 } } },
      ],
      schedule: [{ planId: 'nuit', fromMin: 22 * 60, toMin: 6 * 60, days: [7] }],
    })
  }

  it('prolonge après minuit la plage de nuit ouverte la veille', () => {
    // Dimanche 23 h 50 : la nuit du dimanche court jusqu'à 6 h du lundi. Minuit (t = 600 s) ne l'interrompt
    // pas — sans la convention « jour de début », le plan repasserait en « jour » (cycle 50 s) dès le lundi.
    const h = harness(cross(nuitDuDimanche()), { startTimeOfDayMin: 23 * 60 + 50, dayOfWeek: 7 })
    const segs = h.segments(700)
    expect(segs.find((s) => s.from === 580)).toEqual({ phase: 0, state: 'green', from: 580, length: 5 })
    expect(segs.find((s) => s.from === 600)).toEqual({ phase: 0, state: 'green', from: 600, length: 5 })
  })

  it('n’applique pas au petit matin du dimanche la plage de nuit du dimanche soir', () => {
    // Samedi 23 h 50 : la nuit qui commence est celle du samedi, hors plage → plan de jour (cycle 50 s),
    // y compris après minuit alors que le jour civil devient dimanche.
    const h = harness(cross(nuitDuDimanche()), { startTimeOfDayMin: 23 * 60 + 50, dayOfWeek: 6 })
    const segs = h.segments(700)
    expect(segs.find((s) => s.from === 600)).toEqual({ phase: 0, state: 'green', from: 600, length: 20 })
  })

  it('en mode adaptatif, le plan change au retour sur la première phase', () => {
    // Sans demande, chaque vert s'arrête au vert minimal : le plan pilote donc la longueur des verts.
    const controller = planned({
      mode: 'actuated',
      plans: [
        { id: 'jour', name: 'Jour', cycle: 0, offset: 0, phases: { p1: { green: 20, minGreen: 20 }, p2: { green: 20, minGreen: 20 } } },
        { id: 'creuse', name: 'Creuse', cycle: 0, offset: 0, phases: { p1: { green: 8, minGreen: 8 }, p2: { green: 8, minGreen: 8 } } },
      ],
    })
    const h = harness(cross(controller), { startTimeOfDayMin: 8 * 60 + 58, dayOfWeek: 2 })
    const segs = h.segments(220).filter((seg) => seg.state === 'green')
    expect(segs.find((seg) => seg.from === 100)).toMatchObject({ phase: 0, length: 20 })
    // Bascule due à t = 120 s : le cycle en cours se termine, le plan creux démarre au cycle suivant.
    expect(segs.find((seg) => seg.from === 125)).toMatchObject({ phase: 1, length: 20 })
    expect(segs.find((seg) => seg.from === 150)).toMatchObject({ phase: 0, length: 8 })
    expect(segs.find((seg) => seg.from === 163)).toMatchObject({ phase: 1, length: 8 })
  })

  it('en mode adaptatif, l’inter-vert appliqué est celui de la phase visée', () => {
    const h = harness(cross(dossier({ mode: 'actuated' })))
    const segs = h.segments(80)
    // Vert minimal 7 s dans les deux phases, puis les inter-verts asymétriques du dossier (8 s puis 7 s).
    expect(segs.map((seg) => `${seg.phase} ${seg.state}:${seg.length}`)).toEqual([
      '0 green:7', '0 amber:3', '0 allred:5',
      '1 green:7', '1 amber:5', '1 allred:2',
      '0 green:7', '0 amber:3', '0 allred:5',
      '1 green:7', '1 amber:5', '1 allred:2',
      '0 green:7', '0 amber:3', '0 allred:5',
      '1 green:7',
    ])
  })

  it('un décalage de plan cale le premier cycle', () => {
    const controller = planned({
      plans: [{ id: 'jour', name: 'Jour', cycle: 0, offset: 15, phases: { p1: { green: 20 }, p2: { green: 20 } } }],
      schedule: [],
    })
    // Décalage 15 s : à t = 0 le cycle est déjà commencé depuis 35 s (50 − 15), soit le vert de la phase 2.
    const h = harness(cross(controller), { startTimeOfDayMin: 8 * 60, dayOfWeek: 2 })
    expect(h.segments(30)[0]).toEqual({ phase: 1, state: 'green', from: 0, length: 10 })
  })
})

/* ----------------------------- Part de vert et saturation ----------------------------- */

describe('part de vert des statistiques', () => {
  /** Deux plans très contrastés : pointe (vert 50 s) de 7 h à 9 h, heure creuse (vert 10 s) ensuite. */
  function deuxPlans(): SignalController {
    return dossier({
      interGreen: undefined,
      amberByGroup: undefined,
      phases: [
        phase('p1', 'Est-ouest', 50, { groups: ['V1'] }),
        phase('p2', 'Nord-sud', 50, { groups: ['V2'] }),
      ],
      plans: [
        { id: 'pointe', name: 'Pointe', cycle: 0, offset: 0, phases: { p1: { green: 50 }, p2: { green: 50 } } },
        { id: 'creuse', name: 'Creuse', cycle: 0, offset: 0, phases: { p1: { green: 10 }, p2: { green: 50 } } },
      ],
      schedule: [
        { planId: 'pointe', fromMin: 7 * 60, toMin: 9 * 60, days: [] },
        { planId: 'creuse', fromMin: 9 * 60, toMin: 20 * 60, days: [] },
      ],
    })
  }

  // Cycles : pointe 2 × (50 + 3 + 2) = 110 s, creuse (10 + 5) + (50 + 5) = 70 s.
  const PART_POINTE = 50 / 110
  const PART_CREUSE = 10 / 70

  it('suit le plan en vigueur et non celui du démarrage', () => {
    const h = harness(cross(deuxPlans()), { startTimeOfDayMin: 8 * 60 + 58, dayOfWeek: 2 })
    h.at(0)
    expect(h.share('w_in')).toBeCloseTo(PART_POINTE, 9)
    expect(h.engine.planEpoch).toBe(0)
    // 9 h tombe à t = 120 s ; le plan bascule à la fin du cycle en cours.
    for (let t = 0; t <= 400; t++) h.at(t)
    expect(h.share('w_in')).toBeCloseTo(PART_CREUSE, 9)
    // La bascule est signalée : c'est ce qui permet à la simulation de réévaluer le dénominateur.
    expect(h.engine.planEpoch).toBe(1)
  })

  it('donne la même saturation pour une même fenêtre mesurée, quelle que soit l’heure de départ', () => {
    // Chauffe de 70 min : dans les deux cas la fenêtre mesurée est entièrement en heure creuse. La
    // saturation ne doit donc pas dépendre du plan qui tournait au démarrage.
    const capacite = (startTimeOfDayMin: number): number => {
      const sim = new Simulation({
        network: cross(deuxPlans()),
        demand: demandOf({ w: 300 }, { e: 1 }),
        settings: settingsOf({ warmupMin: 70, durationMin: 10, startTimeOfDayMin, dayOfWeek: 2 }),
      })
      let guard = 200_000
      while (!sim.done && guard-- > 0) sim.step(500)
      expect(sim.done).toBe(true)
      const e = sim.results().edges.w_in
      expect(e.flowVehH).toBeGreaterThan(0)
      // flux / saturation = capacité = débit de saturation × voies × part de vert.
      return e.flowVehH / e.saturation
    }
    const depart8h = capacite(8 * 60) // démarre en pointe, mesure en heure creuse
    const depart9h = capacite(9 * 60) // démarre et mesure en heure creuse
    expect(depart8h).toBeCloseTo(depart9h, 6)
    expect(depart9h).toBeCloseTo(DEFAULT_SETTINGS.saturationFlow * PART_CREUSE, 6)
  })
})

/* ----------------------------- Groupes piétons ----------------------------- */

describe('verts piétons', () => {
  /**
   * Trois phases : l'axe est-ouest reste vert sur les deux premières (inter-vert nul), la traversée piétonne
   * n'étant ouverte que sur la seconde. Le tourne-à-gauche ouest → nord la franchit.
   */
  function controllerAvecPieton(pieton: boolean): SignalController {
    return dossier({
      phases: [
        phase('p1', 'Est-ouest', 20, { groups: ['V1'] }),
        phase('p2', 'Est-ouest + traversée', 20, { groups: pieton ? ['V1', 'P1'] : ['V1'] }),
        phase('p3', 'Nord-sud', 20, { groups: ['V2'] }),
      ],
      interGreen: { V1: { V2: 6 }, P1: { V2: 6 }, V2: { V1: 6 } },
      amberByGroup: { V1: 3, V2: 3 },
    })
  }

  it('met le mouvement sécant en vert permis pendant la phase piétonne, sans le fermer', () => {
    const h = harness(cross(controllerAvecPieton(true)))
    h.at(10)
    expect(h.state('w_in>n_out')).toBe(SIG_GREEN_PROTECTED)
    h.at(25)
    // Vert piéton : le tourne-à-gauche cède le passage (vert permis), l'axe est-ouest reste protégé.
    expect(h.state('w_in>n_out')).toBe(SIG_GREEN_PERMITTED)
    expect(h.state('w_in>e_out')).toBe(SIG_GREEN_PROTECTED)
  })

  it('compte le mouvement permis par un vert piéton dans la part de vert de son approche', () => {
    // Approche ouest : sans ce comptage, une approche dont tous les mouvements franchissent une traversée
    // afficherait une part de vert nulle, donc une saturation infinie sur une approche qui roule.
    const seulementLeTourneAGauche = { id: 'V1', type: 'vehicule' as const, movements: ['w_in>n_out'] }
    const controller = dossier({
      phases: [
        phase('p1', 'Est-ouest + traversée', 20, { groups: ['V1', 'P1'] }),
        phase('p2', 'Nord-sud', 20, { groups: ['V2'] }),
      ],
      groups: [seulementLeTourneAGauche, V2, P1],
      interGreen: { V1: { V2: 6 }, P1: { V2: 6 }, V2: { V1: 6 } },
      amberByGroup: { V1: 3, V2: 3 },
    })
    const h = harness(cross(controller))
    // Cycle 20 + 6 + 20 + 6 = 52 s, dont 20 s de vert pour l'approche ouest.
    expect(h.share('w_in')).toBeCloseTo(20 / 52, 6)
  })

  it('retarde le vert protégé de tout le dégagement de la traversée', () => {
    // Sous-phase piétonne : la traversée s'éteint alors que l'axe est-ouest reste vert. Sans dégagement, le
    // tourne-à-gauche qui lui cédait reprendrait sa protection la seconde suivante — défaut de sécurité,
    // des piétons étant encore engagés sur la chaussée.
    const controller = dossier({
      phases: [
        phase('p1', 'Est-ouest + traversée', 20, { groups: ['V1', 'P1'] }),
        phase('p2', 'Est-ouest', 20, { groups: ['V1'] }),
        phase('p3', 'Nord-sud', 20, { groups: ['V2'] }),
      ],
      interGreen: { V1: { V2: 6 }, P1: { V1: 9, V2: 9 }, V2: { V1: 7, P1: 7 } },
    })
    const h = harness(cross(controller))
    h.at(19)
    expect(h.state('w_in>n_out')).toBe(SIG_GREEN_PERMITTED) // vert piéton : le tourne-à-gauche cède
    for (let t = 20; t < 29; t++) {
      h.at(t)
      // 9 s de dégagement : le conducteur continue de céder, il ne reprend pas la priorité.
      expect(h.state('w_in>n_out'), `t=${t}`).toBe(SIG_GREEN_PERMITTED)
      expect(h.state('w_in>e_out'), `t=${t}`).toBe(SIG_GREEN_PROTECTED) // l'axe, lui, n'est pas coupé
    }
    h.at(29)
    expect(h.state('w_in>n_out')).toBe(SIG_GREEN_PROTECTED)
  })

  /** Débit vers le nord et file maximale sur l'approche ouest, à cycle constant (72 s). */
  function flow(network: Network, demand: Demand): { sortis: number; file: number } {
    const sim = new Simulation({ network, demand, settings: settingsOf() })
    let guard = 200_000
    while (!sim.done && guard-- > 0) sim.step(200)
    expect(sim.done).toBe(true)
    const r = sim.results()
    return { sortis: r.exits.n.count, file: r.edges.w_in.maxQueue }
  }

  it('laisse écouler le tourne-à-gauche qui cède aux piétons au lieu de le bloquer', () => {
    // Même carrefour, mêmes phases, même cycle (72 s) : seule la concomitance du vert piéton change.
    // Chiffres de référence (800 véh/h ouest → nord, 20 min) : 250 véhicules sortis sans traversée,
    // 248 avec la traversée verte en concomitance. Le modèle précédent, qui fermait le mouvement, n'en
    // laissait sortir que 144 : un tiers du cycle perdu pour une traversée que les véhicules peuvent
    // franchir en cédant.
    const demande = demandOf({ w: 800 }, { n: 1 })
    const sans = flow(cross(controllerAvecPieton(false)), demande)
    const avec = flow(cross(controllerAvecPieton(true)), demande)
    expect(sans.sortis).toBeGreaterThan(240)
    // Le seuil discrimine les deux modèles : la fermeture n'en laissait passer que 144.
    expect(avec.sortis).toBeGreaterThan(200)
    // Le vert piéton coûte peu ici, et c'est la limite assumée du modèle : la cession est calculée sur les
    // flux véhicules en conflit, or le conflit est piéton et la demande piétonne n'est pas simulée.
    expect(avec.sortis).toBeGreaterThan(sans.sortis * 0.95)
    expect(avec.sortis).toBeLessThanOrEqual(sans.sortis)
  })

  it('fait bel et bien céder le mouvement permis aux véhicules en conflit', () => {
    // Le vert permis n'est pas un vert franc : avec 800 véh/h en face (est → ouest, tout droit), le
    // tourne-à-gauche ouest → nord tombe de 283 à 191 véhicules sortis. La cession n'est optimiste que
    // faute de piétons simulés, pas faute de modèle.
    const demande = demandOf({ w: 800, e: 800 }, { n: 0.5, w: 0.5 })
    const sans = flow(courantOppose(cross(controllerAvecPieton(false))), demande)
    const avec = flow(courantOppose(cross(controllerAvecPieton(true))), demande)
    expect(sans.sortis).toBeGreaterThan(270)
    expect(avec.sortis).toBeLessThan(sans.sortis * 0.8) // la cession coûte du débit…
    expect(avec.sortis).toBeGreaterThan(160) // … mais bien moins que la fermeture, qui plafonnait à 144
  })
})

/* ----------------------------- Traversées sur bouton poussoir ----------------------------- */

describe('rappel piéton', () => {
  /** Traversée nord identique à `P1`, mais sur bouton poussoir (aucun rappel déclaré au dossier). */
  const P1_APPEL = { id: 'P1', type: 'pieton' as const, movements: ['w_in>n_out'] }

  /** Trois phases : l'axe est-ouest reste vert, la traversée n'est ouverte que sur la sous-phase p2. */
  function controllerAvecTraversee(recall: boolean): SignalController {
    return dossier({
      phases: [
        phase('p1', 'Est-ouest', 20, { groups: ['V1'] }),
        phase('p2', 'Est-ouest + traversée', 20, { groups: ['V1', 'P1'] }),
        phase('p3', 'Nord-sud', 20, { groups: ['V2'] }),
      ],
      groups: [V1, V2, recall ? P1 : P1_APPEL],
      interGreen: { V1: { V2: 6 }, P1: { V2: 6 }, V2: { V1: 6 } },
      amberByGroup: { V1: 3, V2: 3 },
    })
  }

  /**
   * Cycle de 72 s ; à t ≡ 30 s la sous-phase piétonne est en cours. La traversée desservie se reconnaît au
   * vert permis du tourne-à-gauche, qui lui cède le passage ; non desservie, il garde sa protection.
   */
  function cyclesServis(controller: SignalController, clock?: SignalClock, cycles = 40): number {
    const h = harness(cross(controller), clock)
    let servis = 0
    for (let t = 0; t < cycles * 72; t++) {
      h.at(t)
      if (t % 72 === 30 && h.state('w_in>n_out') === SIG_GREEN_PERMITTED) servis++
    }
    return servis
  }

  it('dessert tous les cycles en rappel et une partie seulement sur appel', () => {
    const clock = { startTimeOfDayMin: 8 * 60, dayOfWeek: 2, seed: 2026 }
    expect(cyclesServis(controllerAvecTraversee(true), clock)).toBe(40)
    const surAppel = cyclesServis(controllerAvecTraversee(false), clock)
    expect(surAppel).toBeGreaterThan(0)
    expect(surAppel).toBeLessThan(40)
  })

  it('reste reproductible à graine égale et suit la graine sinon', () => {
    const c = controllerAvecTraversee(false)
    const avec = (seed: number): number => cyclesServis(c, { startTimeOfDayMin: 8 * 60, dayOfWeek: 2, seed })
    expect(avec(2026)).toBe(avec(2026))
    expect(avec(2026)).not.toBe(avec(7))
  })

  it('obéit à la part d’appel demandée', () => {
    const c = controllerAvecTraversee(false)
    const part = (pedestrianCallShare: number): number =>
      cyclesServis(c, { startTimeOfDayMin: 8 * 60, dayOfWeek: 2, seed: 2026, pedestrianCallShare })
    expect(part(1)).toBe(40) // appelée à chaque cycle : équivalent d'un rappel
    expect(part(0)).toBe(0) // jamais appelée : la traversée ne s'ouvre pas, le tourne-à-gauche reste protégé
  })

  it('change le débit du carrefour, à plan de feux identique', () => {
    // Deux simulations qui ne diffèrent que par `recall`. Il faut un courant opposé pour que la différence
    // se voie : un mouvement permis sans conflit véhicule s'écoule presque comme un mouvement protégé
    // (limite assumée, voir `phaseMovements`). Avec 800 véh/h en face, le tourne-à-gauche ouest → nord
    // sort 191 véhicules quand la traversée est en rappel et 256 quand elle est sur bouton poussoir,
    // desservie un cycle sur deux.
    const sortis = (recall: boolean): number => {
      const sim = new Simulation({
        network: courantOppose(cross(controllerAvecTraversee(recall))),
        demand: demandOf({ w: 800, e: 800 }, { n: 0.5, w: 0.5 }),
        settings: settingsOf(),
      })
      let guard = 200_000
      while (!sim.done && guard-- > 0) sim.step(200)
      expect(sim.done).toBe(true)
      return sim.results().exits.n.count
    }
    const enRappel = sortis(true)
    const surAppel = sortis(false)
    expect(enRappel).toBeGreaterThan(0)
    expect(surAppel).toBeGreaterThan(enRappel * 1.2)
  })
})

/* ----------------------------- Rétrocompatibilité ----------------------------- */

describe('contrôleur sans donnée de dossier', () => {
  /** Plan à l'ancienne : mouvements portés par la phase, orange et rouge intégral du contrôleur. */
  function classique(o: Partial<SignalController> = {}): SignalController {
    return {
      id: 'ctl', name: 'Croix', nodeIds: ['c'], mode: 'fixed', offset: 0, amber: 3, allRed: 2,
      phases: [
        phase('p1', 'Est-ouest', 30, {
          movements: { 'w_in>e_out': 'protected', 'e_in>w_out': 'protected' },
        }),
        phase('p2', 'Ouest + nord-sud', 30, {
          movements: { 'w_in>e_out': 'protected', 's_in>n_out': 'protected', 'n_in>s_out': 'permitted' },
        }),
      ],
      actuated: { skipEmpty: false },
      ...o,
    }
  }

  it('déroule le cycle vert / orange / rouge intégral comme auparavant', () => {
    const h = harness(cross(classique()))
    expect(h.segments(70).map((s) => `${s.phase} ${s.state}:${s.length}`))
      .toEqual(['0 green:30', '0 amber:3', '0 allred:2', '1 green:30', '1 amber:3', '1 allred:2'])
  })

  it('éteint tout mouvement vert pendant l’inter-vert, même s’il est vert dans les deux phases', () => {
    const h = harness(cross(classique()))
    h.at(29)
    expect(h.state('w_in>e_out')).toBe(SIG_GREEN_PROTECTED)
    h.at(30)
    expect(h.state('w_in>e_out')).toBe(SIG_AMBER)
    h.at(33)
    expect(h.state('w_in>e_out')).toBe(SIG_RED)
    h.at(35)
    // Nouveau vert : le temps perdu au démarrage s'applique de nouveau.
    expect(h.state('w_in>e_out')).toBe(SIG_GREEN_PROTECTED)
    expect(h.since('w_in>e_out')).toBe(35)
  })

  it('respecte le décalage du contrôleur', () => {
    const h = harness(cross(classique({ offset: 35 })))
    expect(h.segments(40)[0]).toEqual({ phase: 1, state: 'green', from: 0, length: 30 })
  })
})
