/**
 * Import/export CSV de la demande (§6 de docs/ARCHITECTURE.md).
 *
 * Import : séparateur `;` ou `,` détecté sur la première ligne utile, en-tête facultatif, décimales à la virgule
 * acceptées, identifiant de nœud **ou** libellé exact (comparaison insensible à la casse et aux accents).
 *   - format A « entree;debit »        → débits d'entrée (véh/h) ;
 *   - format B « entree;sortie;part »  → matrice OD (passe `destinationMode` à `od`) ;
 *   - après une ligne de commentaire contenant « sortie », les lignes à deux colonnes alimentent les poids de sortie
 *     (c'est ce que produit l'export).
 * Export : format A pour les entrées, puis « # sorties » et les poids de sortie.
 */
import type { Demand, Network, NodeId } from '@/model/types'
import type { CsvImportReport } from './storeTypes'

/** Séparateur d'export (les décimales sont alors écrites à la française). */
const EXPORT_SEPARATOR = ';'

function detectSeparator(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const semis = (line.match(/;/g) ?? []).length
    const commas = (line.match(/,/g) ?? []).length
    return commas > semis ? ',' : ';'
  }
  return ';'
}

/** Nombre à la française ou à l'anglaise, espaces (fines, insécables) ignorés ; NaN si illisible. */
function parseNumber(raw: string): number {
  const cleaned = raw.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!cleaned || !/^[-+]?\d*\.?\d+([eE][-+]?\d+)?$/.test(cleaned)) return Number.NaN
  return Number(cleaned)
}

/** Clé de comparaison des libellés : sans casse, sans accents, espaces réduits. */
function foldLabel(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Index libellé → identifiant (le premier libellé rencontré l'emporte en cas d'homonymes). */
function labelIndex(ids: NodeId[], labels: (id: NodeId) => (string | undefined)[]): Map<string, NodeId> {
  const index = new Map<string, NodeId>()
  for (const id of ids) {
    for (const label of labels(id)) {
      if (!label) continue
      const key = foldLabel(label)
      if (key && !index.has(key)) index.set(key, id)
    }
  }
  return index
}

function splitLine(line: string, sep: string): string[] {
  return line.split(sep).map((f) => f.trim().replace(/^"(.*)"$/, '$1').trim())
}

export function parseDemandCsv(
  text: string,
  demand: Demand,
  network: Network,
): { demand: Demand; report: CsvImportReport } {
  const lines = text.split(/\r?\n/)
  const sep = detectSeparator(lines)

  const entryIds = Object.keys(demand.entries)
  const exitIds = Object.keys(demand.exits)
  const entryIndex = labelIndex(entryIds, (id) => [demand.entries[id]?.label, network.nodes[id]?.label])
  const exitIndex = labelIndex(exitIds, (id) => [demand.exits[id]?.label, network.nodes[id]?.label])

  const entries = { ...demand.entries }
  const exits = { ...demand.exits }
  const od: Demand['od'] = {}
  for (const [k, row] of Object.entries(demand.od)) od[k] = { ...row }

  const report: CsvImportReport = { entries: 0, exits: 0, odCells: 0, unknown: [] }
  const unknown = new Set<string>()
  /** Lignes OD déjà réécrites par cet import : la première cellule d'une entrée remplace sa ligne. */
  const rewrittenOd = new Set<NodeId>()
  let section: 'entries' | 'exits' = 'entries'

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const folded = foldLabel(line)
      if (folded.includes('sortie')) section = 'exits'
      else if (folded.includes('entree')) section = 'entries'
      continue
    }
    const fields = splitLine(line, sep)
    if (fields.length < 2 || !fields[0]) continue

    if (fields.length >= 3 && fields[2] !== '') {
      // Format B : entree ; sortie ; part
      const share = parseNumber(fields[2])
      if (Number.isNaN(share)) continue // en-tête ou ligne illisible
      const entryId = entries[fields[0]] ? fields[0] : entryIndex.get(foldLabel(fields[0]))
      const exitId = exits[fields[1]] ? fields[1] : exitIndex.get(foldLabel(fields[1]))
      if (!entryId) { unknown.add(fields[0]); continue }
      if (!exitId) { unknown.add(fields[1]); continue }
      if (!rewrittenOd.has(entryId)) { od[entryId] = {}; rewrittenOd.add(entryId) }
      if (share > 0) od[entryId][exitId] = share
      report.odCells++
      continue
    }

    // Format A : identifiant ; valeur
    const value = parseNumber(fields[1])
    if (Number.isNaN(value)) continue // en-tête (« entree;debit ») ou ligne illisible
    if (section === 'exits') {
      const exitId = exits[fields[0]] ? fields[0] : exitIndex.get(foldLabel(fields[0]))
      if (!exitId) { unknown.add(fields[0]); continue }
      exits[exitId] = { ...exits[exitId], weight: Math.max(0, value) }
      report.exits++
    } else {
      const entryId = entries[fields[0]] ? fields[0] : entryIndex.get(foldLabel(fields[0]))
      if (!entryId) { unknown.add(fields[0]); continue }
      entries[entryId] = { ...entries[entryId], flow: Math.max(0, value), estimated: false }
      report.entries++
    }
  }

  report.unknown = [...unknown]
  const next: Demand = { ...demand, entries, exits, od }
  if (report.odCells > 0) next.destinationMode = 'od'
  return { demand: next, report }
}

/** Nombre en notation française, sans zéros inutiles. */
function formatNumber(v: number): string {
  const rounded = Math.round(v * 1000) / 1000
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',')
}

export function serializeDemandCsv(demand: Demand, network: Network): string {
  const s = EXPORT_SEPARATOR
  const lines: string[] = []
  lines.push('# entrees (debit en veh/h)')
  lines.push(['entree', 'debit'].join(s))
  for (const [id, entry] of Object.entries(demand.entries)) {
    if (!network.nodes[id]) continue // entrée orpheline (réseau modifié entre-temps)
    lines.push([id, formatNumber(entry.flow)].join(s))
  }
  lines.push('# sorties')
  lines.push(['sortie', 'poids'].join(s))
  for (const [id, exit] of Object.entries(demand.exits)) {
    if (!network.nodes[id]) continue
    lines.push([id, formatNumber(exit.weight)].join(s))
  }
  // Les libellés ne sont pas exportés en colonne supplémentaire : trois colonnes déclencheraient le format B.
  return lines.join('\n') + '\n'
}
