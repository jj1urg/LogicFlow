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
  resolveLiveSubcircuitPath,
  sampleWatchedSignals,
  WatchTarget,
  WaveformStep,
} from '../src/core/debug';
import { importVerilogToCircuits } from '../src/core/hdl';
import { BIT_0, BIT_1, BIT_X, BIT_Z, fromInt, fromLiteral } from '../src/core/logic4';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import { CircuitDocument, ProjectDocument } from '../src/core/types';

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
});
