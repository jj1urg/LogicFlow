import { getGatePins } from './catalog';
import {
  BIT_X,
  BIT_Z,
  dominantState,
  formatValue,
  LogicValue,
  makeUniform,
  toUnsignedInt,
  valuesEqual,
  XCause,
} from './logic4';
import { CircuitDocument, GateInstance, ProjectDocument, SimulationSnapshot, Wire } from './types';

// ============================================================================
// 1. Live Subcircuit Path Resolution (Parent-Driven Real-Time Inspection)
// ============================================================================

export interface LiveSubcircuitCrumb {
  gateId: string;
  instanceLabel: string;
  moduleName: string;
  circuitId: string;
}

export interface ResolvedLiveSubcircuit {
  circuit: CircuitDocument;
  snapshot: SimulationSnapshot | null;
  breadcrumbs: LiveSubcircuitCrumb[];
  isStub: boolean;
}

/**
 * Walk a path of SUBCIRCUIT gate IDs starting from `rootCircuit` and `rootSnapshot`,
 * returning the resolved inner CircuitDocument and its live parent-driven SimulationSnapshot.
 */
export function resolveLiveSubcircuitPath(
  rootCircuit: CircuitDocument,
  project: ProjectDocument,
  rootSnapshot: SimulationSnapshot | null,
  gatePath: string[],
): ResolvedLiveSubcircuit | null {
  if (gatePath.length === 0) return null;

  let curCircuit: CircuitDocument = rootCircuit;
  let curSnapshot: SimulationSnapshot | null = rootSnapshot;
  const breadcrumbs: LiveSubcircuitCrumb[] = [];

  for (const gateId of gatePath) {
    const gate = curCircuit.gates.find((g) => g.id === gateId && g.type === 'SUBCIRCUIT');
    if (!gate || !gate.props.subcircuitId) return null;
    const nextDoc = project.circuits[gate.props.subcircuitId];
    if (!nextDoc) return null;

    const rawLabel = gate.label.trim();
    const instName = rawLabel.includes(':')
      ? rawLabel.split(':')[0].trim() || nextDoc.name
      : rawLabel || nextDoc.name;

    breadcrumbs.push({
      gateId: gate.id,
      instanceLabel: instName,
      moduleName: nextDoc.name,
      circuitId: nextDoc.id,
    });

    curCircuit = nextDoc;
    curSnapshot = curSnapshot?.subSnapshots[gate.id] ?? null;
  }

  return {
    circuit: curCircuit,
    snapshot: curSnapshot,
    breadcrumbs,
    isStub: Boolean(curCircuit.isStub),
  };
}

// ============================================================================
// 2. Signal Watch List & Step-Based Waveform Recording (No #delay Testbench)
// ============================================================================

export type WatchRadix = 'auto' | 'bin' | 'hex' | 'dec' | 'signed';

export interface WatchTarget {
  id: string;
  circuitId: string;
  kind: 'wire' | 'pin';
  wireId?: string;
  gateId?: string;
  pinId?: string;
  label: string;
  radix: WatchRadix;
}

export interface WatchSampleEntry {
  value: LogicValue;
  xCause?: XCause;
}

export interface WaveformStep {
  step: number;
  values: Record<string, WatchSampleEntry>;
}

export const DEFAULT_MAX_WAVEFORM_STEPS = 128;

export function makeWireWatchId(circuitId: string, wireId: string): string {
  return `wire:${circuitId}:${wireId}`;
}

export function makePinWatchId(circuitId: string, gateId: string, pinId: string): string {
  return `pin:${circuitId}:${gateId}:${pinId}`;
}

/** Pick the primary observable pin on a gate (output pin preferred, else input for sinks like MODULE_OUT/LED) */
export function getDefaultWatchPin(
  gate: GateInstance,
  project: ProjectDocument,
): { pinId: string; pinName: string; bitWidth: number } | null {
  const pins = getGatePins(gate, project);
  if (pins.length === 0) return null;
  const outPin = pins.find((p) => p.dir === 'out');
  const chosen = outPin ?? pins[0];
  return { pinId: chosen.id, pinName: chosen.name, bitWidth: chosen.bitWidth };
}

/** Build a clean default human-readable label for a watched wire */
export function buildWireWatchLabel(wire: Wire, circuit: CircuitDocument): string {
  if (wire.netLabel?.trim()) return wire.netLabel.trim();
  if (wire.from) {
    const g = circuit.gates.find((x) => x.id === wire.from!.gateId);
    if (g) {
      const gName = g.label.trim() || g.type;
      return wire.from.pinId === 'out' || wire.from.pinId === 'q'
        ? gName
        : `${gName}.${wire.from.pinId}`;
    }
  }
  if (wire.to) {
    const g = circuit.gates.find((x) => x.id === wire.to!.gateId);
    if (g) {
      const gName = g.label.trim() || g.type;
      return wire.to.pinId === 'in' || wire.to.pinId === 'in0'
        ? gName
        : `${gName}.${wire.to.pinId}`;
    }
  }
  return `wire_${wire.id.slice(-4)}`;
}

/** Build a clean default human-readable label for a watched gate pin */
export function buildPinWatchLabel(gate: GateInstance, pinId: string, pinName?: string): string {
  const base = gate.label.trim() || gate.type;
  if (
    gate.type === 'MODULE_IN' ||
    gate.type === 'MODULE_OUT' ||
    gate.type === 'TOGGLE' ||
    gate.type === 'BUTTON' ||
    gate.type === 'CLOCK' ||
    gate.type === 'LED' ||
    gate.type === 'NUM_DISPLAY' ||
    gate.type === 'D_FF' ||
    gate.type === 'REGISTER' ||
    gate.type === 'COUNTER'
  ) {
    return base;
  }
  return `${base}.${pinName || pinId}`;
}

/** Read current live LogicValue and optional XCause for each watched target on the active circuit */
export function sampleWatchedSignals(
  targets: WatchTarget[],
  circuit: CircuitDocument,
  project: ProjectDocument,
  snapshot: SimulationSnapshot | null,
): Record<string, WatchSampleEntry> {
  const out: Record<string, WatchSampleEntry> = {};
  for (const t of targets) {
    if (t.circuitId !== circuit.id) continue;
    if (t.kind === 'wire' && t.wireId) {
      const val = snapshot?.wireValues[t.wireId] ?? makeUniform(BIT_Z, 1);
      const xCause = dominantState(val) === BIT_X ? snapshot?.wireXCauses?.[t.wireId] : undefined;
      out[t.id] = { value: { width: val.width, bits: val.bits.slice() }, xCause };
    } else if (t.kind === 'pin' && t.gateId && t.pinId) {
      const pk = `${t.gateId}:${t.pinId}`;
      const gate = circuit.gates.find((g) => g.id === t.gateId);
      const pinDef = gate ? getGatePins(gate, project).find((p) => p.id === t.pinId) : undefined;
      const fallbackW = pinDef?.bitWidth ?? 1;
      const val = snapshot?.pinValues[pk] ?? makeUniform(BIT_Z, fallbackW);
      const xCause = dominantState(val) === BIT_X ? snapshot?.pinXCauses?.[pk] : undefined;
      out[t.id] = { value: { width: val.width, bits: val.bits.slice() }, xCause };
    }
  }
  return out;
}

/** True when any watched target on `circuitId` changed value compared to the previous recorded step */
export function hasWatchedSignalsChanged(
  prev: WaveformStep | undefined,
  nextValues: Record<string, WatchSampleEntry>,
  targets: WatchTarget[],
  circuitId: string,
): boolean {
  if (!prev) return true;
  for (const t of targets) {
    if (t.circuitId !== circuitId) continue;
    const a = prev.values[t.id]?.value;
    const b = nextValues[t.id]?.value;
    if (!valuesEqual(a, b)) return true;
  }
  return false;
}

/** Append a sampled step into a bounded waveform ring buffer */
export function appendWaveformStep(
  history: WaveformStep[],
  values: Record<string, WatchSampleEntry>,
  maxSteps = DEFAULT_MAX_WAVEFORM_STEPS,
): WaveformStep[] {
  const nextStep = history.length > 0 ? history[history.length - 1].step + 1 : 0;
  const next = [...history, { step: nextStep, values }];
  if (next.length > maxSteps) {
    return next.slice(next.length - maxSteps);
  }
  return next;
}

/** Format a 4-state LogicValue using the watch panel's chosen radix */
export function formatWatchValue(val: LogicValue | undefined, radix: WatchRadix): string {
  if (!val) return '-';
  if (radix === 'auto') {
    return formatValue(val, val.width > 1 ? 'hex' : 'bin');
  }
  if (radix === 'bin' || radix === 'hex') {
    return formatValue(val, radix);
  }
  if (toUnsignedInt(val) === null) {
    return formatValue(val, 'bin');
  }
  return formatValue(val, radix);
}
