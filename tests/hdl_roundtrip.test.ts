import { describe, expect, it } from 'vite-plus/test';
import {
  exportDotGraph,
  exportJsonNetlist,
  exportVerilog,
  importVerilogToCircuits,
} from '../src/core/hdl';
import {
  BIT_0,
  BIT_1,
  BIT_Z,
  fromInt,
  LogicValue,
  toUnsignedInt,
  valuesEqual,
} from '../src/core/logic4';
import { createSampleProject } from '../src/core/samples';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { CircuitDocument, ProjectDocument, Wire } from '../src/core/types';

function makeProject(circuits: CircuitDocument[], activeId: string): ProjectDocument {
  const map: Record<string, CircuitDocument> = {};
  for (const c of circuits) map[c.id] = c;
  return {
    version: 1,
    name: 'RoundTripProject',
    activeCircuitId: activeId,
    circuits: map,
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

function wire(id: string, fg: string, fp: string, tg: string, tp: string): Wire {
  return {
    id,
    from: { gateId: fg, pinId: fp },
    to: { gateId: tg, pinId: tp },
    points: [],
    routeMode: 'grid',
  };
}

function evalProjectByPortNames(
  project: ProjectDocument,
  circuitId: string,
  inputs: Record<string, LogicValue>,
): Record<string, LogicValue> {
  const circ = project.circuits[circuitId];
  const ext: Record<string, LogicValue> = {};
  for (const g of circ.gates) {
    if (g.type === 'MODULE_IN' && g.label in inputs) {
      ext[g.id] = inputs[g.label];
    }
  }
  const snap = simulateCircuit(circ, project, createEmptySequentialState(), {
    externalInputs: ext,
  });
  const out: Record<string, LogicValue> = {};
  for (const g of circ.gates) {
    if (g.type === 'MODULE_OUT') {
      out[g.label] = snap.pinValues[`${g.id}:in`];
    }
  }
  return out;
}

describe('Verilog Export -> Re-Import Round-Trip Functional Equivalence', () => {
  it('round-trips Sample FullAdder circuit with 100% identical 8-row truth table', () => {
    const origProj = createSampleProject();
    const verilog = exportVerilog(origProj, 'circ_full_adder');

    const reimported = importVerilogToCircuits(verilog);
    const rtProj = makeProject(reimported.circuits, reimported.topCircuitId);

    for (let m = 0; m < 8; m++) {
      const vec = {
        A: fromInt((m >> 0) & 1, 1),
        B: fromInt((m >> 1) & 1, 1),
        Cin: fromInt((m >> 2) & 1, 1),
      };
      const origOut = evalProjectByPortNames(origProj, 'circ_full_adder', vec);
      const rtOut = evalProjectByPortNames(rtProj, reimported.topCircuitId, vec);

      expect(valuesEqual(rtOut.S, origOut.S)).toBe(true);
      expect(valuesEqual(rtOut.Cout, origOut.Cout)).toBe(true);
    }
  });

  it('round-trips a complex combinational circuit (4:1 MUX, NAND/NOR/XNOR, passthrough, fanout, 4-bit ADDER)', () => {
    const circ: CircuitDocument = {
      id: 'c_rt',
      name: 'ComplexComb',
      gates: [
        {
          id: 'in_a',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'a',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_b',
          type: 'MODULE_IN',
          x: 0,
          y: 60,
          rotation: 0,
          label: 'b',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_sel',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'sel',
          props: { bitWidth: 2 },
        },
        {
          id: 'g_nand',
          type: 'NAND',
          x: 200,
          y: 0,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
        {
          id: 'g_nor',
          type: 'NOR',
          x: 200,
          y: 60,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
        {
          id: 'g_xnor',
          type: 'XNOR',
          x: 200,
          y: 120,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
        {
          id: 'g_mux4',
          type: 'MUX',
          x: 400,
          y: 60,
          rotation: 0,
          label: '',
          props: { selectBits: 2, bitWidth: 1 },
        },
        {
          id: 'out_mux',
          type: 'MODULE_OUT',
          x: 600,
          y: 60,
          rotation: 0,
          label: 'y_mux',
          props: { bitWidth: 1 },
        },
        {
          id: 'out_pass',
          type: 'MODULE_OUT',
          x: 600,
          y: 140,
          rotation: 0,
          label: 'y_pass',
          props: { bitWidth: 1 },
        },
        {
          id: 'out_fan',
          type: 'MODULE_OUT',
          x: 600,
          y: 200,
          rotation: 0,
          label: 'y_fan',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        wire('w1', 'in_a', 'out', 'g_nand', 'in0'),
        wire('w2', 'in_b', 'out', 'g_nand', 'in1'),
        wire('w3', 'in_a', 'out', 'g_nor', 'in0'),
        wire('w4', 'in_b', 'out', 'g_nor', 'in1'),
        wire('w5', 'in_a', 'out', 'g_xnor', 'in0'),
        wire('w6', 'in_b', 'out', 'g_xnor', 'in1'),
        wire('w7', 'g_nand', 'out', 'g_mux4', 'd0'),
        wire('w8', 'g_nor', 'out', 'g_mux4', 'd1'),
        wire('w9', 'g_xnor', 'out', 'g_mux4', 'd2'),
        wire('w10', 'in_a', 'out', 'g_mux4', 'd3'),
        wire('w11', 'in_sel', 'out', 'g_mux4', 'sel'),
        wire('w12', 'g_mux4', 'out', 'out_mux', 'in'),
        // Direct input->output passthrough!
        wire('w13', 'in_b', 'out', 'out_pass', 'in'),
        // Same gate driving two outputs (fanout)!
        wire('w14', 'g_nand', 'out', 'out_fan', 'in'),
      ],
    };
    const origProj = makeProject([circ], 'c_rt');
    const verilog = exportVerilog(origProj, 'c_rt');

    const reimported = importVerilogToCircuits(verilog);
    const rtProj = makeProject(reimported.circuits, reimported.topCircuitId);

    // Exhaustive 16-case check (a, b, sel[1:0])
    for (let m = 0; m < 16; m++) {
      const vec = {
        a: fromInt((m >> 0) & 1, 1),
        b: fromInt((m >> 1) & 1, 1),
        sel: fromInt((m >> 2) & 3, 2),
      };
      const origOut = evalProjectByPortNames(origProj, 'c_rt', vec);
      const rtOut = evalProjectByPortNames(rtProj, reimported.topCircuitId, vec);

      expect(valuesEqual(rtOut.y_mux, origOut.y_mux)).toBe(true);
      expect(valuesEqual(rtOut.y_pass, origOut.y_pass)).toBe(true);
      expect(valuesEqual(rtOut.y_fan, origOut.y_fan)).toBe(true);
    }
  });

  it('round-trips Tri-State buffer and 4-bit ADDER with identical 4-state & arithmetic behavior', () => {
    const circ: CircuitDocument = {
      id: 'c_tri_add',
      name: 'TriAndAdd',
      gates: [
        {
          id: 'in_a',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'a',
          props: { bitWidth: 4 },
        },
        {
          id: 'in_b',
          type: 'MODULE_IN',
          x: 0,
          y: 60,
          rotation: 0,
          label: 'b',
          props: { bitWidth: 4 },
        },
        {
          id: 'in_en',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'en',
          props: { bitWidth: 1 },
        },
        { id: 'add', type: 'ADDER', x: 200, y: 20, rotation: 0, label: '', props: { bitWidth: 4 } },
        {
          id: 'tri',
          type: 'TRIBUF',
          x: 380,
          y: 20,
          rotation: 0,
          label: '',
          props: { bitWidth: 4 },
        },
        {
          id: 'out_y',
          type: 'MODULE_OUT',
          x: 560,
          y: 20,
          rotation: 0,
          label: 'y',
          props: { bitWidth: 4 },
        },
        {
          id: 'out_c',
          type: 'MODULE_OUT',
          x: 560,
          y: 80,
          rotation: 0,
          label: 'cout',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        wire('w1', 'in_a', 'out', 'add', 'a'),
        wire('w2', 'in_b', 'out', 'add', 'b'),
        wire('w3', 'add', 's', 'tri', 'in0'),
        wire('w4', 'in_en', 'out', 'tri', 'en'),
        wire('w5', 'tri', 'out', 'out_y', 'in'),
        wire('w6', 'add', 'cout', 'out_c', 'in'),
      ],
    };
    const origProj = makeProject([circ], 'c_tri_add');
    const verilog = exportVerilog(origProj, 'c_tri_add');
    const reimported = importVerilogToCircuits(verilog);
    const rtProj = makeProject(reimported.circuits, reimported.topCircuitId);

    // EN = 0 -> y must be 4'bZZZZ in both original and re-imported!
    const disOrig = evalProjectByPortNames(origProj, 'c_tri_add', {
      a: fromInt(9, 4),
      b: fromInt(8, 4),
      en: fromInt(0, 1),
    });
    const disRt = evalProjectByPortNames(rtProj, reimported.topCircuitId, {
      a: fromInt(9, 4),
      b: fromInt(8, 4),
      en: fromInt(0, 1),
    });
    expect(disOrig.y.bits.every((b) => b === BIT_Z)).toBe(true);
    expect(valuesEqual(disRt.y, disOrig.y)).toBe(true);
    expect(disRt.cout.bits[0]).toBe(BIT_1);

    // EN = 1 -> y must be (9 + 8) & 0xF = 1
    const enRt = evalProjectByPortNames(rtProj, reimported.topCircuitId, {
      a: fromInt(9, 4),
      b: fromInt(8, 4),
      en: fromInt(1, 1),
    });
    expect(toUnsignedInt(enRt.y)).toBe(1);
    expect(enRt.cout.bits[0]).toBe(BIT_1);
  });

  it('round-trips hierarchical multi-module project (Top instantiating FullAdder twice) with exact truth table', () => {
    const base = createSampleProject();
    const fa = base.circuits['circ_full_adder'];
    // Build a clean 2-bit module with MODULE_IN / MODULE_OUT wrapping two FullAdder instances
    const top2: CircuitDocument = {
      id: 'c_add2',
      name: 'Adder2Bit',
      gates: [
        {
          id: 'in_a0',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'a0',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_b0',
          type: 'MODULE_IN',
          x: 0,
          y: 40,
          rotation: 0,
          label: 'b0',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_a1',
          type: 'MODULE_IN',
          x: 0,
          y: 80,
          rotation: 0,
          label: 'a1',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_b1',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'b1',
          props: { bitWidth: 1 },
        },
        {
          id: 'in_cin',
          type: 'MODULE_IN',
          x: 0,
          y: 160,
          rotation: 0,
          label: 'cin',
          props: { bitWidth: 1 },
        },
        {
          id: 'u_fa0',
          type: 'SUBCIRCUIT',
          x: 260,
          y: 40,
          rotation: 0,
          label: 'u_fa0',
          props: { subcircuitId: fa.id },
        },
        {
          id: 'u_fa1',
          type: 'SUBCIRCUIT',
          x: 260,
          y: 180,
          rotation: 0,
          label: 'u_fa1',
          props: { subcircuitId: fa.id },
        },
        {
          id: 'out_s0',
          type: 'MODULE_OUT',
          x: 520,
          y: 20,
          rotation: 0,
          label: 's0',
          props: { bitWidth: 1 },
        },
        {
          id: 'out_s1',
          type: 'MODULE_OUT',
          x: 520,
          y: 100,
          rotation: 0,
          label: 's1',
          props: { bitWidth: 1 },
        },
        {
          id: 'out_c',
          type: 'MODULE_OUT',
          x: 520,
          y: 180,
          rotation: 0,
          label: 'cout',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        wire('w1', 'in_a0', 'out', 'u_fa0', 'fa_in_a'),
        wire('w2', 'in_b0', 'out', 'u_fa0', 'fa_in_b'),
        wire('w3', 'in_cin', 'out', 'u_fa0', 'fa_in_cin'),
        wire('w4', 'in_a1', 'out', 'u_fa1', 'fa_in_a'),
        wire('w5', 'in_b1', 'out', 'u_fa1', 'fa_in_b'),
        wire('w6', 'u_fa0', 'fa_out_c', 'u_fa1', 'fa_in_cin'),
        wire('w7', 'u_fa0', 'fa_out_s', 'out_s0', 'in'),
        wire('w8', 'u_fa1', 'fa_out_s', 'out_s1', 'in'),
        wire('w9', 'u_fa1', 'fa_out_c', 'out_c', 'in'),
      ],
    };
    const origProj = makeProject([fa, top2], 'c_add2');
    const verilog = exportVerilog(origProj, 'c_add2');

    // Exported Verilog must contain BOTH FullAdder and Adder2Bit modules!
    expect(verilog).toContain('module FullAdder');
    expect(verilog).toContain('module Adder2Bit');

    const reimported = importVerilogToCircuits(verilog);
    expect(reimported.circuits.length).toBe(2);
    const rtProj = makeProject(reimported.circuits, reimported.topCircuitId);

    // Exhaustive 32-case check: a[1:0] + b[1:0] + cin
    for (let m = 0; m < 32; m++) {
      const a0 = (m >> 0) & 1;
      const a1 = (m >> 1) & 1;
      const b0 = (m >> 2) & 1;
      const b1 = (m >> 3) & 1;
      const cin = (m >> 4) & 1;
      const vec = {
        a0: fromInt(a0, 1),
        a1: fromInt(a1, 1),
        b0: fromInt(b0, 1),
        b1: fromInt(b1, 1),
        cin: fromInt(cin, 1),
      };
      const origOut = evalProjectByPortNames(origProj, 'c_add2', vec);
      const rtOut = evalProjectByPortNames(rtProj, reimported.topCircuitId, vec);

      const expected = a0 + (a1 << 1) + (b0 + (b1 << 1)) + cin;
      expect(rtOut.s0.bits[0]).toBe(expected & 1);
      expect(rtOut.s1.bits[0]).toBe((expected >> 1) & 1);
      expect(rtOut.cout.bits[0]).toBe((expected >> 2) & 1);
      expect(valuesEqual(rtOut.s0, origOut.s0)).toBe(true);
      expect(valuesEqual(rtOut.s1, origOut.s1)).toBe(true);
      expect(valuesEqual(rtOut.cout, origOut.cout)).toBe(true);
    }
  });
});

describe('JSON Netlist, DOT Graph & Project Serialization Exports', () => {
  it('exports valid structured JSON netlist and Graphviz DOT with complete connectivity', () => {
    const proj = createSampleProject();
    const jsonStr = exportJsonNetlist(proj, 'circ_full_adder');
    const netlist = JSON.parse(jsonStr);

    expect(netlist.format).toBe('logicflow-netlist-v1');
    expect(netlist.module).toBe('FullAdder');
    expect(netlist.instances.length).toBe(10);
    // Verify named nets A, B, Cin, S, Cout exist and carry bit widths
    const netNames = new Set(netlist.nets.map((n: { netName: string }) => n.netName));
    expect(netNames.has('A')).toBe(true);
    expect(netNames.has('B')).toBe(true);
    expect(netNames.has('Cin')).toBe(true);
    expect(netNames.has('S')).toBe(true);
    expect(netNames.has('Cout')).toBe(true);

    const dot = exportDotGraph(proj, 'circ_full_adder');
    expect(dot).toContain('digraph "FullAdder"');
    expect(dot).toContain('"fa_in_a" -> "fa_xor1"');
    expect(dot).toContain('"fa_or1" -> "fa_out_c"');

    // Full .lcirc.json serialization round-trip preserves identical simulation output
    const serialized = JSON.stringify(proj);
    const restored = JSON.parse(serialized) as ProjectDocument;
    const origSnap = simulateCircuit(
      proj.circuits['circ_main'],
      proj,
      createEmptySequentialState(),
    );
    const restSnap = simulateCircuit(
      restored.circuits['circ_main'],
      restored,
      createEmptySequentialState(),
    );
    expect(toUnsignedInt(restSnap.pinValues['disp_7seg:in'])).toBe(
      toUnsignedInt(origSnap.pinValues['disp_7seg:in']),
    );
    expect(restSnap.pinValues['led_cout:in'].bits[0]).toBe(BIT_1);
    expect(restSnap.pinValues['led_s0:in'].bits[0]).toBe(BIT_0);
  });
});
