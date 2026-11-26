import { describe, expect, it } from 'vitest';
import { exportVerilog, importVerilogToCircuits } from '../src/core/hdl';
import { BIT_0, BIT_1, fromInt, LogicValue, toUnsignedInt, valuesEqual } from '../src/core/logic4';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { CircuitDocument, ProjectDocument, Wire } from '../src/core/types';

function toProj(circuits: CircuitDocument[], topId: string): ProjectDocument {
  const map: Record<string, CircuitDocument> = {};
  for (const c of circuits) map[c.id] = c;
  return {
    version: 1,
    name: 'HdlEdgeTest',
    activeCircuitId: topId,
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

function evalByName(proj: ProjectDocument, cid: string, inputs: Record<string, LogicValue>) {
  const circ = proj.circuits[cid];
  const ext: Record<string, LogicValue> = {};
  for (const g of circ.gates) {
    if (g.type === 'MODULE_IN' && g.label in inputs) ext[g.id] = inputs[g.label];
  }
  const snap = simulateCircuit(circ, proj, createEmptySequentialState(), { externalInputs: ext });
  const out: Record<string, LogicValue> = {};
  for (const g of circ.gates) {
    if (g.type === 'MODULE_OUT') out[g.label] = snap.pinValues[`${g.id}:in`];
  }
  return out;
}

describe('Adversarial & Real-World HDL Edge Cases', () => {
  it('handles inline comments, underscored literals, parameterized arithmetic, and deeply nested expressions', () => {
    const src = `
      module /* inline comment */ param_math #(
        parameter N = 8,
        parameter HALF = N / 2
      ) (
        input  logic [N-1:0]    x, // 8-bit input
        input  logic [HALF-1:0] y, /* 4-bit input */
        output logic [N-1:0]    masked,
        output logic [HALF-1:0] y_add,
        output logic            deep_bool
      );
        assign masked = x & 8'b1010_0101;
        assign y_add = y + 4'd3;
        // Deeply nested parentheses + mixed operators
        assign deep_bool = (((x == 8'hFF) || (y == 4'hA)) && !(y < 4'd2));
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);
    const proj = toProj(res.circuits, res.topCircuitId);
    const top = proj.circuits[res.topCircuitId];

    expect(top.gates.find((g) => g.label === 'x')?.props.bitWidth).toBe(8);
    expect(top.gates.find((g) => g.label === 'y')?.props.bitWidth).toBe(4);

    const r1 = evalByName(proj, res.topCircuitId, { x: fromInt(0xff, 8), y: fromInt(5, 4) });
    expect(toUnsignedInt(r1.masked)).toBe(0xa5);
    expect(toUnsignedInt(r1.y_add)).toBe(8);
    expect(r1.deep_bool.bits[0]).toBe(BIT_1);

    const r2 = evalByName(proj, res.topCircuitId, { x: fromInt(0xff, 8), y: fromInt(1, 4) });
    expect(r2.deep_bool.bits[0]).toBe(BIT_0); // y < 2 makes !(y < 2) false
  });

  it('reuses a single External Stub circuit when an undefined external module is instantiated multiple times', () => {
    const src = `
      module dual_fifo_top (
        input  logic [7:0] din,
        output logic [7:0] dout
      );
        logic [7:0] mid;
        ext_sync_fifo u_fifo0 (.din(din), .dout(mid));
        ext_sync_fifo u_fifo1 (.din(mid), .dout(dout));
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    // Only 2 circuits total: dual_fifo_top + ONE shared ext_sync_fifo stub!
    expect(res.circuits.length).toBe(2);
    const stubs = res.circuits.filter((c) => c.isStub);
    expect(stubs.length).toBe(1);

    const top = res.circuits.find((c) => c.id === res.topCircuitId)!;
    const subInsts = top.gates.filter((g) => g.type === 'SUBCIRCUIT');
    expect(subInsts.length).toBe(2);
    expect(subInsts[0].props.subcircuitId).toBe(stubs[0].id);
    expect(subInsts[1].props.subcircuitId).toBe(stubs[0].id);
    // Wiring connects din -> u_fifo0 -> u_fifo1 -> dout (3 wires)
    expect(top.wires.length).toBe(3);
  });

  it('sanitizes non-ASCII / special-character circuit names and preserves TUNNEL wireless connectivity on Verilog round-trip', () => {
    const wire = (id: string, fg: string, fp: string, tg: string, tp: string): Wire => ({
      id,
      from: { gateId: fg, pinId: fp },
      to: { gateId: tg, pinId: tp },
      points: [],
      routeMode: 'grid',
    });

    const circ: CircuitDocument = {
      id: 'c_jp',
      name: '2bit-テスト回路 (XOR)',
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
          y: 80,
          rotation: 0,
          label: 'b',
          props: { bitWidth: 1 },
        },
        {
          id: 't_src',
          type: 'TUNNEL',
          x: 100,
          y: 0,
          rotation: 0,
          label: 'T1',
          props: { bitWidth: 1, netName: 'BUS_A' },
        },
        {
          id: 't_dst',
          type: 'TUNNEL',
          x: 260,
          y: 0,
          rotation: 0,
          label: 'T2',
          props: { bitWidth: 1, netName: 'BUS_A' },
        },
        {
          id: 'g_xor',
          type: 'XOR',
          x: 380,
          y: 40,
          rotation: 0,
          label: 'xor-1',
          props: { inputCount: 2, bitWidth: 1 },
        },
        {
          id: 'out_y',
          type: 'MODULE_OUT',
          x: 520,
          y: 40,
          rotation: 0,
          label: 'y',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        wire('w1', 'in_a', 'out', 't_src', 'io'),
        wire('w2', 't_dst', 'io', 'g_xor', 'in0'),
        wire('w3', 'in_b', 'out', 'g_xor', 'in1'),
        wire('w4', 'g_xor', 'out', 'out_y', 'in'),
      ],
    };
    const origProj = toProj([circ], 'c_jp');
    const verilog = exportVerilog(origProj, 'c_jp');

    // Module identifier must be sanitized (starts with _ instead of digit, no Japanese/spaces/parens)
    expect(verilog).toMatch(/module _2bit_[a-zA-Z0-9_]+\s*\(/);

    // Re-importing sanitized Verilog must preserve exact XOR truth table across the TUNNEL!
    const reimported = importVerilogToCircuits(verilog);
    const rtProj = toProj(reimported.circuits, reimported.topCircuitId);
    for (let m = 0; m < 4; m++) {
      const vec = { a: fromInt(m & 1, 1), b: fromInt((m >> 1) & 1, 1) };
      const origOut = evalByName(origProj, 'c_jp', vec);
      const rtOut = evalByName(rtProj, reimported.topCircuitId, vec);
      expect(valuesEqual(rtOut.y, origOut.y)).toBe(true);
      expect(rtOut.y.bits[0]).toBe((m & 1) ^ ((m >> 1) & 1));
    }
  });
});
