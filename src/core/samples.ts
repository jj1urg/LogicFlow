import { getGatePins, getPinWorldPos, getPinWorldSide, GRID_SIZE } from './catalog';
import { routeWire } from './routing';
import { CircuitDocument, GateInstance, PinRef, ProjectDocument, Wire } from './types';

function connect(
  circuit: CircuitDocument,
  project: ProjectDocument,
  id: string,
  from: PinRef,
  to: PinRef,
  netLabel?: string,
): Wire {
  const gFrom = circuit.gates.find((g) => g.id === from.gateId)!;
  const gTo = circuit.gates.find((g) => g.id === to.gateId)!;
  const pFrom = getGatePins(gFrom, project).find((p) => p.id === from.pinId)!;
  const pTo = getGatePins(gTo, project).find((p) => p.id === to.pinId)!;

  const start = getPinWorldPos(gFrom, pFrom);
  const end = getPinWorldPos(gTo, pTo);
  const points = routeWire(start, end, {
    startSide: getPinWorldSide(pFrom.side, gFrom.rotation),
    endSide: getPinWorldSide(pTo.side, gTo.rotation),
    circuit,
    project,
    routeMode: 'grid',
  });
  const w: Wire = { id, from, to, points, netLabel, routeMode: 'grid' };
  circuit.wires.push(w);
  return w;
}

export function createSampleProject(): ProjectDocument {
  // 1. Subcircuit: FullAdder (built from basic XOR, AND, OR gates!)
  const fullAdder: CircuitDocument = {
    id: 'circ_full_adder',
    name: 'FullAdder',
    description: '基本ゲートで構成した1ビット全加算器モジュール',
    gates: [
      {
        id: 'fa_in_a',
        type: 'MODULE_IN',
        x: 100,
        y: 120,
        rotation: 0,
        label: 'A',
        props: { bitWidth: 1, value: '1', portSide: 'left', portOrder: 0 },
      },
      {
        id: 'fa_in_b',
        type: 'MODULE_IN',
        x: 100,
        y: 200,
        rotation: 0,
        label: 'B',
        props: { bitWidth: 1, value: '1', portSide: 'left', portOrder: 1 },
      },
      {
        id: 'fa_in_cin',
        type: 'MODULE_IN',
        x: 100,
        y: 300,
        rotation: 0,
        label: 'Cin',
        props: { bitWidth: 1, value: '0', portSide: 'left', portOrder: 2 },
      },
      {
        id: 'fa_xor1',
        type: 'XOR',
        x: 260,
        y: 140,
        rotation: 0,
        label: 'XOR1',
        props: { bitWidth: 1, inputCount: 2 },
      },
      {
        id: 'fa_and1',
        type: 'AND',
        x: 260,
        y: 240,
        rotation: 0,
        label: 'AND1',
        props: { bitWidth: 1, inputCount: 2 },
      },
      {
        id: 'fa_xor2',
        type: 'XOR',
        x: 440,
        y: 160,
        rotation: 0,
        label: 'XOR2',
        props: { bitWidth: 1, inputCount: 2 },
      },
      {
        id: 'fa_and2',
        type: 'AND',
        x: 440,
        y: 280,
        rotation: 0,
        label: 'AND2',
        props: { bitWidth: 1, inputCount: 2 },
      },
      {
        id: 'fa_or1',
        type: 'OR',
        x: 600,
        y: 260,
        rotation: 0,
        label: 'OR1',
        props: { bitWidth: 1, inputCount: 2 },
      },
      {
        id: 'fa_out_s',
        type: 'MODULE_OUT',
        x: 740,
        y: 160,
        rotation: 0,
        label: 'S',
        props: { bitWidth: 1, portSide: 'right', portOrder: 0 },
      },
      {
        id: 'fa_out_c',
        type: 'MODULE_OUT',
        x: 740,
        y: 260,
        rotation: 0,
        label: 'Cout',
        props: { bitWidth: 1, portSide: 'right', portOrder: 1 },
      },
    ],
    wires: [],
  };

  // 2. Main Circuit: 2-bit Ripple Adder using Live Peek-Inside FullAdder modules + 7-Seg
  const mainAdder: CircuitDocument = {
    id: 'circ_main',
    name: '2bit_Adder_Live',
    description: 'FullAdderモジュールを中身ライブ表示(Digital風)で接続した2ビット加算器',
    gates: [
      {
        id: 'sw_a0',
        type: 'TOGGLE',
        x: 100,
        y: 120,
        rotation: 0,
        label: 'A0',
        props: { bitWidth: 1, value: '1' },
      },
      {
        id: 'sw_b0',
        type: 'TOGGLE',
        x: 100,
        y: 180,
        rotation: 0,
        label: 'B0',
        props: { bitWidth: 1, value: '1' },
      },
      {
        id: 'sw_cin',
        type: 'TOGGLE',
        x: 100,
        y: 240,
        rotation: 0,
        label: 'Cin',
        props: { bitWidth: 1, value: '0' },
      },
      {
        id: 'sw_a1',
        type: 'TOGGLE',
        x: 100,
        y: 340,
        rotation: 0,
        label: 'A1',
        props: { bitWidth: 1, value: '1' },
      },
      {
        id: 'sw_b1',
        type: 'TOGGLE',
        x: 100,
        y: 400,
        rotation: 0,
        label: 'B1',
        props: { bitWidth: 1, value: '0' },
      },

      {
        id: 'mod_fa0',
        type: 'SUBCIRCUIT',
        x: 340,
        y: 180,
        rotation: 0,
        label: 'FA_Bit0',
        props: { subcircuitId: 'circ_full_adder', displayMode: 'live' },
      },
      {
        id: 'mod_fa1',
        type: 'SUBCIRCUIT',
        x: 340,
        y: 380,
        rotation: 0,
        label: 'FA_Bit1',
        props: { subcircuitId: 'circ_full_adder', displayMode: 'live' },
      },

      {
        id: 'merge_sum',
        type: 'SPLITTER',
        x: 580,
        y: 260,
        rotation: 0,
        label: 'SUM[3:0]',
        props: { bitWidth: 4, splitMode: 'merge', splitWidths: [1, 1, 1, 1] },
      },
      {
        id: 'const_0',
        type: 'CONST',
        x: 500,
        y: 340,
        rotation: 0,
        label: '0',
        props: { bitWidth: 1, value: '0' },
      },

      {
        id: 'led_s0',
        type: 'LED',
        x: 560,
        y: 120,
        rotation: 0,
        label: 'S0',
        props: { bitWidth: 1 },
      },
      {
        id: 'led_s1',
        type: 'LED',
        x: 560,
        y: 420,
        rotation: 0,
        label: 'S1',
        props: { bitWidth: 1 },
      },
      {
        id: 'led_cout',
        type: 'LED',
        x: 560,
        y: 480,
        rotation: 0,
        label: 'Cout',
        props: { bitWidth: 1 },
      },
      {
        id: 'disp_7seg',
        type: 'SEVEN_SEG',
        x: 740,
        y: 240,
        rotation: 0,
        label: 'RESULT',
        props: { bitWidth: 4, segMode: 'hex' },
      },
      {
        id: 'disp_num',
        type: 'NUM_DISPLAY',
        x: 740,
        y: 360,
        rotation: 0,
        label: 'DEC',
        props: { bitWidth: 4, radix: 'dec' },
      },
    ],
    wires: [],
  };

  // 3. 4-State Signal Demo (0 Gray, 1 Green, X Red Contention, Z Blue High-Z) + RAM + Interface Bundle
  const busDemo: CircuitDocument = {
    id: 'circ_4state',
    name: '4State_Bus_RAM',
    description: '0(灰)・1(緑)・X(赤:衝突)・Z(青:ハイインピーダンス) の4値動作とRAMデモ',
    gates: [
      {
        id: 'd_in1',
        type: 'TOGGLE',
        x: 100,
        y: 120,
        rotation: 0,
        label: 'DRV_A',
        props: { bitWidth: 1, value: '1' },
      },
      {
        id: 'd_en1',
        type: 'TOGGLE',
        x: 100,
        y: 180,
        rotation: 0,
        label: 'EN_A',
        props: { bitWidth: 1, value: '1' },
      },
      {
        id: 'd_tri1',
        type: 'TRIBUF',
        x: 260,
        y: 140,
        rotation: 0,
        label: 'TRI_A',
        props: { bitWidth: 1 },
      },

      {
        id: 'd_in2',
        type: 'TOGGLE',
        x: 100,
        y: 260,
        rotation: 0,
        label: 'DRV_B',
        props: { bitWidth: 1, value: '0' },
      },
      {
        id: 'd_en2',
        type: 'TOGGLE',
        x: 100,
        y: 320,
        rotation: 0,
        label: 'EN_B',
        props: { bitWidth: 1, value: '0' },
      },
      {
        id: 'd_tri2',
        type: 'TRIBUF',
        x: 260,
        y: 280,
        rotation: 0,
        label: 'TRI_B',
        props: { bitWidth: 1 },
      },

      {
        id: 'd_bus_led',
        type: 'LED',
        x: 460,
        y: 200,
        rotation: 0,
        label: 'SHARED_BUS',
        props: { bitWidth: 1 },
      },
      {
        id: 'd_z_led',
        type: 'LED',
        x: 460,
        y: 320,
        rotation: 0,
        label: 'FLOAT_Z',
        props: { bitWidth: 1 },
      },

      // Counter + ROM + 7-Seg Demo on the right
      {
        id: 'd_clk',
        type: 'CLOCK',
        x: 100,
        y: 440,
        rotation: 0,
        label: 'CLK',
        props: { bitWidth: 1, clockHigh: false },
      },
      {
        id: 'd_cnt',
        type: 'COUNTER',
        x: 280,
        y: 460,
        rotation: 0,
        label: 'CNT4',
        props: { bitWidth: 4 },
      },
      {
        id: 'd_rom',
        type: 'ROM',
        x: 460,
        y: 460,
        rotation: 0,
        label: 'LUT_ROM',
        props: {
          addrBits: 4,
          dataBits: 4,
          memoryData: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        },
      },
      {
        id: 'd_seg',
        type: 'SEVEN_SEG',
        x: 640,
        y: 460,
        rotation: 0,
        label: 'HEX',
        props: { bitWidth: 4, segMode: 'hex' },
      },
    ],
    wires: [],
  };

  const project: ProjectDocument = {
    version: 1,
    name: 'LogicFlow Starter Project',
    activeCircuitId: 'circ_main',
    openTabIds: ['circ_main', 'circ_4state'],
    circuits: {
      [mainAdder.id]: mainAdder,
      [fullAdder.id]: fullAdder,
      [busDemo.id]: busDemo,
    },
    settings: {
      gridSize: GRID_SIZE,
      routeMode: 'grid',
      simMode: 'realtime',
      clockHz: 2,
      clockRunning: false,
      globalSubcircuitDisplay: 'instance',
      showNetLabels: true,
      showPinNames: true,
    },
  };

  // Wire up FullAdder
  connect(
    fullAdder,
    project,
    'w_fa1',
    { gateId: 'fa_in_a', pinId: 'out' },
    { gateId: 'fa_xor1', pinId: 'in0' },
    'A',
  );
  connect(
    fullAdder,
    project,
    'w_fa2',
    { gateId: 'fa_in_b', pinId: 'out' },
    { gateId: 'fa_xor1', pinId: 'in1' },
    'B',
  );
  connect(
    fullAdder,
    project,
    'w_fa3',
    { gateId: 'fa_in_a', pinId: 'out' },
    { gateId: 'fa_and1', pinId: 'in0' },
  );
  connect(
    fullAdder,
    project,
    'w_fa4',
    { gateId: 'fa_in_b', pinId: 'out' },
    { gateId: 'fa_and1', pinId: 'in1' },
  );
  connect(
    fullAdder,
    project,
    'w_fa5',
    { gateId: 'fa_xor1', pinId: 'out' },
    { gateId: 'fa_xor2', pinId: 'in0' },
  );
  connect(
    fullAdder,
    project,
    'w_fa6',
    { gateId: 'fa_in_cin', pinId: 'out' },
    { gateId: 'fa_xor2', pinId: 'in1' },
    'Cin',
  );
  connect(
    fullAdder,
    project,
    'w_fa7',
    { gateId: 'fa_xor1', pinId: 'out' },
    { gateId: 'fa_and2', pinId: 'in0' },
  );
  connect(
    fullAdder,
    project,
    'w_fa8',
    { gateId: 'fa_in_cin', pinId: 'out' },
    { gateId: 'fa_and2', pinId: 'in1' },
  );
  connect(
    fullAdder,
    project,
    'w_fa9',
    { gateId: 'fa_and1', pinId: 'out' },
    { gateId: 'fa_or1', pinId: 'in0' },
  );
  connect(
    fullAdder,
    project,
    'w_fa10',
    { gateId: 'fa_and2', pinId: 'out' },
    { gateId: 'fa_or1', pinId: 'in1' },
  );
  connect(
    fullAdder,
    project,
    'w_fa11',
    { gateId: 'fa_xor2', pinId: 'out' },
    { gateId: 'fa_out_s', pinId: 'in' },
    'S',
  );
  connect(
    fullAdder,
    project,
    'w_fa12',
    { gateId: 'fa_or1', pinId: 'out' },
    { gateId: 'fa_out_c', pinId: 'in' },
    'Cout',
  );

  // Wire up Main 2-bit Adder
  connect(
    mainAdder,
    project,
    'w_m1',
    { gateId: 'sw_a0', pinId: 'out' },
    { gateId: 'mod_fa0', pinId: 'fa_in_a' },
  );
  connect(
    mainAdder,
    project,
    'w_m2',
    { gateId: 'sw_b0', pinId: 'out' },
    { gateId: 'mod_fa0', pinId: 'fa_in_b' },
  );
  connect(
    mainAdder,
    project,
    'w_m3',
    { gateId: 'sw_cin', pinId: 'out' },
    { gateId: 'mod_fa0', pinId: 'fa_in_cin' },
  );
  connect(
    mainAdder,
    project,
    'w_m4',
    { gateId: 'sw_a1', pinId: 'out' },
    { gateId: 'mod_fa1', pinId: 'fa_in_a' },
  );
  connect(
    mainAdder,
    project,
    'w_m5',
    { gateId: 'sw_b1', pinId: 'out' },
    { gateId: 'mod_fa1', pinId: 'fa_in_b' },
  );
  connect(
    mainAdder,
    project,
    'w_m6',
    { gateId: 'mod_fa0', pinId: 'fa_out_c' },
    { gateId: 'mod_fa1', pinId: 'fa_in_cin' },
    'C1',
  );

  connect(
    mainAdder,
    project,
    'w_m7',
    { gateId: 'mod_fa0', pinId: 'fa_out_s' },
    { gateId: 'led_s0', pinId: 'in' },
  );
  connect(
    mainAdder,
    project,
    'w_m8',
    { gateId: 'mod_fa0', pinId: 'fa_out_s' },
    { gateId: 'merge_sum', pinId: 'b0' },
  );
  connect(
    mainAdder,
    project,
    'w_m9',
    { gateId: 'mod_fa1', pinId: 'fa_out_s' },
    { gateId: 'merge_sum', pinId: 'b1' },
  );
  connect(
    mainAdder,
    project,
    'w_m10',
    { gateId: 'mod_fa1', pinId: 'fa_out_c' },
    { gateId: 'merge_sum', pinId: 'b2' },
  );
  connect(
    mainAdder,
    project,
    'w_m11',
    { gateId: 'const_0', pinId: 'out' },
    { gateId: 'merge_sum', pinId: 'b3' },
  );
  connect(
    mainAdder,
    project,
    'w_m12',
    { gateId: 'mod_fa1', pinId: 'fa_out_s' },
    { gateId: 'led_s1', pinId: 'in' },
  );
  connect(
    mainAdder,
    project,
    'w_m13',
    { gateId: 'mod_fa1', pinId: 'fa_out_c' },
    { gateId: 'led_cout', pinId: 'in' },
  );
  connect(
    mainAdder,
    project,
    'w_m14',
    { gateId: 'merge_sum', pinId: 'bus' },
    { gateId: 'disp_7seg', pinId: 'in' },
    'SUM',
  );
  connect(
    mainAdder,
    project,
    'w_m15',
    { gateId: 'merge_sum', pinId: 'bus' },
    { gateId: 'disp_num', pinId: 'in' },
  );

  // Wire up 4-State Demo
  connect(
    busDemo,
    project,
    'w_d1',
    { gateId: 'd_in1', pinId: 'out' },
    { gateId: 'd_tri1', pinId: 'in0' },
  );
  connect(
    busDemo,
    project,
    'w_d2',
    { gateId: 'd_en1', pinId: 'out' },
    { gateId: 'd_tri1', pinId: 'en' },
  );
  connect(
    busDemo,
    project,
    'w_d3',
    { gateId: 'd_in2', pinId: 'out' },
    { gateId: 'd_tri2', pinId: 'in0' },
  );
  connect(
    busDemo,
    project,
    'w_d4',
    { gateId: 'd_en2', pinId: 'out' },
    { gateId: 'd_tri2', pinId: 'en' },
  );
  connect(
    busDemo,
    project,
    'w_d5',
    { gateId: 'd_tri1', pinId: 'out' },
    { gateId: 'd_bus_led', pinId: 'in' },
    'BUS',
  );
  connect(
    busDemo,
    project,
    'w_d6',
    { gateId: 'd_tri2', pinId: 'out' },
    { gateId: 'd_bus_led', pinId: 'in' },
  );
  connect(
    busDemo,
    project,
    'w_d7',
    { gateId: 'd_clk', pinId: 'out' },
    { gateId: 'd_cnt', pinId: 'clk' },
    'CLK',
  );
  connect(
    busDemo,
    project,
    'w_d8',
    { gateId: 'd_cnt', pinId: 'q' },
    { gateId: 'd_rom', pinId: 'addr' },
    'ADDR',
  );
  connect(
    busDemo,
    project,
    'w_d9',
    { gateId: 'd_rom', pinId: 'dout' },
    { gateId: 'd_seg', pinId: 'in' },
    'DATA',
  );

  return project;
}

export function createBlankCircuit(id: string, name: string): CircuitDocument {
  return {
    id,
    name,
    gates: [],
    wires: [],
  };
}

export const SAMPLE_VERILOG_SNIPPET = `// Example Verilog / SystemVerilog with an external undefined module!
module half_adder (
  input  logic a,
  input  logic b,
  output logic s,
  output logic c
);
  assign s = a ^ b;
  assign c = a & b;
endmodule

module top_system (
  input  logic a,
  input  logic b,
  input  logic sel,
  output logic y,
  output logic carry,
  output logic ext_out
);
  logic sum_w;
  half_adder u_ha (
    .a(a),
    .b(b),
    .s(sum_w),
    .c(carry)
  );
  assign y = sel ? sum_w : carry;

  // External module (not defined in this file -> auto-created as a Stub module!)
  external_uart_tx u_uart (
    .tx_data(sum_w),
    .tx_en(sel),
    .tx_out(ext_out)
  );
endmodule
`;
