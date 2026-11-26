import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getGateBounds } from '../src/core/catalog';
import {
  buildHdlModuleTree,
  exportVerilog,
  importVerilogFilesToCircuits,
  importVerilogToCircuits,
  inferTopModuleName,
  listModuleNamesInFiles,
  resynthesizeCircuitFromHdl,
  resynthesizeHdlProject,
} from '../src/core/hdl';
import { BIT_0, BIT_1, BIT_X, BIT_Z, fromInt, LogicValue, toUnsignedInt } from '../src/core/logic4';
import { rerouteWiresForGates } from '../src/core/routing';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { CircuitDocument, ProjectDocument } from '../src/core/types';

function makeProj(circuits: CircuitDocument[], topId: string): ProjectDocument {
  const map: Record<string, CircuitDocument> = {};
  for (const c of circuits) map[c.id] = c;
  return {
    version: 1,
    name: 'HdlAdvancedTest',
    activeCircuitId: topId,
    openTabIds: [topId],
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

function evalSeq(
  proj: ProjectDocument,
  cid: string,
  seq: ReturnType<typeof createEmptySequentialState>,
  inputs: Record<string, LogicValue>,
) {
  const circ = proj.circuits[cid];
  const ext: Record<string, LogicValue> = {};
  for (const g of circ.gates) {
    if (g.type === 'MODULE_IN' && g.label in inputs) ext[g.id] = inputs[g.label];
  }
  const snap = simulateCircuit(circ, proj, seq, { externalInputs: ext });
  const out: Record<string, LogicValue> = {};
  for (const g of circ.gates) {
    if (g.type === 'MODULE_OUT') out[g.label] = snap.pinValues[`${g.id}:in`];
  }
  return out;
}

describe('HDL Advanced Fixes (Portless TB, Non-Synthesizable Strip, always/always_ff, Auto-Layout)', () => {
  it('1. parses portless testbench modules (module tb; ... endmodule) cleanly', () => {
    const src = `
      \`timescale 1ns/1ps
      module dut (
        input  logic a,
        input  logic b,
        output logic y
      );
        assign y = a ^ b;
      endmodule

      module tb;
        logic a, b, y;
        dut u_dut (.a(a), .b(b), .y(y));
        initial begin
          a = 0; b = 1;
          #10;
          $display("y=%b", y);
          $finish;
        end
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.circuits.length).toBe(2);
    const tb = res.circuits.find((c) => c.id === res.topCircuitId)!;
    expect(tb.name).toBe('tb');
    // tb instantiates dut (1 SUBCIRCUIT), and initial/$display/$finish were cleanly ignored!
    const subs = tb.gates.filter((g) => g.type === 'SUBCIRCUIT');
    expect(subs.length).toBe(1);
    expect(res.circuits.some((c) => c.isStub)).toBe(false);
  });

  it('2. ignores assert/assume/cover/initial/task/function/system tasks without creating phantom "asser" stub modules', () => {
    const src = `
      \`timescale 1ns / 1ps
      \`default_nettype none

      module sv_verified (
        input  logic a,
        input  logic b,
        output logic y
      );
        import my_pkg::*;
        typedef logic [3:0] nibble_t;

        function automatic logic helper(input logic x);
          return ~x;
        endfunction

        task log_state();
          $display("state=%b", y);
        endtask

        assign y = a & b;

        // Assertions & verification statements that MUST be ignored (no "asser" module!)
        assert(a == b) else $error("mismatch");
        chk_lbl: assert property (@(posedge a) y == (a & b));
        assume(a || !a);
        cover(y == 1'b1);

        initial begin
          $dumpfile("wave.vcd");
          $dumpvars(0, sv_verified);
          #100 $finish;
        end
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.circuits.length).toBe(1);
    expect(res.circuits.some((c) => c.isStub)).toBe(false);
    expect(res.warnings).toEqual([]);

    const proj = makeProj(res.circuits, res.topCircuitId);
    for (let m = 0; m < 4; m++) {
      const a = m & 1;
      const b = (m >> 1) & 1;
      const out = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
        a: fromInt(a, 1),
        b: fromInt(b, 1),
      });
      expect(out.y.bits[0]).toBe(a & b);
    }
  });

  it('3a. synthesizes always_ff @(posedge clk or negedge rst_n) with enable into working sequential REGISTER/D_FF', () => {
    const src = `
      module counter_sv (
        input  logic       clk,
        input  logic       rst_n,
        input  logic       en,
        output logic [3:0] count,
        output logic       flag
      );
        always_ff @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            count <= 4'd0;
            flag  <= 1'b0;
          end else if (en) begin
            count <= count + 4'd1;
            flag  <= ~flag;
          end
        end
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);
    const top = res.circuits.find((c) => c.id === res.topCircuitId)!;
    // Synthesized a REGISTER for 4-bit count and a D_FF for 1-bit flag!
    expect(top.gates.some((g) => g.type === 'REGISTER' && g.label === 'count')).toBe(true);
    expect(top.gates.some((g) => g.type === 'D_FF' && g.label === 'flag')).toBe(true);

    const proj = makeProj(res.circuits, res.topCircuitId);
    const seq = createEmptySequentialState();

    // Active-low reset (rst_n = 0) holds count = 0, flag = 0
    let out = evalSeq(proj, res.topCircuitId, seq, {
      clk: fromInt(0, 1),
      rst_n: fromInt(0, 1),
      en: fromInt(1, 1),
    });
    expect(toUnsignedInt(out.count)).toBe(0);
    expect(out.flag.bits[0]).toBe(BIT_0);

    // Release reset (rst_n = 1) and clock 3 times with en = 1
    for (let i = 1; i <= 3; i++) {
      evalSeq(proj, res.topCircuitId, seq, {
        clk: fromInt(0, 1),
        rst_n: fromInt(1, 1),
        en: fromInt(1, 1),
      });
      out = evalSeq(proj, res.topCircuitId, seq, {
        clk: fromInt(1, 1),
        rst_n: fromInt(1, 1),
        en: fromInt(1, 1),
      });
      expect(toUnsignedInt(out.count)).toBe(i);
      expect(out.flag.bits[0]).toBe(i & 1);
    }

    // With en = 0, rising clock edge holds count = 3!
    evalSeq(proj, res.topCircuitId, seq, {
      clk: fromInt(0, 1),
      rst_n: fromInt(1, 1),
      en: fromInt(0, 1),
    });
    out = evalSeq(proj, res.topCircuitId, seq, {
      clk: fromInt(1, 1),
      rst_n: fromInt(1, 1),
      en: fromInt(0, 1),
    });
    expect(toUnsignedInt(out.count)).toBe(3);

    // Assert rst_n = 0 -> asynchronously clears back to 0!
    out = evalSeq(proj, res.topCircuitId, seq, {
      clk: fromInt(0, 1),
      rst_n: fromInt(0, 1),
      en: fromInt(1, 1),
    });
    expect(toUnsignedInt(out.count)).toBe(0);
    expect(out.flag.bits[0]).toBe(BIT_0);
  });

  it('3b. synthesizes always @(*) and always_comb with if/else and case statements accurately', () => {
    const src = `
      module comb_proc (
        input  logic [1:0] op,
        input  logic [3:0] a,
        input  logic [3:0] b,
        input  logic       inv,
        output logic [3:0] y
      );
        logic [3:0] alu_raw;
        always_comb begin
          case (op)
            2'd0: alu_raw = a & b;
            2'd1: alu_raw = a | b;
            2'd2: alu_raw = a ^ b;
            default: alu_raw = a + b;
          endcase
        end

        always @(*) begin
          if (inv)
            y = ~alu_raw;
          else
            y = alu_raw;
        end
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);
    const proj = makeProj(res.circuits, res.topCircuitId);

    const a = 0b1100;
    const b = 0b1010;
    const expectedRaw = [a & b, a | b, a ^ b, (a + b) & 0xf];
    for (let op = 0; op < 4; op++) {
      for (const inv of [0, 1]) {
        const out = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
          op: fromInt(op, 2),
          a: fromInt(a, 4),
          b: fromInt(b, 4),
          inv: fromInt(inv, 1),
        });
        const exp = inv ? ~expectedRaw[op] & 0xf : expectedRaw[op];
        expect(toUnsignedInt(out.y)).toBe(exp);
      }
    }
  });

  it('6. auto-layouts imported gates and submodules with ZERO bounding-box overlaps', () => {
    const src = `
      module sub_a (input logic x, input logic y, output logic z);
        assign z = x ^ y;
      endmodule

      module complex_layout (
        input  logic a,
        input  logic b,
        input  logic c,
        input  logic clk,
        input  logic rst,
        output logic y0,
        output logic y1,
        output logic y2
      );
        logic w1, w2, w3;
        assign w1 = (a & b) | (~c);
        sub_a u1 (.x(a), .y(b), .z(w2));
        sub_a u2 (.x(w2), .y(c), .z(w3));
        ext_ip u_ext (.in0(w1), .in1(w3), .out0(y2));

        always_ff @(posedge clk or posedge rst) begin
          if (rst) y0 <= 1'b0;
          else y0 <= w1 ^ w3;
        end
        assign y1 = w2 & w3;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    const proj = makeProj(res.circuits, res.topCircuitId);
    const top = proj.circuits[res.topCircuitId];

    // Check pairwise bounding boxes of EVERY gate in the imported top circuit -> ZERO overlaps!
    const boxes = top.gates.map((g) => ({ id: g.id, type: g.type, ...getGateBounds(g, proj) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i];
        const B = boxes[j];
        const overlapX = A.x < B.x + B.width && A.x + A.width > B.x;
        const overlapY = A.y < B.y + B.height && A.y + A.height > B.y;
        expect(
          overlapX && overlapY,
          `Overlap between ${A.id}(${A.type}) and ${B.id}(${B.type})`,
        ).toBe(false);
      }
    }
  });

  it('7. keeps continuous assign connections intact for bit-selects, slices, concats, multi-assign, and multi-driver tri-state buses', () => {
    const src = `
      module assign_torture (
        input  logic [3:0] a,
        input  logic [3:0] b,
        input  logic       en1,
        input  logic       en2,
        output logic [3:0] rev,
        output logic [3:0] concat_out,
        output logic [1:0] hi_out,
        output logic       par_out,
        output logic [3:0] diff_out,
        output logic [3:0] bus_out
      );
        // Out-of-order alias + comma-separated assigns + delay
        logic [1:0] hi_mid;
        assign hi_out = hi_mid;
        assign #5 hi_mid = a[3:2], par_out = ^a;

        // Per-bit LHS assigns using RHS bit-selects (bit reversal)
        assign rev[0] = a[3];
        assign rev[1] = a[2];
        assign rev[2] = a[1];
        assign rev[3] = a[0];

        // RHS concatenation & subtraction
        assign concat_out = {a[1:0], b[3:2]};
        assign diff_out = a - b;

        // Multi-driver tri-state bus (must preserve BOTH drivers!)
        assign bus_out = en1 ? a : 4'bzzzz;
        assign bus_out = en2 ? b : 4'bzzzz;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.warnings).toEqual([]);
    const proj = makeProj(res.circuits, res.topCircuitId);

    // Case 1: en1=1, en2=0 -> bus_out = a
    const out1 = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
      a: fromInt(0b1101, 4),
      b: fromInt(0b0110, 4),
      en1: fromInt(1, 1),
      en2: fromInt(0, 1),
    });
    expect(toUnsignedInt(out1.hi_out)).toBe(0b11);
    expect(out1.par_out.bits[0]).toBe(BIT_1); // 1^1^0^1 = 1
    expect(toUnsignedInt(out1.rev)).toBe(0b1011);
    expect(toUnsignedInt(out1.concat_out)).toBe(0b0101); // {a[1:0]=01, b[3:2]=01}
    expect(toUnsignedInt(out1.diff_out)).toBe((0b1101 - 0b0110) & 0xf);
    expect(toUnsignedInt(out1.bus_out)).toBe(0b1101);

    // Case 2: en1=0, en2=1 -> bus_out = b
    const out2 = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
      a: fromInt(0b1101, 4),
      b: fromInt(0b0110, 4),
      en1: fromInt(0, 1),
      en2: fromInt(1, 1),
    });
    expect(toUnsignedInt(out2.bus_out)).toBe(0b0110);

    // Case 3: en1=0, en2=0 -> bus_out = ZZZZ
    const outZ = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
      a: fromInt(0b1101, 4),
      b: fromInt(0b0110, 4),
      en1: fromInt(0, 1),
      en2: fromInt(0, 1),
    });
    expect(outZ.bus_out.bits).toEqual([BIT_Z, BIT_Z, BIT_Z, BIT_Z]);

    // Case 4: en1=1, en2=1 -> bus contention where bits differ -> X
    const outX = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
      a: fromInt(0b1101, 4),
      b: fromInt(0b0110, 4),
      en1: fromInt(1, 1),
      en2: fromInt(1, 1),
    });
    // bit0: 1 vs 0 -> X; bit1: 0 vs 1 -> X; bit2: 1 vs 1 -> 1; bit3: 1 vs 0 -> X
    expect(outX.bus_out.bits).toEqual([BIT_X, BIT_X, BIT_1, BIT_X]);
  });

  it('8. synthesizes case / chained select into a SINGLE multi-input MUX and round-trips via Verilog export', () => {
    const src4 = `
      module mux4_case (
        input  logic [1:0] sel,
        input  logic [3:0] d0,
        input  logic [3:0] d1,
        input  logic [3:0] d2,
        input  logic [3:0] d3,
        output logic [3:0] y
      );
        always_comb begin
          case (sel)
            2'd0: y = d0;
            2'd1: y = d1;
            2'd2: y = d2;
            2'd3: y = d3;
          endcase
        end
      endmodule
    `;
    const res4 = importVerilogToCircuits(src4);
    const top4 = res4.circuits.find((c) => c.id === res4.topCircuitId)!;
    const muxes4 = top4.gates.filter((g) => g.type === 'MUX');
    const cmps4 = top4.gates.filter((g) => g.type === 'COMPARATOR');
    // Must synthesize ONE single 4:1 MUX with ZERO comparators!
    expect(muxes4.length).toBe(1);
    expect(cmps4.length).toBe(0);
    expect(muxes4[0].props.inputCount).toBe(4);
    expect(muxes4[0].props.selectBits).toBe(2);

    const proj4 = makeProj(res4.circuits, res4.topCircuitId);
    const vals = [0x2, 0x5, 0xa, 0xf];
    for (let s = 0; s < 4; s++) {
      const out = evalSeq(proj4, res4.topCircuitId, createEmptySequentialState(), {
        sel: fromInt(s, 2),
        d0: fromInt(vals[0], 4),
        d1: fromInt(vals[1], 4),
        d2: fromInt(vals[2], 4),
        d3: fromInt(vals[3], 4),
      });
      expect(toUnsignedInt(out.y)).toBe(vals[s]);
    }

    // Export Verilog & re-import -> still ONE single 4:1 MUX!
    const verilogOut = exportVerilog(proj4, res4.topCircuitId);
    const rt = importVerilogToCircuits(verilogOut);
    const rtTop = rt.circuits.find((c) => c.id === rt.topCircuitId)!;
    expect(rtTop.gates.filter((g) => g.type === 'MUX').length).toBe(1);
    expect(rtTop.gates.filter((g) => g.type === 'MUX')[0].props.inputCount).toBe(4);
    expect(rtTop.gates.filter((g) => g.type === 'COMPARATOR').length).toBe(0);

    // 3-input case (no default) -> ONE single 3:1 MUX (sel=3 -> X)
    const src3 = `
      module mux3_case (
        input  logic [1:0] sel,
        input  logic [3:0] a,
        input  logic [3:0] b,
        input  logic [3:0] c,
        output logic [3:0] y
      );
        always_comb begin
          case (sel)
            2'd0: y = a;
            2'd1: y = b;
            2'd2: y = c;
          endcase
        end
      endmodule
    `;
    const res3 = importVerilogToCircuits(src3);
    const top3 = res3.circuits.find((c) => c.id === res3.topCircuitId)!;
    const muxes3 = top3.gates.filter((g) => g.type === 'MUX');
    expect(muxes3.length).toBe(1);
    expect(muxes3[0].props.inputCount).toBe(3);
    expect(muxes3[0].props.selectBits).toBe(2);

    const proj3 = makeProj(res3.circuits, res3.topCircuitId);
    for (let s = 0; s < 3; s++) {
      const out = evalSeq(proj3, res3.topCircuitId, createEmptySequentialState(), {
        sel: fromInt(s, 2),
        a: fromInt(1, 4),
        b: fromInt(4, 4),
        c: fromInt(9, 4),
      });
      expect(toUnsignedInt(out.y)).toBe([1, 4, 9][s]);
    }
    const outUndef = evalSeq(proj3, res3.topCircuitId, createEmptySequentialState(), {
      sel: fromInt(3, 2),
      a: fromInt(1, 4),
      b: fromInt(4, 4),
      c: fromInt(9, 4),
    });
    expect(outUndef.y.bits.every((b) => b === BIT_X)).toBe(true);
  });

  it('9. preserves original untouched per-module HDL source and full file source (with comments & assertions)', () => {
    const src = `\`timescale 1ns/1ps
// Shared header comment

module leaf_xor (
  input  logic a, // first input
  input  logic b,
  output logic y
);
  // Comment inside module + non-synthesizable assert must stay intact in hdlSource!
  assign y = a ^ b;
  assert (y === (a ^ b));
endmodule

module top_wrapper (
  input  logic x,
  input  logic y,
  output logic z
);
  leaf_xor u0 (.a(x), .b(y), .y(z));
endmodule`;

    const res = importVerilogToCircuits(src);
    const leaf = res.circuits.find((c) => c.name === 'leaf_xor')!;
    const top = res.circuits.find((c) => c.name === 'top_wrapper')!;

    // Per-module hdlSource preserves comments, indentation, and assertions verbatim
    expect(leaf.hdlSource).toBeDefined();
    expect(leaf.hdlSource).toContain('module leaf_xor');
    expect(leaf.hdlSource).toContain('// first input');
    expect(leaf.hdlSource).toContain('assert (y === (a ^ b));');
    expect(leaf.hdlSource).toContain('endmodule');
    expect(leaf.hdlSource).not.toContain('module top_wrapper');

    expect(top.hdlSource).toBeDefined();
    expect(top.hdlSource).toContain('module top_wrapper');
    expect(top.hdlSource).toContain('leaf_xor u0');
    expect(top.hdlSource).not.toContain('module leaf_xor');

    // Full original file source (including `timescale and both modules) is preserved for multi-module files
    expect(leaf.hdlFileSource).toBe(src.trim());
    expect(top.hdlFileSource).toBe(src.trim());

    // Single-module file with no extra text outside module omits redundant hdlFileSource
    const singleSrc = `module solo (input logic a, output logic y);\n  assign y = ~a;\nendmodule`;
    const singleRes = importVerilogToCircuits(singleSrc);
    expect(singleRes.circuits[0].hdlSource).toBe(singleSrc);
    expect(singleRes.circuits[0].hdlFileSource).toBeUndefined();
  });

  it('10. wires stub-to-stub-only nets even when port directions are ambiguous, identical, or multi-driven', () => {
    const src = `
      module stub_chain (
        input  logic       clk,
        input  logic [7:0] ext_in,
        output logic [7:0] ext_out
      );
        logic [7:0] link_ab;
        logic [7:0] shared_bus;
        logic [7:0] dual_out_wire;

        // Stub-to-stub wire with unknown port names (.p_mid / .q_mid)
        ip_stage_a u_a (.clk(clk), .data(ext_in), .p_mid(link_ab), .dout(dual_out_wire));
        ip_stage_b u_b (.clk(clk), .q_mid(link_ab), .final_sig(ext_out), .dout(dual_out_wire));

        // Same external stub instantiated twice sharing a wire on identically named port (.bus)
        ip_peer u_p1 (.bus(shared_bus));
        ip_peer u_p2 (.bus(shared_bus));
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    const top = res.circuits.find((c) => c.id === res.topCircuitId)!;

    // 1. Stub-to-stub link_ab MUST have a routed wire connecting u_a and u_b!
    const linkWires = top.wires.filter((w) => w.netLabel === 'link_ab');
    expect(linkWires.length).toBeGreaterThanOrEqual(1);
    expect(linkWires[0].points.length).toBeGreaterThanOrEqual(2);

    // 2. Identical-port stub-to-stub wire shared_bus (both pins on ip_peer.bus) MUST be wired!
    const sharedWires = top.wires.filter((w) => w.netLabel === 'shared_bus');
    expect(sharedWires.length).toBeGreaterThanOrEqual(1);

    // 3. Multi-driver stub-to-stub wire dual_out_wire (both pins named .dout) MUST be wired!
    const dualWires = top.wires.filter((w) => w.netLabel === 'dual_out_wire');
    expect(dualWires.length).toBeGreaterThanOrEqual(1);

    // 4. Stub port driving MODULE_OUT (final_sig -> ext_out) MUST be wired!
    const outWires = top.wires.filter((w) => w.netLabel === 'ext_out');
    expect(outWires.length).toBeGreaterThanOrEqual(1);
  });

  it('11. imports multiple .v/.sv files together with cross-file module resolution and supports in-place HDL resynthesis', () => {
    const fileTop = {
      name: 'top.sv',
      content: `
        module top_sys (
          input  logic [3:0] a,
          input  logic [3:0] b,
          output logic [3:0] y
        );
          logic [3:0] mid;
          sub_xor u_xor (.x(a), .y(b), .z(mid));
          sub_inv u_inv (.d(mid), .q(y));
        endmodule
      `,
    };
    const fileXor = {
      name: 'sub_xor.sv',
      content: `
        module sub_xor (
          input  logic [3:0] x,
          input  logic [3:0] y,
          output logic [3:0] z
        );
          assign z = x ^ y;
        endmodule
      `,
    };
    const fileInv = {
      name: 'sub_inv.v',
      content: `
        module sub_inv (
          input  [3:0] d,
          output [3:0] q
        );
          assign q = ~d;
        endmodule
      `,
    };

    // Order deliberately puts top.sv FIRST before sub_xor.sv & sub_inv.v!
    const res = importVerilogFilesToCircuits([fileTop, fileXor, fileInv]);
    expect(res.warnings).toEqual([]);
    expect(res.circuits.length).toBe(3);
    expect(res.circuits.some((c) => c.isStub)).toBe(false);

    const topDoc = res.circuits.find((c) => c.id === res.topCircuitId)!;
    const xorDoc = res.circuits.find((c) => c.name === 'sub_xor')!;
    const invDoc = res.circuits.find((c) => c.name === 'sub_inv')!;
    expect(topDoc.name).toBe('top_sys');
    expect(topDoc.hdlFileName).toBe('top.sv');
    expect(xorDoc.hdlFileName).toBe('sub_xor.sv');
    expect(invDoc.hdlFileName).toBe('sub_inv.v');

    const proj = makeProj(res.circuits, res.topCircuitId);
    const outBefore = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
      a: fromInt(0b1010, 4),
      b: fromInt(0b0110, 4),
    });
    // ~(1010 ^ 0110) = ~(1100) = 0011
    expect(toUnsignedInt(outBefore.y)).toBe(0b0011);

    // Simulate schematic divergence, then re-synthesize sub_xor in-place to AND instead of XOR!
    proj.circuits[xorDoc.id].hdlDiverged = true;
    const editedXorSrc = `
      module sub_xor (
        input  logic [3:0] x,
        input  logic [3:0] y,
        output logic [3:0] z
      );
        assign z = x & y;
      endmodule
    `;
    const resynth = resynthesizeCircuitFromHdl(xorDoc.id, editedXorSrc, proj);
    expect(resynth.warnings).toEqual([]);
    const updatedXor = resynth.circuits.find((c) => c.id === xorDoc.id)!;
    expect(updatedXor).toBeDefined();
    expect(updatedXor.hdlDiverged).toBe(false);
    expect(updatedXor.hdlFileName).toBe('sub_xor.sv');

    // Apply in-place update into proj — top_sys automatically uses the newly synthesized sub_xor!
    for (const c of resynth.circuits) proj.circuits[c.id] = c;
    const outAfter = evalSeq(proj, res.topCircuitId, createEmptySequentialState(), {
      a: fromInt(0b1010, 4),
      b: fromInt(0b0110, 4),
    });
    // ~(1010 & 0110) = ~(0010) = 1101
    expect(toUnsignedInt(outAfter.y)).toBe(0b1101);
  });

  it('12. bundles multi-file imports into a unified HdlProjectBundle with explicit top-module designation & project-wide resynthesis', () => {
    const f1 = {
      name: 'leaf.sv',
      content: `
        module leaf_and (input logic a, input logic b, output logic y);
          assign y = a & b;
        endmodule
      `,
    };
    const f2 = {
      name: 'mid.sv',
      content: `
        module mid_wrap (input logic a, input logic b, output logic y);
          leaf_and u0 (.a(a), .b(b), .y(y));
        endmodule
      `,
    };
    const f3 = {
      name: 'tb.sv',
      content: `
        module tb_top;
          logic a, b, y;
          mid_wrap u_dut (.a(a), .b(b), .y(y));
          unknown_stim u_st (.out(a));
        endmodule
      `,
    };

    // Detect all module names across files for UI dropdown
    const detected = listModuleNamesInFiles([f1, f2, f3]);
    expect(detected.map((d) => d.name)).toEqual(['leaf_and', 'mid_wrap', 'tb_top']);

    // Explicitly designate `mid_wrap` as top module instead of `tb_top`!
    const res = importVerilogFilesToCircuits([f1, f2, f3], {
      projectName: 'MyCoreIP',
      topModuleName: 'mid_wrap',
    });
    expect(res.hdlProject.name).toBe('MyCoreIP');
    expect(res.hdlProject.topModuleName).toBe('mid_wrap');
    expect(res.hdlProject.files.length).toBe(3);
    expect(res.hdlProject.moduleCircuitIds.length).toBe(3);
    expect(res.hdlProject.stubCircuitIds.length).toBe(1);

    const topCircuit = res.circuits.find((c) => c.id === res.topCircuitId)!;
    expect(topCircuit.name).toBe('mid_wrap');
    expect(topCircuit.hdlProjectId).toBe(res.hdlProject.id);

    // Every defined module shares the same hdlProjectId, and stub is isolated in stubCircuitIds (isStub=true)
    const stubDoc = res.circuits.find((c) => c.id === res.hdlProject.stubCircuitIds[0])!;
    expect(stubDoc.isStub).toBe(true);
    expect(res.hdlProject.moduleCircuitIds).not.toContain(stubDoc.id);

    // Project-wide resynthesis preserves circuit IDs for existing modules and switches top module cleanly!
    const proj = makeProj(res.circuits, res.topCircuitId);
    proj.hdlProjects = { [res.hdlProject.id]: res.hdlProject };
    const origMidId = topCircuit.id;
    const origLeafId = res.circuits.find((c) => c.name === 'leaf_and')!.id;

    const f1Edited = {
      name: 'leaf.sv',
      content: `
        module leaf_and (input logic a, input logic b, output logic y);
          assign y = a | b;
        endmodule
      `,
    };
    const resynth = resynthesizeHdlProject(res.hdlProject.id, [f1Edited, f2], 'mid_wrap', proj);
    expect(resynth.hdlProject.id).toBe(res.hdlProject.id);
    expect(resynth.hdlProject.moduleCircuitIds).toContain(origMidId);
    expect(resynth.hdlProject.moduleCircuitIds).toContain(origLeafId);
    expect(resynth.hdlProject.stubCircuitIds.length).toBe(0);

    for (const c of resynth.circuits) proj.circuits[c.id] = c;
    const out = evalSeq(proj, origMidId, createEmptySequentialState(), {
      a: fromInt(1, 1),
      b: fromInt(0, 1),
    });
    // Now OR instead of AND: 1 | 0 = 1
    expect(out.y.bits[0]).toBe(BIT_1);
  });

  it('13. builds hierarchical HDL module tree and detours global CLK and right-to-left CPU feedback loops cleanly around modules', () => {
    const cpuFiles = [
      {
        name: 'stages.sv',
        content: `
          module add_unit (input logic [3:0] a, input logic [3:0] b, output logic [3:0] s);
            assign s = a + b;
          endmodule

          module stage_pc (
            input  logic       clk,
            input  logic       rst_n,
            input  logic [3:0] next_pc,
            output logic [3:0] pc
          );
            always_ff @(posedge clk or negedge rst_n) begin
              if (!rst_n) pc <= 4'd0;
              else pc <= next_pc;
            end
          endmodule

          module stage_dec (
            input  logic       clk,
            input  logic [3:0] pc_in,
            output logic [3:0] op_out
          );
            always_ff @(posedge clk) op_out <= pc_in ^ 4'd3;
          endmodule

          module stage_ex (
            input  logic       clk,
            input  logic [3:0] op_in,
            output logic [3:0] ex_out
          );
            logic [3:0] sum_w;
            add_unit u_add (.a(op_in), .b(4'd1), .s(sum_w));
            always_ff @(posedge clk) ex_out <= sum_w;
          endmodule

          module unused_helper (input logic x, output logic y);
            assign y = ~x;
          endmodule
        `,
      },
      {
        name: 'cpu_top.sv',
        content: `
          module cpu_top (
            input  logic       clk,
            input  logic       rst_n,
            output logic [3:0] dbg_out
          );
            logic [3:0] pc_w, dec_w, ex_fb;
            stage_pc  u_pc  (.clk(clk), .rst_n(rst_n), .next_pc(ex_fb), .pc(pc_w));
            stage_dec u_dec (.clk(clk), .pc_in(pc_w), .op_out(dec_w));
            stage_ex  u_ex  (.clk(clk), .op_in(dec_w), .ex_out(ex_fb));
            assign dbg_out = ex_fb;
          endmodule
        `,
      },
    ];

    const res = importVerilogFilesToCircuits(cpuFiles, {
      projectName: 'MiniCPU',
      topModuleName: 'cpu_top',
    });
    const proj = makeProj(res.circuits, res.topCircuitId);
    const top = proj.circuits[res.topCircuitId];

    // 1. Module Hierarchy Tree: cpu_top -> (u_pc, u_dec, u_ex -> u_add), plus orphan unused_helper!
    const tree = buildHdlModuleTree(res.hdlProject, proj.circuits);
    expect(tree.root?.moduleName).toBe('cpu_top');
    expect(tree.root?.children.map((c) => c.moduleName)).toEqual([
      'stage_pc',
      'stage_dec',
      'stage_ex',
    ]);
    const exNode = tree.root!.children.find((c) => c.moduleName === 'stage_ex')!;
    expect(exNode.children.length).toBe(1);
    expect(exNode.children[0].moduleName).toBe('add_unit');
    expect(tree.orphans.map((o) => o.moduleName)).toEqual(['unused_helper']);

    // 2. Layout: ZERO overlapping bounding boxes across all gates/subcircuits!
    const boxes = top.gates.map((g) => ({ id: g.id, type: g.type, ...getGateBounds(g, proj) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i];
        const B = boxes[j];
        expect(
          A.x < B.x + B.width &&
            A.x + A.width > B.x &&
            A.y < B.y + B.height &&
            A.y + A.height > B.y,
        ).toBe(false);
      }
    }

    const layoutTopY = Math.min(...boxes.map((b) => b.y));
    const layoutBottomY = Math.max(...boxes.map((b) => b.y + b.height));

    // 3. Global CLK wires detour ABOVE all module bodies on the top corridor rail!
    const clkWires = top.wires.filter((w) => w.netLabel === 'clk');
    expect(clkWires.length).toBe(3);
    for (const cw of clkWires) {
      const minY = Math.min(...cw.points.map((p) => p.y));
      expect(minY).toBeLessThan(layoutTopY);
    }

    // 4. Right-to-left feedback wire `ex_fb` (u_ex -> u_pc) detours BELOW all module bodies!
    const uPc = top.gates.find((g) => g.label.startsWith('u_pc'))!;
    const uEx = top.gates.find((g) => g.label.startsWith('u_ex'))!;
    const fbWire = top.wires.find(
      (w) => w.netLabel === 'ex_fb' && w.from?.gateId === uEx.id && w.to?.gateId === uPc.id,
    );
    expect(fbWire).toBeDefined();
    const maxFbY = Math.max(...fbWire!.points.map((p) => p.y));
    expect(maxFbY).toBeGreaterThan(layoutBottomY);
  });

  it('14. real-world TD4 CPU (docs/test_hdl): infers td4_cpu as top over unused rom_16x8 and routes/simulates fast', () => {
    const hdlDir = join(process.cwd(), 'docs', 'test_hdl');
    const fileNames = readdirSync(hdlDir)
      .filter((f) => f.endsWith('.sv') || f.endsWith('.v'))
      .sort(); // alphabetical order puts rom_16x8bit.sv BEFORE td4_cpu.sv!
    const files = fileNames.map((name) => ({
      name,
      content: readFileSync(join(hdlDir, name), 'utf-8'),
    }));

    // Smart top-module inference MUST choose `td4_cpu` (8 instances) over alphabetically earlier files (e.g. alu.sv)
    // AND over an unused alphabetically-first leaf module!
    expect(inferTopModuleName(files)).toBe('td4_cpu');
    expect(
      inferTopModuleName([
        {
          name: 'aaa_unused.sv',
          content: 'module aaa_unused(input logic a, output logic y); assign y = a; endmodule',
        },
        ...files,
      ]),
    ).toBe('td4_cpu');

    const t0 = performance.now();
    const res = importVerilogFilesToCircuits(files);
    const importMs = performance.now() - t0;

    const topDoc = res.circuits.find((c) => c.id === res.topCircuitId)!;
    expect(topDoc.name).toBe('td4_cpu');
    expect(res.hdlProject.topModuleName).toBe('td4_cpu');

    // Module tree shows td4_cpu as root with all its instantiated submodules
    const proj = makeProj(res.circuits, res.topCircuitId);
    const tree = buildHdlModuleTree(res.hdlProject, proj.circuits);
    expect(tree.root?.moduleName).toBe('td4_cpu');
    expect(tree.root?.children.length).toBeGreaterThanOrEqual(7);

    // Performance check: full 7-file import + auto-layout + all 30+ A* routes completes quickly
    expect(importMs).toBeLessThan(1000);

    // Rerouting the heaviest module (decoder_inst with 12 pins) must be snappy (< 80ms)
    const decGate = topDoc.gates.find((g) => g.label.includes('decoder_inst'))!;
    expect(decGate).toBeDefined();
    const tReroute0 = performance.now();
    const rerouted = rerouteWiresForGates(new Set([decGate.id]), topDoc, proj);
    const rerouteMs = performance.now() - tReroute0;
    expect(rerouted.length).toBe(topDoc.wires.length);
    expect(rerouteMs).toBeLessThan(80);
  });

  it('15. classifies X signal causes (conflict, oscillation, stub, unknown) accurately in SimulationSnapshot', () => {
    // 1. Bus contention (0 vs 1 -> 'conflict')
    const conflictRes = importVerilogToCircuits(`
      module m_conflict (input logic a, input logic b, output logic y);
        assign y = 1'b1 ? a : 1'bz;
        assign y = 1'b1 ? b : 1'bz;
      endmodule
    `);
    const pConf = makeProj(conflictRes.circuits, conflictRes.topCircuitId);
    const cConf = pConf.circuits[conflictRes.topCircuitId];
    const inConf: Record<string, LogicValue> = {};
    for (const g of cConf.gates) {
      if (g.type === 'MODULE_IN') inConf[g.id] = fromInt(g.label === 'a' ? 1 : 0, 1);
    }
    const snapConf = simulateCircuit(cConf, pConf, createEmptySequentialState(), {
      externalInputs: inConf,
    });
    const yOutConf = cConf.gates.find((g) => g.type === 'MODULE_OUT')!;
    expect(snapConf.pinXCauses?.[`${yOutConf.id}:in`]).toBe('conflict');

    // 2. Combinational feedback oscillation (transparent D_LATCH with inverted Q feedback -> 'oscillation')
    const oscCirc: CircuitDocument = {
      id: 'c_osc',
      name: 'Osc',
      gates: [
        {
          id: 'c_en',
          type: 'CONST',
          x: 40,
          y: 100,
          rotation: 0,
          label: '1',
          props: { bitWidth: 1, value: '1' },
        },
        {
          id: 'lat',
          type: 'D_LATCH',
          x: 160,
          y: 100,
          rotation: 0,
          label: 'L1',
          props: { bitWidth: 1 },
        },
        {
          id: 'inv',
          type: 'NOT',
          x: 280,
          y: 100,
          rotation: 0,
          label: 'N1',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        {
          id: 'w_en',
          from: { gateId: 'c_en', pinId: 'out' },
          to: { gateId: 'lat', pinId: 'en' },
          points: [],
          routeMode: 'grid',
        },
        {
          id: 'w_q',
          from: { gateId: 'lat', pinId: 'q' },
          to: { gateId: 'inv', pinId: 'in0' },
          points: [],
          routeMode: 'grid',
        },
        {
          id: 'w_osc',
          from: { gateId: 'inv', pinId: 'out' },
          to: { gateId: 'lat', pinId: 'd' },
          points: [],
          routeMode: 'grid',
        },
      ],
    };
    const pOsc = makeProj([oscCirc], 'c_osc');
    const snapOsc = simulateCircuit(oscCirc, pOsc, createEmptySequentialState());
    expect(snapOsc.oscillating).toBe(true);
    expect(snapOsc.wireXCauses?.['w_osc']).toBe('oscillation');

    // 3. Unimplemented external stub output ('stub') vs downstream propagated X ('unknown')
    const stubRes = importVerilogToCircuits(`
      module m_stub (output logic raw_x, output logic prop_x);
        ext_rom u_rom (.dout(raw_x));
        assign prop_x = ~raw_x;
      endmodule
    `);
    const pStub = makeProj(stubRes.circuits, stubRes.topCircuitId);
    const cStub = pStub.circuits[stubRes.topCircuitId];
    const snapStub = simulateCircuit(cStub, pStub, createEmptySequentialState());
    const rawOut = cStub.gates.find((g) => g.type === 'MODULE_OUT' && g.label === 'raw_x')!;
    const propOut = cStub.gates.find((g) => g.type === 'MODULE_OUT' && g.label === 'prop_x')!;
    expect(snapStub.pinXCauses?.[`${rawOut.id}:in`]).toBe('stub');
    expect(snapStub.pinXCauses?.[`${propOut.id}:in`]).toBe('unknown');
  });
});
