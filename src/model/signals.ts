/**
 * Plans de feux : cycle, mouvements pilotés, plan par défaut, validation.
 * Module de contrat partagé (lots A, B, C, E) — le moteur (engine/signals.ts) en dérive son automate.
 */
import type {
  ControllerId, EdgeId, GreenKind, MovementKey, NetEdge, Network, NodeId, PlanPhaseTiming, PlanSchedule,
  SignalController, SignalGroup, SignalPhase, SignalPlan,
} from './types'
import { highwayRank } from './types'
import { DEFAULT_SIGNAL_TIMING } from './defaults'
import {
  type Adjacency, type Movement, approachAngle, buildAdjacency, movementsConflict, nodeMovements, normalizeAngle,
} from './geometry'

/** Orange effectif d'une phase (valeur de la phase, sinon celle du contrôleur), à défaut de matrice d'inter-verts. */
export function phaseAmber(controller: SignalController, phase: SignalPhase): number {
  return phase.amber ?? controller.amber
}

/** Rouge intégral effectif d'une phase, à défaut de matrice d'inter-verts. */
export function phaseAllRed(controller: SignalController, phase: SignalPhase): number {
  return phase.allRed ?? controller.allRed
}

/* ---------------- Dossiers de carrefour : groupes, inter-verts, plans horaires (§14) ---------------- */

/**
 * Groupes au vert pendant une phase. Vide quand la phase n'est pas écrite en groupes : `phase.movements`
 * fait alors foi, ce qui est le cas de tous les plans créés dans l'éditeur.
 * Un identifiant de groupe inconnu du contrôleur est ignoré ici et signalé par `validateController`.
 */
export function phaseGreenGroups(controller: SignalController, phase: SignalPhase): SignalGroup[] {
  if (!phase.groups?.length || !controller.groups?.length) return []
  const byId = new Map(controller.groups.map((g) => [g.id, g]))
  const res: SignalGroup[] = []
  for (const id of phase.groups) {
    const g = byId.get(id)
    if (g) res.push(g)
  }
  return res
}

/**
 * Mouvements au vert pendant une phase, et type de vert de chacun.
 *
 * Un dossier de carrefour écrit ses phases en groupes de signaux : les mouvements verts sont l'union des
 * mouvements des groupes véhicules ouverts, moins ceux qu'un vert piéton simultané traverse. C'est par là
 * que le temps piéton consomme de la capacité (§14.5) — sans cette soustraction, un plan importé
 * surestimerait le débit du carrefour.
 *
 * `skipped` recense les groupes que le cycle courant ne dessert pas : c'est ainsi qu'une traversée sur
 * bouton poussoir (`recall` absent) laisse, les cycles où personne n'appuie, les mouvements sécants ouverts.
 * Vide par défaut : tous les groupes cités par la phase sont verts, comportement historique.
 */
export function phaseMovements(
  controller: SignalController,
  phase: SignalPhase,
  skipped?: ReadonlySet<string>,
): Record<MovementKey, GreenKind> {
  const cited = phaseGreenGroups(controller, phase)
  // Le repli sur `phase.movements` ne concerne que les phases écrites sans groupes : une phase dont tous
  // les groupes cités sont non desservis reste vide, elle ne retombe pas sur ses mouvements bruts.
  if (!cited.length) return { ...phase.movements }
  const groups = skipped?.size ? cited.filter((g) => !skipped.has(g.id)) : cited
  const out: Record<MovementKey, GreenKind> = {}
  for (const g of groups) {
    if (g.type !== 'vehicule') continue
    // Le dossier ne distingue pas protégé et permis : on conserve l'indication portée par la phase si elle existe.
    for (const key of g.movements) out[key] = phase.movements[key] ?? 'protected'
  }
  for (const g of groups) {
    if (g.type !== 'pieton') continue
    for (const key of g.movements) delete out[key]
  }
  return out
}

/**
 * Part des cycles où une traversée piétonne **sur bouton poussoir** (`SignalGroup.recall` absent) est
 * desservie. Un groupe en rappel, lui, est vert à chaque cycle : sa part vaut 1 et n'est pas tirée au sort.
 *
 * Hypothèse assumée, faute de donnée de demande piétonne dans les dossiers : un appui par cycle sur deux.
 * Avec des arrivées de piétons poissonniennes de taux λ et un cycle C, la traversée est appelée avec la
 * probabilité 1 − e^(−λC) ; la valeur 0,5 correspond, pour un cycle de 80 s, à une trentaine de piétons par
 * heure, ordre de grandeur d'une traversée d'agglomération hors centre-ville. Elle est volontairement
 * médiane entre les deux comportements extrêmes (jamais appelée, toujours appelée) : c'est un réglage, pas
 * une mesure, et un carrefour dont la demande piétonne est connue doit le remplacer.
 */
export const DEFAULT_PEDESTRIAN_CALL_SHARE = 0.5

/** Temps séparant le vert d'une phase du vert de la suivante, et sa décomposition jaune / rouge intégral. */
export interface PhaseTransition {
  amber: number
  allRed: number
  /** Durée totale de la transition. */
  total: number
  /** La durée vient de la matrice d'inter-verts et non de `amber` / `allRed`. */
  matrixBased: boolean
  /** Le jaune du dossier dépassait l'inter-vert et a été tronqué (incohérence de saisie). */
  truncatedAmber: boolean
}

/**
 * Inter-vert entre deux phases (§14.3).
 *
 * Avec une matrice, la durée n'est plus une constante du contrôleur : c'est le maximum de
 * `interGreen[g][h]` sur les groupes `g` qui perdent le vert et `h` qui le prennent, une case absente
 * signifiant que les deux groupes sont compatibles. Le jaune est celui du groupe véhicule qui perd le vert
 * (un groupe piéton n'en a pas), le reste est du rouge intégral. Sans matrice — ou si l'une des deux phases
 * n'est pas écrite en groupes — on retrouve exactement l'orange et le rouge intégral de la phase quittée.
 *
 * Trois règles complètent ce principe, toutes tirées de la lecture des dossiers :
 *  - **dégagement piéton d'une sous-phase.** Une traversée qui s'éteint doit être dégagée avant que les
 *    mouvements qu'elle fermait ne rouvrent, y compris quand le groupe véhicule qui les porte est vert dans
 *    les deux phases (motif « phase B = V3 + P2, phase C = V3 ») : ce groupe n'apparaît alors ni dans
 *    `losing` ni dans `taking`, et le carrefour rouvrirait sans le moindre rouge de dégagement ;
 *  - **jaune restreint aux conflits.** Seul un groupe véhicule qui possède une case vers un groupe qui prend
 *    le vert peut allonger le jaune : sinon un groupe sans rapport mangerait le rouge de dégagement ;
 *  - **repli sur le jaune du contrôleur.** Faute de colonne « jaune » exploitable dans le dossier, le jaune
 *    de `controller.amber` s'applique (plafonné à l'inter-vert) plutôt que de rendre toute la transition
 *    rouge sans avertir.
 */
export function phaseTransition(
  controller: SignalController,
  from: SignalPhase,
  to: SignalPhase,
): PhaseTransition {
  const matrix = controller.interGreen
  const fromIds = from.groups ?? []
  const toIds = to.groups ?? []
  if (!matrix || !fromIds.length || !toIds.length) {
    const amber = phaseAmber(controller, from)
    const allRed = phaseAllRed(controller, from)
    return { amber, allRed, total: amber + allRed, matrixBased: false, truncatedAmber: false }
  }
  const losing = fromIds.filter((g) => !toIds.includes(g))
  const taking = toIds.filter((h) => !fromIds.includes(h))
  /** Case de la matrice, ou `undefined` quand les deux groupes sont compatibles. */
  const cell = (g: string, h: string): number | undefined => {
    const v = matrix[g]?.[h]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  }
  let total = 0
  for (const g of losing) {
    for (const h of taking) {
      const v = cell(g, h)
      if (v !== undefined && v > total) total = v
    }
  }

  const byId = new Map((controller.groups ?? []).map((g) => [g.id, g]))
  // Dégagement des traversées qui s'éteignent. Un groupe véhicule vert dans les deux phases est absent de
  // `taking`, mais les mouvements que la traversée lui fermait repassent bel et bien au vert : c'est le cas
  // d'une sous-phase piétonne, et l'ignorer supprimerait tout rouge de dégagement.
  const losingPed = losing.filter((g) => byId.get(g)?.type === 'pieton')
  if (losingPed.length) {
    const greenTo = phaseMovements(controller, to)
    for (const p of losingPed) {
      const group = byId.get(p)
      if (!group?.movements.some((key) => key in greenTo)) continue // rien ne rouvre : pas de dégagement dû
      let clear = 0
      for (const h of toIds) {
        const v = cell(p, h)
        if (v !== undefined && v > clear) clear = v
      }
      if (clear === 0) {
        // Aucune case vers les groupes de la phase suivante : ils étaient verts en même temps que la
        // traversée, donc déclarés compatibles au dossier. Le dégagement dû reste celui de la traversée,
        // c'est-à-dire le plus long de sa ligne — un temps de marche, indépendant du groupe qui rouvre.
        for (const v of Object.values(matrix[p] ?? {})) {
          if (typeof v === 'number' && Number.isFinite(v) && v > clear) clear = v
        }
      }
      if (clear > total) total = clear
    }
  }

  const losingVeh = losing.filter((g) => byId.get(g)?.type === 'vehicule')
  const conflicting = losingVeh.filter((g) => taking.some((h) => cell(g, h) !== undefined))
  // Le jaune vient des groupes réellement en conflit avec un groupe qui prend le vert. Quand l'inter-vert
  // est nul alors qu'un groupe véhicule s'éteint (aucune case au dossier), on conserve au moins son jaune :
  // un feu ne passe jamais du vert au rouge sans jaune.
  const jaunes = conflicting.length ? conflicting : (total === 0 ? losingVeh : [])
  let best = -1
  for (const g of jaunes) {
    const a = controller.amberByGroup?.[g]
    if (typeof a === 'number' && Number.isFinite(a) && a >= 0 && a > best) best = a
  }
  // Sans valeur exploitable au dossier, le jaune du contrôleur prend le relais (l'import le renseigne).
  const repli = Number.isFinite(controller.amber) ? Math.max(0, controller.amber) : 0
  let amber = best >= 0 ? best : (jaunes.length ? repli : 0)
  // Un jaune plus long que l'inter-vert est une incohérence du dossier : on le tronque pour que la
  // transition dure exactement l'inter-vert, et pour que le rouge intégral ne soit jamais négatif.
  // Un inter-vert nul, lui, n'est pas une incohérence : la transition s'allonge alors jusqu'au jaune.
  const truncatedAmber = amber > total && total > 0
  if (truncatedAmber) amber = total
  const span = Math.max(total, amber)
  return { amber, allRed: span - amber, total: span, matrixBased: true, truncatedAmber }
}

export const MINUTES_PER_DAY = 1440

/**
 * Heure simulée à l'instant `t` (s) d'une simulation démarrée à `startTimeOfDayMin` le jour `dayOfWeek`
 * (1 = lundi). Une simulation qui franchit minuit change de jour, ce dont dépendent les plages horaires.
 */
export function clockAt(
  startTimeOfDayMin: number,
  dayOfWeek: number,
  t: number,
): { minOfDay: number; dayOfWeek: number } {
  const start = Number.isFinite(startTimeOfDayMin) ? startTimeOfDayMin : 0
  const raw = start + (Number.isFinite(t) ? t : 0) / 60
  const days = Math.floor(raw / MINUTES_PER_DAY)
  const base = Number.isFinite(dayOfWeek) ? Math.round(dayOfWeek) : 1
  return {
    minOfDay: raw - days * MINUTES_PER_DAY,
    dayOfWeek: ((((base - 1 + days) % 7) + 7) % 7) + 1,
  }
}

/** Jour de la semaine ramené dans 1..7 (1 = lundi), un décalage négatif compris. */
function normalizeDay(dayOfWeek: number): number {
  const d = Number.isFinite(dayOfWeek) ? Math.round(dayOfWeek) : 1
  return ((((d - 1) % 7) + 7) % 7) + 1
}

/**
 * La plage couvre-t-elle cette heure ? Bornes en minutes depuis minuit, début inclus et fin exclue pour que
 * deux plages consécutives ne se recouvrent pas ; `fromMin` supérieur à `toMin` franchit minuit ;
 * `days` vide vaut tous les jours.
 *
 * Convention retenue pour les plages de nuit : **une plage appartient au jour où elle commence**. « 22 h -
 * 6 h du lundi au vendredi » désigne cinq nuits qui commencent le lundi soir et finissent le samedi matin ;
 * `days` est donc évalué sur la veille dès que l'heure courante est passée minuit (`minOfDay < toMin`).
 * Elle couvre ainsi le samedi 1 h (nuit du vendredi) et non le lundi 1 h (nuit du dimanche, hors plage) —
 * c'est la lecture des dossiers, où une plage de nuit est un seul créneau continu et non deux morceaux
 * rattachés à deux jours différents.
 */
export function scheduleCovers(entry: PlanSchedule, minOfDay: number, dayOfWeek: number): boolean {
  const from = entry.fromMin
  const to = entry.toMin
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false
  const days = entry.days
  const coversDay = (d: number): boolean => !days?.length || days.includes(normalizeDay(d))
  if (from === to) return coversDay(dayOfWeek) // plage dégénérée : le plan couvre la journée entière
  if (from < to) return minOfDay >= from && minOfDay < to && coversDay(dayOfWeek)
  if (minOfDay >= from) return coversDay(dayOfWeek) // soirée : la plage commence aujourd'hui
  // Petit matin : la plage a commencé la veille, c'est ce jour-là qui décide.
  return minOfDay < to && coversDay(dayOfWeek - 1)
}

/** Plan applicable à une heure simulée, et provenance de ce choix. */
export interface ActivePlan {
  plan: SignalPlan | undefined
  /**
   * Vrai quand le contrôleur porte un calendrier mais qu'aucune de ses plages ne couvre l'heure : le premier
   * plan s'applique par défaut, et ce n'est donc pas une plage du dossier. L'interface doit pouvoir le dire.
   */
  fallback: boolean
}

/**
 * Plan de feux applicable à une heure simulée. Sans `schedule` — ou si aucune plage ne couvre l'heure —
 * le premier plan s'applique ; sans `plans`, `undefined` : les durées portées par les phases font foi.
 * `fallback` distingue le second cas du premier, sans changer le plan retenu.
 */
export function activePlanAt(
  controller: SignalController,
  minOfDay: number,
  dayOfWeek: number,
): ActivePlan {
  const plans = controller.plans
  if (!plans?.length) return { plan: undefined, fallback: false }
  for (const entry of controller.schedule ?? []) {
    if (!scheduleCovers(entry, minOfDay, dayOfWeek)) continue
    const plan = plans.find((p) => p.id === entry.planId)
    if (plan) return { plan, fallback: false }
  }
  // Un calendrier qui laisse un trou (ou qui cite un plan inconnu) : repli sur le premier plan, signalé.
  return { plan: plans[0], fallback: !!controller.schedule?.length }
}

/** Plan de feux applicable à une heure simulée. Voir `activePlanAt` pour distinguer un repli d'une plage. */
export function activePlan(
  controller: SignalController,
  minOfDay: number,
  dayOfWeek: number,
): SignalPlan | undefined {
  return activePlanAt(controller, minOfDay, dayOfWeek).plan
}

/** Plan retenu hors de tout contexte horaire (affichage, cycle de référence) : le premier du contrôleur. */
export function defaultPlan(controller: SignalController): SignalPlan | undefined {
  return controller.plans?.[0]
}

/** Durées d'une phase sous un plan donné ; une phase absente du plan garde les siennes. */
export function planPhaseTiming(phase: SignalPhase, plan?: SignalPlan | null): Required<PlanPhaseTiming> {
  const t = plan?.phases?.[phase.id]
  return {
    green: t?.green ?? phase.green,
    minGreen: t?.minGreen ?? phase.minGreen,
    maxGreen: t?.maxGreen ?? phase.maxGreen,
    skipped: t?.skipped === true,
  }
}

/** La phase s'ouvre-t-elle dans ce plan ? Une phase désactivée est sautée sans consommer d'inter-vert. */
export function phaseRunsIn(phase: SignalPhase, plan?: SignalPlan | null): boolean {
  return plan?.phases?.[phase.id]?.skipped !== true
}

/** Phases réellement ouvertes par un plan, dans l'ordre du cycle. */
export function planPhases(controller: SignalController, plan?: SignalPlan | null): SignalPhase[] {
  const actives = controller.phases.filter((p) => phaseRunsIn(p, plan))
  // Un plan qui désactiverait toutes les phases laisserait le carrefour au rouge : on l'ignore alors.
  return actives.length ? actives : controller.phases
}

/** Phase suivante dans le cycle (la dernière enchaîne sur la première). */
function nextPhaseOf(controller: SignalController, phase: SignalPhase): SignalPhase | undefined {
  const n = controller.phases.length
  if (!n) return undefined
  let i = controller.phases.indexOf(phase)
  if (i < 0) i = controller.phases.findIndex((p) => p.id === phase.id)
  if (i < 0) return undefined
  return controller.phases[(i + 1) % n]
}

/**
 * Durée totale d'une phase : vert du plan retenu + inter-vert vers la phase suivante.
 * Sans matrice d'inter-verts ni plan, on retrouve vert + orange + rouge intégral de la phase.
 */
export function phaseDuration(
  controller: SignalController,
  phase: SignalPhase,
  plan: SignalPlan | undefined = defaultPlan(controller),
): number {
  const green = planPhaseTiming(phase, plan).green
  const next = nextPhaseOf(controller, phase)
  const tr = next
    ? phaseTransition(controller, phase, next)
    : { amber: phaseAmber(controller, phase), allRed: phaseAllRed(controller, phase) }
  return green + tr.amber + tr.allRed
}

/** Temps de cycle (s) : somme des durées de phase. 0 s'il n'y a aucune phase. */
export function controllerCycle(
  controller: SignalController,
  plan: SignalPlan | undefined = defaultPlan(controller),
): number {
  let c = 0
  for (const p of planPhases(controller, plan)) c += phaseDuration(controller, p, plan)
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
  const plan = defaultPlan(controller)
  const knownGroups = new Set((controller.groups ?? []).map((g) => g.id))
  const piloted = new Set(movements.map((m) => m.key))
  const everGreen = new Set<MovementKey>()
  /** Mouvements ouverts par un groupe véhicule mais refermés par un vert piéton dans la même phase. */
  const closedByPedestrians = new Set<MovementKey>()

  for (const p of controller.phases) {
    if (planPhaseTiming(p, plan).green <= 0) out.push(`Phase « ${p.name} » : durée de vert nulle ou négative.`)
    if (phaseAmber(controller, p) < 0 || phaseAllRed(controller, p) < 0) {
      out.push(`Phase « ${p.name} » : orange ou rouge intégral négatif.`)
    }
    if (controller.mode === 'actuated' && p.minGreen > p.maxGreen) {
      out.push(`Phase « ${p.name} » : vert minimal supérieur au vert maximal.`)
    }
    const unknown = (p.groups ?? []).filter((id) => !knownGroups.has(id))
    if (unknown.length) {
      out.push(`Phase « ${p.name} » : groupe(s) absent(s) du dossier (${unknown.join(', ')}).`)
    }
    const green = phaseMovements(controller, p)
    for (const k of Object.keys(green)) everGreen.add(k)
    // Un mouvement ouvert par un groupe véhicule mais coupé par un vert piéton n'est pas un oubli de plan.
    for (const g of phaseGreenGroups(controller, p)) {
      if (g.type !== 'vehicule') continue
      for (const k of g.movements) if (!(k in green) && piloted.has(k)) closedByPedestrians.add(k)
    }
    // Conflits entre mouvements protégés simultanés.
    const greens = movements.filter((m) => green[m.key])
    for (let i = 0; i < greens.length; i++) {
      for (let j = i + 1; j < greens.length; j++) {
        const a = greens[i]
        const b = greens[j]
        if (green[a.key] === 'protected' && green[b.key] === 'protected' && movementsConflict(a, b)) {
          out.push(`Phase « ${p.name} » : mouvements protégés en conflit (${describeMovement(network, a)} et ${describeMovement(network, b)}).`)
        }
      }
    }
  }

  // Inter-verts : un jaune plus long que l'inter-vert du dossier est tronqué, autant le dire.
  for (let i = 0; i < controller.phases.length; i++) {
    const from = controller.phases[i]
    const to = controller.phases[(i + 1) % controller.phases.length]
    const tr = phaseTransition(controller, from, to)
    if (tr.truncatedAmber) {
      out.push(`Inter-vert de « ${from.name} » vers « ${to.name} » (${tr.total} s) plus court que le jaune du dossier : jaune tronqué.`)
    }
  }

  const never = movements.filter((m) => !everGreen.has(m.key))
  const blocked = never.filter((m) => closedByPedestrians.has(m.key))
  const orphans = never.filter((m) => !closedByPedestrians.has(m.key))
  if (orphans.length) {
    out.push(`${orphans.length} mouvement(s) jamais au vert : ${orphans.slice(0, 3).map((m) => describeMovement(network, m)).join(', ')}${orphans.length > 3 ? '…' : ''}.`)
  }
  if (blocked.length) {
    out.push(`${blocked.length} mouvement(s) fermé(s) par un vert piéton à chaque phase : ${blocked.slice(0, 3).map((m) => describeMovement(network, m)).join(', ')}${blocked.length > 3 ? '…' : ''}.`)
  }

  // Plans horaires : durées, phases citées et plages.
  const phaseIds = new Set(controller.phases.map((p) => p.id))
  for (const pl of controller.plans ?? []) {
    for (const id of Object.keys(pl.phases ?? {})) {
      if (!phaseIds.has(id)) out.push(`Plan « ${pl.name} » : phase inconnue (${id}).`)
    }
    const cycle = controllerCycle(controller, pl)
    if (cycle <= 0) out.push(`Plan « ${pl.name} » : temps de cycle nul.`)
    else if (pl.cycle > 0 && Math.abs(cycle - pl.cycle) > 0.5) {
      out.push(`Plan « ${pl.name} » : somme des durées ${Math.round(cycle)} s, temps de cycle annoncé ${pl.cycle} s.`)
    }
  }
  const planIds = new Set((controller.plans ?? []).map((p) => p.id))
  for (const s of controller.schedule ?? []) {
    if (!planIds.has(s.planId)) out.push(`Plage horaire : plan inconnu (${s.planId}).`)
  }
  if (!controller.plans?.length && controllerCycle(controller) <= 0) out.push('Temps de cycle nul.')
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
 * Exception : un contrôleur issu d'un dossier de carrefour (il porte des groupes de signaux) n'est jamais
 * modifié. Ses phases sont écrites en groupes, ses inter-verts sont calés sur eux : un mouvement ajouté à la
 * main y serait soit sans effet, soit contraire au dossier — notamment s'il traverse un vert piéton. Ces
 * mouvements sont comptés dans `skipped` et signalés par `validateController`.
 *
 * Renvoie le réseau reçu à l'identique si rien n'était à compléter (l'identité des objets est préservée
 * pour ne pas invalider les caches d'affichage).
 */
export function completeSignalPlans(
  network: Network,
  adjacency?: Adjacency,
): { network: Network; added: number; skipped: number } {
  const controllers = Object.values(network.controllers)
  if (!controllers.length) return { network, added: 0, skipped: 0 }
  const adj = adjacency ?? buildAdjacency(network)
  const suivants: Record<ControllerId, SignalController> = {}
  let added = 0
  let skipped = 0

  for (const controller of controllers) {
    const movements = controllerMovements(network, controller, adj)
    if (!movements.length) continue
    const parCle = new Map<MovementKey, Movement>()
    for (const m of movements) parCle.set(m.key, m)

    const couverts = new Set<MovementKey>()
    for (const phase of controller.phases) {
      for (const key of Object.keys(phaseMovements(controller, phase))) couverts.add(key)
    }
    const manquants = movements.filter((m) => !couverts.has(m.key))
    if (!manquants.length) continue
    if (controller.groups?.length) {
      skipped += manquants.length
      continue
    }

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

  if (!added) return { network, added: 0, skipped }
  return { network: { ...network, controllers: { ...network.controllers, ...suivants } }, added, skipped }
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
