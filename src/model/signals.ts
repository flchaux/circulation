/**
 * Plans de feux : cycle, mouvements pilotés, plan par défaut, validation.
 * Module de contrat partagé (lots A, B, C, E) — le moteur (engine/signals.ts) en dérive son automate.
 */
import type {
  ControllerId, EdgeId, GreenKind, MovementKey, NetEdge, Network, NodeId, SignalController, SignalPhase,
} from './types'
import { highwayRank } from './types'
import { DEFAULT_SIGNAL_TIMING } from './defaults'
import {
  type Adjacency, type Movement, approachAngle, buildAdjacency, movementsConflict, nodeMovements, normalizeAngle,
} from './geometry'

/** Orange effectif d'une phase (valeur de la phase, sinon celle du contrôleur). */
export function phaseAmber(controller: SignalController, phase: SignalPhase): number {
  return phase.amber ?? controller.amber
}

/** Rouge intégral effectif d'une phase. */
export function phaseAllRed(controller: SignalController, phase: SignalPhase): number {
  return phase.allRed ?? controller.allRed
}

/** Durée totale d'une phase : vert + orange + rouge intégral. */
export function phaseDuration(controller: SignalController, phase: SignalPhase): number {
  return phase.green + phaseAmber(controller, phase) + phaseAllRed(controller, phase)
}

/** Temps de cycle (s) : somme des durées de phase. 0 s'il n'y a aucune phase. */
export function controllerCycle(controller: SignalController): number {
  let c = 0
  for (const p of controller.phases) c += phaseDuration(controller, p)
  return c
}

/**
 * Mouvements pilotés par un contrôleur : ceux des nœuds couverts dont l'approche vient de l'extérieur du regroupement.
 * Les tronçons internes au regroupement restent toujours franchissables.
 */
export function controllerMovements(
  network: Network,
  controller: SignalController,
  adjacency?: Adjacency,
): Movement[] {
  const adj = adjacency ?? buildAdjacency(network)
  const inside = new Set(controller.nodeIds)
  const res: Movement[] = []
  for (const nodeId of controller.nodeIds) {
    const movements = nodeMovements(network, nodeId, adj.incoming.get(nodeId), adj.outgoing.get(nodeId))
    for (const m of movements) {
      const fromEdge = network.edges[m.from]
      if (fromEdge && inside.has(fromEdge.from)) continue // approche interne au carrefour regroupé
      res.push(m)
    }
  }
  return res
}

/** Approches externes d'un contrôleur (tronçons entrants venant de l'extérieur du regroupement). */
export function controllerApproaches(
  network: Network,
  controller: SignalController,
  adjacency?: Adjacency,
): NetEdge[] {
  const adj = adjacency ?? buildAdjacency(network)
  const inside = new Set(controller.nodeIds)
  const res: NetEdge[] = []
  for (const nodeId of controller.nodeIds) {
    for (const e of adj.incoming.get(nodeId) ?? []) {
      if (!e.closed && !inside.has(e.from)) res.push(e)
    }
  }
  return res
}

/** Cap d'arrivée d'une approche, pour l'appariement des axes. */
function approachBearing(e: NetEdge): number {
  return approachAngle(e)
}

/**
 * Plan par défaut à deux phases : axe principal (approche de plus forte classe + l'approche la plus opposée),
 * axe secondaire (les autres). `through`/`right` protégés, `left` permis.
 * L'appelant fixe l'identifiant du contrôleur.
 */
export function createDefaultSignalPlan(
  network: Network,
  nodeIds: NodeId[],
  timing?: Partial<typeof DEFAULT_SIGNAL_TIMING>,
  adjacency?: Adjacency,
): Omit<SignalController, 'id'> {
  const T = { ...DEFAULT_SIGNAL_TIMING, ...timing }
  const adj = adjacency ?? buildAdjacency(network)
  const controllerStub: SignalController = {
    id: '_', name: '', nodeIds, mode: 'fixed', offset: 0, amber: T.amber, allRed: T.allRed, phases: [],
    actuated: { skipEmpty: true },
  }
  const approaches = controllerApproaches(network, controllerStub, adj)
  const movements = controllerMovements(network, controllerStub, adj)

  // Axe principal : meilleure approche (classe, puis voies, puis longueur) et l'approche la plus opposée à ≥ 135°.
  const sorted = [...approaches].sort((a, b) =>
    highwayRank(a.highway) - highwayRank(b.highway) || b.lanes - a.lanes || b.length - a.length)
  const main = new Set<EdgeId>()
  if (sorted.length) {
    const first = sorted[0]
    main.add(first.id)
    const a0 = approachBearing(first)
    let best: NetEdge | null = null
    let bestDelta = 0
    for (const e of sorted.slice(1)) {
      const delta = Math.abs(normalizeAngle(approachBearing(e) - a0))
      if (delta >= (135 * Math.PI) / 180 && delta > bestDelta) { best = e; bestDelta = delta }
    }
    if (best) main.add(best.id)
  }
  const secondary = approaches.filter((e) => !main.has(e.id))

  const amberFast = approaches.some((e) => e.maxspeed > 50) ? T.amberFast : T.amber
  const groups: { name: string; edges: EdgeId[] }[] = [{ name: 'Axe principal', edges: [...main] }]
  if (secondary.length) groups.push({ name: 'Axe secondaire', edges: secondary.map((e) => e.id) })

  const lostPerPhase = amberFast + T.allRed
  const totalGreen = Math.max(groups.length * T.minGreen, T.cycle - groups.length * lostPerPhase)
  const weights = groups.map((g) => g.edges.reduce((s, id) => s + (network.edges[id]?.lanes ?? 1), 0) || 1)
  const weightSum = weights.reduce((a, b) => a + b, 0)

  const phases: SignalPhase[] = groups.map((g, i) => {
    const set = new Set(g.edges)
    const mv: Record<MovementKey, 'protected' | 'permitted'> = {}
    for (const m of movements) {
      if (!set.has(m.from)) continue
      mv[m.key] = m.turn === 'left' || m.turn === 'uturn' ? 'permitted' : 'protected'
    }
    return {
      id: `p${i + 1}`,
      name: g.name,
      green: Math.max(T.minGreen, Math.round((totalGreen * weights[i]) / weightSum)),
      movements: mv,
      minGreen: T.minGreen,
      maxGreen: T.maxGreen,
      gap: T.gap,
    }
  })

  const names = nodeIds
    .map((id) => network.nodes[id]?.label)
    .filter((l): l is string => !!l)
  const uniqueNames = [...new Set(names)].slice(0, 2)

  return {
    name: uniqueNames.length ? uniqueNames.join(' / ') : 'Carrefour à feux',
    nodeIds: [...nodeIds],
    mode: 'fixed',
    offset: 0,
    amber: amberFast,
    allRed: T.allRed,
    phases,
    actuated: { skipEmpty: true },
  }
}

/** Anomalies d'un contrôleur, en français, pour l'affichage dans le panneau Feux. */
export function validateController(
  network: Network,
  controller: SignalController,
  adjacency?: Adjacency,
): string[] {
  const out: string[] = []
  const adj = adjacency ?? buildAdjacency(network)
  const movements = controllerMovements(network, controller, adj)
  if (!controller.phases.length) {
    out.push('Aucune phase : tous les mouvements restent au rouge.')
    return out
  }
  for (const p of controller.phases) {
    if (p.green <= 0) out.push(`Phase « ${p.name} » : durée de vert nulle ou négative.`)
    if (phaseAmber(controller, p) < 0 || phaseAllRed(controller, p) < 0) {
      out.push(`Phase « ${p.name} » : orange ou rouge intégral négatif.`)
    }
    if (controller.mode === 'actuated' && p.minGreen > p.maxGreen) {
      out.push(`Phase « ${p.name} » : vert minimal supérieur au vert maximal.`)
    }
    // Conflits entre mouvements protégés simultanés.
    const greens = movements.filter((m) => p.movements[m.key])
    for (let i = 0; i < greens.length; i++) {
      for (let j = i + 1; j < greens.length; j++) {
        const a = greens[i]
        const b = greens[j]
        if (p.movements[a.key] === 'protected' && p.movements[b.key] === 'protected' && movementsConflict(a, b)) {
          out.push(`Phase « ${p.name} » : mouvements protégés en conflit (${describeMovement(network, a)} et ${describeMovement(network, b)}).`)
        }
      }
    }
  }
  const everGreen = new Set<MovementKey>()
  for (const p of controller.phases) for (const k of Object.keys(p.movements)) everGreen.add(k)
  const never = movements.filter((m) => !everGreen.has(m.key))
  if (never.length) {
    out.push(`${never.length} mouvement(s) jamais au vert : ${never.slice(0, 3).map((m) => describeMovement(network, m)).join(', ')}${never.length > 3 ? '…' : ''}.`)
  }
  if (controllerCycle(controller) <= 0) out.push('Temps de cycle nul.')
  return out
}

const TURN_LABEL: Record<Movement['turn'], string> = {
  through: 'tout droit', left: 'à gauche', right: 'à droite', uturn: 'demi-tour',
}

/** Libellé lisible d'un mouvement (« rue de Lyon → tout droit »). */
export function describeMovement(network: Network, m: Movement): string {
  const from = network.edges[m.from]
  const to = network.edges[m.to]
  const fromName = from?.name ?? 'voie sans nom'
  const toName = to?.name ? ` vers ${to.name}` : ''
  return `${fromName} ${TURN_LABEL[m.turn]}${toName}`
}

/**
 * Distance angulaire entre deux approches, en considérant qu'une approche opposée appartient au même axe :
 * une branche à 180° d'une autre est desservie par la même phase dans un plan classique.
 */
function distanceAxe(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a - b))
  return Math.min(d, Math.PI - d)
}

/**
 * Complète les plans de feux après une modification de topologie.
 *
 * Fusionner deux nœuds, ajouter un tronçon ou inverser un sens ajoute des mouvements à un carrefour à feux
 * sans que le plan existant ne les connaisse : ils resteraient au rouge en permanence et bloqueraient leur
 * approche. Chaque mouvement orphelin est donc rattaché à la phase dont l'axe est le plus proche du sien,
 * en « protégé » si cela ne crée aucun conflit avec un autre mouvement protégé de la phase, en « permis » sinon.
 * Un contrôleur sans aucune phase reçoit un plan par défaut complet.
 *
 * Renvoie le réseau reçu à l'identique si rien n'était à compléter (l'identité des objets est préservée
 * pour ne pas invalider les caches d'affichage).
 */
export function completeSignalPlans(
  network: Network,
  adjacency?: Adjacency,
): { network: Network; added: number } {
  const controllers = Object.values(network.controllers)
  if (!controllers.length) return { network, added: 0 }
  const adj = adjacency ?? buildAdjacency(network)
  const suivants: Record<ControllerId, SignalController> = {}
  let added = 0

  for (const controller of controllers) {
    const movements = controllerMovements(network, controller, adj)
    if (!movements.length) continue
    const parCle = new Map<MovementKey, Movement>()
    for (const m of movements) parCle.set(m.key, m)

    const couverts = new Set<MovementKey>()
    for (const phase of controller.phases) for (const key of Object.keys(phase.movements)) couverts.add(key)
    const manquants = movements.filter((m) => !couverts.has(m.key))
    if (!manquants.length) continue

    // Aucun plan exploitable : on en régénère un complet plutôt que de bricoler.
    if (!controller.phases.length) {
      const plan = createDefaultSignalPlan(network, controller.nodeIds, undefined, adj)
      suivants[controller.id] = { ...controller, phases: plan.phases }
      added += manquants.length
      continue
    }

    // Angles d'approche déjà desservis par chaque phase, et mouvements verts de chaque phase.
    const anglesParPhase = controller.phases.map((phase) => {
      const angles: number[] = []
      for (const key of Object.keys(phase.movements)) {
        const m = parCle.get(key)
        if (m) angles.push(m.inAngle)
      }
      return angles
    })
    const phases = controller.phases.map((phase) => ({ ...phase, movements: { ...phase.movements } }))

    for (const m of manquants) {
      // Phase dont l'axe est le plus proche ; à défaut d'information, la première.
      let choisie = 0
      let meilleure = Infinity
      for (let i = 0; i < phases.length; i++) {
        for (const angle of anglesParPhase[i]) {
          const d = distanceAxe(angle, m.inAngle)
          if (d < meilleure) { meilleure = d; choisie = i }
        }
      }
      const phase = phases[choisie]
      // Protégé seulement si aucun mouvement protégé de la phase ne le croise.
      let kind: GreenKind = m.turn === 'left' || m.turn === 'uturn' ? 'permitted' : 'protected'
      if (kind === 'protected') {
        for (const [key, autre] of Object.entries(phase.movements)) {
          if (autre !== 'protected') continue
          const existant = parCle.get(key)
          if (existant && movementsConflict(existant, m)) { kind = 'permitted'; break }
        }
      }
      phase.movements[m.key] = kind
      anglesParPhase[choisie].push(m.inAngle)
      added++
    }
    suivants[controller.id] = { ...controller, phases }
  }

  if (!added) return { network, added: 0 }
  return { network: { ...network, controllers: { ...network.controllers, ...suivants } }, added }
}

/** Identifiant de contrôleur libre dérivé d'un nœud (éditeur). */
export function nextControllerId(existing: Record<ControllerId, unknown>, nodeId: NodeId): ControllerId {
  const base = `c_${nodeId}`
  if (!(base in existing)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`
    if (!(candidate in existing)) return candidate
  }
}
