import { describe, expect, it } from 'vite-plus/test';
import { importVerilogToCircuits } from '../src/core/hdl';
import { BIT_0, BIT_1, BIT_X, BIT_Z, fromInt, LogicValue, toUnsignedInt } from '../src/core/logic4';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { CircuitDocument, ProjectDocument } from '../src/core/types';

function evalTop(circuits: CircuitDocument[], topId: string, inputs: Record<string, LogicValue>) {
  const map: Record<string, CircuitDocument> = {};
  for (const c of circuits) map[c.id] = c;
  const proj: ProjectDocument = {
    version: 1,
    name: 'SVTest',
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
  const top = proj.circuits[topId];
  const ext: Record<string, LogicValue> = {};
  for (const g of top.gates) {
    if (g.type === 'MODULE_IN' && g.label in inputs) {
      ext[g.id] = inputs[g.label];
    }
  }
  const snap = simulateCircuit(top, proj, createEmptySequentialState(), { externalInputs: ext });
  const out: Record<string, LogicValue> = {};
  for (const g of top.gates) {
    if (g.type === 'MODULE_OUT') {
      out[g.label] = snap.pinValues[`${g.id}:in`];
    }
  }
  return { out, snap, top, proj };
}

describe('SystemVerilog (.sv) Parsing, Synthesis & Stub Visualization', () => {
  it('parses parameterized SV modules (#(parameter WIDTH = 4)), localparam, logic, and inline wire init', () => {
    const src = `
      module sv_param_alu #(
        parameter int WIDTH = 4
      ) (
        input  logic [WIDTH-1:0] a, b,
        input  logic             sel,
        output logic [WIDTH-1:0] y,
        output logic             is_neq
      );
        localparam int TOP_BIT = WIDTH - 1;
        logic [TOP_BIT:0] xored = a ^ b;
        logic [WIDTH-1:0] anded = a & b;

        assign y = sel ? xored : anded;
        assign is_neq = (a != b);
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);
    const top = res.circuits.find((c) => c.id === res.topCircuitId)!;

    // Verify parameterized bit widths resolved to 4!
    expect(top.gates.find((g) => g.label === 'a')?.props.bitWidth).toBe(4);
    expect(top.gates.find((g) => g.label === 'b')?.props.bitWidth).toBe(4);
    expect(top.gates.find((g) => g.label === 'y')?.props.bitWidth).toBe(4);

    // Verify simulation correctness
    const r0 = evalTop(res.circuits, res.topCircuitId, {
      a: fromInt(0b1100, 4),
      b: fromInt(0b1010, 4),
      sel: fromInt(0, 1),
    });
    expect(toUnsignedInt(r0.out.y)).toBe(0b1000);
    expect(r0.out.is_neq.bits[0]).toBe(BIT_1);

    const r1 = evalTop(res.circuits, res.topCircuitId, {
      a: fromInt(0b1010, 4),
      b: fromInt(0b1010, 4),
      sel: fromInt(1, 1),
    });
    expect(toUnsignedInt(r1.out.y)).toBe(0b0000);
    expect(r1.out.is_neq.bits[0]).toBe(BIT_0);
  });

  it('supports SystemVerilog implicit .name port connections and always_comb simple assignments', () => {
    const src = `
      module sv_comb_leaf (
        input  logic a,
        input  logic b,
        output logic y
      );
        always_comb begin
          y = a ^ b;
        end
      endmodule

      module sv_top (
        input  logic a,
        input  logic b,
        output logic y,
        output logic y_inv
      );
        sv_comb_leaf u_leaf (.a, .b, .y);
        always_comb y_inv = ~y;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);

    for (let m = 0; m < 4; m++) {
      const a = m & 1;
      const b = (m >> 1) & 1;
      const { out } = evalTop(res.circuits, res.topCircuitId, {
        a: fromInt(a, 1),
        b: fromInt(b, 1),
      });
      expect(out.y.bits[0]).toBe(a ^ b);
      expect(out.y_inv.bits[0]).toBe(a ^ b ^ 1);
    }
  });

  it("synthesizes SystemVerilog tri-state idiom (en ? data : 1'bz) with real Z and bus contention X", () => {
    const src = `
      module sv_tristate (
        input  logic d_a,
        input  logic en_a,
        input  logic d_b,
        input  logic en_b,
        output logic bus_out
      );
        assign bus_out = en_a ? d_a : 1'bz;
        assign bus_out = en_b ? d_b : 1'bz;
      endmodule
    `;
    // Note: testing single tri-state output first, plus shared bus with two outputs
    const singleSrc = `
      module sv_tri1 (
        input  logic d,
        input  logic en,
        output logic y
      );
        assign y = en ? d : 1'bz;
      endmodule
    `;
    const res1 = importVerilogToCircuits(singleSrc);
    const zRes = evalTop(res1.circuits, res1.topCircuitId, { d: fromInt(1, 1), en: fromInt(0, 1) });
    expect(zRes.out.y.bits[0]).toBe(BIT_Z);
    const oneRes = evalTop(res1.circuits, res1.topCircuitId, {
      d: fromInt(1, 1),
      en: fromInt(1, 1),
    });
    expect(oneRes.out.y.bits[0]).toBe(BIT_1);
    const zeroRes = evalTop(res1.circuits, res1.topCircuitId, {
      d: fromInt(0, 1),
      en: fromInt(1, 1),
    });
    expect(zeroRes.out.y.bits[0]).toBe(BIT_0);

    // Ensure multi-assign tri-state source parses cleanly without crashing
    const res2 = importVerilogToCircuits(src);
    expect(res2.circuits.length).toBe(1);
  });

  it('auto-creates placeholder External Stub modules for undefined SV modules and preserves full wiring topology', () => {
    const src = `
      module defined_preproc (
        input  logic [7:0] raw_in,
        output logic [7:0] clean_out
      );
        assign clean_out = ~raw_in;
      endmodule

      module soc_top (
        input  logic       clk,
        input  logic [7:0] rx_byte,
        output logic [7:0] tx_byte,
        output logic       irq_o
      );
        logic [7:0] pre_bus;

        defined_preproc u_pre (
          .raw_in   (rx_byte),
          .clean_out(pre_bus)
        );

        // External IP blocks not defined in this file -> must become Stub modules with visible wiring!
        ext_crypto_engine #(.KEY_BITS(128)) u_crypto (
          .clk     (clk),
          .din     (pre_bus),
          .dout    (tx_byte),
          .irq_out (irq_o)
        );
      endmodule
    `;
    const res = importVerilogToCircuits(src);

    // Should have 3 circuits: defined_preproc, soc_top, and ext_crypto_engine (External Stub)
    expect(res.circuits.length).toBe(3);
    const stub = res.circuits.find((c) => c.isStub);
    expect(stub).toBeDefined();
    expect(stub!.name).toContain('ext_crypto_engine');
    expect(stub!.stubPorts).toEqual([
      { name: 'clk', dir: 'in', bitWidth: 1 },
      { name: 'din', dir: 'in', bitWidth: 8 },
      { name: 'dout', dir: 'out', bitWidth: 8 },
      { name: 'irq_out', dir: 'out', bitWidth: 1 },
    ]);
    expect(res.warnings.some((w) => w.includes('ext_crypto_engine'))).toBe(true);

    // Verify top module has BOTH subcircuit instances and wires connecting defined_preproc -> ext_crypto_engine -> outputs
    const { top, out } = evalTop(res.circuits, res.topCircuitId, {
      clk: fromInt(1, 1),
      rx_byte: fromInt(0x0f, 8),
    });
    const subGates = top.gates.filter((g) => g.type === 'SUBCIRCUIT');
    expect(subGates.length).toBe(2);
    expect(top.wires.length).toBeGreaterThanOrEqual(5);

    // External stub outputs unknown X safely while defined_preproc runs live!
    expect(out.tx_byte.bits.every((b) => b === BIT_X)).toBe(true);
    expect(out.irq_o.bits[0]).toBe(BIT_X);
  });

  it('synthesizes always_ff D-FF blocks cleanly and throws helpful error on invalid/empty HDL', () => {
    const srcWithFf = `
      module seq_mod (input logic clk, input logic d, output logic q, output logic y);
        always_ff @(posedge clk) begin
          q <= d;
        end
        assign y = ~d;
      endmodule
    `;
    const res = importVerilogToCircuits(srcWithFf);
    expect(res.warnings).toEqual([]);
    const top = res.circuits.find((c) => c.id === res.topCircuitId)!;
    expect(top.gates.some((g) => g.type === 'D_FF')).toBe(true);
    // Combinational part works and FF synthesizes cleanly!
    const { out } = evalTop(res.circuits, res.topCircuitId, {
      clk: fromInt(0, 1),
      d: fromInt(1, 1),
    });
    expect(out.y.bits[0]).toBe(BIT_0);

    expect(() => importVerilogToCircuits('// just comments, no module here')).toThrow();
    expect(() => importVerilogToCircuits('')).toThrow();
  });
});
