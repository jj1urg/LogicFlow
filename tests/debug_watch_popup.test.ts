import { describe, expect, it } from 'vitest';
import {
  appendWaveformStep,
  buildPinWatchLabel,
  buildWireWatchLabel,
  formatWatchValue,
  getDefaultWatchPin,
  hasWatchedSignalsChanged,
  makePinWatchId,
  makeWireWatchId,
  parseStoredWatchTargets,
  pruneWatchTargets,
  resolveLiveSubcircuitPath,
  sampleWatchedSignals,
  WatchTarget,
  WaveformStep,
} from '../src/core/debug';
import { importVerilogToCircuits } from '../src/core/hdl';
import { BIT_0, BIT_1, BIT_X, BIT_Z, fromInt, fromLiteral } from '../src/core/logic4';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { closeCircuitTabState, reorderOpenTabIds, resolveOpenTabIds } from '../src/core/tabs';
import { CircuitDocument, ProjectDocument } from '../src/core/types';
import { formatAppVersion } from '../src/core/version';

function makeProject(circuits: CircuitDocument[], topId: string): ProjectDocument {
  const map: Record<string, CircuitDocument> = {};
  for (const c of circuits) map[c.id] = c;
  return {
    version: 1,
    name: 'DebugTest',
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

describe('Live Subcircuit Popup & Signal Watch / Waveform Helpers', () => {
  it('1. resolves nested subcircuit paths with live parent-driven SimulationSnapshots', () => {
    const src = `
      module leaf_inv(input logic a, output logic y);
        assign y = ~a;
      endmodule

      module mid_buf(input logic x, output logic z);
        wire w;
        leaf_inv u_leaf (.a(x), .y(w));
        assign z = w;
      endmodule

      module top_sys(input logic sw, output logic led);
        mid_buf u_mid (.x(sw), .z(led));
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    const proj = makeProject(res.circuits, res.topCircuitId);
    const topDoc = proj.circuits[res.topCircuitId];
    const seq = createEmptySequentialState();

    // Drive parent input sw = 1 and simulate top circuit
    const swGate = topDoc.gates.find((g) => g.type === 'MODULE_IN' && g.label === 'sw')!;
    swGate.props.value = '1';
    const rootSnap = simulateCircuit(topDoc, proj, seq);

    const midGate = topDoc.gates.find((g) => g.type === 'SUBCIRCUIT')!;
    const resolvedMid = resolveLiveSubcircuitPath(topDoc, proj, rootSnap, [midGate.id]);
    expect(resolvedMid).not.toBeNull();
    expect(resolvedMid!.circuit.name).toBe('mid_buf');
    expect(resolvedMid!.breadcrumbs).toHaveLength(1);
    expect(resolvedMid!.breadcrumbs[0].instanceLabel).toBe('u_mid');

    // Drill down 2 levels: top_sys -> u_mid -> u_leaf
    const leafGate = resolvedMid!.circuit.gates.find((g) => g.type === 'SUBCIRCUIT')!;
    const resolvedLeaf = resolveLiveSubcircuitPath(topDoc, proj, rootSnap, [
      midGate.id,
      leafGate.id,
    ]);
    expect(resolvedLeaf).not.toBeNull();
    expect(resolvedLeaf!.circuit.name).toBe('leaf_inv');
    expect(resolvedLeaf!.breadcrumbs.map((b) => b.moduleName)).toEqual(['mid_buf', 'leaf_inv']);

    // Verify parent input sw=1 propagated into leaf_inv (a=1, y=0)
    const leafIn = resolvedLeaf!.circuit.gates.find((g) => g.type === 'MODULE_IN')!;
    const leafOut = resolvedLeaf!.circuit.gates.find((g) => g.type === 'MODULE_OUT')!;
    expect(resolvedLeaf!.snapshot?.pinValues[`${leafIn.id}:out`]?.bits[0]).toBe(BIT_1);
    expect(resolvedLeaf!.snapshot?.pinValues[`${leafOut.id}:in`]?.bits[0]).toBe(BIT_0);

    // Flip parent input sw = 0 -> live popup snapshot reflects a=0, y=1 immediately
    swGate.props.value = '0';
    const rootSnap2 = simulateCircuit(topDoc, proj, seq);
    const resolvedLeaf2 = resolveLiveSubcircuitPath(topDoc, proj, rootSnap2, [
      midGate.id,
      leafGate.id,
    ]);
    expect(resolvedLeaf2!.snapshot?.pinValues[`${leafIn.id}:out`]?.bits[0]).toBe(BIT_0);
    expect(resolvedLeaf2!.snapshot?.pinValues[`${leafOut.id}:in`]?.bits[0]).toBe(BIT_1);

    // Invalid path returns null safely
    expect(resolveLiveSubcircuitPath(topDoc, proj, rootSnap2, ['nonexistent'])).toBeNull();
  });

  it('2. samples watched wires & pins, detects state changes, and enforces waveform ring buffer cap', () => {
    const src = `
      module adder_demo(input logic [3:0] a, input logic [3:0] b, output logic [3:0] sum);
        assign sum = a + b;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    const proj = makeProject(res.circuits, res.topCircuitId);
    const topDoc = proj.circuits[res.topCircuitId];
    const seq = createEmptySequentialState();

    const gateA = topDoc.gates.find((g) => g.type === 'MODULE_IN' && g.label === 'a')!;
    const gateB = topDoc.gates.find((g) => g.type === 'MODULE_IN' && g.label === 'b')!;
    const gateSum = topDoc.gates.find((g) => g.type === 'MODULE_OUT' && g.label === 'sum')!;
    const sumWire = topDoc.wires.find((w) => w.to?.gateId === gateSum.id)!;

    const pinA = getDefaultWatchPin(gateA, proj)!;
    const targets: WatchTarget[] = [
      {
        id: makePinWatchId(topDoc.id, gateA.id, pinA.pinId),
        circuitId: topDoc.id,
        kind: 'pin',
        gateId: gateA.id,
        pinId: pinA.pinId,
        label: buildPinWatchLabel(gateA, pinA.pinId, pinA.pinName),
        radix: 'auto',
      },
      {
        id: makeWireWatchId(topDoc.id, sumWire.id),
        circuitId: topDoc.id,
        kind: 'wire',
        wireId: sumWire.id,
        label: buildWireWatchLabel(sumWire, topDoc),
        radix: 'hex',
      },
    ];

    gateA.props.value = '3';
    gateB.props.value = '4';
    const snap1 = simulateCircuit(topDoc, proj, seq);
    const s1 = sampleWatchedSignals(targets, topDoc, proj, snap1);
    expect(formatWatchValue(s1[targets[0].id].value, 'dec')).toBe('3');
    expect(formatWatchValue(s1[targets[1].id].value, 'dec')).toBe('7');

    let history: WaveformStep[] = [];
    expect(hasWatchedSignalsChanged(history[history.length - 1], s1, targets, topDoc.id)).toBe(
      true,
    );
    history = appendWaveformStep(history, s1, 4);
    expect(history).toHaveLength(1);
    expect(history[0].step).toBe(0);

    // Same values -> no redundant step
    expect(hasWatchedSignalsChanged(history[history.length - 1], s1, targets, topDoc.id)).toBe(
      false,
    );

    // Change inputs 5 times with maxSteps=4 -> ring buffer keeps last 4 steps
    for (let v = 1; v <= 5; v++) {
      gateA.props.value = String(v);
      const snap = simulateCircuit(topDoc, proj, seq);
      const sample = sampleWatchedSignals(targets, topDoc, proj, snap);
      if (hasWatchedSignalsChanged(history[history.length - 1], sample, targets, topDoc.id)) {
        history = appendWaveformStep(history, sample, 4);
      }
    }
    expect(history).toHaveLength(4);
    expect(history[history.length - 1].step).toBe(5);
    expect(formatWatchValue(history[history.length - 1].values[targets[1].id].value, 'dec')).toBe(
      '9',
    );
  });

  it('3. formats 4-state values cleanly across auto, bin, hex, dec, and signed radices', () => {
    const valNeg = fromInt(0xf, 4); // 4-bit 1111 = unsigned 15, signed -1
    expect(formatWatchValue(valNeg, 'auto')).toBe('0xF');
    expect(formatWatchValue(valNeg, 'hex')).toBe('0xF');
    expect(formatWatchValue(valNeg, 'bin')).toBe('1111');
    expect(formatWatchValue(valNeg, 'dec')).toBe('15');
    expect(formatWatchValue(valNeg, 'signed')).toBe('-1');

    const bit1 = fromInt(1, 1);
    expect(formatWatchValue(bit1, 'auto')).toBe('1');

    const withX = fromLiteral('0b10x1', 4);
    expect(withX.bits[1]).toBe(BIT_X);
    expect(formatWatchValue(withX, 'dec')).toBe('10X1');
    expect(formatWatchValue(withX, 'signed')).toBe('10X1');

    const highZ = fromLiteral('0bz', 1);
    expect(highZ.bits[0]).toBe(BIT_Z);
    expect(formatWatchValue(highZ, 'auto')).toBe('Z');
  });

  it('4. excludes ambiguous multi-output blocks from single-click gate watch and records Hi-Z own output on disabled TRIBUF', () => {
    const src = `
      module tri_bus(
        input  logic a,
        input  logic b,
        input  logic en_a,
        input  logic en_b,
        output logic bus_y
      );
        assign bus_y = en_a ? a : 1'bz;
        assign bus_y = en_b ? b : 1'bz;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    const proj = makeProject(res.circuits, res.topCircuitId);
    const topDoc = proj.circuits[res.topCircuitId];
    const seq = createEmptySequentialState();

    // Drive TRIBUF 0 enabled (en_a=1, a=1) and TRIBUF 1 disabled (en_b=0, b=0) onto the same shared bus
    const inA = topDoc.gates.find((g) => g.label === 'a')!;
    const inB = topDoc.gates.find((g) => g.label === 'b')!;
    const inEnA = topDoc.gates.find((g) => g.label === 'en_a')!;
    const inEnB = topDoc.gates.find((g) => g.label === 'en_b')!;
    inA.props.value = '1';
    inB.props.value = '0';
    inEnA.props.value = '1';
    inEnB.props.value = '0';

    const snap = simulateCircuit(topDoc, proj, seq);
    const triGates = topDoc.gates.filter((g) => g.type === 'TRIBUF');
    expect(triGates).toHaveLength(2);

    // Both share the bus wire resolved to 1, but pinDrivenValues preserves each driver's own output (1 and Z)!
    const ownStates = triGates.map((g) => snap.pinDrivenValues?.[`${g.id}:out`]?.bits[0]);
    expect(ownStates).toContain(BIT_1);
    expect(ownStates).toContain(BIT_Z);
    for (const g of triGates) {
      expect(snap.pinValues[`${g.id}:out`]?.bits[0]).toBe(BIT_1);
      expect(getDefaultWatchPin(g, proj)?.pinId).toBe('out');
    }

    // Now enable BOTH TRIBUFs with opposite values (1 vs 0) -> wire resolves to conflict X,
    // while pinDrivenValues keeps each OUT pin's own driven value (1 and 0)!
    inEnB.props.value = '1';
    const conflictSnap = simulateCircuit(topDoc, proj, seq);
    const conflictOwn = triGates.map((g) => conflictSnap.pinDrivenValues?.[`${g.id}:out`]?.bits[0]);
    expect(conflictOwn).toContain(BIT_1);
    expect(conflictOwn).toContain(BIT_0);
    for (const g of triGates) {
      expect(conflictSnap.pinValues[`${g.id}:out`]?.bits[0]).toBe(BIT_X);
      expect(conflictSnap.pinXCauses?.[`${g.id}:out`]).toBe('conflict');
    }

    // Ambiguous multi-output blocks must return null from getDefaultWatchPin
    expect(
      getDefaultWatchPin(
        { id: 's1', type: 'SUBCIRCUIT', x: 0, y: 0, rotation: 0, label: 'u1', props: {} },
        proj,
      ),
    ).toBeNull();
    expect(
      getDefaultWatchPin(
        {
          id: 'sp1',
          type: 'SPLITTER',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'sp',
          props: { splitMode: 'split', splitWidths: [1, 1], bitWidth: 2 },
        },
        proj,
      ),
    ).toBeNull();
    expect(
      getDefaultWatchPin(
        { id: 'dm1', type: 'DEMUX', x: 0, y: 0, rotation: 0, label: 'dm', props: {} },
        proj,
      ),
    ).toBeNull();
    expect(
      getDefaultWatchPin(
        { id: 'cmp1', type: 'COMPARATOR', x: 0, y: 0, rotation: 0, label: 'cmp', props: {} },
        proj,
      ),
    ).toBeNull();
  });

  it('5. parses and prunes persisted watch lists safely while preserving order and radix', () => {
    const src = `
      module watch_persist(input logic a, output logic y);
        assign y = ~a;
      endmodule
    `;
    const res = importVerilogToCircuits(src);
    const proj = makeProject(res.circuits, res.topCircuitId);
    const topDoc = proj.circuits[res.topCircuitId];
    const inA = topDoc.gates.find((g) => g.label === 'a')!;
    const w0 = topDoc.wires[0];

    const saved: WatchTarget[] = [
      {
        id: makeWireWatchId(topDoc.id, w0.id),
        circuitId: topDoc.id,
        kind: 'wire',
        wireId: w0.id,
        label: 'w_sig',
        radix: 'hex',
      },
      {
        id: 'wire:missing_circ:w999',
        circuitId: 'missing_circ',
        kind: 'wire',
        wireId: 'w999',
        label: 'stale_wire',
        radix: 'bin',
      },
      {
        id: makePinWatchId(topDoc.id, inA.id, 'out'),
        circuitId: topDoc.id,
        kind: 'pin',
        gateId: inA.id,
        pinId: 'out',
        label: 'a',
        radix: 'signed',
      },
    ];

    const parsed = parseStoredWatchTargets(JSON.stringify(saved));
    expect(parsed).toHaveLength(3);
    const pruned = pruneWatchTargets(parsed, proj);
    expect(pruned.map((t) => t.label)).toEqual(['w_sig', 'a']);
    expect(pruned.map((t) => t.radix)).toEqual(['hex', 'signed']);

    // Corrupted JSON or invalid objects return empty safely
    expect(parseStoredWatchTargets('{bad json')).toEqual([]);
    expect(parseStoredWatchTargets(null)).toEqual([]);
  });

  it('6. formats package.json SemVer version into LogicFlow short vx.y and full vx.y-rz.w strings', () => {
    expect(formatAppVersion('0.17.0-r0.0')).toEqual({
      short: 'v0.17',
      full: 'v0.17-r0.0',
      raw: '0.17.0-r0.0',
    });
    expect(formatAppVersion('1.2.0-r3.4')).toEqual({
      short: 'v1.2',
      full: 'v1.2-r3.4',
      raw: '1.2.0-r3.4',
    });
    expect(formatAppVersion('0.16.0')).toEqual({
      short: 'v0.16',
      full: 'v0.16',
      raw: '0.16.0',
    });
  });

  it('7. purely closes tabs down to 0 open tabs while preserving module definitions and MRU return order', () => {
    const c1: CircuitDocument = { id: 'c1', name: 'Main', gates: [], wires: [] };
    const c2: CircuitDocument = { id: 'c2', name: 'Alu', gates: [], wires: [] };
    const c3: CircuitDocument = { id: 'c3', name: 'Reg', gates: [], wires: [] };
    const stub: CircuitDocument = { id: 's1', name: 'Ext', gates: [], wires: [], isStub: true };
    const proj = makeProject([c1, c2, c3, stub], 'c3');

    // Legacy project (openTabIds undefined) resolves all non-stub circuits
    expect(resolveOpenTabIds({ ...proj, openTabIds: undefined })).toEqual(['c1', 'c2', 'c3']);

    // Explicitly empty openTabIds stays empty (never auto-reopens all modules!)
    expect(resolveOpenTabIds({ ...proj, openTabIds: [] })).toEqual([]);

    // Closing active tab c3 with MRU history [c1, c2, c3] returns to c2 without deleting c3
    const p1: ProjectDocument = { ...proj, openTabIds: ['c1', 'c2', 'c3'], activeCircuitId: 'c3' };
    const step1 = closeCircuitTabState(p1, 'c3', ['c1', 'c2', 'c3']);
    expect(step1.openTabIds).toEqual(['c1', 'c2']);
    expect(step1.activeCircuitId).toBe('c2');
    expect(p1.circuits['c3']).toBeDefined();

    // Closing inactive tab c1 keeps active c2
    const p2: ProjectDocument = {
      ...p1,
      openTabIds: step1.openTabIds,
      activeCircuitId: step1.activeCircuitId,
    };
    const step2 = closeCircuitTabState(p2, 'c1', step1.tabHistory);
    expect(step2.openTabIds).toEqual(['c2']);
    expect(step2.activeCircuitId).toBe('c2');

    // Closing the last remaining tab c2 succeeds cleanly -> 0 open tabs, activeCircuitId === ''
    const p3: ProjectDocument = {
      ...p2,
      openTabIds: step2.openTabIds,
      activeCircuitId: step2.activeCircuitId,
    };
    const step3 = closeCircuitTabState(p3, 'c2', step2.tabHistory);
    expect(step3.openTabIds).toEqual([]);
    expect(step3.activeCircuitId).toBe('');
    expect(resolveOpenTabIds({ ...p3, openTabIds: step3.openTabIds })).toEqual([]);
    expect(Object.keys(p3.circuits)).toEqual(['c1', 'c2', 'c3', 's1']);
  });

  it('8. reorders open circuit tabs cleanly before/after target without mutating project', () => {
    const c1: CircuitDocument = { id: 'c1', name: 'Main', gates: [], wires: [] };
    const c2: CircuitDocument = { id: 'c2', name: 'Alu', gates: [], wires: [] };
    const c3: CircuitDocument = { id: 'c3', name: 'Reg', gates: [], wires: [] };
    const proj = { ...makeProject([c1, c2, c3], 'c1'), openTabIds: ['c1', 'c2', 'c3'] };

    // Move first tab after last tab
    expect(reorderOpenTabIds(proj, 'c1', 'c3', 'after')).toEqual(['c2', 'c3', 'c1']);
    // Move first tab before last tab
    expect(reorderOpenTabIds(proj, 'c1', 'c3', 'before')).toEqual(['c2', 'c1', 'c3']);
    // Move last tab before first tab
    expect(reorderOpenTabIds(proj, 'c3', 'c1', 'before')).toEqual(['c3', 'c1', 'c2']);
    // Move last tab after first tab
    expect(reorderOpenTabIds(proj, 'c3', 'c1', 'after')).toEqual(['c1', 'c3', 'c2']);
    // Same tab or unknown ID returns unchanged order
    expect(reorderOpenTabIds(proj, 'c2', 'c2', 'before')).toEqual(['c1', 'c2', 'c3']);
    expect(reorderOpenTabIds(proj, 'missing', 'c1', 'before')).toEqual(['c1', 'c2', 'c3']);
    // Original openTabIds was not mutated
    expect(proj.openTabIds).toEqual(['c1', 'c2', 'c3']);
  });
});
