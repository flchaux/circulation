/**
 * Échelles de couleur de la carte (§7 de docs/ARCHITECTURE.md).
 *
 * Trois familles :
 *  - qualitative : classe de voie (`class`), couleurs de `HIGHWAY_COLORS` ;
 *  - séquentielle : flux, retard, saturation, vitesse, file d'attente ;
 *  - divergente : écarts référence → variante (`deltaDelay`, `deltaFlow`), symétrique autour de 0.
 *
 * Une échelle mémoïse ses couleurs dans une table de 256 entrées : `color()` est appelée une fois par
 * tronçon à chaque redessin (jusqu'à 5 000 appels), sans allouer de chaîne.
 */
import type { HighwayClass, NetEdge, SimResults } from '@/model/types'
import type { ColorMode } from '@/state/storeTypes'

export interface ColorScale {
  color(value: number): string
  stops: { value: number; color: string }[]
  label: string
  unit: string
}

/** Couleur des tronçons en mode « classe de voie » (lisible sur le fond OSM). */
export const HIGHWAY_COLORS: Record<HighwayClass, string> = {
  motorway: '#b3261e',
  trunk: '#d1462f',
  primary: '#e2762a',
  secondary: '#e0a533',
  tertiary: '#b99b4a',
  unclassified: '#8c93a1',
  residential: '#9aa3b2',
  living_street: '#b0b8c6',
  motorway_link: '#c96a5a',
  trunk_link: '#dd7d68',
  primary_link: '#eb9a63',
  secondary_link: '#e8bd6e',
  tertiary_link: '#cbb681',
}

/** Libellés français des classes de voie (légende, panneaux). */
export const CLASS_LABELS: Record<HighwayClass, string> = {
  motorway: 'Autoroute',
  trunk: 'Voie rapide',
  primary: 'Route principale',
  secondary: 'Route secondaire',
  tertiary: 'Route tertiaire',
  unclassified: 'Voie non classée',
  residential: 'Rue résidentielle',
  living_street: 'Zone de rencontre',
  motorway_link: "Bretelle d'autoroute",
  trunk_link: 'Bretelle de voie rapide',
  primary_link: 'Bretelle (principale)',
  secondary_link: 'Bretelle (secondaire)',
  tertiary_link: 'Bretelle (tertiaire)',
}

/** Classes affichées dans la légende qualitative (les bretelles suivent leur classe mère). */
export const LEGEND_CLASSES: HighwayClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
]

/** Tronçon sans valeur pour le mode courant (simulation non lancée, pas de référence…). */
export const NO_DATA_COLOR = '#98a2b3'

/** Tronçon fermé à la circulation. */
export const CLOSED_COLOR = '#7b8494'

export const SELECTION_COLOR = '#0b63ce'
export const HOVER_COLOR = '#4a94e8'
export const DROP_TARGET_COLOR = '#e0522a'
export const TOOL_COLOR = '#12a150'

/**
 * Couleurs des itinéraires comparés, du plus rapide au plus lent (outil « itinéraires »).
 *
 * Cinq teintes franchement séparées, et non une rampe du meilleur au pire : les itinéraires se recouvrent
 * sur une bonne part de leur longueur, et c'est justement là où ils divergent qu'il faut pouvoir dire d'un
 * coup d'œil lequel est lequel. Aucune n'est celle de la sélection (bleu) ni celle des outils (vert), qui
 * peuvent être affichées en même temps.
 */
export const ITINERAIRE_COLORS = ['#d1495b', '#1b6ca8', '#e08b1e', '#6b3fa0', '#0f8f6f']

/** Couleur d'un itinéraire de rang `i` (0 = le plus rapide) ; les rangs au-delà reprennent la série. */
export function itineraireColor(rang: number): string {
  return ITINERAIRE_COLORS[((rang % ITINERAIRE_COLORS.length) + ITINERAIRE_COLORS.length) % ITINERAIRE_COLORS.length]
}

/* ------------------------------------------------------------------ */
/*  Rampes                                                             */
/* ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number]

function hexToRgb(hex: string): Rgb {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function ramp(...hexes: string[]): Rgb[] {
  return hexes.map(hexToRgb)
}

/** Bleus : débit. */
const RAMP_FLOW = ramp('#eaf2fb', '#a8cbe8', '#5b9bd5', '#2166ac', '#0b3d75')
/** Jaune → rouge : retard, saturation. */
const RAMP_HOT = ramp('#fff5b8', '#fecc5c', '#fd8d3c', '#ef3b2c', '#a50f15')
/** Rouge → vert : vitesse (rouge = lent). */
const RAMP_SPEED = ramp('#c1272d', '#f2743a', '#f7d154', '#8fc44a', '#1e8b3f')
/** Violets : file d'attente. */
const RAMP_QUEUE = ramp('#f2effa', '#c6c2e3', '#9086c4', '#5f4fa2', '#331b6e')
/** Divergente : bleu (baisse) → gris (nul) → rouge (hausse). */
const RAMP_DELTA = ramp('#1a5fb4', '#7fb0e0', '#eeeeee', '#f08a5d', '#b3261e')

function mix(a: Rgb, b: Rgb, t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return `rgb(${r},${g},${bl})`
}

/** Couleur d'une rampe pour `t` ∈ [0,1] (interpolation linéaire entre les jalons). */
export function rampColor(colors: readonly Rgb[], t: number): string {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  const scaled = clamped * (colors.length - 1)
  const i = Math.min(colors.length - 2, Math.floor(scaled))
  return mix(colors[i], colors[i + 1], scaled - i)
}

/** Nombre de nuances précalculées d'une échelle continue. */
const TABLE_SIZE = 256

interface ScaleSpec {
  colors: readonly Rgb[]
  min: number
  max: number
  label: string
  unit: string
  /** Nombre de bornes affichées dans la légende. */
  stops?: number
}

function makeScale(spec: ScaleSpec): ColorScale {
  const { colors, min, max, label, unit } = spec
  const table: string[] = new Array(TABLE_SIZE)
  for (let i = 0; i < TABLE_SIZE; i++) table[i] = rampColor(colors, i / (TABLE_SIZE - 1))
  const span = max - min || 1
  const stopCount = spec.stops ?? 5
  const stops = Array.from({ length: stopCount }, (_, i) => {
    const value = min + (span * i) / (stopCount - 1)
    return { value, color: table[Math.round(((value - min) / span) * (TABLE_SIZE - 1))] }
  })
  return {
    color(value: number): string {
      const t = (value - min) / span
      const i = t <= 0 ? 0 : t >= 1 ? TABLE_SIZE - 1 : Math.round(t * (TABLE_SIZE - 1))
      return table[i]
    },
    stops,
    label,
    unit,
  }
}

/** Échelle qualitative (classes de voie) : aucune borne numérique. */
function classScale(): ColorScale {
  return {
    color: () => NO_DATA_COLOR,
    stops: [],
    label: 'Classe de voie',
    unit: '',
  }
}

/* ------------------------------------------------------------------ */
/*  Bornes                                                             */
/* ------------------------------------------------------------------ */

/** Arrondi supérieur « joli » (1, 2, 5 × 10ⁿ) pour les bornes de légende. */
export function niceUpper(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1
  const exp = Math.floor(Math.log10(value))
  const pow = 10 ** exp
  const m = value / pow
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return nice * pow
}

/** Maximum d'une statistique de tronçon sur l'ensemble des résultats. */
function maxEdgeStat(results: SimResults | null, pick: (s: SimResults['edges'][string]) => number): number {
  if (!results) return 0
  let max = 0
  for (const s of Object.values(results.edges)) {
    const v = pick(s)
    if (Number.isFinite(v) && v > max) max = v
  }
  return max
}

/** Écart absolu maximal entre la variante et la référence. */
function maxDelta(
  results: SimResults | null,
  reference: SimResults | null,
  pick: (s: SimResults['edges'][string]) => number,
): number {
  if (!results || !reference) return 0
  let max = 0
  for (const [id, s] of Object.entries(results.edges)) {
    const ref = reference.edges[id]
    if (!ref) continue
    const d = Math.abs(pick(s) - pick(ref))
    if (Number.isFinite(d) && d > max) max = d
  }
  return max
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

export function scaleFor(mode: ColorMode, results: SimResults | null, reference: SimResults | null): ColorScale {
  switch (mode) {
    case 'class':
      return classScale()
    case 'flow':
      return makeScale({
        colors: RAMP_FLOW,
        min: 0,
        max: Math.max(100, niceUpper(maxEdgeStat(results, (s) => s.flowVehH))),
        label: 'Débit',
        unit: 'véh/h',
      })
    case 'delay':
      return makeScale({
        colors: RAMP_HOT,
        min: 0,
        max: Math.max(10, niceUpper(maxEdgeStat(results, (s) => s.meanDelayS))),
        label: 'Retard moyen',
        unit: 's',
      })
    case 'saturation':
      // Domaine fixe : 1 = capacité atteinte, au-delà la file s'accumule.
      return makeScale({ colors: RAMP_HOT, min: 0, max: 1.2, label: 'Saturation', unit: '', stops: 7 })
    case 'speed':
      return makeScale({
        colors: RAMP_SPEED,
        min: 0,
        max: Math.max(50, Math.ceil(maxEdgeStat(results, (s) => s.meanSpeedKmh) / 10) * 10),
        label: 'Vitesse moyenne',
        unit: 'km/h',
      })
    case 'queue':
      return makeScale({
        colors: RAMP_QUEUE,
        min: 0,
        max: Math.max(5, niceUpper(maxEdgeStat(results, (s) => s.maxQueue))),
        label: 'File maximale',
        unit: 'véh',
      })
    case 'deltaDelay': {
      const bound = Math.max(5, niceUpper(maxDelta(results, reference, (s) => s.meanDelayS)))
      return makeScale({ colors: RAMP_DELTA, min: -bound, max: bound, label: 'Écart de retard', unit: 's' })
    }
    case 'deltaFlow': {
      const bound = Math.max(50, niceUpper(maxDelta(results, reference, (s) => s.flowVehH)))
      return makeScale({ colors: RAMP_DELTA, min: -bound, max: bound, label: 'Écart de débit', unit: 'véh/h' })
    }
  }
}

/**
 * Valeur numérique d'un tronçon pour le mode courant, ou `null` si elle n'existe pas
 * (mode qualitatif, simulation non lancée, tronçon absent des résultats ou de la référence).
 */
export function edgeValue(
  mode: ColorMode,
  edge: NetEdge,
  results: SimResults | null,
  reference: SimResults | null,
): number | null {
  if (mode === 'class') return null
  const stats = results?.edges[edge.id]
  switch (mode) {
    case 'flow':
      return stats ? stats.flowVehH : null
    case 'delay':
      return stats ? stats.meanDelayS : null
    case 'saturation':
      return stats ? stats.saturation : null
    case 'speed':
      return stats && stats.exited > 0 ? stats.meanSpeedKmh : null
    case 'queue':
      return stats ? stats.maxQueue : null
    case 'deltaDelay': {
      const ref = reference?.edges[edge.id]
      return stats && ref ? stats.meanDelayS - ref.meanDelayS : null
    }
    case 'deltaFlow': {
      const ref = reference?.edges[edge.id]
      return stats && ref ? stats.flowVehH - ref.flowVehH : null
    }
  }
}

/** Couleur d'un tronçon : classe de voie en mode qualitatif, échelle sinon, gris si aucune valeur. */
export function edgeColor(
  mode: ColorMode,
  edge: NetEdge,
  scale: ColorScale,
  results: SimResults | null,
  reference: SimResults | null,
): string {
  if (mode === 'class') return HIGHWAY_COLORS[edge.highway]
  const v = edgeValue(mode, edge, results, reference)
  return v === null ? NO_DATA_COLOR : scale.color(v)
}

const FORMATS: Record<ColorMode, Intl.NumberFormat> = {
  class: new Intl.NumberFormat('fr-FR'),
  flow: new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }),
  delay: new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }),
  saturation: new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 }),
  speed: new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }),
  queue: new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }),
  deltaDelay: new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0, signDisplay: 'exceptZero' }),
  deltaFlow: new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0, signDisplay: 'exceptZero' }),
}

/** Valeur formatée pour la légende et les étiquettes de la carte (unité comprise). */
export function formatValue(mode: ColorMode, value: number): string {
  const text = FORMATS[mode].format(value)
  const unit = scaleUnit(mode)
  return unit ? `${text} ${unit}` : text
}

function scaleUnit(mode: ColorMode): string {
  switch (mode) {
    case 'flow':
    case 'deltaFlow':
      return 'véh/h'
    case 'delay':
    case 'deltaDelay':
      return 's'
    case 'speed':
      return 'km/h'
    case 'queue':
      return 'véh'
    default:
      return ''
  }
}
