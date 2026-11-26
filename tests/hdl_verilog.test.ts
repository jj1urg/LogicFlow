import { describe, expect, it } from 'vite-plus/test';
import { importVerilogToCircuits } from '../src/core/hdl';
import { BIT_0, BIT_1, BIT_X, BIT_Z, fromInt, LogicValue, toUnsignedInt } from '../src/core/logic4';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { CircuitDocument, ProjectDocument } from '../src/core/types';

function toProject(circuits: CircuitDocument[], topId: string): ProjectDocument {
  const map: Record<string, CircuitDocument> = {};
  for (const c of circuits) map[c.id] = c;
  return {
    version: 1,
    name: 'VerilogTest',
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

/** Helper to simulate an imported Verilog module by input port names and read output port values */
function evalImportedModule(
  circuits: CircuitDocument[],
  topId: string,
  inputByName: Record<string, LogicValue>,
): Record<string, LogicValue> {
  const proj = toProject(circuits, topId);
  const top = proj.circuits[topId];
  const ext: Record<string, LogicValue> = {};
  for (const g of top.gates) {
    if (g.type === 'MODULE_IN' && g.label in inputByName) {
      ext[g.id] = inputByName[g.label];
    }
  }
  const snap = simulateCircuit(top, proj, createEmptySequentialState(), { externalInputs: ext });
  const out: Record<string, LogicValue> = {};
  for (const g of top.gates) {
    if (g.type === 'MODULE_OUT') {
      out[g.label] = snap.pinValues[`${g.id}:in`];
    }
  }
  return out;
}

describe('Verilog (.v) Parsing, Synthesis & Simulation Correctness', () => {
  it('parses Verilog-1995 non-ANSI module with all 8 gate primitives (named & unnamed)', () => {
    const src = `
      /* Multi-line block comment
         testing Verilog-1995 style */
      module prim_test (a, b, c, y_and, y_or, y_xor, y_nand, y_nor, y_xnor, y_not, y_buf);
        input a, b, c;
        output y_and, y_or, y_xor, y_nand, y_nor, y_xnor, y_not, y_buf;

        // 3-input and 2-input primitives, both named and unnamed
        and  u1 (y_and, a, b, c);
        or      (y_or, a, b, c);
        xor  u3 (y_xor, a, b);
        nand    (y_nand, a, b);
        nor  u5 (y_nor, a, b);
        xnor u6 (y_xnor, a, b);
        not  u7 (y_not, a);
        buf     (y_buf, b);
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);

    for (let m = 0; m < 8; m++) {
      const a = (m >> 0) & 1;
      const b = (m >> 1) & 1;
      const c = (m >> 2) & 1;
      const out = evalImportedModule(res.circuits, res.topCircuitId, {
        a: fromInt(a, 1),
        b: fromInt(b, 1),
        c: fromInt(c, 1),
      });
      expect(out.y_and.bits[0]).toBe(a & b & c);
      expect(out.y_or.bits[0]).toBe(a | b | c);
      expect(out.y_xor.bits[0]).toBe(a ^ b);
      expect(out.y_nand.bits[0]).toBe((a & b) ^ 1);
      expect(out.y_nor.bits[0]).toBe((a | b) ^ 1);
      expect(out.y_xnor.bits[0]).toBe(a ^ b ^ 1);
      expect(out.y_not.bits[0]).toBe(a ^ 1);
      expect(out.y_buf.bits[0]).toBe(b);
    }
  });

  it('respects Verilog operator precedence, parentheses, unary NOT, XNOR, and nested ternary MUX', () => {
    const src = `
      module expr_prec (
        input wire a,
        input wire b,
        input wire c,
        input wire s0,
        input wire s1,
        output wire y_prec1,
        output wire y_prec2,
        output wire y_not_and,
        output wire y_xnor,
        output wire y_mux4
      );
        // & binds tighter than | : a | (b & c)
        assign y_prec1 = a | b & c;
        // Parentheses override precedence: (a | b) & c
        assign y_prec2 = (a | b) & c;
        // Unary ~ binds tighter than & : (~a) & b
        assign y_not_and = ~a & b;
        // XNOR operator (~^)
        assign y_xnor = a ~^ b;
        // Nested ternary (right-associative 4:1 MUX)
        assign y_mux4 = s1 ? (s0 ? 1'b1 : c) : (s0 ? b : a);
      endmodule
    `;
    const res = importVerilogToCircuits(src);

    for (let m = 0; m < 32; m++) {
      const a = (m >> 0) & 1;
      const b = (m >> 1) & 1;
      const c = (m >> 2) & 1;
      const s0 = (m >> 3) & 1;
      const s1 = (m >> 4) & 1;
      const out = evalImportedModule(res.circuits, res.topCircuitId, {
        a: fromInt(a, 1),
        b: fromInt(b, 1),
        c: fromInt(c, 1),
        s0: fromInt(s0, 1),
        s1: fromInt(s1, 1),
      });
      expect(out.y_prec1.bits[0]).toBe(a | (b & c));
      expect(out.y_prec2.bits[0]).toBe((a | b) & c);
      expect(out.y_not_and.bits[0]).toBe((a ^ 1) & b);
      expect(out.y_xnor.bits[0]).toBe(a ^ b ^ 1);
      const expMux = s1 ? (s0 ? 1 : c) : s0 ? b : a;
      expect(out.y_mux4.bits[0]).toBe(expMux);
    }
  });

  it('handles out-of-order wire assignments, direct passthrough, fanout, and 4-state constants', () => {
    const src = `
      module order_and_const (
        input wire a,
        input wire b,
        output wire y_pass,
        output wire y_rev,
        output wire y_fan1,
        output wire y_fan2,
        output wire y_const_x,
        output wire y_const_z
      );
        wire mid;
        wire delayed;
        assign y_pass = a;
        assign y_rev = ~delayed;
        assign y_fan1 = mid;
        assign y_fan2 = ~mid;
        assign delayed = mid;
        assign mid = a & b;
        assign y_const_x = 1'bx;
        assign y_const_z = 1'bz;
      endmodule
    `;
    const res = importVerilogToCircuits(src);

    for (let m = 0; m < 4; m++) {
      const a = m & 1;
      const b = (m >> 1) & 1;
      const out = evalImportedModule(res.circuits, res.topCircuitId, {
        a: fromInt(a, 1),
        b: fromInt(b, 1),
      });
      const ab = a & b;
      expect(out.y_pass.bits[0]).toBe(a);
      expect(out.y_rev.bits[0]).toBe(ab ^ 1);
      expect(out.y_fan1.bits[0]).toBe(ab);
      expect(out.y_fan2.bits[0]).toBe(ab ^ 1);
      expect(out.y_const_x.bits[0]).toBe(BIT_X);
      expect(out.y_const_z.bits[0]).toBe(BIT_Z);
    }
  });

  it('synthesizes multi-bit vectors, comparisons, and concatenation adders {cout, sum} = a + b + cin', () => {
    const src = `
      module alu4 (
        input wire [3:0] a,
        input wire [3:0] b,
        input wire cin,
        output wire [3:0] sum,
        output wire cout,
        output wire eq,
        output wire gt,
        output wire [3:0] band
      );
        assign {cout, sum} = a + b + cin;
        assign eq = (a == b);
        assign gt = (a > b);
        assign band = a & b;
      endmodule
    `;
    const res = importVerilogToCircuits(src);

    const pairs = [
      [0, 0, 0],
      [5, 6, 0],
      [5, 5, 1],
      [15, 1, 0],
      [15, 15, 1],
      [10, 3, 0],
    ];
    for (const [a, b, cin] of pairs) {
      const out = evalImportedModule(res.circuits, res.topCircuitId, {
        a: fromInt(a, 4),
        b: fromInt(b, 4),
        cin: fromInt(cin, 1),
      });
      const total = a + b + cin;
      expect(toUnsignedInt(out.sum)).toBe(total & 0xf);
      expect(out.cout.bits[0]).toBe(total > 15 ? BIT_1 : BIT_0);
      expect(out.eq.bits[0]).toBe(a === b ? BIT_1 : BIT_0);
      expect(out.gt.bits[0]).toBe(a > b ? BIT_1 : BIT_0);
      expect(toUnsignedInt(out.band)).toBe(a & b);
    }
  });

  it('synthesizes hierarchical multi-module Verilog (both top-first and bottom-first ordering) with constant port bindings', () => {
    // Top module defined BEFORE submodule half_adder!
    const src = `
      module full_adder_hier (
        input wire a,
        input wire b,
        input wire cin,
        output wire s,
        output wire cout
      );
        wire s1, c1, c2;
        half_adder u_ha1 (.a(a), .b(b), .s(s1), .c(c1));
        half_adder u_ha2 (s1, cin, s, c2); // positional port connection!
        assign cout = c1 | c2;
      endmodule

      module half_adder (
        input wire a,
        input wire b,
        output wire s,
        output wire c
      );
        assign s = a ^ b;
        assign c = a & b;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.circuits.length).toBe(2);
    expect(res.circuits.find((c) => c.id === res.topCircuitId)?.name).toBe('full_adder_hier');

    // Exhaustive 8-case truth table verification of hierarchical Full Adder
    for (let m = 0; m < 8; m++) {
      const a = (m >> 0) & 1;
      const b = (m >> 1) & 1;
      const cin = (m >> 2) & 1;
      const out = evalImportedModule(res.circuits, res.topCircuitId, {
        a: fromInt(a, 1),
        b: fromInt(b, 1),
        cin: fromInt(cin, 1),
      });
      const sum = a + b + cin;
      expect(out.s.bits[0]).toBe(sum & 1);
      expect(out.cout.bits[0]).toBe((sum >> 1) & 1);
    }
  });

  it('synthesizes constant and expression arguments inside submodule port connections', () => {
    const src = `
      module adder_inc (
        input wire [3:0] x,
        output wire [3:0] y,
        output wire cout
      );
        add4 u_add (.a(x), .b(4'h1), .cin(1'b0), .s(y), .cout(cout));
      endmodule

      module add4 (
        input wire [3:0] a,
        input wire [3:0] b,
        input wire cin,
        output wire [3:0] s,
        output wire cout
      );
        assign {cout, s} = a + b + cin;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    for (let x = 0; x < 16; x++) {
      const out = evalImportedModule(res.circuits, res.topCircuitId, { x: fromInt(x, 4) });
      expect(toUnsignedInt(out.y)).toBe((x + 1) & 0xf);
      expect(out.cout.bits[0]).toBe(x === 15 ? BIT_1 : BIT_0);
    }
  });
});
