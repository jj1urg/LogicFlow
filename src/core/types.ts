import { LogicValue, XCause } from './logic4';

export type PinSide = 'left' | 'right' | 'top' | 'bottom';
export type PinDir = 'in' | 'out' | 'inout';
export type Rotation = 0 | 90 | 180 | 270;
export type RouteMode = 'grid' | 'free';
export type SimMode = 'realtime' | 'manual';
export type InputMode = 'auto' | 'trackpad' | 'mouse';
export type SubcircuitDisplayMode = 'box' | 'preview' | 'live';

export type GateCategory =
  | 'io'
  | 'gates'
  | 'combinational'
  | 'sequential'
  | 'memory'
  | 'wiring'
  | 'modules';

export type GateType =
  // I/O & Probes
  | 'MODULE_IN'
  | 'MODULE_OUT'
  | 'TOGGLE'
  | 'BUTTON'
  | 'CLOCK'
  | 'CONST'
  | 'LED'
  | 'SEVEN_SEG'
  | 'NUM_DISPLAY'
  // Wiring & Buses
  | 'TUNNEL'
  | 'SPLITTER'
  | 'IFACE_BUNDLE'
  // Basic Logic Gates
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'NAND'
  | 'NOR'
  | 'XOR'
  | 'XNOR'
  | 'BUF'
  | 'TRIBUF'
  // Combinational
  | 'MUX'
  | 'DEMUX'
  | 'DECODER'
  | 'HALF_ADDER'
  | 'FULL_ADDER'
  | 'ADDER'
  | 'COMPARATOR'
  // Sequential
  | 'SR_LATCH'
  | 'D_LATCH'
  | 'D_FF'
  | 'JK_FF'
  | 'T_FF'
  | 'REGISTER'
  | 'COUNTER'
  // Memory
  | 'RAM'
  | 'ROM'
  // Custom Module
  | 'SUBCIRCUIT';

export interface Point {
  x: number;
  y: number;
}

export interface PinDef {
  id: string;
  name: string;
  dir: PinDir;
  side: PinSide;
  /** Local offset relative to gate center (before rotation) */
  x: number;
  y: number;
  bitWidth: number;
}

export interface PinRef {
  gateId: string;
  pinId: string;
}

export interface InterfaceField {
  name: string;
  bitWidth: number;
}

export interface GateProps {
  bitWidth?: number;
  inputCount?: number;
  selectBits?: number;
  /** Toggle / Const value string (e.g. "1", "0", "0xA", "X", "Z") */
  value?: string;
  /** Button currently pressed */
  pressed?: boolean;
  /** Display radix for NUM_DISPLAY */
  radix?: 'hex' | 'dec' | 'signed' | 'bin';
  /** SEVEN_SEG mode: 'hex' (4-bit decoder) or 'direct' (7-bit segments) */
  segMode?: 'hex' | 'direct';
  /** Net name for TUNNEL */
  netName?: string;
  /** Splitter mode: 'split' (1->N) or 'merge' (N->1) */
  splitMode?: 'split' | 'merge';
  /** Splitter fanout bit widths, e.g. [1,1,1,1] */
  splitWidths?: number[];
  /** Interface bundle mode: 'pack' or 'unpack' */
  bundleMode?: 'pack' | 'unpack';
  /** Interface bundle fields (SystemVerilog interface-like named bus) */
  interfaceName?: string;
  interfaceFields?: InterfaceField[];
  /** Module port side when this circuit is used as a subcircuit */
  portSide?: PinSide;
  portOrder?: number;
  /** Memory configuration (RAM/ROM) */
  addrBits?: number;
  dataBits?: number;
  /** Initial / current memory contents as hex strings indexed by address */
  memoryData?: number[];
  /** Subcircuit reference */
  subcircuitId?: string;
  displayMode?: SubcircuitDisplayMode;
  /** Clock phase / enabled */
  clockHigh?: boolean;
  /** Whether multi-bit ADDER exposes a Carry-In (Cin) pin (defaults to true when omitted for backward compatibility) */
  hasCarryIn?: boolean;
}

export interface GateInstance {
  id: string;
  type: GateType;
  x: number;
  y: number;
  rotation: Rotation;
  label: string;
  props: GateProps;
}

export interface Wire {
  id: string;
  from?: PinRef;
  to?: PinRef;
  points: Point[];
  netLabel?: string;
  routeMode: RouteMode;
}

export interface ModuleSymbolPin {
  portGateId: string;
  name: string;
  dir: 'in' | 'out';
  side: PinSide;
  order: number;
  bitWidth: number;
}

export interface ModuleSymbolConfig {
  width: number;
  height: number;
  pins: ModuleSymbolPin[];
}

export interface StubPort {
  name: string;
  dir: 'in' | 'out';
  bitWidth: number;
}

export interface HdlProjectFile {
  name: string;
  content: string;
}

export interface HdlProjectBundle {
  id: string;
  name: string;
  /** All source files bundled together as one unified HDL source project */
  files: HdlProjectFile[];
  /** Designated top module name */
  topModuleName: string;
  /** CircuitDocument ID of the designated top module */
  topCircuitId: string;
  /** CircuitDocument IDs of all defined modules in this HDL project */
  moduleCircuitIds: string[];
  /** CircuitDocument IDs of external stub boxes generated for this HDL project */
  stubCircuitIds: string[];
}

export interface CircuitDocument {
  id: string;
  name: string;
  description?: string;
  gates: GateInstance[];
  wires: Wire[];
  symbolConfig?: ModuleSymbolConfig;
  /** True for external modules imported from Verilog/SV without implementation */
  isStub?: boolean;
  stubPorts?: StubPort[];
  /** Original Verilog / SystemVerilog source snippet for this module (when imported from HDL) */
  hdlSource?: string;
  /** Full original HDL file text when imported alongside other modules/directives */
  hdlFileSource?: string;
  /** Original filename from which this HDL module was imported (e.g. "alu.sv") */
  hdlFileName?: string;
  /** ID of the parent HdlProjectBundle when imported as part of an HDL source project */
  hdlProjectId?: string;
  /** True when the schematic side was manually edited after importing/synthesizing from HDL */
  hdlDiverged?: boolean;
}

export interface ProjectSettings {
  gridSize: number;
  routeMode: RouteMode;
  simMode: SimMode;
  inputMode?: InputMode;
  clockHz: number;
  clockRunning: boolean;
  globalSubcircuitDisplay: 'instance' | SubcircuitDisplayMode;
  showNetLabels: boolean;
  showPinNames: boolean;
}

export interface ProjectDocument {
  version: 1;
  name: string;
  activeCircuitId: string;
  /** Circuit IDs currently open as tabs in the top bar (submodules/stubs stay hidden until user opens them) */
  openTabIds?: string[];
  /** Unified HDL source project bundles (multi-file / multi-module imports with designated top module) */
  hdlProjects?: Record<string, HdlProjectBundle>;
  circuits: Record<string, CircuitDocument>;
  settings: ProjectSettings;
}

/** Mutable sequential state persisted across simulation ticks per circuit instance */
export interface SequentialState {
  /** Stored values per gateId (FF Q, Register, Counter, Latch) */
  registers: Record<string, LogicValue>;
  /** Previous clock bit per gateId for rising-edge detection */
  prevClock: Record<string, number>;
  /** Runtime RAM contents per gateId */
  ramData: Record<string, number[]>;
  /** Nested sequential state per subcircuit gateId */
  subStates: Record<string, SequentialState>;
  /** Persisted settled net values keyed by stable driver-pin signature so gate-level latches hold state */
  prevNetValues?: Record<string, LogicValue>;
  /** One-shot flag set on manual reset to initialize bistable propagated-X feedback loops */
  resetUnknownLoops?: boolean;
}

/** Computed real-time signal snapshot for rendering */
export interface SimulationSnapshot {
  /** Value per pin key `${gateId}:${pinId}` */
  pinValues: Record<string, LogicValue>;
  /** Value per wireId */
  wireValues: Record<string, LogicValue>;
  /** Value per named net / tunnel */
  netValues: Record<string, LogicValue>;
  /** Optional root cause for pins currently holding X (conflict / oscillation / stub / unknown) */
  pinXCauses?: Record<string, XCause>;
  /** Optional root cause for wires currently holding X (conflict / oscillation / stub / unknown) */
  wireXCauses?: Record<string, XCause>;
  /** Stored internal value for display (registers, counters, latches) */
  gateInternalValues: Record<string, LogicValue>;
  /** Runtime RAM readout */
  ramData: Record<string, number[]>;
  /** Nested snapshots per subcircuit gateId (for live peek-inside rendering!) */
  subSnapshots: Record<string, SimulationSnapshot>;
  /** Number of delta cycles taken to settle (and whether oscillation occurred) */
  iterations: number;
  oscillating: boolean;
}
