import { describe, expect, it } from 'vitest'
import { approachAngle, exitAngle, isOnRight, movementsConflict, nodeMovements, turnType } from './geometry'
import { crossNetwork } from './testNetworks'

describe('geometry', () => {
  const net = crossNetwork()
  const mv = nodeMovements(net, 'c')
  const get = (from: string, to: string) => {
    const m = mv.find((x) => x.from === from && x.to === to)
    if (!m) throw new Error(`mouvement absent ${from}>${to}`)
    return m
  }

  it('énumère 12 mouvements sans demi-tour', () => {
    expect(mv.length).toBe(12)
    expect(mv.some((m) => m.turn === 'uturn')).toBe(false)
  })

  it('classe les tourne-à-gauche/droite (circulation à droite)', () => {
    expect(turnType(net.edges.s_in, net.edges.n_out)).toBe('through')
    expect(turnType(net.edges.s_in, net.edges.w_out)).toBe('left')
    expect(turnType(net.edges.s_in, net.edges.e_out)).toBe('right')
    expect(turnType(net.edges.e_in, net.edges.n_out)).toBe('right')
    expect(turnType(net.edges.e_in, net.edges.s_out)).toBe('left')
  })

  it('place la voie d approche à droite de la voie de sortie de la même rue', () => {
    // Branche sud : approche légèrement à l'est (angle > 270°), sortie légèrement à l'ouest.
    const a = approachAngle(net.edges.s_in)
    const x = exitAngle(net.edges.s_out)
    expect(a).toBeGreaterThan((3 * Math.PI) / 2)
    expect(x).toBeLessThan((3 * Math.PI) / 2)
  })

  it('conflits : tout droit opposés ne se croisent pas', () => {
    expect(movementsConflict(get('s_in', 'n_out'), get('n_in', 's_out'))).toBe(false)
  })
  it('conflits : tourne-à-gauche croise le tout droit opposé', () => {
    expect(movementsConflict(get('n_in', 'e_out'), get('s_in', 'n_out'))).toBe(true)
    expect(movementsConflict(get('s_in', 'n_out'), get('n_in', 'e_out'))).toBe(true)
  })
  it('conflits : tourne-à-droite ne croise pas le tout droit opposé', () => {
    expect(movementsConflict(get('n_in', 'w_out'), get('s_in', 'n_out'))).toBe(false)
  })
  it('conflits : convergence sur la même sortie', () => {
    expect(movementsConflict(get('e_in', 'n_out'), get('s_in', 'n_out'))).toBe(true)
  })
  it('conflits : tout droit transversaux se croisent', () => {
    expect(movementsConflict(get('e_in', 'w_out'), get('s_in', 'n_out'))).toBe(true)
  })
  it('conflits : deux tourne-à-gauche opposés ne se croisent pas', () => {
    expect(movementsConflict(get('s_in', 'w_out'), get('n_in', 'e_out'))).toBe(false)
  })
  it('conflits : tourne-à-droite depuis l est et tout droit sud-nord convergent (même sortie nord)', () => {
    expect(movementsConflict(get('e_in', 'n_out'), get('s_in', 'n_out'))).toBe(true)
  })
  it('conflits : tourne-à-gauche depuis l est croise le tout droit sud-nord', () => {
    expect(movementsConflict(get('e_in', 's_out'), get('s_in', 'n_out'))).toBe(true)
  })
  it('conflits : tourne-à-droite ouest→nord vs tout droit est→ouest : pas de croisement', () => {
    // Depuis l'ouest (cap est), à droite = sud. Depuis l'est (cap ouest) tout droit vers l'ouest.
    expect(movementsConflict(get('w_in', 's_out'), get('e_in', 'w_out'))).toBe(false)
  })
  it('conflits : tourne-à-gauche ouest→nord croise tout droit est→ouest', () => {
    expect(movementsConflict(get('w_in', 'n_out'), get('e_in', 'w_out'))).toBe(true)
  })

  it('priorité à droite : l est est à droite du sud', () => {
    // Véhicule venant du sud (cap nord) : la branche est est à sa droite.
    expect(isOnRight(approachAngle(net.edges.s_in), approachAngle(net.edges.e_in))).toBe(true)
    expect(isOnRight(approachAngle(net.edges.s_in), approachAngle(net.edges.w_in))).toBe(false)
    expect(isOnRight(approachAngle(net.edges.s_in), approachAngle(net.edges.n_in))).toBe(false)
    // Véhicule venant de l'est (cap ouest) : le nord est à sa droite.
    expect(isOnRight(approachAngle(net.edges.e_in), approachAngle(net.edges.n_in))).toBe(true)
  })
})
