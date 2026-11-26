import { describe, expect, it } from 'vite-plus/test';
import {
  BIT_0,
  BIT_1,
  BIT_X,
  BIT_Z,
  Bit,
  bitAnd,
  bitBuf,
  bitNot,
  bitOr,
  bitTriBuf,
  bitXor,
  fromInt,
  fromLiteral,
  LogicValue,
  makeUniform,
  resolveBit,
  toBinString,
  toHexString,
  toUnsignedInt,
} from '../src/core/logic4';
import {
  compileCircuit,
  createEmptySequentialState,
  simulateCircuit,
  simulateCompiledCircuit,
} from '../src/core/simulator';
import { CircuitDocument, GateInstance, ProjectDocument, Wire } from '../src/core/types';

function makeProject(
  circuit: CircuitDocument,
  extraCircuits: CircuitDocument[] = [],
): ProjectDocument {
  const circuits: Record<string, CircuitDocument> = { [circuit.id]: circuit };
  for (const c of extraCircuits) circuits[c.id] = c;
  return {
    version: 1,
    name: 'TestProject',
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

function wire(id: string, fg: string, fp: string, tg: string, tp: string, netLabel?: string): Wire {
  return {
    id,
    from: { gateId: fg, pinId: fp },
    to: { gateId: tg, pinId: tp },
    points: [],
    netLabel,
    routeMode: 'grid',
  };
}

describe('Exhaustive IEEE 1364 4-State Truth Tables', () => {
  const ALL_BITS: Bit[] = [BIT_0, BIT_1, BIT_X, BIT_Z];

  it('verifies complete 4x4 truth tables for AND, OR, XOR, NOT, BUF, TRIBUF', () => {
    const expectedAnd: Record<Bit, Record<Bit, Bit>> = {
      [BIT_0]: { [BIT_0]: BIT_0, [BIT_1]: BIT_0, [BIT_X]: BIT_0, [BIT_Z]: BIT_0 },
      [BIT_1]: { [BIT_0]: BIT_0, [BIT_1]: BIT_1, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_X]: { [BIT_0]: BIT_0, [BIT_1]: BIT_X, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_Z]: { [BIT_0]: BIT_0, [BIT_1]: BIT_X, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
    };
    const expectedOr: Record<Bit, Record<Bit, Bit>> = {
      [BIT_0]: { [BIT_0]: BIT_0, [BIT_1]: BIT_1, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_1]: { [BIT_0]: BIT_1, [BIT_1]: BIT_1, [BIT_X]: BIT_1, [BIT_Z]: BIT_1 },
      [BIT_X]: { [BIT_0]: BIT_X, [BIT_1]: BIT_1, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_Z]: { [BIT_0]: BIT_X, [BIT_1]: BIT_1, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
    };
    const expectedXor: Record<Bit, Record<Bit, Bit>> = {
      [BIT_0]: { [BIT_0]: BIT_0, [BIT_1]: BIT_1, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_1]: { [BIT_0]: BIT_1, [BIT_1]: BIT_0, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_X]: { [BIT_0]: BIT_X, [BIT_1]: BIT_X, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
      [BIT_Z]: { [BIT_0]: BIT_X, [BIT_1]: BIT_X, [BIT_X]: BIT_X, [BIT_Z]: BIT_X },
    };

    for (const a of ALL_BITS) {
      expect(bitNot(a)).toBe(a === BIT_0 ? BIT_1 : a === BIT_1 ? BIT_0 : BIT_X);
      expect(bitBuf(a)).toBe(a === BIT_0 || a === BIT_1 ? a : BIT_X);
      for (const b of ALL_BITS) {
        expect(bitAnd(a, b)).toBe(expectedAnd[a][b]);
        expect(bitOr(a, b)).toBe(expectedOr[a][b]);
        expect(bitXor(a, b)).toBe(expectedXor[a][b]);
      }
    }

    // TRIBUF(data, en)
    for (const d of ALL_BITS) {
      expect(bitTriBuf(d, BIT_0)).toBe(BIT_Z);
      expect(bitTriBuf(d, BIT_1)).toBe(d === BIT_Z ? BIT_X : d);
      expect(bitTriBuf(d, BIT_X)).toBe(BIT_X);
      expect(bitTriBuf(d, BIT_Z)).toBe(BIT_X);
    }

    // Multi-driver bus resolution
    expect(resolveBit([BIT_0, BIT_Z, BIT_0])).toBe(BIT_0);
    expect(resolveBit([BIT_1, BIT_Z, BIT_1])).toBe(BIT_1);
    expect(resolveBit([BIT_0, BIT_1, BIT_Z])).toBe(BIT_X);
    expect(resolveBit([BIT_Z, BIT_Z])).toBe(BIT_Z);
  });

  it('parses and formats multi-bit 4-state literals accurately', () => {
    const v = fromLiteral('0b10xz', 4);
    expect(v.bits).toEqual([BIT_Z, BIT_X, BIT_0, BIT_1]);
    expect(toBinString(v)).toBe('10XZ');
    expect(toHexString(fromInt(0xa5, 8))).toBe('A5');
    expect(toHexString(makeUniform(BIT_Z, 8))).toBe('ZZ');
  });
});

describe('Combinational Components Correctness', () => {
  it('verifies 4-input AND/OR/NAND/NOR/XOR/XNOR gates across all 16 combinations', () => {
    const gates: GateInstance[] = [
      { id: 'i0', type: 'MODULE_IN', x: 0, y: 0, rotation: 0, label: 'a', props: { bitWidth: 1 } },
      { id: 'i1', type: 'MODULE_IN', x: 0, y: 40, rotation: 0, label: 'b', props: { bitWidth: 1 } },
      { id: 'i2', type: 'MODULE_IN', x: 0, y: 80, rotation: 0, label: 'c', props: { bitWidth: 1 } },
      {
        id: 'i3',
        type: 'MODULE_IN',
        x: 0,
        y: 120,
        rotation: 0,
        label: 'd',
        props: { bitWidth: 1 },
      },
      {
        id: 'g_and',
        type: 'AND',
        x: 200,
        y: 0,
        rotation: 0,
        label: '',
        props: { inputCount: 4, bitWidth: 1 },
      },
      {
        id: 'g_nand',
        type: 'NAND',
        x: 200,
        y: 80,
        rotation: 0,
        label: '',
        props: { inputCount: 4, bitWidth: 1 },
      },
      {
        id: 'g_or',
        type: 'OR',
        x: 200,
        y: 160,
        rotation: 0,
        label: '',
        props: { inputCount: 4, bitWidth: 1 },
      },
      {
        id: 'g_nor',
        type: 'NOR',
        x: 200,
        y: 240,
        rotation: 0,
        label: '',
        props: { inputCount: 4, bitWidth: 1 },
      },
      {
        id: 'g_xor',
        type: 'XOR',
        x: 200,
        y: 320,
        rotation: 0,
        label: '',
        props: { inputCount: 4, bitWidth: 1 },
      },
      {
        id: 'g_xnor',
        type: 'XNOR',
        x: 200,
        y: 400,
        rotation: 0,
        label: '',
        props: { inputCount: 4, bitWidth: 1 },
      },
    ];
    const wires: Wire[] = [];
    for (const gid of ['g_and', 'g_nand', 'g_or', 'g_nor', 'g_xor', 'g_xnor']) {
      for (let k = 0; k < 4; k++) {
        wires.push(wire(`w_${gid}_${k}`, `i${k}`, 'out', gid, `in${k}`));
      }
    }
    const circ: CircuitDocument = { id: 'c_gates', name: 'Gates4', gates, wires };
    const proj = makeProject(circ);

    for (let mask = 0; mask < 16; mask++) {
      const b0 = (mask >> 0) & 1;
      const b1 = (mask >> 1) & 1;
      const b2 = (mask >> 2) & 1;
      const b3 = (mask >> 3) & 1;
      const snap = simulateCircuit(circ, proj, createEmptySequentialState(), {
        externalInputs: {
          i0: fromInt(b0, 1),
          i1: fromInt(b1, 1),
          i2: fromInt(b2, 1),
          i3: fromInt(b3, 1),
        },
      });
      const expAnd = b0 & b1 & b2 & b3;
      const expOr = b0 | b1 | b2 | b3;
      const expXor = b0 ^ b1 ^ b2 ^ b3;
      expect(snap.pinValues['g_and:out'].bits[0]).toBe(expAnd);
      expect(snap.pinValues['g_nand:out'].bits[0]).toBe(expAnd ^ 1);
      expect(snap.pinValues['g_or:out'].bits[0]).toBe(expOr);
      expect(snap.pinValues['g_nor:out'].bits[0]).toBe(expOr ^ 1);
      expect(snap.pinValues['g_xor:out'].bits[0]).toBe(expXor);
      expect(snap.pinValues['g_xnor:out'].bits[0]).toBe(expXor ^ 1);
    }
  });

  it('verifies 4:1 MUX, 1:4 DEMUX, 2-to-4 DECODER, 4-bit ADDER, and 4-bit COMPARATOR', () => {
    const circ: CircuitDocument = {
      id: 'c_comb',
      name: 'Comb',
      gates: [
        {
          id: 'd0',
          type: 'CONST',
          x: 0,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, value: '0x3' },
        },
        {
          id: 'd1',
          type: 'CONST',
          x: 0,
          y: 40,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, value: '0x7' },
        },
        {
          id: 'd2',
          type: 'CONST',
          x: 0,
          y: 80,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, value: '0xB' },
        },
        {
          id: 'd3',
          type: 'CONST',
          x: 0,
          y: 120,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, value: '0xE' },
        },
        {
          id: 'sel',
          type: 'MODULE_IN',
          x: 0,
          y: 180,
          rotation: 0,
          label: 'sel',
          props: { bitWidth: 2 },
        },
        {
          id: 'mux',
          type: 'MUX',
          x: 200,
          y: 60,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, selectBits: 2 },
        },
        {
          id: 'demux',
          type: 'DEMUX',
          x: 400,
          y: 60,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, selectBits: 2 },
        },
        {
          id: 'dec',
          type: 'DECODER',
          x: 200,
          y: 220,
          rotation: 0,
          label: '',
          props: { selectBits: 2 },
        },
        {
          id: 'a',
          type: 'MODULE_IN',
          x: 0,
          y: 320,
          rotation: 0,
          label: 'a',
          props: { bitWidth: 4 },
        },
        {
          id: 'b',
          type: 'MODULE_IN',
          x: 0,
          y: 380,
          rotation: 0,
          label: 'b',
          props: { bitWidth: 4 },
        },
        {
          id: 'cin',
          type: 'MODULE_IN',
          x: 0,
          y: 440,
          rotation: 0,
          label: 'cin',
          props: { bitWidth: 1 },
        },
        {
          id: 'add',
          type: 'ADDER',
          x: 200,
          y: 360,
          rotation: 0,
          label: '',
          props: { bitWidth: 4 },
        },
        {
          id: 'cmp',
          type: 'COMPARATOR',
          x: 400,
          y: 360,
          rotation: 0,
          label: '',
          props: { bitWidth: 4 },
        },
      ],
      wires: [
        wire('w0', 'd0', 'out', 'mux', 'd0'),
        wire('w1', 'd1', 'out', 'mux', 'd1'),
        wire('w2', 'd2', 'out', 'mux', 'd2'),
        wire('w3', 'd3', 'out', 'mux', 'd3'),
        wire('ws1', 'sel', 'out', 'mux', 'sel'),
        wire('wm', 'mux', 'out', 'demux', 'in'),
        wire('ws2', 'sel', 'out', 'demux', 'sel'),
        wire('ws3', 'sel', 'out', 'dec', 'sel'),
        wire('wa1', 'a', 'out', 'add', 'a'),
        wire('wb1', 'b', 'out', 'add', 'b'),
        wire('wc1', 'cin', 'out', 'add', 'cin'),
        wire('wa2', 'a', 'out', 'cmp', 'a'),
        wire('wb2', 'b', 'out', 'cmp', 'b'),
      ],
    };
    const proj = makeProject(circ);
    const muxExpected = [0x3, 0x7, 0xb, 0xe];

    for (let s = 0; s < 4; s++) {
      const aVal = (s * 4 + 2) & 0xf;
      const bVal = (14 - s * 3) & 0xf;
      const cinVal = s & 1;
      const snap = simulateCircuit(circ, proj, createEmptySequentialState(), {
        externalInputs: {
          sel: fromInt(s, 2),
          a: fromInt(aVal, 4),
          b: fromInt(bVal, 4),
          cin: fromInt(cinVal, 1),
        },
      });
      // MUX
      expect(toUnsignedInt(snap.pinValues['mux:out'])).toBe(muxExpected[s]);
      // DEMUX
      for (let ch = 0; ch < 4; ch++) {
        expect(toUnsignedInt(snap.pinValues[`demux:y${ch}`])).toBe(ch === s ? muxExpected[s] : 0);
      }
      // DECODER
      for (let ch = 0; ch < 4; ch++) {
        expect(snap.pinValues[`dec:y${ch}`].bits[0]).toBe(ch === s ? BIT_1 : BIT_0);
      }
      // ADDER
      const total = aVal + bVal + cinVal;
      expect(toUnsignedInt(snap.pinValues['add:s'])).toBe(total & 0xf);
      expect(snap.pinValues['add:cout'].bits[0]).toBe(total > 15 ? BIT_1 : BIT_0);
      // COMPARATOR
      expect(snap.pinValues['cmp:lt'].bits[0]).toBe(aVal < bVal ? BIT_1 : BIT_0);
      expect(snap.pinValues['cmp:eq'].bits[0]).toBe(aVal === bVal ? BIT_1 : BIT_0);
      expect(snap.pinValues['cmp:gt'].bits[0]).toBe(aVal > bVal ? BIT_1 : BIT_0);
    }
  });
});

describe('Sequential, Memory, Tunnels & Oscillation Handling', () => {
  it('verifies D_FF, JK_FF, T_FF, SR_LATCH, D_LATCH, REGISTER, and RAM read/write/OE-Z', () => {
    const circ: CircuitDocument = {
      id: 'c_seq',
      name: 'Seq',
      gates: [
        {
          id: 'clk',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'clk',
          props: { bitWidth: 1 },
        },
        {
          id: 'd',
          type: 'MODULE_IN',
          x: 0,
          y: 40,
          rotation: 0,
          label: 'd',
          props: { bitWidth: 1 },
        },
        {
          id: 'rst',
          type: 'MODULE_IN',
          x: 0,
          y: 80,
          rotation: 0,
          label: 'rst',
          props: { bitWidth: 1 },
        },
        {
          id: 'j',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'j',
          props: { bitWidth: 1 },
        },
        {
          id: 'k',
          type: 'MODULE_IN',
          x: 0,
          y: 160,
          rotation: 0,
          label: 'k',
          props: { bitWidth: 1 },
        },
        { id: 'dff', type: 'D_FF', x: 200, y: 20, rotation: 0, label: '', props: { bitWidth: 1 } },
        {
          id: 'jkff',
          type: 'JK_FF',
          x: 200,
          y: 140,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        { id: 'tff', type: 'T_FF', x: 200, y: 260, rotation: 0, label: '', props: { bitWidth: 1 } },
        {
          id: 'sr',
          type: 'SR_LATCH',
          x: 200,
          y: 360,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        {
          id: 'dlat',
          type: 'D_LATCH',
          x: 200,
          y: 460,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        // RAM
        {
          id: 'addr',
          type: 'MODULE_IN',
          x: 400,
          y: 0,
          rotation: 0,
          label: 'addr',
          props: { bitWidth: 4 },
        },
        {
          id: 'din',
          type: 'MODULE_IN',
          x: 400,
          y: 40,
          rotation: 0,
          label: 'din',
          props: { bitWidth: 4 },
        },
        {
          id: 'we',
          type: 'MODULE_IN',
          x: 400,
          y: 80,
          rotation: 0,
          label: 'we',
          props: { bitWidth: 1 },
        },
        {
          id: 'oe',
          type: 'MODULE_IN',
          x: 400,
          y: 120,
          rotation: 0,
          label: 'oe',
          props: { bitWidth: 1 },
        },
        {
          id: 'ram',
          type: 'RAM',
          x: 600,
          y: 60,
          rotation: 0,
          label: '',
          props: { addrBits: 4, dataBits: 4 },
        },
      ],
      wires: [
        wire('w1', 'd', 'out', 'dff', 'd'),
        wire('w2', 'clk', 'out', 'dff', 'clk'),
        wire('w3', 'rst', 'out', 'dff', 'rst'),
        wire('w4', 'j', 'out', 'jkff', 'j'),
        wire('w5', 'k', 'out', 'jkff', 'k'),
        wire('w6', 'clk', 'out', 'jkff', 'clk'),
        wire('w7', 'rst', 'out', 'jkff', 'rst'),
        wire('w8', 'j', 'out', 'tff', 't'),
        wire('w9', 'clk', 'out', 'tff', 'clk'),
        wire('w10', 'rst', 'out', 'tff', 'rst'),
        wire('w11', 'j', 'out', 'sr', 's'),
        wire('w12', 'k', 'out', 'sr', 'r'),
        wire('w13', 'd', 'out', 'dlat', 'd'),
        wire('w14', 'clk', 'out', 'dlat', 'en'),
        wire('w15', 'addr', 'out', 'ram', 'addr'),
        wire('w16', 'din', 'out', 'ram', 'din'),
        wire('w17', 'we', 'out', 'ram', 'we'),
        wire('w18', 'clk', 'out', 'ram', 'clk'),
        wire('w19', 'oe', 'out', 'ram', 'oe'),
      ],
    };
    const proj = makeProject(circ);
    const seq = createEmptySequentialState();

    const step = (inp: Record<string, LogicValue>) =>
      simulateCircuit(circ, proj, seq, { externalInputs: inp });

    // Initial clk=0, d=1, j=1, k=0, write 0xC to addr 0x5
    let s = step({
      clk: fromInt(0, 1),
      d: fromInt(1, 1),
      rst: fromInt(0, 1),
      j: fromInt(1, 1),
      k: fromInt(0, 1),
      addr: fromInt(5, 4),
      din: fromInt(0xc, 4),
      we: fromInt(1, 1),
      oe: fromInt(1, 1),
    });
    expect(s.pinValues['dff:q'].bits[0]).toBe(BIT_0);
    expect(s.pinValues['sr:q'].bits[0]).toBe(BIT_1); // S=1, R=0 -> Q=1

    // Rising edge clk=1 -> D_FF latches 1, JK_FF sets 1, T_FF toggles 0->1, D_LATCH transparent -> 1, RAM[5] <= 0xC
    s = step({
      clk: fromInt(1, 1),
      d: fromInt(1, 1),
      rst: fromInt(0, 1),
      j: fromInt(1, 1),
      k: fromInt(0, 1),
      addr: fromInt(5, 4),
      din: fromInt(0xc, 4),
      we: fromInt(1, 1),
      oe: fromInt(1, 1),
    });
    expect(s.pinValues['dff:q'].bits[0]).toBe(BIT_1);
    expect(s.pinValues['dff:qn'].bits[0]).toBe(BIT_0);
    expect(s.pinValues['jkff:q'].bits[0]).toBe(BIT_1);
    expect(s.pinValues['tff:q'].bits[0]).toBe(BIT_1);
    expect(s.pinValues['dlat:q'].bits[0]).toBe(BIT_1);
    expect(toUnsignedInt(s.pinValues['ram:dout'])).toBe(0xc);

    // Falling edge clk=0, d=0 -> D_FF holds 1, D_LATCH holds 1 (EN=0), JK=11 prepared, SR S=R=1 -> X, RAM OE=0 -> Z!
    s = step({
      clk: fromInt(0, 1),
      d: fromInt(0, 1),
      rst: fromInt(0, 1),
      j: fromInt(1, 1),
      k: fromInt(1, 1),
      addr: fromInt(5, 4),
      din: fromInt(0x0, 4),
      we: fromInt(0, 1),
      oe: fromInt(0, 1),
    });
    expect(s.pinValues['dff:q'].bits[0]).toBe(BIT_1);
    expect(s.pinValues['dlat:q'].bits[0]).toBe(BIT_1);
    expect(s.pinValues['sr:q'].bits[0]).toBe(BIT_X);
    expect(s.pinValues['ram:dout'].bits.every((b) => b === BIT_Z)).toBe(true);

    // Rising edge clk=1 -> JK=11 toggles 1->0, T=1 toggles 1->0, D_FF latches 0, RAM OE=1 still reads 0xC!
    s = step({
      clk: fromInt(1, 1),
      d: fromInt(0, 1),
      rst: fromInt(0, 1),
      j: fromInt(1, 1),
      k: fromInt(1, 1),
      addr: fromInt(5, 4),
      din: fromInt(0x0, 4),
      we: fromInt(0, 1),
      oe: fromInt(1, 1),
    });
    expect(s.pinValues['dff:q'].bits[0]).toBe(BIT_0);
    expect(s.pinValues['jkff:q'].bits[0]).toBe(BIT_0);
    expect(s.pinValues['tff:q'].bits[0]).toBe(BIT_0);
    expect(toUnsignedInt(s.pinValues['ram:dout'])).toBe(0xc);
  });

  it('connects wireless TUNNELs and detects combinational oscillation loops safely as X', () => {
    const circ: CircuitDocument = {
      id: 'c_osc',
      name: 'TunnelAndOsc',
      gates: [
        {
          id: 'c1',
          type: 'CONST',
          x: 0,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, value: '1' },
        },
        {
          id: 't1',
          type: 'TUNNEL',
          x: 100,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, netName: 'SIG_A' },
        },
        {
          id: 't2',
          type: 'TUNNEL',
          x: 300,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, netName: 'SIG_A' },
        },
        { id: 'led', type: 'LED', x: 400, y: 0, rotation: 0, label: '', props: { bitWidth: 1 } },
        // Uninitialized inverter loop converges immediately to X (NOT(Z)=X, NOT(X)=X)
        {
          id: 'ring_not',
          type: 'NOT',
          x: 200,
          y: 160,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
        // Active 0<->1 oscillating loop: SR_LATCH (starts Q=0, Qn=1) with S = Qn, R = Q flips every delta cycle!
        {
          id: 'osc_sr',
          type: 'SR_LATCH',
          x: 200,
          y: 280,
          rotation: 0,
          label: '',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        wire('w1', 'c1', 'out', 't1', 'io'),
        wire('w2', 't2', 'io', 'led', 'in'),
        wire('w_not', 'ring_not', 'out', 'ring_not', 'in0'),
        wire('w_os1', 'osc_sr', 'qn', 'osc_sr', 's'),
        wire('w_os2', 'osc_sr', 'q', 'osc_sr', 'r'),
      ],
    };
    const proj = makeProject(circ);
    const snap = simulateCircuit(circ, proj, createEmptySequentialState());

    expect(snap.pinValues['led:in'].bits[0]).toBe(BIT_1);
    expect(snap.pinValues['ring_not:out'].bits[0]).toBe(BIT_X);
    expect(snap.oscillating).toBe(true);
    expect(snap.pinValues['osc_sr:q'].bits[0]).toBe(BIT_X);
  });

  it('isolates sequential state across multiple instances of the same subcircuit', () => {
    const subCnt: CircuitDocument = {
      id: 'sub_cnt',
      name: 'SubCounter',
      gates: [
        {
          id: 'in_clk',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'clk',
          props: { bitWidth: 1 },
        },
        {
          id: 'cnt',
          type: 'COUNTER',
          x: 200,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth: 4 },
        },
        {
          id: 'out_q',
          type: 'MODULE_OUT',
          x: 400,
          y: 0,
          rotation: 0,
          label: 'q',
          props: { bitWidth: 4 },
        },
      ],
      wires: [wire('ws1', 'in_clk', 'out', 'cnt', 'clk'), wire('ws2', 'cnt', 'q', 'out_q', 'in')],
    };
    const top: CircuitDocument = {
      id: 'top_iso',
      name: 'TopIso',
      gates: [
        {
          id: 'clk_a',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'clk_a',
          props: { bitWidth: 1 },
        },
        {
          id: 'clk_b',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'clk_b',
          props: { bitWidth: 1 },
        },
        {
          id: 'u1',
          type: 'SUBCIRCUIT',
          x: 240,
          y: 0,
          rotation: 0,
          label: 'U1',
          props: { subcircuitId: 'sub_cnt' },
        },
        {
          id: 'u2',
          type: 'SUBCIRCUIT',
          x: 240,
          y: 120,
          rotation: 0,
          label: 'U2',
          props: { subcircuitId: 'sub_cnt' },
        },
      ],
      wires: [
        wire('wt1', 'clk_a', 'out', 'u1', 'in_clk'),
        wire('wt2', 'clk_b', 'out', 'u2', 'in_clk'),
      ],
    };
    const proj = makeProject(top, [subCnt]);
    const seq = createEmptySequentialState();

    // Clock U1 twice, U2 once
    simulateCircuit(top, proj, seq, {
      externalInputs: { clk_a: fromInt(0, 1), clk_b: fromInt(0, 1) },
    });
    simulateCircuit(top, proj, seq, {
      externalInputs: { clk_a: fromInt(1, 1), clk_b: fromInt(0, 1) },
    });
    simulateCircuit(top, proj, seq, {
      externalInputs: { clk_a: fromInt(0, 1), clk_b: fromInt(1, 1) },
    });
    const snap = simulateCircuit(top, proj, seq, {
      externalInputs: { clk_a: fromInt(1, 1), clk_b: fromInt(0, 1) },
    });

    expect(toUnsignedInt(snap.pinValues['u1:out_q'])).toBe(2);
    expect(toUnsignedInt(snap.pinValues['u2:out_q'])).toBe(1);
  });

  it('executes pre-compiled circuits with runtimeInputs without mutating ProjectDocument', () => {
    const circ: CircuitDocument = {
      id: 'c_compiled',
      name: 'CompiledCounter',
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
          id: 'en',
          type: 'TOGGLE',
          x: 0,
          y: 60,
          rotation: 0,
          label: 'EN',
          props: { bitWidth: 1, value: '1' },
        },
        {
          id: 'cnt',
          type: 'COUNTER',
          x: 200,
          y: 20,
          rotation: 0,
          label: 'CNT',
          props: { bitWidth: 4 },
        },
      ],
      wires: [wire('wc1', 'clk', 'out', 'cnt', 'clk'), wire('wc2', 'en', 'out', 'cnt', 'en')],
    };
    const proj = makeProject(circ);
    const beforeJson = JSON.stringify(proj);

    // Compile ONCE and run 10 clock ticks via lightweight runtimeInputs overrides!
    const compiled = compileCircuit(circ, proj);
    const seq = createEmptySequentialState();
    let lastSnap = simulateCompiledCircuit(compiled, proj, seq, {
      runtimeInputs: { clk: { clockHigh: false }, en: { value: '1' } },
    });
    for (let i = 0; i < 5; i++) {
      simulateCompiledCircuit(compiled, proj, seq, {
        runtimeInputs: { clk: { clockHigh: true }, en: { value: '1' } },
      });
      lastSnap = simulateCompiledCircuit(compiled, proj, seq, {
        runtimeInputs: { clk: { clockHigh: false }, en: { value: '1' } },
      });
    }

    expect(toUnsignedInt(lastSnap.pinValues['cnt:q'])).toBe(5);
    // ProjectDocument was never mutated or cloned!
    expect(JSON.stringify(proj)).toBe(beforeJson);
  });

  it('holds state in basic-gate cross-coupled NOR SR-latch and supports propagated-X loop reset', () => {
    const circ: CircuitDocument = {
      id: 'c_nor_sr',
      name: 'GateSRLatch',
      gates: [
        {
          id: 'in_s',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'S',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_r',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'R',
          props: { bitWidth: 1 },
        },
        {
          id: 'nor_q',
          type: 'NOR',
          x: 160,
          y: 0,
          rotation: 0,
          label: 'NOR_Q',
          props: { inputCount: 2, bitWidth: 1 },
        },
        {
          id: 'nor_qn',
          type: 'NOR',
          x: 160,
          y: 120,
          rotation: 0,
          label: 'NOR_QN',
          props: { inputCount: 2, bitWidth: 1 },
        },
      ],
      wires: [
        wire('w_r', 'in_r', 'out', 'nor_q', 'in0'),
        wire('w_s', 'in_s', 'out', 'nor_qn', 'in1'),
        wire('w_fb1', 'nor_qn', 'out', 'nor_q', 'in1'),
        wire('w_fb2', 'nor_q', 'out', 'nor_qn', 'in0'),
      ],
    };
    const proj = makeProject(circ);
    const seq = createEmptySequentialState();

    // 1. Cold start S=0, R=0 -> genuinely bistable (stays X 'unknown', NOT falsely oscillating!)
    const snapInit = simulateCircuit(circ, proj, seq, {
      externalInputs: { in_s: fromInt(0, 1), in_r: fromInt(0, 1) },
    });
    expect(snapInit.oscillating).toBe(false);
    expect(snapInit.pinValues['nor_q:out'].bits[0]).toBe(BIT_X);
    expect(snapInit.pinXCauses?.['nor_q:out']).toBe('unknown');

    // 2. Pulse S=1, R=0 -> latches Q=1, Qn=0
    const snapSet = simulateCircuit(circ, proj, seq, {
      externalInputs: { in_s: fromInt(1, 1), in_r: fromInt(0, 1) },
    });
    expect(snapSet.pinValues['nor_q:out'].bits[0]).toBe(BIT_1);
    expect(snapSet.pinValues['nor_qn:out'].bits[0]).toBe(BIT_0);

    // 3. Release S=0, R=0 (HOLD) -> MUST hold Q=1, Qn=0 (not collapse back to X!)
    const snapHold1 = simulateCircuit(circ, proj, seq, {
      externalInputs: { in_s: fromInt(0, 1), in_r: fromInt(0, 1) },
    });
    expect(snapHold1.oscillating).toBe(false);
    expect(snapHold1.pinValues['nor_q:out'].bits[0]).toBe(BIT_1);
    expect(snapHold1.pinValues['nor_qn:out'].bits[0]).toBe(BIT_0);

    // 4. Pulse S=0, R=1 -> resets Q=0, Qn=1, then HOLD S=0, R=0 -> holds Q=0, Qn=1
    simulateCircuit(circ, proj, seq, {
      externalInputs: { in_s: fromInt(0, 1), in_r: fromInt(1, 1) },
    });
    const snapHold0 = simulateCircuit(circ, proj, seq, {
      externalInputs: { in_s: fromInt(0, 1), in_r: fromInt(0, 1) },
    });
    expect(snapHold0.pinValues['nor_q:out'].bits[0]).toBe(BIT_0);
    expect(snapHold0.pinValues['nor_qn:out'].bits[0]).toBe(BIT_1);

    // 5. Manual resetUnknownLoops breaks symmetry on cold S=0, R=0 latch into a valid complementary state
    const freshSeq = createEmptySequentialState();
    freshSeq.resetUnknownLoops = true;
    const snapReset = simulateCircuit(circ, proj, freshSeq, {
      externalInputs: { in_s: fromInt(0, 1), in_r: fromInt(0, 1) },
    });
    const qBit = snapReset.pinValues['nor_q:out'].bits[0];
    const qnBit = snapReset.pinValues['nor_qn:out'].bits[0];
    expect([BIT_0, BIT_1]).toContain(qBit);
    expect([BIT_0, BIT_1]).toContain(qnBit);
    expect(qBit).not.toBe(qnBit);
    // And holds that initialized state on the next tick!
    const snapAfterReset = simulateCircuit(circ, proj, freshSeq, {
      externalInputs: { in_s: fromInt(0, 1), in_r: fromInt(0, 1) },
    });
    expect(snapAfterReset.pinValues['nor_q:out'].bits[0]).toBe(qBit);
    expect(snapAfterReset.pinValues['nor_qn:out'].bits[0]).toBe(qnBit);
  });

  it('auto-resolves uniquely determined gate loops, flags bare NOT ring oscillators, and keeps real floating X', () => {
    // 1. Uniquely determined loops: y1 = y1 ^ y1 (=0), y2 = y2 & ~y2 (=0), y3 = y3 | ~y3 (=1), y4 = MUX(y4, 1, 1) (=1)
    const detCirc: CircuitDocument = {
      id: 'c_det_loops',
      name: 'DetLoops',
      gates: [
        {
          id: 'xor1',
          type: 'XOR',
          x: 0,
          y: 0,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
        { id: 'not2', type: 'NOT', x: 0, y: 80, rotation: 0, label: '', props: { bitWidth: 1 } },
        {
          id: 'and2',
          type: 'AND',
          x: 100,
          y: 80,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
        { id: 'not3', type: 'NOT', x: 0, y: 160, rotation: 0, label: '', props: { bitWidth: 1 } },
        {
          id: 'or3',
          type: 'OR',
          x: 100,
          y: 160,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
        {
          id: 'c1',
          type: 'CONST',
          x: 0,
          y: 240,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, value: '1' },
        },
        {
          id: 'mux4',
          type: 'MUX',
          x: 100,
          y: 240,
          rotation: 0,
          label: '',
          props: { bitWidth: 1, selectBits: 1 },
        },
        // Real floating input: AND(1, unconnected_Z) -> MUST remain X ('unknown')!
        {
          id: 'and_float',
          type: 'AND',
          x: 100,
          y: 340,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
      ],
      wires: [
        wire('w_x1', 'xor1', 'out', 'xor1', 'in0'),
        wire('w_x2', 'xor1', 'out', 'xor1', 'in1'),
        wire('w_a1', 'and2', 'out', 'not2', 'in0'),
        wire('w_a2', 'and2', 'out', 'and2', 'in0'),
        wire('w_a3', 'not2', 'out', 'and2', 'in1'),
        wire('w_o1', 'or3', 'out', 'not3', 'in0'),
        wire('w_o2', 'or3', 'out', 'or3', 'in0'),
        wire('w_o3', 'not3', 'out', 'or3', 'in1'),
        wire('w_m0', 'c1', 'out', 'mux4', 'd0'),
        wire('w_m1', 'c1', 'out', 'mux4', 'd1'),
        wire('w_ms', 'mux4', 'out', 'mux4', 'sel'),
        wire('w_fl', 'c1', 'out', 'and_float', 'in0'),
      ],
    };
    const detProj = makeProject(detCirc);
    const detSeq = createEmptySequentialState();
    detSeq.resetUnknownLoops = true;
    const detSnap = simulateCircuit(detCirc, detProj, detSeq);
    expect(detSnap.oscillating).toBe(false);
    expect(detSnap.pinValues['xor1:out'].bits[0]).toBe(BIT_0);
    expect(detSnap.pinValues['and2:out'].bits[0]).toBe(BIT_0);
    expect(detSnap.pinValues['or3:out'].bits[0]).toBe(BIT_1);
    expect(detSnap.pinValues['mux4:out'].bits[0]).toBe(BIT_1);
    expect(detSnap.pinXCauses?.['xor1:out']).toBeUndefined();
    expect(detSnap.pinXCauses?.['and2:out']).toBeUndefined();
    expect(detSnap.pinXCauses?.['or3:out']).toBeUndefined();
    expect(detSnap.pinXCauses?.['mux4:out']).toBeUndefined();
    // Genuine floating input stays X ('unknown') even when resetUnknownLoops is true
    expect(detSnap.pinValues['and_float:out'].bits[0]).toBe(BIT_X);
    expect(detSnap.pinXCauses?.['and_float:out']).toBe('unknown');

    // 2. Bare 3-NOT ring oscillator -> classified as 'oscillation', NOT 'unknown'!
    const ringCirc: CircuitDocument = {
      id: 'c_ring3',
      name: 'Ring3',
      gates: [
        { id: 'n1', type: 'NOT', x: 0, y: 0, rotation: 0, label: '', props: { bitWidth: 1 } },
        { id: 'n2', type: 'NOT', x: 100, y: 0, rotation: 0, label: '', props: { bitWidth: 1 } },
        { id: 'n3', type: 'NOT', x: 200, y: 0, rotation: 0, label: '', props: { bitWidth: 1 } },
      ],
      wires: [
        wire('wr1', 'n1', 'out', 'n2', 'in0'),
        wire('wr2', 'n2', 'out', 'n3', 'in0'),
        wire('wr3', 'n3', 'out', 'n1', 'in0'),
      ],
    };
    const ringProj = makeProject(ringCirc);
    const ringSnap = simulateCircuit(ringCirc, ringProj, createEmptySequentialState());
    expect(ringSnap.oscillating).toBe(true);
    expect(ringSnap.wireXCauses?.['wr1']).toBe('oscillation');
    expect(ringSnap.wireXCauses?.['wr2']).toBe('oscillation');
    expect(ringSnap.wireXCauses?.['wr3']).toBe('oscillation');
  });
});
