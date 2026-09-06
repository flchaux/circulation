import { describe, expect, it } from 'vitest'
import { createRng, exponential, hashString, randomInt, shuffleInPlace, streamSeed } from './rng'

describe('rng', () => {
  it('est déterministe et reproductible pour une graine donnée', () => {
    const a = createRng(1234)
    const b = createRng(1234)
    const va = Array.from({ length: 200 }, () => a())
    const vb = Array.from({ length: 200 }, () => b())
    expect(va).toEqual(vb)
  })

  it('produit des valeurs dans [0, 1) et diffère selon la graine', () => {
    const r = createRng(7)
    for (let i = 0; i < 10_000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    const first = createRng(1)()
    const second = createRng(2)()
    expect(first).not.toBe(second)
  })

  it('a une moyenne et une variance proches de la loi uniforme', () => {
    const r = createRng(99)
    const n = 200_000
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const v = r()
      sum += v
      sumSq += v * v
    }
    const mean = sum / n
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005)
    expect(Math.abs(sumSq / n - mean * mean - 1 / 12)).toBeLessThan(0.005)
  })

  it('hashString est stable et bien réparti', () => {
    expect(hashString('entry:n1')).toBe(hashString('entry:n1'))
    expect(hashString('entry:n1')).not.toBe(hashString('entry:n2'))
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) seen.add(hashString(`entry:n${i}`))
    expect(seen.size).toBe(5000)
  })

  it('streamSeed sépare les flux nommés', () => {
    const a = createRng(streamSeed(42, 'entry:a'))
    const b = createRng(streamSeed(42, 'entry:b'))
    expect(a()).not.toBe(b())
  })

  it('randomInt reste dans les bornes', () => {
    const r = createRng(5)
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(r, 7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
    expect(randomInt(r, 0)).toBe(0)
  })

  it('exponential suit la moyenne 1/rate', () => {
    const r = createRng(11)
    let sum = 0
    const n = 100_000
    for (let i = 0; i < n; i++) sum += exponential(r, 2)
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.01)
  })

  it('shuffleInPlace conserve les éléments', () => {
    const r = createRng(3)
    const arr = Int32Array.from({ length: 50 }, (_, i) => i)
    shuffleInPlace(arr, arr.length, r)
    expect([...arr].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })
})
