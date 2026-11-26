import { describe, expect, it } from 'vite-plus/test';
import {
  addVectors,
  BIT_0,
  BIT_1,
  BIT_X,
  BIT_Z,
  bitAnd,
  bitOr,
  bitTriBuf,
  bitXor,
  fromInt,
  resolveBit,
  toUnsignedInt,
} from '../src/core/logic4';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { createSampleProject } from '../src/core/samples';
import {
  exportDotGraph,
  exportJsonNetlist,
  exportVerilog,
  importVerilogToCircuits,
} from '../src/core/hdl';
import {
  dragWireSegment,
  dragWireWaypoint,
  rerouteWiresForGates,
  routeWire,
  simplifyPolyline,
} from '../src/core/routing';
import { CircuitDocument, ProjectDocument } from '../src/core/types';

describe('4-state IEEE 1364 Logic Operations', () => {
  it('handles 0, 1, X, Z truth tables accurately', () => {
    expect(bitAnd(BIT_0, BIT_X)).toBe(BIT_0);
    expect(bitAnd(BIT_0, BIT_Z)).toBe(BIT_0);
    expect(bitAnd(BIT_1, BIT_X)).toBe(BIT_X);
    expect(bitOr(BIT_1, BIT_X)).toBe(BIT_1);
    expect(bitOr(BIT_0, BIT_Z)).toBe(BIT_X);
    expect(bitXor(BIT_1, BIT_1)).toBe(BIT_0);
    expect(bitXor(BIT_1, BIT_0)).toBe(BIT_1);
    expect(bitXor(BIT_0, BIT_X)).toBe(BIT_X);

    // Tri-state buffer
    expect(bitTriBuf(BIT_1, BIT_0)).toBe(BIT_Z);
    expect(bitTriBuf(BIT_1, BIT_1)).toBe(BIT_1);
    expect(bitTriBuf(BIT_Z, BIT_1)).toBe(BIT_X);
  });

  it('resolves multi-driver bus contention properly', () => {
    expect(resolveBit([])).toBe(BIT_Z);
    expect(resolveBit([BIT_Z, BIT_Z])).toBe(BIT_Z);
    expect(resolveBit([BIT_Z, BIT_1])).toBe(BIT_1);
    expect(resolveBit([BIT_0, BIT_0, BIT_Z])).toBe(BIT_0);
    // 0 vs 1 contention -> X!
    expect(resolveBit([BIT_0, BIT_1])).toBe(BIT_X);
    expect(resolveBit([BIT_Z, BIT_X])).toBe(BIT_X);
  });

  it('adds multi-bit vectors with carry and X propagation', () => {
    const res = addVectors(fromInt(5, 4), fromInt(6, 4), BIT_0, 4);
    expect(toUnsignedInt(res.sum)).toBe(11);
    expect(res.cout).toBe(BIT_0);

    const ovf = addVectors(fromInt(15, 4), fromInt(1, 4), BIT_0, 4);
    expect(toUnsignedInt(ovf.sum)).toBe(0);
    expect(ovf.cout).toBe(BIT_1);

    const unk = addVectors(fromInt(3, 4), fromInt(2, 4), BIT_X, 4);
    expect(unk.sum.bits.every((b) => b === BIT_X)).toBe(true);
    expect(unk.cout).toBe(BIT_X);
  });
});

describe('Hierarchical Subcircuit & 4-State Simulator', () => {
  it('simulates sample 2-bit hierarchical ripple adder with live subcircuit snapshots', () => {
    const project = createSampleProject();
    const main = project.circuits['circ_main'];
    const seq = createEmptySequentialState();

    // Default switches: A0=1, B0=1, Cin=0, A1=1, B1=0 => A=3 (11b), B=1 (01b) => Sum = 4 (100b)
    const snap = simulateCircuit(main, project, seq);

    expect(snap.pinValues['led_s0:in']?.bits[0]).toBe(BIT_0);
    expect(snap.pinValues['led_s1:in']?.bits[0]).toBe(BIT_0);
    expect(snap.pinValues['led_cout:in']?.bits[0]).toBe(BIT_1);
    expect(toUnsignedInt(snap.pinValues['disp_7seg:in'])).toBe(4);

    // Live internal snapshots exist independently for both FullAdder instances!
    expect(snap.subSnapshots['mod_fa0']).toBeDefined();
    expect(snap.subSnapshots['mod_fa1']).toBeDefined();
    // FA0 has A=1, B=1, Cin=0 -> S=0, Cout=1
    expect(snap.subSnapshots['mod_fa0'].pinValues['fa_out_c:in']?.bits[0]).toBe(BIT_1);
    expect(snap.subSnapshots['mod_fa0'].pinValues['fa_out_s:in']?.bits[0]).toBe(BIT_0);
  });

  it('detects Z (floating), 1 (driven), and X (bus contention) in Tri-State Bus demo', () => {
    const project = createSampleProject();
    const demo = project.circuits['circ_4state'];
    const seq = createEmptySequentialState();

    // Initially EN_A=1 (DRV_A=1), EN_B=0 (DRV_B=0) => SHARED_BUS = 1, FLOAT_Z = Z
    let snap = simulateCircuit(demo, project, seq);
    expect(snap.pinValues['d_bus_led:in']?.bits[0]).toBe(BIT_1);
    expect(snap.pinValues['d_z_led:in']?.bits[0]).toBe(BIT_Z);

    // Enable BOTH drivers with opposite values (1 vs 0) => Contention X!
    demo.gates.find((g) => g.id === 'd_en2')!.props.value = '1';
    snap = simulateCircuit(demo, project, seq);
    expect(snap.pinValues['d_bus_led:in']?.bits[0]).toBe(BIT_X);

    // Disable BOTH drivers => Bus floats to Z!
    demo.gates.find((g) => g.id === 'd_en1')!.props.value = '0';
    demo.gates.find((g) => g.id === 'd_en2')!.props.value = '0';
    snap = simulateCircuit(demo, project, seq);
    expect(snap.pinValues['d_bus_led:in']?.bits[0]).toBe(BIT_Z);
  });

  it('advances Counter on rising clock edge and reads ROM', () => {
    const project = createSampleProject();
    const demo = project.circuits['circ_4state'];
    const seq = createEmptySequentialState();
    const clk = demo.gates.find((g) => g.id === 'd_clk')!;

    clk.props.clockHigh = false;
    let snap = simulateCircuit(demo, project, seq);
    expect(toUnsignedInt(snap.pinValues['d_seg:in'])).toBe(0);

    // Rising edge 1 -> count = 1
    clk.props.clockHigh = true;
    snap = simulateCircuit(demo, project, seq);
    expect(toUnsignedInt(snap.pinValues['d_seg:in'])).toBe(1);

    // Falling edge -> holds 1
    clk.props.clockHigh = false;
    snap = simulateCircuit(demo, project, seq);
    expect(toUnsignedInt(snap.pinValues['d_seg:in'])).toBe(1);

    // Rising edge 2 -> count = 2
    clk.props.clockHigh = true;
    snap = simulateCircuit(demo, project, seq);
    expect(toUnsignedInt(snap.pinValues['d_seg:in'])).toBe(2);
  });

  it('packs and unpacks SV-style Interface Bundles accurately', () => {
    const circ: CircuitDocument = {
      id: 'c_if',
      name: 'IfaceTest',
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
          id: 'c2',
          type: 'CONST',
          x: 0,
          y: 40,
          rotation: 0,
          label: '',
          props: { bitWidth: 4, value: '0xA' },
        },
        {
          id: 'pack',
          type: 'IFACE_BUNDLE',
          x: 160,
          y: 20,
          rotation: 0,
          label: '',
          props: {
            bundleMode: 'pack',
            interfaceName: 'axi_lite',
            interfaceFields: [
              { name: 'valid', bitWidth: 1 },
              { name: 'data', bitWidth: 4 },
            ],
          },
        },
        {
          id: 'unpack',
          type: 'IFACE_BUNDLE',
          x: 360,
          y: 20,
          rotation: 0,
          label: '',
          props: {
            bundleMode: 'unpack',
            interfaceName: 'axi_lite',
            interfaceFields: [
              { name: 'valid', bitWidth: 1 },
              { name: 'data', bitWidth: 4 },
            ],
          },
        },
      ],
      wires: [
        {
          id: 'w1',
          from: { gateId: 'c1', pinId: 'out' },
          to: { gateId: 'pack', pinId: 'f_0' },
          points: [],
          routeMode: 'grid',
        },
        {
          id: 'w2',
          from: { gateId: 'c2', pinId: 'out' },
          to: { gateId: 'pack', pinId: 'f_1' },
          points: [],
          routeMode: 'grid',
        },
        {
          id: 'w3',
          from: { gateId: 'pack', pinId: 'bundle' },
          to: { gateId: 'unpack', pinId: 'bundle' },
          points: [],
          routeMode: 'grid',
        },
      ],
    };
    const proj: ProjectDocument = {
      version: 1,
      name: 't',
      activeCircuitId: 'c_if',
      circuits: { c_if: circ },
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
    const snap = simulateCircuit(circ, proj, createEmptySequentialState());
    expect(snap.pinValues['unpack:f_0']?.bits[0]).toBe(BIT_1);
    expect(toUnsignedInt(snap.pinValues['unpack:f_1'])).toBe(0xa);
  });
});

describe('Wire Routing & HDL Import / Netlist Export', () => {
  it('routes grid-fit wires orthogonally around obstacles without overlapping existing wires', () => {
    const circ: CircuitDocument = {
      id: 'c_r',
      name: 'RouteTest',
      gates: [
        {
          id: 'obs',
          type: 'AND',
          x: 200,
          y: 100,
          rotation: 0,
          label: '',
          props: { inputCount: 2, bitWidth: 1 },
        },
      ],
      wires: [],
    };
    const pts = routeWire(
      { x: 80, y: 100 },
      { x: 320, y: 100 },
      {
        startSide: 'right',
        endSide: 'left',
        circuit: circ,
        routeMode: 'grid',
      },
    );
    expect(pts.length).toBeGreaterThanOrEqual(4);
    // Every segment should be horizontal or vertical
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = Math.abs(pts[i + 1].x - pts[i].x);
      const dy = Math.abs(pts[i + 1].y - pts[i].y);
      expect(Math.min(dx, dy)).toBeLessThan(0.5);
    }
  });

  it('imports Verilog/SV with unknown external modules as placeholder stubs and visualizes wiring', () => {
    const src = `
      module top(input logic a, input logic b, output logic y);
        logic mid;
        assign mid = a ^ b;
        ext_blackbox u_bb (.din(mid), .dout(y));
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    expect(res.circuits.length).toBe(2);
    const stub = res.circuits.find((c) => c.isStub);
    expect(stub).toBeDefined();
    expect(stub?.stubPorts?.map((p) => p.name)).toEqual(['din', 'dout']);
    expect(res.warnings.length).toBeGreaterThan(0);

    const top = res.circuits.find((c) => c.id === res.topCircuitId)!;
    expect(top.gates.some((g) => g.type === 'SUBCIRCUIT')).toBe(true);
    expect(top.wires.length).toBeGreaterThan(0);
  });

  it('exports Verilog, JSON netlist, and DOT graph cleanly', () => {
    const project = createSampleProject();
    const v = exportVerilog(project, 'circ_main');
    expect(v).toContain('module FullAdder');
    expect(v).toContain('module _2bit_Adder_Live');

    const j = JSON.parse(exportJsonNetlist(project, 'circ_full_adder'));
    expect(j.format).toBe('logicflow-netlist-v1');
    expect(j.nets.length).toBeGreaterThan(0);

    const d = exportDotGraph(project, 'circ_full_adder');
    expect(d).toContain('digraph "FullAdder"');
  });

  it('allows manual wire segment/waypoint dragging while preserving pin endpoints, then auto-relayouts when gate moves', () => {
    // 1. Dragging a straight 2-point horizontal wire vertically creates a clean orthogonal U-bend with fixed endpoints
    const straight = [
      { x: 100, y: 100 },
      { x: 260, y: 100 },
    ];
    const bent = simplifyPolyline(dragWireSegment(straight, 0, { x: 180, y: 160 }, 'grid', 20));
    expect(bent[0]).toEqual({ x: 100, y: 100 });
    expect(bent[bent.length - 1]).toEqual({ x: 260, y: 100 });
    expect(bent.some((p) => p.y === 160)).toBe(true);

    // 2. Dragging an interior vertical segment horizontally shifts only its X
    const zWire = [
      { x: 100, y: 100 },
      { x: 180, y: 100 },
      { x: 180, y: 200 },
      { x: 260, y: 200 },
    ];
    const shifted = simplifyPolyline(dragWireSegment(zWire, 1, { x: 220, y: 150 }, 'grid', 20));
    expect(shifted[0]).toEqual({ x: 100, y: 100 });
    expect(shifted[1]).toEqual({ x: 220, y: 100 });
    expect(shifted[2]).toEqual({ x: 220, y: 200 });
    expect(shifted[3]).toEqual({ x: 260, y: 200 });

    // 3. Dragging an interior corner waypoint moves it cleanly on grid
    const cornerMoved = simplifyPolyline(
      dragWireWaypoint(zWire, 1, { x: 200, y: 140 }, 'grid', 20),
    );
    expect(cornerMoved[0]).toEqual({ x: 100, y: 100 });
    expect(cornerMoved[cornerMoved.length - 1]).toEqual({ x: 260, y: 200 });

    // 4. Moving a connected gate after manual wire adjustment automatically re-layouts the wire cleanly
    const project = createSampleProject();
    const fa = project.circuits['circ_full_adder'];
    const wire = fa.wires.find((w) => w.id === 'w_fa1')!;
    wire.points = dragWireSegment(wire.points, 0, { x: 180, y: 40 }, 'grid', 20);
    expect(wire.points.some((p) => p.y === 40)).toBe(true);

    // Move gate fa_xor1 -> rerouteWiresForGates cleanly re-layouts w_fa1 to new pin position!
    const xor1 = fa.gates.find((g) => g.id === 'fa_xor1')!;
    xor1.y += 40;
    const rerouted = rerouteWiresForGates(new Set(['fa_xor1']), fa, project);
    const updatedW = rerouted.find((w) => w.id === 'w_fa1')!;
    expect(updatedW.points.some((p) => p.y === 40)).toBe(false);
    expect(updatedW.points[updatedW.points.length - 1].y).toBeGreaterThan(140);
  });
});
