/**
 * Générateurs pseudo-aléatoires déterministes du moteur.
 *
 * `sfc32` (Small Fast Counter, 32 bits) amorcé par `splitmix32` : rapide, période très longue,
 * état entièrement déterminé par la graine. Le moteur utilise plusieurs flux nommés indépendants
 * (`seed ^ hashString(nom)`) pour que l'ajout ou la modification d'une entrée ne décale pas les
 * tirages des autres — c'est la base des « variables aléatoires communes » entre référence et variante.
 */

/** Mélangeur d'entiers 32 bits, utilisé pour dériver les quatre mots d'état de sfc32. */
function splitmix32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x9e3779b9) | 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return t >>> 0
  }
}

/** Flux uniforme dans [0, 1) reproductible pour une graine donnée. */
export function createRng(seed: number): () => number {
  const next = splitmix32(seed | 0)
  let a = next() | 0
  let b = next() | 0
  let c = next() | 0
  let d = next() | 0
  if ((a | b | c | d) === 0) d = 1 // l'état nul est un point fixe de sfc32
  // Quelques tours à vide pour décorréler les graines voisines.
  for (let i = 0; i < 12; i++) {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
  }
  return () => {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

/** Hachage FNV-1a 32 bits (entier non signé) — sert à nommer les flux aléatoires. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Entier uniforme dans [0, maxExclusive). Renvoie 0 si `maxExclusive` ≤ 0. */
export function randomInt(rng: () => number, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0
  const v = Math.floor(rng() * maxExclusive)
  return v >= maxExclusive ? maxExclusive - 1 : v
}

/** Graine dérivée d'un flux nommé (`seed ⊕ hash(nom)`). */
export function streamSeed(seed: number, name: string): number {
  return (seed ^ hashString(name)) | 0
}

/** Tirage exponentiel de paramètre `rate` (intervalle d'un processus de Poisson). */
export function exponential(rng: () => number, rate: number): number {
  // rng() ∈ [0, 1) donc 1 - rng() ∈ (0, 1] : jamais log(0).
  return -Math.log(1 - rng()) / rate
}

/** Mélange de Fisher-Yates des `n` premiers éléments d'un tableau, en place. */
export function shuffleInPlace(arr: Int32Array | number[], n: number, rng: () => number): void {
  for (let i = n - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1)
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
}
