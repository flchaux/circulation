/** Types des données géographiques brutes (extraits OSM, communes). */
import type { GeoMultiPolygon, GeoPolygon } from '@/model/types'

export interface CommuneSummary {
  nom: string
  code: string
  codesPostaux: string[]
  centre: { type: 'Point'; coordinates: [number, number] }
  population?: number
  surface?: number
}

export interface CommuneDetail extends CommuneSummary {
  contour: GeoPolygon | GeoMultiPolygon
}

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }
export interface OsmRelation {
  type: 'relation'
  id: number
  members: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[]
  tags?: Record<string, string>
}
export type OsmElement = OsmNode | OsmWay | OsmRelation

export interface OsmJson {
  version?: number
  generator?: string
  osm3s?: { timestamp_osm_base?: string; copyright?: string }
  elements: OsmElement[]
}

/** Fichier produit par scripts/extract-city.mjs et par le cache navigateur. */
export interface OsmExtract {
  format: 'circulation-osm-extract'
  version: 1
  extractedAt: string
  attribution: string
  commune: CommuneDetail
  osm: OsmJson
}

/** Bilan de l'import OSM → graphe (osm2graph). */
export interface ImportStats {
  ways: number
  edges: number
  nodes: number
  entries: number
  exits: number
  signals: number
  controllers: number
  stops: number
  giveWays: number
  restrictions: number
  droppedEdges: number
  warnings: number
}

export interface ImportResult {
  network: import('@/model/types').Network
  warnings: string[]
  stats: ImportStats
}
