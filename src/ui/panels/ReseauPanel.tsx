/**
 * Panneau « Réseau » : édition de l'élément sélectionné sur la carte (nœud ou tronçon) et outils à deux clics.
 *
 * Le contenu dépend de la sélection : régulation, approches qui cèdent le passage et matrice des mouvements
 * autorisés pour un nœud ; attributs, sens et fermeture pour un tronçon.
 */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '@/state/store'
import type { ControlType, EdgeId, HighwayClass, NetEdge, Network, NodeId } from '@/model/types'
import { HIGHWAY_CLASSES } from '@/model/types'
import { effectiveControl } from '@/model/defaults'
import { buildAdjacency } from '@/model/geometry'
import { NumberField } from '@/ui/components/NumberField'
import { CONTROL_LABELS, HIGHWAY_LABELS, S, formatNumber } from '@/ui/strings'

const CONTROL_TYPES: ControlType[] = ['priority_class', 'priority_right', 'give_way', 'stop', 'signals', 'roundabout']

function edgeLabel(edge: NetEdge | undefined): string {
  if (!edge) return '—'
  return edge.name ?? `${S.reseau.troncon} ${edge.id}`
}

function nodeLabel(network: Network, id: NodeId): string {
  return network.nodes[id]?.label ?? id
}

export function ReseauPanel(): JSX.Element {
  const project = useAppStore((s) => s.project)
  const selection = useAppStore((s) => s.selection)
  const tool = useAppStore((s) => s.ui.tool)
  const toolNodes = useAppStore((s) => s.ui.toolNodes)
  const addEdgeOptions = useAppStore((s) => s.ui.addEdgeOptions)

  if (!project) return <div className="panel"><p className="hint">{S.app.aucunProjet}</p></div>

  return (
    <div className="panel">
      <section className="block">
        <h2>{S.reseau.titre}</h2>
        {selection?.kind === 'node' ? <NodeEditor nodeId={selection.id} /> : null}
        {selection?.kind === 'edge' ? <EdgeEditor edgeId={selection.id} /> : null}
        {!selection || selection.kind === 'controller' ? (
          <>
            <p className="hint">{S.reseau.aucuneSelection}</p>
            <p className="hint">{S.reseau.aideEdition}</p>
          </>
        ) : null}
      </section>

      <section className="block">
        <h3>{S.reseau.outils}</h3>
        <div className="segmented" role="group" aria-label={S.reseau.outils}>
          <button type="button" className={tool === 'select' ? 'active' : ''} onClick={() => useAppStore.getState().setTool('select')}>{S.reseau.outilSelection}</button>
          <button type="button" className={tool === 'greenwave' ? 'active' : ''} onClick={() => useAppStore.getState().setTool('greenwave')}>{S.reseau.outilOnde}</button>
          <button type="button" className={tool === 'addEdge' ? 'active' : ''} onClick={() => useAppStore.getState().setTool('addEdge')}>{S.reseau.outilAjout}</button>
        </div>
        {tool === 'greenwave' ? <p className="hint">{S.reseau.outilOndeAide}</p> : null}
        {tool === 'addEdge' ? (
          <>
            <p className="hint">{S.reseau.outilAjoutAide}</p>
            <label className="check">
              <input
                type="checkbox"
                checked={addEdgeOptions.twoWay}
                onChange={(e) => useAppStore.getState().setUi({ addEdgeOptions: { ...addEdgeOptions, twoWay: e.target.checked } })}
              />
              {S.reseau.doubleSens}
            </label>
            <label className="field">
              <span className="field-label">{S.reseau.classe}</span>
              <select
                value={addEdgeOptions.highway}
                onChange={(e) => useAppStore.getState().setUi({ addEdgeOptions: { ...addEdgeOptions, highway: e.target.value as HighwayClass } })}
              >
                {HIGHWAY_CLASSES.map((h) => <option key={h} value={h}>{HIGHWAY_LABELS[h]}</option>)}
              </select>
            </label>
            <div className="row">
              <NumberField
                label={S.reseau.voies}
                value={addEdgeOptions.lanes}
                min={1}
                max={6}
                onChange={(v) => useAppStore.getState().setUi({ addEdgeOptions: { ...addEdgeOptions, lanes: Math.round(v) } })}
              />
              <NumberField
                label={S.reseau.vitesse}
                value={addEdgeOptions.maxspeed}
                min={5}
                max={130}
                step={5}
                unit={S.unites.kmh}
                onChange={(v) => useAppStore.getState().setUi({ addEdgeOptions: { ...addEdgeOptions, maxspeed: Math.round(v) } })}
              />
            </div>
          </>
        ) : null}
        {tool !== 'select' && toolNodes.length === 1 ? <p className="hint">{S.reseau.outilPremierNoeud}</p> : null}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Nœud                                                               */
/* ------------------------------------------------------------------ */

function NodeEditor({ nodeId }: { nodeId: NodeId }): JSX.Element | null {
  const network = useAppStore((s) => s.project?.network)

  const { incoming, outgoing } = useMemo(() => {
    if (!network) return { incoming: [], outgoing: [] }
    const adjacency = buildAdjacency(network)
    return { incoming: adjacency.incoming.get(nodeId) ?? [], outgoing: adjacency.outgoing.get(nodeId) ?? [] }
  }, [network, nodeId])

  const node = network?.nodes[nodeId]
  if (!network || !node) return null
  const control = effectiveControl(network, nodeId, incoming)
  const explicit = !!network.controls[nodeId]
  const yieldEdges = control.yieldEdges ?? []
  const controllerId = control.controllerId
  const showYield = control.type === 'stop' || control.type === 'give_way'

  function setControl(type: ControlType, edges?: EdgeId[]): void {
    useAppStore.getState().setNodeControl(nodeId, {
      type,
      ...(type === 'stop' || type === 'give_way' ? { yieldEdges: edges ?? yieldEdges } : {}),
      ...(type === 'signals' && control.controllerId ? { controllerId: control.controllerId } : {}),
    })
  }

  return (
    <>
      <h3>{S.reseau.noeud} · {node.label ?? S.reseau.noeudSansNom}</h3>
      <label className="field">
        <span className="field-label">{S.reseau.label}</span>
        <span className="field-input">
          <input
            type="text"
            value={node.label ?? ''}
            onChange={(e) => useAppStore.getState().updateNode(nodeId, { label: e.target.value })}
          />
        </span>
      </label>

      <label className="field">
        <span className="field-label">{S.reseau.regulation}</span>
        <select value={control.type} onChange={(e) => setControl(e.target.value as ControlType)} data-testid="regulation-noeud">
          {CONTROL_TYPES.map((t) => <option key={t} value={t}>{CONTROL_LABELS[t]}</option>)}
        </select>
      </label>
      {!explicit ? <p className="hint">{S.reseau.regulationImplicite}</p> : null}
      {control.type === 'signals' && controllerId ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            const store = useAppStore.getState()
            store.select({ kind: 'controller', id: controllerId })
            store.setTab('feux')
          }}
        >
          {S.reseau.versFeux}
        </button>
      ) : null}

      <label className="check">
        <input
          type="checkbox"
          checked={!!node.miniRoundabout}
          onChange={(e) => useAppStore.getState().updateNode(nodeId, { miniRoundabout: e.target.checked })}
        />
        {S.reseau.miniGiratoire}
      </label>

      {showYield ? (
        <fieldset className="fieldset">
          <legend>{S.reseau.approchesCedent}</legend>
          {incoming.map((e) => (
            <label className="check" key={e.id}>
              <input
                type="checkbox"
                checked={yieldEdges.includes(e.id)}
                onChange={(ev) => {
                  const next = ev.target.checked ? [...yieldEdges, e.id] : yieldEdges.filter((id) => id !== e.id)
                  setControl(control.type, next)
                }}
              />
              {edgeLabel(e)}
            </label>
          ))}
          {!yieldEdges.length ? <p className="hint">{S.reseau.approchesToutes}</p> : null}
        </fieldset>
      ) : null}

      <h4>{S.reseau.interdictions}</h4>
      {incoming.length && outgoing.length && !node.boundary ? (
        <>
          <p className="hint">{S.reseau.interdictionsAide}</p>
          <div className="table-wrap">
            <table className="data-table matrix">
              <thead>
                <tr>
                  <th>{S.reseau.de} \ {S.reseau.vers}</th>
                  {outgoing.map((o) => <th key={o.id} className="right" title={edgeLabel(o)}>{shortLabel(o)}</th>)}
                </tr>
              </thead>
              <tbody>
                {incoming.map((i) => (
                  <tr key={i.id}>
                    <th scope="row" title={edgeLabel(i)}>{shortLabel(i)}</th>
                    {outgoing.map((o) => {
                      const uturn = o.id === i.reverseOf || i.id === o.reverseOf
                      const deadEnd = incoming.length === 1 && outgoing.length === 1
                      const impossible = uturn && !deadEnd
                      return (
                        <td key={o.id} className="right">
                          {impossible ? <span className="muted">—</span> : (
                            <input
                              type="checkbox"
                              checked={!i.bannedTo.includes(o.id)}
                              aria-label={`${edgeLabel(i)} → ${edgeLabel(o)}`}
                              onChange={(e) => useAppStore.getState().setBannedTurn(i.id, o.id, !e.target.checked)}
                            />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="hint">{S.reseau.aucunMouvement}</p>
      )}

      <button type="button" className="button danger" onClick={() => useAppStore.getState().deleteNode(nodeId)}>
        {S.reseau.supprimerNoeud}
      </button>
    </>
  )
}

/** Étiquette courte d'un tronçon pour les en-têtes de la matrice. */
function shortLabel(edge: NetEdge): string {
  const name = edge.name ?? edge.id
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

/* ------------------------------------------------------------------ */
/*  Tronçon                                                            */
/* ------------------------------------------------------------------ */

function EdgeEditor({ edgeId }: { edgeId: EdgeId }): JSX.Element | null {
  const network = useAppStore((s) => s.project?.network)
  const [applyToReverse, setApplyToReverse] = useState(true)
  const edge = network?.edges[edgeId]
  if (!network || !edge) return null
  const reverse = edge.reverseOf ? network.edges[edge.reverseOf] : undefined
  const update = useAppStore.getState().updateEdge

  return (
    <>
      <h3>{S.reseau.troncon} · {edgeLabel(edge)}</h3>
      <p className="hint">
        {S.reseau.de} <button type="button" className="link" onClick={() => useAppStore.getState().select({ kind: 'node', id: edge.from }, { reveal: true })}>{nodeLabel(network, edge.from)}</button>
        {' '}{S.reseau.vers.toLowerCase()} <button type="button" className="link" onClick={() => useAppStore.getState().select({ kind: 'node', id: edge.to }, { reveal: true })}>{nodeLabel(network, edge.to)}</button>
        {' · '}{formatNumber(edge.length)} {S.unites.m}
      </p>

      <label className="check">
        <input type="checkbox" checked={applyToReverse} disabled={!reverse} onChange={(e) => setApplyToReverse(e.target.checked)} />
        {S.reseau.appliquerInverse}
      </label>

      <label className="field">
        <span className="field-label">{S.reseau.nom}</span>
        <span className="field-input">
          <input
            type="text"
            value={edge.name ?? ''}
            placeholder={S.reseau.sansNom}
            onChange={(e) => update(edgeId, { name: e.target.value || undefined }, applyToReverse)}
          />
        </span>
      </label>

      <label className="field">
        <span className="field-label">{S.reseau.classe}</span>
        <select value={edge.highway} onChange={(e) => update(edgeId, { highway: e.target.value as HighwayClass }, applyToReverse)}>
          {HIGHWAY_CLASSES.map((h) => <option key={h} value={h}>{HIGHWAY_LABELS[h]}</option>)}
        </select>
      </label>

      <div className="row">
        <NumberField
          label={S.reseau.voies}
          value={edge.lanes}
          min={1}
          max={6}
          estimated={edge.estimated.lanes}
          onChange={(v) => update(edgeId, { lanes: Math.max(1, Math.round(v)) }, applyToReverse)}
        />
        <NumberField
          label={S.reseau.vitesse}
          value={edge.maxspeed}
          min={5}
          max={130}
          step={5}
          unit={S.unites.kmh}
          estimated={edge.estimated.maxspeed}
          onChange={(v) => update(edgeId, { maxspeed: Math.round(v) }, applyToReverse)}
        />
      </div>

      <fieldset className="fieldset">
        <legend>{S.reseau.sens}</legend>
        <div className="segmented" role="group">
          <button type="button" className={reverse ? '' : 'active'} disabled={!reverse} onClick={() => useAppStore.getState().setEdgeDirection(edgeId, 'oneway')}>{S.reseau.sensUnique}</button>
          <button type="button" onClick={() => useAppStore.getState().setEdgeDirection(edgeId, 'reverse')}>{S.reseau.inverser}</button>
          <button type="button" className={reverse ? 'active' : ''} disabled={!!reverse} onClick={() => useAppStore.getState().setEdgeDirection(edgeId, 'twoway')}>{S.reseau.doubleSens}</button>
        </div>
        <p className="hint">{S.reseau.sensOppose} : {reverse ? edgeLabel(reverse) : S.reseau.sensOpposeAucun}</p>
      </fieldset>

      <label className="check">
        <input type="checkbox" checked={edge.closed} onChange={(e) => update(edgeId, { closed: e.target.checked }, applyToReverse)} />
        {S.reseau.ferme}
      </label>

      <button type="button" className="button danger" onClick={() => useAppStore.getState().deleteEdge(edgeId)}>
        {S.reseau.supprimerTroncon}
      </button>
    </>
  )
}
