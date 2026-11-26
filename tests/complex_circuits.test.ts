import { describe, expect, it } from 'vitest';
import {
  BIT_0,
  BIT_1,
  BIT_X,
  BIT_Z,
  dominantState,
  formatValue,
  fromInt,
  fromLiteral,
  makeUniform,
  toUnsignedInt,
} from '../src/core/logic4';
import {
  compileCircuit,
  createEmptySequentialState,
  simulateCircuit,
  simulateCompiledCircuit,
} from '../src/core/simulator';
import { CircuitDocument, GateInstance, ProjectDocument, Wire } from '../src/core/types';

function makeProj(circuit: CircuitDocument, extra: CircuitDocument[] = []): ProjectDocument {
  const circuits: Record<string, CircuitDocument> = { [circuit.id]: circuit };
  for (const c of extra) circuits[c.id] = c;
  return {
    version: 1,
    name: 'ComplexTest',
    activeCircuitId: circuit.id,
    circuits,
    settings: {
      gridSize: 20,
      routeMode: 'grid',
      simMode: 'realtime',
      clockHz: 2,
      clockRunning: false,
      globalSubcircuitDisplay: 'instance',
      showNetLabels: true,
      showPinNames: true,
    },
  };
}

function w(id: string, fg: string, fp: string, tg: string, tp: string): Wire {
  return {
    id,
    from: { gateId: fg, pinId: fp },
    to: { gateId: tg, pinId: tp },
    points: [],
    routeMode: 'grid',
  };
}

describe('4-State Value Formatting & Edge Cases', () => {
  it('formats signed, unsigned, hex, bin, and 4-state unknown values accurately', () => {
    expect(formatValue(fromInt(0xf, 4), 'hex')).toBe('0xF');
    expect(formatValue(fromInt(0xf, 4), 'dec')).toBe('15');
    expect(formatValue(fromInt(0xf, 4), 'signed')).toBe('-1');
    expect(formatValue(fromInt(0x8, 4), 'signed')).toBe('-8');
    expect(formatValue(fromInt(0x7, 4), 'signed')).toBe('7');
    expect(formatValue(fromInt(0xa, 4), 'bin')).toBe('1010');
    expect(formatValue(makeUniform(BIT_Z, 4), 'dec')).toBe('Z');
    expect(formatValue(makeUniform(BIT_X, 4), 'dec')).toBe('X');
    expect(formatValue(fromLiteral('invalid_xyz', 4), 'bin')).toBe('XXXX');

    // 32-bit unsigned full range
    const u32 = fromInt(0xffffffff, 32);
    expect(toUnsignedInt(u32)).toBe(0xffffffff);
    expect(formatValue(u32, 'hex')).toBe('0xFFFFFFFF');

    // dominantState priority: X > 1 > Z > 0
    expect(dominantState(fromLiteral('0b01xz', 4))).toBe(BIT_X);
    expect(dominantState(fromLiteral('0b010z', 4))).toBe(BIT_1);
    expect(dominantState(fromLiteral('0b000z', 4))).toBe(BIT_Z);
    expect(dominantState(fromLiteral('0bzzzz', 4))).toBe(BIT_Z);
    expect(dominantState(fromLiteral('0b0000', 4))).toBe(BIT_0);
  });
});

describe('End-to-End Complex Digital Architectures', () => {
  it('verifies a 4-bit Ripple Carry Adder built from SPLITTER + 4x FULL_ADDER across all 256 (A, B) pairs', () => {
    const circ: CircuitDocument = {
      id: 'c_rca4',
      name: 'RCA4',
      gates: [
        {
          id: 'in_a',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'A',
          props: { bitWidth: 4 },
        },
        {
          id: 'in_b',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'B',
          props: { bitWidth: 4 },
        },
        {
          id: 'sp_a',
          type: 'SPLITTER',
          x: 100,
          y: 0,
          rotation: 0,
          label: '',
          props: { splitMode: 'split', splitWidths: [1, 1, 1, 1] },
        },
        {
          id: 'sp_b',
          type: 'SPLITTER',
          x: 100,
          y: 120,
          rotation: 0,
          label: '',
          props: { splitMode: 'split', splitWidths: [1, 1, 1, 1] },
        },
        {
          id: 'fa0',
          type: 'FULL_ADDER',
          x: 260,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        {
          id: 'fa1',
          type: 'FULL_ADDER',
          x: 260,
          y: 100,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        {
          id: 'fa2',
          type: 'FULL_ADDER',
          x: 260,
          y: 200,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        {
          id: 'fa3',
          type: 'FULL_ADDER',
          x: 260,
          y: 300,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        {
          id: 'mg_s',
          type: 'SPLITTER',
          x: 440,
          y: 140,
          rotation: 0,
          label: '',
          props: { splitMode: 'merge', splitWidths: [1, 1, 1, 1] },
        },
        {
          id: 'out_s',
          type: 'MODULE_OUT',
          x: 560,
          y: 140,
          rotation: 0,
          label: 'S',
          props: { bitWidth: 4 },
        },
        {
          id: 'out_c',
          type: 'MODULE_OUT',
          x: 560,
          y: 300,
          rotation: 0,
          label: 'Cout',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        w('wa', 'in_a', 'out', 'sp_a', 'bus'),
        w('wb', 'in_b', 'out', 'sp_b', 'bus'),
        w('wa0', 'sp_a', 'b0', 'fa0', 'a'),
        w('wb0', 'sp_b', 'b0', 'fa0', 'b'),
        w('wa1', 'sp_a', 'b1', 'fa1', 'a'),
        w('wb1', 'sp_b', 'b1', 'fa1', 'b'),
        w('wa2', 'sp_a', 'b2', 'fa2', 'a'),
        w('wb2', 'sp_b', 'b2', 'fa2', 'b'),
        w('wa3', 'sp_a', 'b3', 'fa3', 'a'),
        w('wb3', 'sp_b', 'b3', 'fa3', 'b'),
        w('wc0', 'fa0', 'cout', 'fa1', 'cin'),
        w('wc1', 'fa1', 'cout', 'fa2', 'cin'),
        w('wc2', 'fa2', 'cout', 'fa3', 'cin'),
        w('ws0', 'fa0', 's', 'mg_s', 'b0'),
        w('ws1', 'fa1', 's', 'mg_s', 'b1'),
        w('ws2', 'fa2', 's', 'mg_s', 'b2'),
        w('ws3', 'fa3', 's', 'mg_s', 'b3'),
        w('wos', 'mg_s', 'bus', 'out_s', 'in'),
        w('woc', 'fa3', 'cout', 'out_c', 'in'),
      ],
    };
    const proj = makeProj(circ);
    const compiled = compileCircuit(circ, proj);

    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        const snap = simulateCompiledCircuit(compiled, proj, createEmptySequentialState(), {
          externalInputs: { in_a: fromInt(a, 4), in_b: fromInt(b, 4) },
        });
        const total = a + b;
        expect(toUnsignedInt(snap.pinValues['out_s:in'])).toBe(total & 0xf);
        expect(snap.pinValues['out_c:in'].bits[0]).toBe(total > 15 ? BIT_1 : BIT_0);
      }
    }
  });

  it('verifies a 4-stage serial Shift Register (4x chained D_FF) with async RST', () => {
    const circ: CircuitDocument = {
      id: 'c_sr4',
      name: 'ShiftReg4',
      gates: [
        {
          id: 'clk',
          type: 'CLOCK',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'CLK',
          props: { clockHigh: false },
        },
        {
          id: 'din',
          type: 'TOGGLE',
          x: 0,
          y: 60,
          rotation: 0,
          label: 'DIN',
          props: { bitWidth: 1, value: '0' },
        },
        {
          id: 'rst',
          type: 'TOGGLE',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'RST',
          props: { bitWidth: 1, value: '0' },
        },
        {
          id: 'ff0',
          type: 'D_FF',
          x: 160,
          y: 40,
          rotation: 0,
          label: 'FF0',
          props: { bitWidth: 1 },
        },
        {
          id: 'ff1',
          type: 'D_FF',
          x: 300,
          y: 40,
          rotation: 0,
          label: 'FF1',
          props: { bitWidth: 1 },
        },
        {
          id: 'ff2',
          type: 'D_FF',
          x: 440,
          y: 40,
          rotation: 0,
          label: 'FF2',
          props: { bitWidth: 1 },
        },
        {
          id: 'ff3',
          type: 'D_FF',
          x: 580,
          y: 40,
          rotation: 0,
          label: 'FF3',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        w('wd0', 'din', 'out', 'ff0', 'd'),
        w('wd1', 'ff0', 'q', 'ff1', 'd'),
        w('wd2', 'ff1', 'q', 'ff2', 'd'),
        w('wd3', 'ff2', 'q', 'ff3', 'd'),
        w('wc0', 'clk', 'out', 'ff0', 'clk'),
        w('wc1', 'clk', 'out', 'ff1', 'clk'),
        w('wc2', 'clk', 'out', 'ff2', 'clk'),
        w('wc3', 'clk', 'out', 'ff3', 'clk'),
        w('wr0', 'rst', 'out', 'ff0', 'rst'),
        w('wr1', 'rst', 'out', 'ff1', 'rst'),
        w('wr2', 'rst', 'out', 'ff2', 'rst'),
        w('wr3', 'rst', 'out', 'ff3', 'rst'),
      ],
    };
    const proj = makeProj(circ);
    const compiled = compileCircuit(circ, proj);
    const seq = createEmptySequentialState();

    const clockBit = (bit: number, rst = 0) => {
      simulateCompiledCircuit(compiled, proj, seq, {
        runtimeInputs: {
          clk: { clockHigh: false },
          din: { value: String(bit) },
          rst: { value: String(rst) },
        },
      });
      return simulateCompiledCircuit(compiled, proj, seq, {
        runtimeInputs: {
          clk: { clockHigh: true },
          din: { value: String(bit) },
          rst: { value: String(rst) },
        },
      });
    };

    // Shift in 1, 0, 1, 1 -> after 4 rising edges: FF0=1, FF1=1, FF2=0, FF3=1
    clockBit(1);
    clockBit(0);
    clockBit(1);
    const snap = clockBit(1);
    expect([
      snap.pinValues['ff0:q'].bits[0],
      snap.pinValues['ff1:q'].bits[0],
      snap.pinValues['ff2:q'].bits[0],
      snap.pinValues['ff3:q'].bits[0],
    ]).toEqual([BIT_1, BIT_1, BIT_0, BIT_1]);

    // Async RST=1 clears all 4 stages immediately even without a rising clock edge
    const resetSnap = simulateCompiledCircuit(compiled, proj, seq, {
      runtimeInputs: { clk: { clockHigh: false }, din: { value: '1' }, rst: { value: '1' } },
    });
    expect([
      resetSnap.pinValues['ff0:q'].bits[0],
      resetSnap.pinValues['ff1:q'].bits[0],
      resetSnap.pinValues['ff2:q'].bits[0],
      resetSnap.pinValues['ff3:q'].bits[0],
    ]).toEqual([BIT_0, BIT_0, BIT_0, BIT_0]);
  });

  it('propagates electrical signals accurately across T-junction wires', () => {
    const circ: CircuitDocument = {
      id: 'c_tj',
      name: 'TJunctionSim',
      gates: [
        {
          id: 'sw',
          type: 'CONST',
          x: 100,
          y: 100,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, value: '1' },
        },
        { id: 'led1', type: 'LED', x: 300, y: 100, rotation: 0, label: '', props: { bitWidth: 1 } },
        { id: 'led2', type: 'LED', x: 200, y: 240, rotation: 0, label: '', props: { bitWidth: 1 } },
      ],
      wires: [
        // Main wire from sw to led1 along y=100
        {
          id: 'w_main',
          from: { gateId: 'sw', pinId: 'out' },
          to: { gateId: 'led1', pinId: 'in' },
          points: [
            { x: 128, y: 100 },
            { x: 278, y: 100 },
          ],
          routeMode: 'grid',
        },
        // Branch wire whose free start endpoint lands on the middle of w_main at (200, 100)!
        {
          id: 'w_branch',
          to: { gateId: 'led2', pinId: 'in' },
          points: [
            { x: 200, y: 100 },
            { x: 200, y: 240 },
            { x: 178, y: 240 },
          ],
          routeMode: 'grid',
        },
      ],
    };
    const proj = makeProj(circ);
    const snap = simulateCircuit(circ, proj, createEmptySequentialState());
    expect(snap.pinValues['led1:in'].bits[0]).toBe(BIT_1);
    expect(snap.pinValues['led2:in'].bits[0]).toBe(BIT_1);
  });

  it('supports 3-level nested subcircuit hierarchy with nested live snapshots and guards against cyclic self-instantiation', () => {
    const leaf: CircuitDocument = {
      id: 'leaf',
      name: 'LeafInv',
      gates: [
        {
          id: 'l_in',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'a',
          props: { bitWidth: 1 },
        },
        { id: 'l_not', type: 'NOT', x: 100, y: 0, rotation: 0, label: '', props: { bitWidth: 1 } },
        {
          id: 'l_out',
          type: 'MODULE_OUT',
          x: 200,
          y: 0,
          rotation: 0,
          label: 'y',
          props: { bitWidth: 1 },
        },
      ],
      wires: [w('wl1', 'l_in', 'out', 'l_not', 'in0'), w('wl2', 'l_not', 'out', 'l_out', 'in')],
    };
    const mid: CircuitDocument = {
      id: 'mid',
      name: 'MidDoubleInv',
      gates: [
        {
          id: 'm_in',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'a',
          props: { bitWidth: 1 },
        },
        {
          id: 'u_l1',
          type: 'SUBCIRCUIT',
          x: 120,
          y: 0,
          rotation: 0,
          label: 'L1',
          props: { subcircuitId: 'leaf' },
        },
        {
          id: 'u_l2',
          type: 'SUBCIRCUIT',
          x: 260,
          y: 0,
          rotation: 0,
          label: 'L2',
          props: { subcircuitId: 'leaf' },
        },
        {
          id: 'm_out',
          type: 'MODULE_OUT',
          x: 400,
          y: 0,
          rotation: 0,
          label: 'y',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        w('wm1', 'm_in', 'out', 'u_l1', 'l_in'),
        w('wm2', 'u_l1', 'l_out', 'u_l2', 'l_in'),
        w('wm3', 'u_l2', 'l_out', 'm_out', 'in'),
      ],
    };
    const top: CircuitDocument = {
      id: 'top3',
      name: 'Top3',
      gates: [
        {
          id: 't_in',
          type: 'CONST',
          x: 0,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, value: '1' },
        },
        {
          id: 'u_mid',
          type: 'SUBCIRCUIT',
          x: 200,
          y: 0,
          rotation: 0,
          label: 'MID',
          props: { subcircuitId: 'mid' },
        },
        { id: 't_led', type: 'LED', x: 400, y: 0, rotation: 0, label: '', props: { bitWidth: 1 } },
      ],
      wires: [w('wt1', 't_in', 'out', 'u_mid', 'm_in'), w('wt2', 'u_mid', 'm_out', 't_led', 'in')],
    };
    const proj = makeProj(top, [mid, leaf]);
    const snap = simulateCircuit(top, proj, createEmptySequentialState());

    // Double inversion of 1 -> 0 -> 1
    expect(snap.pinValues['t_led:in'].bits[0]).toBe(BIT_1);
    // Live nested snapshots populated 2 levels deep!
    expect(snap.subSnapshots['u_mid'].subSnapshots['u_l1'].pinValues['l_out:in'].bits[0]).toBe(
      BIT_0,
    );
    expect(snap.subSnapshots['u_mid'].subSnapshots['u_l2'].pinValues['l_out:in'].bits[0]).toBe(
      BIT_1,
    );

    // Cyclic self-instantiation guard: circuit A instantiates itself -> must NOT stack overflow!
    const cyclic: CircuitDocument = {
      id: 'cyc',
      name: 'Cyclic',
      gates: [
        {
          id: 'c_in',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'a',
          props: { bitWidth: 1 },
        },
        {
          id: 'u_self',
          type: 'SUBCIRCUIT',
          x: 200,
          y: 0,
          rotation: 0,
          label: 'SELF',
          props: { subcircuitId: 'cyc' },
        },
        {
          id: 'c_out',
          type: 'MODULE_OUT',
          x: 400,
          y: 0,
          rotation: 0,
          label: 'y',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        w('wc1', 'c_in', 'out', 'u_self', 'c_in'),
        w('wc2', 'u_self', 'c_out', 'c_out', 'in'),
      ],
    };
    const cycProj = makeProj(cyclic);
    expect(() => simulateCircuit(cyclic, cycProj, createEmptySequentialState())).not.toThrow();
  });

  it('handles a 120-gate compiled sequential+combinational circuit cleanly across 50 clock cycles', () => {
    // Chain 100 inverters (even -> preserves parity) fed by an 8-bit counter!
    const gates: GateInstance[] = [
      {
        id: 'clk',
        type: 'CLOCK',
        x: 0,
        y: 0,
        rotation: 0,
        label: 'CLK',
        props: { clockHigh: false },
      },
      {
        id: 'cnt',
        type: 'COUNTER',
        x: 100,
        y: 0,
        rotation: 0,
        label: 'CNT',
        props: { bitWidth: 8 },
      },
    ];
    const wires: Wire[] = [w('w_clk', 'clk', 'out', 'cnt', 'clk')];
    const chainLen = 30; // even number of inverters, well within 48 delta cycles
    for (let i = 0; i < chainLen; i++) {
      gates.push({
        id: `inv_${i}`,
        type: 'NOT',
        x: 200 + i * 40,
        y: 0,
        rotation: 0,
        label: '',
        props: { bitWidth: 8 },
      });
      if (i === 0) wires.push(w(`w_c_${i}`, 'cnt', 'q', `inv_${i}`, 'in0'));
      else wires.push(w(`w_c_${i}`, `inv_${i - 1}`, 'out', `inv_${i}`, 'in0'));
    }
    // Add 90 parallel observer AND gates for 122 total gates
    for (let i = 0; i < 90; i++) {
      gates.push({
        id: `obs_${i}`,
        type: 'AND',
        x: 200 + (i % 10) * 80,
        y: 100 + Math.floor(i / 10) * 60,
        rotation: 0,
        label: '',
        props: { inputCount: 2, bitWidth: 8 },
      });
      wires.push(w(`wo_a_${i}`, `inv_${chainLen - 1}`, 'out', `obs_${i}`, 'in0'));
      wires.push(w(`wo_b_${i}`, 'cnt', 'q', `obs_${i}`, 'in1'));
    }

    const circ: CircuitDocument = { id: 'c_stress', name: 'Stress122', gates, wires };
    const proj = makeProj(circ);
    const compiled = compileCircuit(circ, proj);
    const seq = createEmptySequentialState();

    const t0 = performance.now();
    let lastSnap = simulateCompiledCircuit(compiled, proj, seq, {
      runtimeInputs: { clk: { clockHigh: false } },
    });
    for (let tick = 0; tick < 50; tick++) {
      simulateCompiledCircuit(compiled, proj, seq, { runtimeInputs: { clk: { clockHigh: true } } });
      lastSnap = simulateCompiledCircuit(compiled, proj, seq, {
        runtimeInputs: { clk: { clockHigh: false } },
      });
    }
    const elapsedMs = performance.now() - t0;

    expect(toUnsignedInt(lastSnap.pinValues['cnt:q'])).toBe(50);
    expect(toUnsignedInt(lastSnap.pinValues[`inv_${chainLen - 1}:out`])).toBe(50);
    expect(toUnsignedInt(lastSnap.pinValues['obs_89:out'])).toBe(50);
    // 100 compiled ticks on 122 gates should finish comfortably under 1 second
    expect(elapsedMs).toBeLessThan(1000);
  });
});
