/**
 * Panneau « Feux » : liste des contrôleurs, éditeur de plan (mode, décalage, orange, rouge intégral),
 * cartes de phases avec le schéma du carrefour cliquable et diagramme temporel du cycle.
 *
 * Le schéma place chaque approche à son `approachAngle` et chaque sortie à son `exitAngle` (src/model/geometry.ts) ;
 * un mouvement est une courbe de Bézier de l'une vers l'autre, dont un clic fait tourner l'état
 * rouge → protégé → permis.
 *
 * S'y ajoute ce qu'un dossier de carrefour réel apporte (docs/ARCHITECTURE.md §14) : import du dossier du
 * carrefour sélectionné, origine des réglages, groupes de signaux, choix du plan de feux et matrice
 * d'inter-verts. Ces blocs n'apparaissent que lorsque le contrôleur porte les données correspondantes :
 * un plan créé dans l'éditeur s'affiche exactement comme avant.
 */
import { useId, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { useAppStore } from '@/state/store'
import type {
  ControllerId, GreenKind, MovementKey, Network, NodeId, SignalController, SignalGroup, SignalPhase, SignalPlan,
} from '@/model/types'
import type { Movement } from '@/model/geometry'
import {
  activePlan, clockAt, controllerCycle, controllerMovements, describeMovement, phaseDuration, phaseMovements,
  phasePedestrianYields, phaseTransition, planPhaseTiming, validateController,
} from '@/model/signals'
import { ChampRecherche } from '@/ui/components/ChampRecherche'
import { NumberField } from '@/ui/components/NumberField'
import { SEUIL_RECHERCHE, filtrer } from '@/ui/components/recherche'
import { DAY_LABELS, GREEN_KIND_LABELS, S, SIGNAL_MODE_LABELS, formatNumber, formatTimeOfDay } from '@/ui/strings'

const SIGNAL_MODES: SignalController['mode'][] = ['fixed', 'actuated', 'flashing', 'off']

/** Heure simulée : instant du jour et jour de la semaine à l'instant courant de la simulation. */
interface Horloge {
  minOfDay: number
  dayOfWeek: number
}

/**
 * Plan de feux à afficher : celui imposé par l'utilisateur s'il existe encore, sinon celui que le calendrier
 * horaire désigne à l'heure simulée. `undefined` pour un contrôleur sans plan (cas de l'éditeur).
 */
function planAffiche(
  controller: SignalController,
  planApercu: Record<ControllerId, string>,
  horloge: Horloge,
): SignalPlan | undefined {
  const impose = controller.plans?.find((p) => p.id === planApercu[controller.id])
  return impose ?? activePlan(controller, horloge.minOfDay, horloge.dayOfWeek)
}

export function FeuxPanel(): JSX.Element {
  const network = useAppStore((s) => s.project?.network)
  const selection = useAppStore((s) => s.selection)
  const startTimeOfDayMin = useAppStore((s) => s.project?.settings.startTimeOfDayMin ?? 0)
  const dayOfWeek = useAppStore((s) => s.project?.settings.dayOfWeek ?? 1)
  const planApercu = useAppStore((s) => s.ui.planApercu)
  // L'heure simulée n'est lue qu'à la minute près : sans cela le panneau se redessinerait à chaque frame.
  const minutesEcoulees = useAppStore((s) => Math.floor(s.sim.time / 60))
  const horloge = clockAt(startTimeOfDayMin, dayOfWeek, minutesEcoulees * 60)

  const controllers = useMemo(
    () => (network ? Object.values(network.controllers).sort((a, b) => a.name.localeCompare(b.name, 'fr')) : []),
    [network],
  )

  // La recherche porte aussi sur les rues qui se croisent au carrefour : l'exploitant connaît « son »
  // carrefour par ses voies, rarement par le nom du contrôleur.
  const [recherche, setRecherche] = useState('')
  const controllersVus = useMemo(
    () => (network
      ? filtrer(controllers, recherche, (c) => [c.name, ...c.nodeIds.map((id) => nomDeNoeud(network, id))])
      : controllers),
    [controllers, network, recherche],
  )

  if (!network) return <div className="panel"><p className="hint">{S.app.aucunProjet}</p></div>

  const activeId = selection?.kind === 'controller'
    ? selection.id
    : selection?.kind === 'node' ? network.controls[selection.id]?.controllerId : undefined
  const active = activeId ? network.controllers[activeId] : undefined

  return (
    <div className="panel">
      <section className="block">
        <h2>{S.feux.titre}</h2>
        {controllers.length >= SEUIL_RECHERCHE ? (
          <ChampRecherche value={recherche} onChange={setRecherche} label={S.feux.liste} testId="recherche-feux" />
        ) : null}
        {!controllersVus.length && controllers.length ? <p className="hint">{S.recherche.aucune}</p> : null}
        {controllers.length ? (
          <ul className="list">
            {controllersVus.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`list-row${c.id === activeId ? ' active' : ''}`}
                  onClick={() => useAppStore.getState().select({ kind: 'controller', id: c.id }, { reveal: true })}
                >
                  <span className="list-main">{c.name}</span>
                  <span className="list-side">
                    {SIGNAL_MODE_LABELS[c.mode]} · {S.feux.cycle}{' '}
                    {formatNumber(controllerCycle(c, planAffiche(c, planApercu, horloge)))} {S.unites.s}
                    {c.nodeIds.length > 1 ? ` · ${c.nodeIds.length} ${S.feux.noeuds}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{S.feux.aucun}</p>
        )}
      </section>
      {active ? (
        <ControllerEditor
          network={network}
          controller={active}
          horloge={horloge}
          plan={planAffiche(active, planApercu, horloge)}
          planImpose={planApercu[active.id] ?? null}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Carrefour regroupé : les nœuds pilotés par le contrôleur           */
/* ------------------------------------------------------------------ */

/** Nom d'un nœud pour l'exploitant : son étiquette, sinon les rues qui s'y croisent. */
function nomDeNoeud(network: Network, nodeId: NodeId): string {
  const node = network.nodes[nodeId]
  if (node?.label) return node.label
  const rues = new Set<string>()
  for (const e of Object.values(network.edges)) {
    if ((e.from === nodeId || e.to === nodeId) && e.name) rues.add(e.name)
  }
  return [...rues].slice(0, 3).join(' / ') || nodeId
}

/**
 * Nœuds du réseau que ce contrôleur peut absorber : ses voisins directs, hors bord de commune.
 *
 * Une armoire réelle commande un carrefour d'un seul tenant ; regrouper deux nœuds qui ne se touchent
 * pas donnerait un « carrefour » dont les mouvements ne s'enchaînent pas. Un voisin déjà à feux reste
 * proposé — c'est le cas de deux carrefours voisins repris par une même armoire — mais il est annoncé
 * comme tel, car son propre contrôleur y perdra ce nœud.
 */
function voisinsRegroupables(network: Network, controller: SignalController): NodeId[] {
  const dedans = new Set(controller.nodeIds)
  const out = new Set<NodeId>()
  for (const e of Object.values(network.edges)) {
    if (dedans.has(e.from) && !dedans.has(e.to) && !network.nodes[e.to]?.boundary) out.add(e.to)
    if (dedans.has(e.to) && !dedans.has(e.from) && !network.nodes[e.from]?.boundary) out.add(e.from)
  }
  return [...out].sort((a, b) => nomDeNoeud(network, a).localeCompare(nomDeNoeud(network, b), 'fr'))
}

function CarrefourRegroupe({ network, controller }: { network: Network; controller: SignalController }): JSX.Element {
  const voisins = useMemo(() => voisinsRegroupables(network, controller), [network, controller])
  const [choix, setChoix] = useState<NodeId>('')
  const cible = voisins.includes(choix) ? choix : voisins[0] ?? ''
  const store = useAppStore.getState()

  return (
    <>
      <h4>{S.feux.regroupement} · {formatNumber(controller.nodeIds.length)} {S.feux.noeuds}</h4>
      <p className="hint">{S.feux.regroupementAide}</p>
      <p className="field-label">{S.feux.regroupementNoeuds}</p>
      <ul className="list">
        {controller.nodeIds.map((nodeId) => (
          <li key={nodeId} className="list-item">
            <button
              type="button"
              className="list-row"
              onClick={() => store.select({ kind: 'node', id: nodeId }, { reveal: true })}
              onMouseEnter={() => store.setHover({ kind: 'node', id: nodeId })}
              onMouseLeave={() => store.setHover(null)}
            >
              <span className="list-main">{nomDeNoeud(network, nodeId)}</span>
              <span className="list-side">{S.feux.selectionner}</span>
            </button>
            <button
              type="button"
              className="button"
              data-testid={`retirer-noeud-${nodeId}`}
              disabled={controller.nodeIds.length < 2}
              title={controller.nodeIds.length < 2 ? S.feux.regroupementRetirerAide : undefined}
              onClick={() => store.setControllerNodes(controller.id, controller.nodeIds.filter((n) => n !== nodeId))}
            >
              {S.feux.regroupementRetirer}
            </button>
          </li>
        ))}
      </ul>
      {voisins.length ? (
        <div className="row">
          <label className="field">
            <span className="field-label">{S.feux.regroupementVoisins}</span>
            <select value={cible} data-testid="voisin-a-regrouper" onChange={(e) => setChoix(e.target.value)}>
              {voisins.map((nodeId) => (
                <option key={nodeId} value={nodeId}>
                  {nomDeNoeud(network, nodeId)}
                  {network.controls[nodeId]?.type === 'signals' ? ` (${S.feux.regroupementDejaFeux})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            data-testid="ajouter-noeud"
            onClick={() => { if (cible) store.setControllerNodes(controller.id, [...controller.nodeIds, cible]) }}
          >
            {S.feux.regroupementAjouter}
          </button>
        </div>
      ) : (
        <p className="hint">{S.feux.regroupementAucunVoisin}</p>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Import du dossier du carrefour sélectionné                         */
/* ------------------------------------------------------------------ */

/**
 * Charge sur CE carrefour le fichier de son dossier. C'est l'exploitant qui désigne le carrefour, en le
 * sélectionnant sur la carte : l'application ne cherche plus à reconnaître aux noms de rues quel carrefour
 * un dossier décrit, faute de pouvoir trancher sans lui dans la majorité des cas (§14.3).
 */
function DossierImport({ controller }: { controller: SignalController }): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  // Le bilan vient du store et non d'un état local : changer d'onglet démonte ce panneau, et l'exploitant
  // doit pouvoir revenir lire les réserves de l'import après avoir regardé son carrefour sur la carte.
  const rapport = useAppStore((s) => s.dossierRapport)
  // Le bilan d'un autre carrefour ne le concerne pas : il resterait affiché sous un plan qu'il ne décrit pas.
  const bilan = rapport?.controllerId === controller.id ? rapport : null

  return (
    <>
      <h4>{S.feux.dossier}</h4>
      <p className="hint">{S.feux.dossierAide}</p>
      <div className="row">
        <button type="button" className="button" data-testid="importer-dossier" onClick={() => fileRef.current?.click()}>
          {S.feux.dossierImporter}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const fichier = e.target.files?.[0]
          // Le champ est vidé tout de suite pour qu'un second import du même fichier déclenche bien `change`.
          e.target.value = ''
          if (!fichier) return
          void fichier.text().then((texte) => useAppStore.getState().importDossierFeux(controller.id, texte))
        }}
      />
      {bilan ? (
        <div className="report">
          <strong>{S.feux.dossierBilan}</strong>
          <ul>
            {bilan.applique
              ? <li>{S.feux.dossierApplique} {bilan.dossierId} · {formatNumber(bilan.groupes)} {S.feux.dossierGroupes}</li>
              : <li>{S.feux.dossierEchec}</li>}
          </ul>
          {bilan.avertissements.length ? (
            <>
              <p className="hint">{S.feux.dossierReserves}</p>
              <ul className="warnings">
                {bilan.avertissements.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Éditeur d'un contrôleur                                            */
/* ------------------------------------------------------------------ */

function ControllerEditor(props: {
  network: Network
  controller: SignalController
  horloge: Horloge
  plan: SignalPlan | undefined
  planImpose: string | null
}): JSX.Element {
  const { network, controller, horloge, plan, planImpose } = props
  const movements = useMemo(() => controllerMovements(network, controller), [network, controller])
  const anomalies = useMemo(() => validateController(network, controller), [network, controller])
  // Phase en cours dans la simulation : sélecteur scalaire, l'éditeur ne se redessine qu'au changement de phase.
  const currentPhase = useAppStore((s) => s.sim.frame?.controllers.find((c) => c.id === controller.id)?.phaseIndex ?? -1)
  const cycle = controllerCycle(controller, plan)
  const update = useAppStore.getState().updateController

  return (
    <section className="block">
      <h3>{controller.name}</h3>
      {controller.source ? <p className="hint">{S.feux.origine} : {controller.source}</p> : null}
      <label className="field">
        <span className="field-label">{S.reseau.label}</span>
        <span className="field-input">
          <input type="text" value={controller.name} onChange={(e) => update(controller.id, { name: e.target.value })} />
        </span>
      </label>
      <label className="field">
        <span className="field-label">{S.feux.mode}</span>
        <select
          value={controller.mode}
          data-testid="mode-feux"
          onChange={(e) => update(controller.id, { mode: e.target.value as SignalController['mode'] })}
        >
          {SIGNAL_MODES.map((m) => <option key={m} value={m}>{SIGNAL_MODE_LABELS[m]}</option>)}
        </select>
      </label>
      <div className="row">
        {/* Un plan de feux porte son propre décalage : le moteur ignore alors celui du contrôleur. */}
        <NumberField label={S.feux.decalage} value={plan ? plan.offset : controller.offset} min={0} unit={S.unites.s} disabled={!!plan} onChange={(v) => update(controller.id, { offset: v })} />
        <NumberField label={S.feux.orange} value={controller.amber} min={0} max={10} step={0.5} unit={S.unites.s} onChange={(v) => update(controller.id, { amber: v })} />
        <NumberField label={S.feux.rougeIntegral} value={controller.allRed} min={0} max={10} step={0.5} unit={S.unites.s} onChange={(v) => update(controller.id, { allRed: v })} />
      </div>
      {plan ? <p className="hint">{S.feux.planDecalage}</p> : null}
      {controller.mode === 'actuated' ? (
        <label className="check">
          <input
            type="checkbox"
            checked={controller.actuated.skipEmpty}
            onChange={(e) => update(controller.id, { actuated: { skipEmpty: e.target.checked } })}
          />
          {S.feux.sauterPhases}
        </label>
      ) : null}

      <CarrefourRegroupe network={network} controller={controller} />
      <DossierImport controller={controller} />

      <PlanSelector controller={controller} horloge={horloge} planImpose={planImpose} />
      <GroupList controller={controller} />
      <InterGreenTable controller={controller} />

      <h4>{S.feux.diagramme} · {formatNumber(cycle)} {S.unites.s}</h4>
      <CycleDiagram controller={controller} plan={plan} currentPhase={currentPhase} />

      <h4>{S.feux.anomalies}</h4>
      {anomalies.length ? (
        <ul className="warnings">{anomalies.map((a, i) => <li key={i}>{a}</li>)}</ul>
      ) : (
        <p className="hint">{S.feux.aucuneAnomalie}</p>
      )}

      <h4>{S.feux.phases}</h4>
      {!movements.length ? <p className="hint">{S.feux.mouvementsAucun}</p> : null}
      {controller.phases.map((phase, index) => (
        <PhaseCard
          key={phase.id}
          network={network}
          controller={controller}
          phase={phase}
          plan={plan}
          index={index}
          movements={movements}
          current={index === currentPhase}
        />
      ))}
      <div className="row">
        <button type="button" className="button" onClick={() => useAppStore.getState().addPhase(controller.id)}>{S.feux.ajouterPhase}</button>
        {/* Même action : revenir au plan par défaut détache le dossier, puisque ses groupes, ses plans et
            ses inter-verts décrivent les phases qui disparaissent. Le libellé le dit quand c'est le cas. */}
        <button
          type="button"
          className="button"
          onClick={() => {
            const message = controller.source ? S.feux.confirmerDetacher : S.feux.confirmerRegenerer
            if (confirm(message)) useAppStore.getState().resetControllerPlan(controller.id)
          }}
        >
          {controller.source ? S.feux.detacherDossier : S.feux.regenerer}
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Plans horaires, groupes et inter-verts (dossiers de carrefour)     */
/* ------------------------------------------------------------------ */

/** Période d'un plan : celle du dossier si elle y figure, sinon les plages du calendrier qui le désignent. */
function periodeDuPlan(controller: SignalController, plan: SignalPlan): string {
  if (plan.period) return plan.period
  const plages = (controller.schedule ?? []).filter((s) => s.planId === plan.id)
  if (!plages.length) return S.feux.planPeriodeInconnue
  return plages
    .map((s) => {
      const heures = `${formatTimeOfDay(s.fromMin)} – ${formatTimeOfDay(s.toMin)}`
      return s.days.length ? `${heures} (${s.days.map((d) => DAY_LABELS[d]).join(', ')})` : heures
    })
    .join(' ; ')
}

/**
 * Choix du plan de feux. L'heure et le jour simulés se règlent dans l'onglet Trafic, avec les autres
 * réglages de simulation : ils valent pour toute la commune (§14.4). Ils sont rappelés ici, en lecture
 * seule, parce que c'est ici qu'on lit leur effet — le plan que le calendrier du carrefour désigne.
 */
function PlanSelector(props: {
  controller: SignalController
  horloge: Horloge
  planImpose: string | null
}): JSX.Element | null {
  const { controller, horloge, planImpose } = props
  const plans = controller.plans
  if (!plans?.length) return null
  const store = useAppStore.getState()
  // Plan que le calendrier désigne à l'heure simulée : affiché même lorsqu'un plan est imposé, pour que
  // l'écart entre ce que fait le carrefour dans la réalité et ce qu'on lui impose reste visible.
  const calendrier = activePlan(controller, horloge.minOfDay, horloge.dayOfWeek)

  return (
    <>
      <h4>{S.feux.plans}</h4>
      {plans.length > 1 ? (
        <label className="field">
          <span className="field-label">{S.feux.planSelection}</span>
          <select
            value={planImpose ?? ''}
            data-testid="plan-feux"
            onChange={(e) => store.setActivePlan(controller.id, e.target.value || null)}
          >
            <option value="">{S.feux.planCalendrier}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {periodeDuPlan(controller, p)}</option>
            ))}
          </select>
        </label>
      ) : (
        <p className="hint">{S.feux.planUnique} : {plans[0].name} · {periodeDuPlan(controller, plans[0])}</p>
      )}
      <p className="hint">
        {S.feux.planActif} {formatTimeOfDay(horloge.minOfDay)} ({DAY_LABELS[horloge.dayOfWeek]}) :{' '}
        {calendrier ? `${calendrier.name} · ${periodeDuPlan(controller, calendrier)}` : '—'}
      </p>
      <p className="hint">{planImpose ? S.feux.planImpose : S.feux.planCalendrierAide}</p>
      <p className="hint">{S.feux.heureSimuleeRappel}</p>
    </>
  )
}

/**
 * Groupes de signaux du dossier ; les groupes piétons se distinguent, leur vert retirant la protection des
 * mouvements qui franchissent leur traversée sans jamais les fermer (§14.5).
 */
function GroupList({ controller }: { controller: SignalController }): JSX.Element | null {
  const groups = controller.groups
  if (!groups?.length) return null
  return (
    <>
      <h4>{S.feux.groupes}</h4>
      <ul className="list groupes">
        {groups.map((g: SignalGroup) => (
          <li key={g.id} className={`list-item groupe${g.type === 'pieton' ? ' pieton' : ''}`}>
            <span className="groupe-id">{g.id}</span>
            <span className="groupe-type">{g.type === 'pieton' ? S.feux.groupePieton : S.feux.groupeVehicule}</span>
            <span className="list-main">{g.label ?? S.feux.groupeSansVoie}</span>
            <span className="list-side">
              {g.movements.length
                ? `${formatNumber(g.movements.length)} ${S.feux.groupeMouvements}`
                : S.feux.groupeAucunMouvement}
            </span>
            {g.recall ? <span className="badge" title={S.feux.groupeRappelAide}>{S.feux.groupeRappel}</span> : null}
          </li>
        ))}
      </ul>
      {/* La réserve suit l'explication : dire qu'un mouvement reste vert sans dire que sa capacité est
          alors majorée laisserait lire les débits simulés pour argent comptant. */}
      {groups.some((g) => g.type === 'pieton') ? (
        <>
          <p className="hint">{S.feux.groupePietonAide}</p>
          <p className="hint">{S.feux.groupePietonReserve}</p>
        </>
      ) : null}
    </>
  )
}

/**
 * Matrice d'inter-verts en lecture seule : lignes = groupes qui perdent le vert, colonnes = groupes qui le
 * prennent. Une case vide n'est pas une valeur manquante mais deux groupes compatibles (§14.3).
 */
function InterGreenTable({ controller }: { controller: SignalController }): JSX.Element | null {
  const matrix = controller.interGreen
  if (!matrix || !Object.keys(matrix).length) return null
  const groups = controller.groups ?? []
  // À défaut de groupes déclarés, les identifiants de la matrice suffisent à en dresser le tableau.
  const ids = groups.length
    ? groups.map((g) => g.id)
    : [...new Set([...Object.keys(matrix), ...Object.values(matrix).flatMap((row) => Object.keys(row))])]
  const pietons = new Set(groups.filter((g) => g.type === 'pieton').map((g) => g.id))
  // Colonne « jaune » seulement si le dossier en donne : une colonne entièrement vide n'apprend rien.
  const amber = Object.keys(controller.amberByGroup ?? {}).length ? controller.amberByGroup : undefined

  return (
    <>
      <h4>{S.feux.intervertsTitre}</h4>
      <div className="table-wrap scroll">
        <table className="data-table matrix intervert">
          <thead>
            <tr>
              <th scope="col" />
              {ids.map((id) => (
                <th key={id} scope="col" className={pietons.has(id) ? 'pieton' : undefined}>{id}</th>
              ))}
              {amber ? <th scope="col">{S.feux.intervertJaune}</th> : null}
            </tr>
          </thead>
          <tbody>
            {ids.map((from) => (
              <tr key={from}>
                <th scope="row" className={pietons.has(from) ? 'pieton' : undefined}>{from}</th>
                {ids.map((to) => {
                  const value = from === to ? undefined : matrix[from]?.[to]
                  return <td key={to}>{typeof value === 'number' ? formatNumber(value, value % 1 ? 1 : 0) : ''}</td>
                })}
                {amber ? <td>{typeof amber[from] === 'number' ? formatNumber(amber[from]) : ''}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">{S.feux.intervertsAide}</p>
      <p className="hint">{S.feux.intervertsRemplacent}</p>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Carte d'une phase                                                  */
/* ------------------------------------------------------------------ */

function PhaseCard(props: {
  network: Network
  controller: SignalController
  phase: SignalPhase
  plan: SignalPlan | undefined
  index: number
  movements: Movement[]
  current: boolean
}): JSX.Element {
  const { network, controller, phase, plan, index, movements, current } = props
  const store = useAppStore.getState()
  const actuated = controller.mode === 'actuated'
  // Durées du plan retenu : une phase que le plan décrit n'est pas modifiable ici, sans quoi le champ
  // afficherait une valeur (celle du plan) et en écrirait une autre (celle de la phase).
  const timing = planPhaseTiming(phase, plan)
  const imposeParPlan = !!plan?.phases?.[phase.id]
  // Phase écrite en groupes (dossier de carrefour) : les verts se déduisent des groupes véhicules ouverts,
  // une traversée verte de la même phase déclassant en « permis » les mouvements qu'elle franchit sans les
  // fermer (§14.5). Les modifier mouvement par mouvement n'aurait aucun effet, le schéma est donc en
  // lecture seule.
  const parGroupes = !!phase.groups?.length && !!controller.groups?.length
  const verts = parGroupes ? phaseMovements(controller, phase) : phase.movements
  // Le « permis » d'un mouvement dérivé des groupes n'est pas lisible sur le schéma : sans cette note, un
  // technicien ne peut pas savoir si la cession vise le flux d'en face ou la traversée piétonne.
  const cedeAuxPietons = parGroupes && phasePedestrianYields(controller, phase).length > 0

  return (
    <article className={`phase-card${current ? ' current' : ''}`}>
      <header>
        <input
          type="text"
          className="phase-name"
          value={phase.name}
          aria-label={S.feux.nomPhase}
          onChange={(e) => store.updatePhase(controller.id, phase.id, { name: e.target.value })}
        />
        {current ? <span className="badge">{S.feux.phaseCourante}</span> : null}
        <button type="button" className="icon-button" title={S.feux.monter} aria-label={S.feux.monter} onClick={() => store.movePhase(controller.id, phase.id, -1)}>↑</button>
        <button type="button" className="icon-button" title={S.feux.descendre} aria-label={S.feux.descendre} onClick={() => store.movePhase(controller.id, phase.id, 1)}>↓</button>
        <button type="button" className="icon-button danger" title={S.feux.supprimerPhase} aria-label={S.feux.supprimerPhase} onClick={() => store.removePhase(controller.id, phase.id)}>×</button>
      </header>
      <div className="row">
        <NumberField
          label={S.feux.vert}
          value={timing.green}
          min={0}
          unit={S.unites.s}
          disabled={actuated || imposeParPlan}
          onChange={(v) => store.updatePhase(controller.id, phase.id, { green: v })}
        />
        {actuated ? (
          <>
            <NumberField label={S.feux.vertMin} value={timing.minGreen} min={1} unit={S.unites.s} disabled={imposeParPlan} onChange={(v) => store.updatePhase(controller.id, phase.id, { minGreen: v })} />
            <NumberField label={S.feux.vertMax} value={timing.maxGreen} min={1} unit={S.unites.s} disabled={imposeParPlan} onChange={(v) => store.updatePhase(controller.id, phase.id, { maxGreen: v })} />
            <NumberField label={S.feux.prolongation} value={phase.gap} min={0} step={0.5} unit={S.unites.s} onChange={(v) => store.updatePhase(controller.id, phase.id, { gap: v })} />
          </>
        ) : null}
      </div>
      {imposeParPlan && plan ? <p className="hint">{S.feux.planDurees} « {plan.name} »</p> : null}
      <IntersectionDiagram
        network={network}
        movements={movements}
        greens={verts}
        readOnly={parGroupes}
        onToggle={(key, kind) => store.setPhaseMovement(controller.id, phase.id, key, kind)}
      />
      <p className="hint">{parGroupes ? S.feux.schemaGroupes : S.feux.schema} · {index + 1}/{controller.phases.length}</p>
      {cedeAuxPietons ? <p className="hint">{S.feux.schemaGroupesPietons}</p> : null}
    </article>
  )
}

/* ------------------------------------------------------------------ */
/*  Schéma du carrefour                                                */
/* ------------------------------------------------------------------ */

const SIZE = 240
const CENTER = SIZE / 2
/** Rayon des extrémités de flèche, du bord du carrefour, des amorces de voirie et des étiquettes. */
const R_ARROW = 92
const R_INNER = 32
const R_STUB = 108
const R_TEXT = 114
/** Position du point de contrôle de Bézier, en fraction de la distance au centre, selon le type de mouvement. */
const CONTROL_FACTOR: Record<Movement['turn'], number> = { through: 0.5, right: 0.45, left: 1.1, uturn: 1.45 }
const MOVEMENT_STATES: (GreenKind | null)[] = [null, 'protected', 'permitted']

/** Repère mathématique (y vers le nord) → repère SVG (y vers le bas). */
function point(angle: number, radius: number): [number, number] {
  return [CENTER + radius * Math.cos(angle), CENTER - radius * Math.sin(angle)]
}

function movementPath(m: Movement): string {
  const [x1, y1] = point(m.inAngle, R_ARROW)
  const [x2, y2] = point(m.outAngle, R_ARROW)
  const k = CONTROL_FACTOR[m.turn]
  const c1x = x1 + (CENTER - x1) * k
  const c1y = y1 + (CENTER - y1) * k
  const c2x = x2 + (CENTER - x2) * k
  const c2y = y2 + (CENTER - y2) * k
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

function stateClass(kind: GreenKind | undefined): string {
  if (kind === 'protected') return 'protege'
  if (kind === 'permitted') return 'permis'
  return 'rouge'
}

function IntersectionDiagram(props: {
  network: Network
  movements: Movement[]
  /** Verts effectifs de la phase, par mouvement (absent = rouge). */
  greens: Record<MovementKey, GreenKind>
  readOnly: boolean
  onToggle(key: MovementKey, kind: GreenKind | null): void
}): JSX.Element {
  const { network, movements, greens, readOnly, onToggle } = props
  const markerPrefix = useId().replace(/[^a-zA-Z0-9]/g, '')

  // Amorces de voirie : un trait par angle d'approche et de sortie (les deux voies d'une rue forment un V).
  const stubs = useMemo(() => {
    const seen = new Map<string, { angle: number; label: string; approach: boolean }>()
    for (const m of movements) {
      const inName = network.edges[m.from]?.name ?? ''
      const outName = network.edges[m.to]?.name ?? ''
      const inKey = `i${m.from}`
      const outKey = `o${m.to}`
      if (!seen.has(inKey)) seen.set(inKey, { angle: m.inAngle, label: inName, approach: true })
      if (!seen.has(outKey)) seen.set(outKey, { angle: m.outAngle, label: outName, approach: false })
    }
    return [...seen.values()]
  }, [movements, network])

  const approachCount = stubs.filter((s) => s.approach).length

  return (
    <svg className="carrefour" viewBox={`${-18} ${-18} ${SIZE + 36} ${SIZE + 36}`} role="group" aria-label={S.feux.schema}>
      <defs>
        {(['rouge', 'protege', 'permis'] as const).map((name) => (
          <marker key={name} id={`${markerPrefix}-${name}`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path className={`pointe ${name}`} d="M0 0 L8 4 L0 8 z" />
          </marker>
        ))}
      </defs>
      <circle className="chaussee" cx={CENTER} cy={CENTER} r={R_INNER} />
      {stubs.map((stub, i) => {
        const [x1, y1] = point(stub.angle, R_INNER)
        const [x2, y2] = point(stub.angle, R_STUB)
        const [tx, ty] = point(stub.angle, R_TEXT)
        const anchor = Math.abs(Math.cos(stub.angle)) < 0.3 ? 'middle' : Math.cos(stub.angle) > 0 ? 'start' : 'end'
        return (
          <g key={i}>
            <line className="amorce" x1={x1} y1={y1} x2={x2} y2={y2} />
            {stub.approach && stub.label && approachCount <= 4 ? (
              <text className="amorce-label" x={tx} y={ty + 3} textAnchor={anchor}>
                {stub.label.length > 12 ? `${stub.label.slice(0, 11)}…` : stub.label}
              </text>
            ) : null}
          </g>
        )
      })}
      {movements.map((m) => {
        const kind = greens[m.key]
        const css = stateClass(kind)
        const next = MOVEMENT_STATES[(MOVEMENT_STATES.indexOf(kind ?? null) + 1) % MOVEMENT_STATES.length]
        const d = movementPath(m)
        const description = `${describeMovement(network, m)} — ${kind ? GREEN_KIND_LABELS[kind] : S.feux.rouge}`
        const interactif = readOnly
          ? {}
          : {
              onClick: () => onToggle(m.key, next),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(m.key, next) }
              },
              role: 'button',
              tabIndex: 0,
            }
        return (
          <g key={m.key} className={`mouvement${readOnly ? ' fige' : ''}`} {...interactif}>
            <title>{description}</title>
            <path className="cible" d={d} />
            <path className={`fleche ${css}`} d={d} markerEnd={`url(#${markerPrefix}-${css})`} />
          </g>
        )
      })}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  Diagramme temporel du cycle                                        */
/* ------------------------------------------------------------------ */

function CycleDiagram(props: {
  controller: SignalController
  plan: SignalPlan | undefined
  currentPhase: number
}): JSX.Element {
  const { controller, plan, currentPhase } = props
  const cycle = controllerCycle(controller, plan)
  if (!controller.phases.length || cycle <= 0) return <p className="hint">{S.feux.aucunePhase}</p>
  let start = 0
  return (
    <div className="cycle-diagram">
      {controller.phases.map((phase, i) => {
        const green = planPhaseTiming(phase, plan).green
        // L'inter-vert dépend de la phase suivante quand le contrôleur porte une matrice (§14.3) ; la
        // dernière phase enchaîne sur la première.
        const suivante = controller.phases[(i + 1) % controller.phases.length]
        const { amber, allRed } = phaseTransition(controller, phase, suivante)
        const offset = start
        start += phaseDuration(controller, phase, plan)
        const pct = (v: number): string => `${(v / cycle) * 100}%`
        return (
          <div className={`cycle-row${i === currentPhase ? ' current' : ''}`} key={phase.id}>
            <span className="cycle-label" title={phase.name}>{phase.name}</span>
            <span className="cycle-track">
              <span className="cycle-bar vert" style={{ left: pct(offset), width: pct(green) }} title={`${S.feux.vert} ${formatNumber(green)} ${S.unites.s}`} />
              <span className="cycle-bar orange" style={{ left: pct(offset + green), width: pct(amber) }} title={`${S.feux.orange} ${formatNumber(amber)} ${S.unites.s}`} />
              <span className="cycle-bar rouge" style={{ left: pct(offset + green + amber), width: pct(allRed) }} title={`${S.feux.rougeIntegral} ${formatNumber(allRed)} ${S.unites.s}`} />
            </span>
            <span className="cycle-value">{formatNumber(green)} {S.unites.s}</span>
          </div>
        )
      })}
    </div>
  )
}
