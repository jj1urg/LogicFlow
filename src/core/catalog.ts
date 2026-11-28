import {
  CircuitDocument,
  GateCategory,
  GateInstance,
  GateProps,
  GateType,
  PinDef,
  PinSide,
  Point,
  ProjectDocument,
} from './types';

export const GRID_SIZE = 20;

export interface GateCatalogEntry {
  type: GateType;
  name: string;
  shortName: string;
  category: GateCategory;
  description: string;
  defaultWidth: number;
  defaultHeight: number;
  defaultProps: GateProps;
}

export const CATEGORY_LABELS: Record<GateCategory, string> = {
  io: '入出力 / I/O',
  gates: '基本論理ゲート',
  combinational: '組み合わせ回路',
  sequential: '順序回路 (FF / Latch)',
  memory: 'メモリ (RAM / ROM)',
  wiring: '配線 / バス / Interface',
  modules: 'モジュール',
};

export const GATE_CATALOG: Record<GateType, GateCatalogEntry> = {
  // I/O
  MODULE_IN: {
    type: 'MODULE_IN',
    name: 'モジュール入力 (Input)',
    shortName: 'IN',
    category: 'io',
    description: 'モジュール外部からの入力端子（単独実行時はトグル可能）',
    defaultWidth: 64,
    defaultHeight: 36,
    defaultProps: { bitWidth: 1, value: '0', portSide: 'left', portOrder: 0 },
  },
  MODULE_OUT: {
    type: 'MODULE_OUT',
    name: 'モジュール出力 (Output)',
    shortName: 'OUT',
    category: 'io',
    description: 'モジュール外部への出力端子',
    defaultWidth: 64,
    defaultHeight: 36,
    defaultProps: { bitWidth: 1, portSide: 'right', portOrder: 0 },
  },
  TOGGLE: {
    type: 'TOGGLE',
    name: 'スイッチ / レバー (Toggle)',
    shortName: 'SW',
    category: 'io',
    description: 'クリックで 0/1 (または多ビット値) を切り替える入力スイッチ',
    defaultWidth: 56,
    defaultHeight: 40,
    defaultProps: { bitWidth: 1, value: '0' },
  },
  BUTTON: {
    type: 'BUTTON',
    name: 'プッシュボタン (Button)',
    shortName: 'BTN',
    category: 'io',
    description: '押している間だけ 1 を出力するモーメンタリボタン',
    defaultWidth: 48,
    defaultHeight: 44,
    defaultProps: { bitWidth: 1, pressed: false },
  },
  CLOCK: {
    type: 'CLOCK',
    name: 'クロック (Clock)',
    shortName: 'CLK',
    category: 'io',
    description: '周期的に 0/1 を切り替えるクロック発振器（クリックで手動反転可）',
    defaultWidth: 56,
    defaultHeight: 40,
    defaultProps: { bitWidth: 1, clockHigh: false },
  },
  CONST: {
    type: 'CONST',
    name: '定数 (Constant 0/1/X/Z)',
    shortName: 'CONST',
    category: 'io',
    description: '固定値 (0, 1, X, Z, 16進数) を出力',
    defaultWidth: 56,
    defaultHeight: 34,
    defaultProps: { bitWidth: 1, value: '1' },
  },
  LED: {
    type: 'LED',
    name: 'LED ランプ',
    shortName: 'LED',
    category: 'io',
    description: '4値信号 (0:灰, 1:緑, X:赤, Z:青) をリアルタイム表示',
    defaultWidth: 44,
    defaultHeight: 44,
    defaultProps: { bitWidth: 1 },
  },
  SEVEN_SEG: {
    type: 'SEVEN_SEG',
    name: '7セグメント表示器',
    shortName: '7SEG',
    category: 'io',
    description: '1〜4桁(4〜16bit)HEXデコードまたは7bit直接入力対応の7セグディスプレイ',
    defaultWidth: 68,
    defaultHeight: 96,
    defaultProps: { bitWidth: 4, segMode: 'hex', segDigits: 1 },
  },
  NUM_DISPLAY: {
    type: 'NUM_DISPLAY',
    name: '数値表示器 (Probe)',
    shortName: 'HEX',
    category: 'io',
    description: 'マルチビット配線の値を HEX / DEC / BIN でリアルタイム表示',
    defaultWidth: 84,
    defaultHeight: 44,
    defaultProps: { bitWidth: 4, radix: 'hex' },
  },

  // Wiring & Buses
  TUNNEL: {
    type: 'TUNNEL',
    name: 'ネットラベル / トンネル',
    shortName: 'NET',
    category: 'wiring',
    description: '同じ名前のトンネル同士をワイヤレス接続',
    defaultWidth: 64,
    defaultHeight: 28,
    defaultProps: { bitWidth: 1, netName: 'NET_A' },
  },
  SPLITTER: {
    type: 'SPLITTER',
    name: 'スプリッタ / マージャ',
    shortName: 'SPLIT',
    category: 'wiring',
    description: 'マルチビットバスを個別ビットに分割・結合',
    defaultWidth: 44,
    defaultHeight: 88,
    defaultProps: { bitWidth: 4, splitMode: 'split', splitWidths: [1, 1, 1, 1] },
  },
  IFACE_BUNDLE: {
    type: 'IFACE_BUNDLE',
    name: 'Interface バンドル (SV風)',
    shortName: 'IFACE',
    category: 'wiring',
    description: '意味のある名前付き信号群を1本のインターフェースバスに束ねる/展開する',
    defaultWidth: 96,
    defaultHeight: 96,
    defaultProps: {
      bundleMode: 'pack',
      interfaceName: 'bus_if',
      interfaceFields: [
        { name: 'valid', bitWidth: 1 },
        { name: 'ready', bitWidth: 1 },
        { name: 'data', bitWidth: 4 },
      ],
    },
  },

  // Basic Logic Gates
  AND: {
    type: 'AND',
    name: 'AND ゲート',
    shortName: 'AND',
    category: 'gates',
    description: '論理積 (4値対応・多入力/多ビット対応)',
    defaultWidth: 68,
    defaultHeight: 52,
    defaultProps: { bitWidth: 1, inputCount: 2 },
  },
  OR: {
    type: 'OR',
    name: 'OR ゲート',
    shortName: 'OR',
    category: 'gates',
    description: '論理和 (4値対応・多入力/多ビット対応)',
    defaultWidth: 68,
    defaultHeight: 52,
    defaultProps: { bitWidth: 1, inputCount: 2 },
  },
  NOT: {
    type: 'NOT',
    name: 'NOT ゲート (インバータ)',
    shortName: 'NOT',
    category: 'gates',
    description: '論理否定',
    defaultWidth: 56,
    defaultHeight: 40,
    defaultProps: { bitWidth: 1 },
  },
  NAND: {
    type: 'NAND',
    name: 'NAND ゲート',
    shortName: 'NAND',
    category: 'gates',
    description: '否定論理積',
    defaultWidth: 72,
    defaultHeight: 52,
    defaultProps: { bitWidth: 1, inputCount: 2 },
  },
  NOR: {
    type: 'NOR',
    name: 'NOR ゲート',
    shortName: 'NOR',
    category: 'gates',
    description: '否定論理和',
    defaultWidth: 72,
    defaultHeight: 52,
    defaultProps: { bitWidth: 1, inputCount: 2 },
  },
  XOR: {
    type: 'XOR',
    name: 'XOR ゲート',
    shortName: 'XOR',
    category: 'gates',
    description: '排他的論理和',
    defaultWidth: 72,
    defaultHeight: 52,
    defaultProps: { bitWidth: 1, inputCount: 2 },
  },
  XNOR: {
    type: 'XNOR',
    name: 'XNOR ゲート',
    shortName: 'XNOR',
    category: 'gates',
    description: '排他的否定論理和',
    defaultWidth: 76,
    defaultHeight: 52,
    defaultProps: { bitWidth: 1, inputCount: 2 },
  },
  BUF: {
    type: 'BUF',
    name: 'バッファ (Buffer)',
    shortName: 'BUF',
    category: 'gates',
    description: '信号バッファ',
    defaultWidth: 52,
    defaultHeight: 40,
    defaultProps: { bitWidth: 1 },
  },
  TRIBUF: {
    type: 'TRIBUF',
    name: 'トライステートバッファ',
    shortName: 'TRI',
    category: 'gates',
    description: 'EN=0 のときハイインピーダンス (Z) を出力',
    defaultWidth: 60,
    defaultHeight: 48,
    defaultProps: { bitWidth: 1 },
  },

  // Combinational
  MUX: {
    type: 'MUX',
    name: 'マルチプレクサ (MUX)',
    shortName: 'MUX',
    category: 'combinational',
    description: '選択信号 S により入力を選択するマルチプレクサ',
    defaultWidth: 56,
    defaultHeight: 76,
    defaultProps: { bitWidth: 1, selectBits: 1 },
  },
  DEMUX: {
    type: 'DEMUX',
    name: 'デマルチプレクサ (DEMUX)',
    shortName: 'DEMUX',
    category: 'combinational',
    description: '1入力を選択信号 S の出力先へ振り分け',
    defaultWidth: 56,
    defaultHeight: 76,
    defaultProps: { bitWidth: 1, selectBits: 1 },
  },
  DECODER: {
    type: 'DECODER',
    name: 'デコーダ (Decoder)',
    shortName: 'DEC',
    category: 'combinational',
    description: '2-to-4 / 3-to-8 バイナリデコーダ',
    defaultWidth: 64,
    defaultHeight: 96,
    defaultProps: { selectBits: 2 },
  },
  HALF_ADDER: {
    type: 'HALF_ADDER',
    name: '半加算器 (Half Adder)',
    shortName: 'HA',
    category: 'combinational',
    description: 'A + B → S (和), C (桁上がり)',
    defaultWidth: 72,
    defaultHeight: 64,
    defaultProps: { bitWidth: 1 },
  },
  FULL_ADDER: {
    type: 'FULL_ADDER',
    name: '全加算器 (Full Adder)',
    shortName: 'FA',
    category: 'combinational',
    description: 'A + B + Cin → S (和), Cout (桁上がり)',
    defaultWidth: 76,
    defaultHeight: 80,
    defaultProps: { bitWidth: 1 },
  },
  ADDER: {
    type: 'ADDER',
    name: 'Nビット加算器 (Adder)',
    shortName: 'ADD',
    category: 'combinational',
    description: 'マルチビット加算器 (A + B + Cin → S, Cout)',
    defaultWidth: 80,
    defaultHeight: 80,
    defaultProps: { bitWidth: 4 },
  },
  COMPARATOR: {
    type: 'COMPARATOR',
    name: '比較器 (Comparator)',
    shortName: 'CMP',
    category: 'combinational',
    description: 'A と B を比較し LT (<), EQ (=), GT (>) を出力',
    defaultWidth: 80,
    defaultHeight: 80,
    defaultProps: { bitWidth: 4 },
  },

  // Sequential
  SR_LATCH: {
    type: 'SR_LATCH',
    name: 'SR ラッチ',
    shortName: 'SR',
    category: 'sequential',
    description: 'セット/リセット非同期ラッチ',
    defaultWidth: 72,
    defaultHeight: 68,
    defaultProps: { bitWidth: 1 },
  },
  D_LATCH: {
    type: 'D_LATCH',
    name: 'D ラッチ (レベルトリガ)',
    shortName: 'DLAT',
    category: 'sequential',
    description: 'EN=1 の間 D を透過するレベルトリガラッチ',
    defaultWidth: 76,
    defaultHeight: 68,
    defaultProps: { bitWidth: 1 },
  },
  D_FF: {
    type: 'D_FF',
    name: 'D フリップフロップ (エッジ)',
    shortName: 'DFF',
    category: 'sequential',
    description: 'CLK 立ち上がりエッジで D を記憶 (EN, RST 付き)',
    defaultWidth: 80,
    defaultHeight: 88,
    defaultProps: { bitWidth: 1 },
  },
  JK_FF: {
    type: 'JK_FF',
    name: 'JK フリップフロップ',
    shortName: 'JKFF',
    category: 'sequential',
    description: 'CLK 立ち上がりエッジ動作の JK-FF',
    defaultWidth: 80,
    defaultHeight: 88,
    defaultProps: { bitWidth: 1 },
  },
  T_FF: {
    type: 'T_FF',
    name: 'T フリップフロップ',
    shortName: 'TFF',
    category: 'sequential',
    description: 'T=1 のとき CLK 立ち上がりで出力反転',
    defaultWidth: 80,
    defaultHeight: 80,
    defaultProps: { bitWidth: 1 },
  },
  REGISTER: {
    type: 'REGISTER',
    name: 'レジスタ (Register)',
    shortName: 'REG',
    category: 'sequential',
    description: 'Nビット同期レジスタ (D, CLK, EN, CLR → Q)',
    defaultWidth: 88,
    defaultHeight: 96,
    defaultProps: { bitWidth: 4 },
  },
  COUNTER: {
    type: 'COUNTER',
    name: 'カウンタ (Counter)',
    shortName: 'CNT',
    category: 'sequential',
    description: 'Nビット同期カウンタ (CLK, EN, CLR → Q, OVF)',
    defaultWidth: 88,
    defaultHeight: 96,
    defaultProps: { bitWidth: 4 },
  },

  // Memory
  RAM: {
    type: 'RAM',
    name: 'RAM (読み書きメモリ)',
    shortName: 'RAM',
    category: 'memory',
    description: 'アドレス・データ幅可変の同期書込/非同期読出 RAM',
    defaultWidth: 108,
    defaultHeight: 112,
    defaultProps: { addrBits: 4, dataBits: 4, memoryData: new Array(16).fill(0) },
  },
  ROM: {
    type: 'ROM',
    name: 'ROM (読出専用メモリ)',
    shortName: 'ROM',
    category: 'memory',
    description: 'アドレス・データ幅可変のルックアップテーブル ROM',
    defaultWidth: 100,
    defaultHeight: 88,
    defaultProps: {
      addrBits: 4,
      dataBits: 4,
      memoryData: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    },
  },

  // Custom Module
  SUBCIRCUIT: {
    type: 'SUBCIRCUIT',
    name: 'カスタムモジュール',
    shortName: 'MOD',
    category: 'modules',
    description: '別タブや外部ファイルの回路をモジュールとして配置',
    defaultWidth: 140,
    defaultHeight: 100,
    defaultProps: { displayMode: 'live' },
  },
};

export function snapToGrid(v: number, gridSize = GRID_SIZE): number {
  return Math.round(v / gridSize) * gridSize;
}

/** Snap pin positions nicely onto GRID_SIZE steps relative to center */
function distributePinOffsets(count: number, step = GRID_SIZE): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const span = (count - 1) * step;
  const start = -span / 2;
  // Ensure grid alignment when count is even by snapping to half-grid or grid
  return Array.from({ length: count }, (_, i) => Math.round((start + i * step) / 10) * 10);
}

export function getInterfaceTotalWidth(props: GateProps): number {
  const fields = props.interfaceFields ?? [];
  return Math.max(
    1,
    fields.reduce((acc, f) => acc + Math.max(1, f.bitWidth), 0),
  );
}

export function getMuxConfig(p: GateProps): { channels: number; selectBits: number } {
  if (p.inputCount !== undefined) {
    const channels = Math.max(2, Math.min(16, p.inputCount));
    const selectBits = Math.max(1, Math.ceil(Math.log2(channels)));
    return { channels, selectBits };
  }
  const selectBits = Math.max(1, Math.min(4, p.selectBits ?? 1));
  return { channels: 1 << selectBits, selectBits };
}

export function getSevenSegConfig(p: GateProps): {
  mode: 'hex' | 'direct';
  digits: number;
  bitWidth: number;
} {
  if (p.segMode === 'direct') {
    return { mode: 'direct', digits: 1, bitWidth: 7 };
  }
  const digits = Math.max(1, Math.min(4, Math.round(p.segDigits ?? 1)));
  return { mode: 'hex', digits, bitWidth: digits * 4 };
}

export function getGateSize(
  gate: GateInstance,
  project?: ProjectDocument,
): { width: number; height: number } {
  const entry = GATE_CATALOG[gate.type];
  const p = gate.props;

  if (
    gate.type === 'AND' ||
    gate.type === 'OR' ||
    gate.type === 'NAND' ||
    gate.type === 'NOR' ||
    gate.type === 'XOR' ||
    gate.type === 'XNOR'
  ) {
    const n = Math.max(2, Math.min(8, p.inputCount ?? 2));
    return { width: entry.defaultWidth, height: Math.max(52, n * GRID_SIZE + 12) };
  }
  if (gate.type === 'MUX' || gate.type === 'DEMUX') {
    const { channels } = getMuxConfig(p);
    return { width: 64, height: Math.max(76, channels * GRID_SIZE + 28) };
  }
  if (gate.type === 'DECODER') {
    const sel = Math.max(1, Math.min(3, p.selectBits ?? 2));
    const outs = 1 << sel;
    return { width: 68, height: Math.max(88, outs * GRID_SIZE + 20) };
  }
  if (gate.type === 'SPLITTER') {
    const widths = p.splitWidths ?? [1, 1, 1, 1];
    return { width: 48, height: Math.max(60, widths.length * GRID_SIZE + 16) };
  }
  if (gate.type === 'IFACE_BUNDLE') {
    const fields = p.interfaceFields ?? [];
    return { width: 108, height: Math.max(72, fields.length * GRID_SIZE + 28) };
  }
  if (gate.type === 'SEVEN_SEG') {
    const { digits } = getSevenSegConfig(p);
    return {
      width: digits === 1 ? entry.defaultWidth : digits * 50 + 20,
      height: entry.defaultHeight,
    };
  }
  if (gate.type === 'SUBCIRCUIT') {
    const sub = p.subcircuitId && project ? project.circuits[p.subcircuitId] : undefined;
    if (sub?.symbolConfig) {
      return { width: sub.symbolConfig.width, height: sub.symbolConfig.height };
    }
    const ports = getSubcircuitPins(sub);
    const leftCount = ports.filter((pt) => pt.side === 'left').length;
    const rightCount = ports.filter((pt) => pt.side === 'right').length;
    const topCount = ports.filter((pt) => pt.side === 'top').length;
    const bottomCount = ports.filter((pt) => pt.side === 'bottom').length;
    const maxV = Math.max(leftCount, rightCount, 2);
    const maxH = Math.max(topCount, bottomCount, 2);
    const displayMode = p.displayMode ?? 'live';
    const minW = displayMode === 'box' ? 120 : 180;
    const minH = displayMode === 'box' ? 80 : 120;
    return {
      width: Math.max(minW, snapToGrid(maxH * 40 + 40, GRID_SIZE)),
      height: Math.max(minH, snapToGrid(maxV * GRID_SIZE + 40, GRID_SIZE)),
    };
  }
  return { width: entry.defaultWidth, height: entry.defaultHeight };
}

function getSubcircuitPins(sub: CircuitDocument | undefined): {
  id: string;
  name: string;
  dir: 'in' | 'out';
  side: PinSide;
  order: number;
  bitWidth: number;
}[] {
  if (!sub) return [];
  if (sub.isStub && sub.stubPorts) {
    return sub.stubPorts.map((sp, i) => ({
      id: `stub_${sp.name}_${i}`,
      name: sp.name,
      dir: sp.dir,
      side: sp.dir === 'in' ? 'left' : 'right',
      order: i,
      bitWidth: sp.bitWidth,
    }));
  }
  if (sub.symbolConfig && sub.symbolConfig.pins.length > 0) {
    return sub.symbolConfig.pins.map((sp) => ({
      id: sp.portGateId,
      name: sp.name,
      dir: sp.dir,
      side: sp.side,
      order: sp.order,
      bitWidth: sp.bitWidth,
    }));
  }
  const pins: {
    id: string;
    name: string;
    dir: 'in' | 'out';
    side: PinSide;
    order: number;
    bitWidth: number;
  }[] = [];
  for (const g of sub.gates) {
    if (g.type === 'MODULE_IN' || g.type === 'MODULE_OUT') {
      const dir = g.type === 'MODULE_IN' ? 'in' : 'out';
      pins.push({
        id: g.id,
        name: g.label || (dir === 'in' ? 'IN' : 'OUT'),
        dir,
        side: g.props.portSide ?? (dir === 'in' ? 'left' : 'right'),
        order: g.props.portOrder ?? g.y,
        bitWidth: g.props.bitWidth ?? 1,
      });
    }
  }
  return pins.sort((a, b) => a.order - b.order);
}

export function getGatePins(gate: GateInstance, project?: ProjectDocument): PinDef[] {
  const { width, height } = getGateSize(gate, project);
  const hw = width / 2;
  const hh = height / 2;
  const p = gate.props;
  const bw = Math.max(1, p.bitWidth ?? 1);

  switch (gate.type) {
    case 'MODULE_IN':
    case 'TOGGLE':
    case 'BUTTON':
    case 'CLOCK':
    case 'CONST':
      return [{ id: 'out', name: 'OUT', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw }];

    case 'MODULE_OUT':
    case 'LED':
    case 'NUM_DISPLAY':
      return [{ id: 'in', name: 'IN', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: bw }];

    case 'SEVEN_SEG': {
      const cfg = getSevenSegConfig(p);
      return [
        {
          id: 'in',
          name: cfg.mode === 'direct' ? 'SEG' : cfg.digits > 1 ? `HEX${cfg.bitWidth}` : 'HEX',
          dir: 'in',
          side: 'left',
          x: -hw,
          y: 0,
          bitWidth: cfg.bitWidth,
        },
      ];
    }

    case 'TUNNEL':
      return [
        {
          id: 'io',
          name: p.netName || 'NET',
          dir: 'inout',
          side: 'left',
          x: -hw,
          y: 0,
          bitWidth: bw,
        },
      ];

    case 'SPLITTER': {
      const widths = p.splitWidths ?? [1, 1, 1, 1];
      const total = widths.reduce((a, b) => a + b, 0);
      const isSplit = (p.splitMode ?? 'split') === 'split';
      const ys = distributePinOffsets(widths.length, GRID_SIZE);
      const pins: PinDef[] = [
        {
          id: 'bus',
          name: `BUS[${total - 1}:0]`,
          dir: isSplit ? 'in' : 'out',
          side: isSplit ? 'left' : 'right',
          x: isSplit ? -hw : hw,
          y: 0,
          bitWidth: total,
        },
      ];
      let bitCursor = 0;
      widths.forEach((w, idx) => {
        const label = w === 1 ? `[${bitCursor}]` : `[${bitCursor + w - 1}:${bitCursor}]`;
        bitCursor += w;
        pins.push({
          id: `b${idx}`,
          name: label,
          dir: isSplit ? 'out' : 'in',
          side: isSplit ? 'right' : 'left',
          x: isSplit ? hw : -hw,
          y: ys[idx],
          bitWidth: w,
        });
      });
      return pins;
    }

    case 'IFACE_BUNDLE': {
      const fields = p.interfaceFields ?? [];
      const total = getInterfaceTotalWidth(p);
      const isPack = (p.bundleMode ?? 'pack') === 'pack';
      const ys = distributePinOffsets(fields.length, GRID_SIZE);
      const pins: PinDef[] = [
        {
          id: 'bundle',
          name: p.interfaceName || 'if',
          dir: isPack ? 'out' : 'in',
          side: isPack ? 'right' : 'left',
          x: isPack ? hw : -hw,
          y: 0,
          bitWidth: total,
        },
      ];
      fields.forEach((f, idx) => {
        pins.push({
          id: `f_${idx}`,
          name: f.name,
          dir: isPack ? 'in' : 'out',
          side: isPack ? 'left' : 'right',
          x: isPack ? -hw : hw,
          y: ys[idx],
          bitWidth: Math.max(1, f.bitWidth),
        });
      });
      return pins;
    }

    case 'NOT':
    case 'BUF':
      return [
        { id: 'in0', name: 'A', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: bw },
        { id: 'out', name: 'Y', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw },
      ];

    case 'TRIBUF':
      return [
        { id: 'in0', name: 'A', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: bw },
        { id: 'en', name: 'EN', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
        { id: 'out', name: 'Y', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw },
      ];

    case 'AND':
    case 'OR':
    case 'NAND':
    case 'NOR':
    case 'XOR':
    case 'XNOR': {
      const n = Math.max(2, Math.min(8, p.inputCount ?? 2));
      const ys = distributePinOffsets(n, GRID_SIZE);
      const pins: PinDef[] = ys.map((y, idx) => ({
        id: `in${idx}`,
        name: String.fromCharCode(65 + idx),
        dir: 'in',
        side: 'left',
        x: -hw,
        y,
        bitWidth: bw,
      }));
      pins.push({ id: 'out', name: 'Y', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw });
      return pins;
    }

    case 'MUX': {
      const { channels, selectBits: sel } = getMuxConfig(p);
      const ys = distributePinOffsets(channels, GRID_SIZE);
      const pins: PinDef[] = ys.map((y, idx) => ({
        id: `d${idx}`,
        name: `D${idx}`,
        dir: 'in',
        side: 'left',
        x: -hw,
        y,
        bitWidth: bw,
      }));
      pins.push({ id: 'sel', name: 'S', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: sel });
      pins.push({ id: 'out', name: 'Y', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw });
      return pins;
    }

    case 'DEMUX': {
      const { channels, selectBits: sel } = getMuxConfig(p);
      const ys = distributePinOffsets(channels, GRID_SIZE);
      const pins: PinDef[] = [
        { id: 'in', name: 'D', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: bw },
        { id: 'sel', name: 'S', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: sel },
      ];
      ys.forEach((y, idx) => {
        pins.push({
          id: `y${idx}`,
          name: `Y${idx}`,
          dir: 'out',
          side: 'right',
          x: hw,
          y,
          bitWidth: bw,
        });
      });
      return pins;
    }

    case 'DECODER': {
      const sel = Math.max(1, Math.min(3, p.selectBits ?? 2));
      const outs = 1 << sel;
      const ys = distributePinOffsets(outs, GRID_SIZE);
      const pins: PinDef[] = [
        { id: 'sel', name: 'A', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: sel },
        { id: 'en', name: 'EN', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
      ];
      ys.forEach((y, idx) => {
        pins.push({
          id: `y${idx}`,
          name: `Y${idx}`,
          dir: 'out',
          side: 'right',
          x: hw,
          y,
          bitWidth: 1,
        });
      });
      return pins;
    }

    case 'HALF_ADDER':
      return [
        { id: 'a', name: 'A', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: 1 },
        { id: 'b', name: 'B', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
        { id: 's', name: 'S', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: 1 },
        { id: 'c', name: 'C', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'FULL_ADDER':
      return [
        { id: 'a', name: 'A', dir: 'in', side: 'left', x: -hw, y: -20, bitWidth: 1 },
        { id: 'b', name: 'B', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: 1 },
        { id: 'cin', name: 'Cin', dir: 'in', side: 'left', x: -hw, y: 20, bitWidth: 1 },
        { id: 's', name: 'S', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: 1 },
        { id: 'cout', name: 'Cout', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'ADDER':
      if (p.hasCarryIn === false) {
        return [
          { id: 'a', name: 'A', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: bw },
          { id: 'b', name: 'B', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: bw },
          { id: 's', name: 'S', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: bw },
          { id: 'cout', name: 'Cout', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
        ];
      }
      return [
        { id: 'a', name: 'A', dir: 'in', side: 'left', x: -hw, y: -20, bitWidth: bw },
        { id: 'b', name: 'B', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: bw },
        { id: 'cin', name: 'Cin', dir: 'in', side: 'left', x: -hw, y: 20, bitWidth: 1 },
        { id: 's', name: 'S', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: bw },
        { id: 'cout', name: 'Cout', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'COMPARATOR':
      return [
        { id: 'a', name: 'A', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: bw },
        { id: 'b', name: 'B', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: bw },
        { id: 'lt', name: '<', dir: 'out', side: 'right', x: hw, y: -20, bitWidth: 1 },
        { id: 'eq', name: '=', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: 1 },
        { id: 'gt', name: '>', dir: 'out', side: 'right', x: hw, y: 20, bitWidth: 1 },
      ];

    case 'SR_LATCH':
      return [
        { id: 's', name: 'S', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: 1 },
        { id: 'r', name: 'R', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: 1 },
        { id: 'qn', name: 'Q̄', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'D_LATCH':
      return [
        { id: 'd', name: 'D', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: bw },
        { id: 'en', name: 'EN', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: bw },
        { id: 'qn', name: 'Q̄', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: bw },
      ];

    case 'D_FF':
      if (p.hasEnable === false) {
        return [
          { id: 'd', name: 'D', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: bw },
          { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
          { id: 'rst', name: 'RST', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
          { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: bw },
          { id: 'qn', name: 'Q̄', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: bw },
        ];
      }
      return [
        { id: 'd', name: 'D', dir: 'in', side: 'left', x: -hw, y: -20, bitWidth: bw },
        { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: 1 },
        { id: 'en', name: 'EN', dir: 'in', side: 'left', x: -hw, y: 20, bitWidth: 1 },
        { id: 'rst', name: 'RST', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: bw },
        { id: 'qn', name: 'Q̄', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: bw },
      ];

    case 'JK_FF':
      return [
        { id: 'j', name: 'J', dir: 'in', side: 'left', x: -hw, y: -20, bitWidth: 1 },
        { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: 1 },
        { id: 'k', name: 'K', dir: 'in', side: 'left', x: -hw, y: 20, bitWidth: 1 },
        { id: 'rst', name: 'RST', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: 1 },
        { id: 'qn', name: 'Q̄', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'T_FF':
      return [
        { id: 't', name: 'T', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: 1 },
        { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
        { id: 'rst', name: 'RST', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: 1 },
        { id: 'qn', name: 'Q̄', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'REGISTER':
      if (p.hasEnable === false) {
        return [
          { id: 'd', name: 'D', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: bw },
          { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
          { id: 'clr', name: 'CLR', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
          { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw },
        ];
      }
      return [
        { id: 'd', name: 'D', dir: 'in', side: 'left', x: -hw, y: -20, bitWidth: bw },
        { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: 1 },
        { id: 'en', name: 'EN', dir: 'in', side: 'left', x: -hw, y: 20, bitWidth: 1 },
        { id: 'clr', name: 'CLR', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: bw },
      ];

    case 'COUNTER':
      return [
        { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: -20, bitWidth: 1 },
        { id: 'en', name: 'EN', dir: 'in', side: 'left', x: -hw, y: 0, bitWidth: 1 },
        { id: 'clr', name: 'CLR', dir: 'in', side: 'left', x: -hw, y: 20, bitWidth: 1 },
        { id: 'q', name: 'Q', dir: 'out', side: 'right', x: hw, y: -10, bitWidth: bw },
        { id: 'ovf', name: 'OVF', dir: 'out', side: 'right', x: hw, y: 10, bitWidth: 1 },
      ];

    case 'RAM': {
      const ab = Math.max(1, Math.min(8, p.addrBits ?? 4));
      const db = Math.max(1, Math.min(16, p.dataBits ?? 4));
      return [
        { id: 'addr', name: 'A', dir: 'in', side: 'left', x: -hw, y: -30, bitWidth: ab },
        { id: 'din', name: 'DI', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: db },
        { id: 'we', name: 'WE', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
        { id: 'clk', name: 'CLK', dir: 'in', side: 'left', x: -hw, y: 30, bitWidth: 1 },
        { id: 'oe', name: 'OE', dir: 'in', side: 'bottom', x: 0, y: hh, bitWidth: 1 },
        { id: 'dout', name: 'DO', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: db },
      ];
    }

    case 'ROM': {
      const ab = Math.max(1, Math.min(8, p.addrBits ?? 4));
      const db = Math.max(1, Math.min(16, p.dataBits ?? 4));
      return [
        { id: 'addr', name: 'A', dir: 'in', side: 'left', x: -hw, y: -10, bitWidth: ab },
        { id: 'oe', name: 'OE', dir: 'in', side: 'left', x: -hw, y: 10, bitWidth: 1 },
        { id: 'dout', name: 'DO', dir: 'out', side: 'right', x: hw, y: 0, bitWidth: db },
      ];
    }

    case 'SUBCIRCUIT': {
      const sub = p.subcircuitId && project ? project.circuits[p.subcircuitId] : undefined;
      const raw = getSubcircuitPins(sub);
      const bySide: Record<PinSide, typeof raw> = { left: [], right: [], top: [], bottom: [] };
      for (const r of raw) bySide[r.side].push(r);

      const pins: PinDef[] = [];
      (['left', 'right', 'top', 'bottom'] as PinSide[]).forEach((side) => {
        const list = bySide[side].sort((a, b) => a.order - b.order);
        const step = side === 'left' || side === 'right' ? GRID_SIZE : GRID_SIZE * 2;
        const offsets = distributePinOffsets(list.length, step);
        list.forEach((item, i) => {
          const x = side === 'left' ? -hw : side === 'right' ? hw : offsets[i];
          const y = side === 'top' ? -hh : side === 'bottom' ? hh : offsets[i];
          pins.push({
            id: item.id,
            name: item.name,
            dir: item.dir,
            side,
            x,
            y,
            bitWidth: item.bitWidth,
          });
        });
      });
      return pins;
    }
  }
}

export function rotateLocalPoint(pt: Point, rotation: number): Point {
  const r = ((rotation % 360) + 360) % 360;
  if (r === 90) return { x: -pt.y, y: pt.x };
  if (r === 180) return { x: -pt.x, y: -pt.y };
  if (r === 270) return { x: pt.y, y: -pt.x };
  return { x: pt.x, y: pt.y };
}

export function getPinWorldPos(gate: GateInstance, pin: PinDef): Point {
  const rot = rotateLocalPoint({ x: pin.x, y: pin.y }, gate.rotation);
  return { x: gate.x + rot.x, y: gate.y + rot.y };
}

export function getPinWorldSide(side: PinSide, rotation: number): PinSide {
  const order: PinSide[] = ['right', 'bottom', 'left', 'top'];
  const idx = order.indexOf(side);
  const steps = Math.round((((rotation % 360) + 360) % 360) / 90);
  return order[(idx + steps) % 4];
}

export function getGateBounds(
  gate: GateInstance,
  project?: ProjectDocument,
): { x: number; y: number; width: number; height: number } {
  const { width, height } = getGateSize(gate, project);
  const rotated = gate.rotation === 90 || gate.rotation === 270;
  const w = rotated ? height : width;
  const h = rotated ? width : height;
  return {
    x: gate.x - w / 2,
    y: gate.y - h / 2,
    width: w,
    height: h,
  };
}

// --- Component Replacement Helpers (preserve wires when swapping components) ---

const REPLACEMENT_GROUPS: GateType[][] = [
  ['TOGGLE', 'BUTTON', 'CLOCK', 'CONST', 'MODULE_IN'],
  ['LED', 'NUM_DISPLAY', 'SEVEN_SEG', 'MODULE_OUT'],
  ['AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR'],
  ['NOT', 'BUF', 'TRIBUF'],
  ['MUX', 'DEMUX', 'DECODER'],
  ['HALF_ADDER', 'FULL_ADDER', 'ADDER', 'COMPARATOR'],
  ['D_FF', 'REGISTER', 'D_LATCH', 'SR_LATCH', 'JK_FF', 'T_FF', 'COUNTER'],
  ['RAM', 'ROM'],
  ['TUNNEL', 'SPLITTER', 'IFACE_BUNDLE'],
];

/** Return quick-swap compatible component types for the given gate type (excluding itself) */
export function getCompatibleReplacementTypes(type: GateType): GateType[] {
  const grp = REPLACEMENT_GROUPS.find((g) => g.includes(type));
  return grp ? grp.filter((t) => t !== type) : [];
}

/** Build a replacement gate preserving position, rotation, compatible props, and custom label */
export function buildReplacementGate(
  oldGate: GateInstance,
  newType: GateType,
  project?: ProjectDocument,
  newSubcircuitId?: string,
): GateInstance {
  const newEntry = GATE_CATALOG[newType];
  const nextProps: GateProps = { ...newEntry.defaultProps };
  const oldProps = oldGate.props;

  // Preserve compatible properties across replacement
  if (
    oldProps.bitWidth !== undefined &&
    newType !== 'HALF_ADDER' &&
    newType !== 'FULL_ADDER' &&
    newType !== 'SR_LATCH' &&
    newType !== 'JK_FF' &&
    newType !== 'T_FF' &&
    newType !== 'DECODER' &&
    newType !== 'SEVEN_SEG' &&
    newType !== 'SUBCIRCUIT'
  ) {
    nextProps.bitWidth = oldProps.bitWidth;
  }
  if (oldProps.bitWidth !== undefined && newType === 'SEVEN_SEG') {
    const digits = Math.max(1, Math.min(4, Math.ceil(oldProps.bitWidth / 4)));
    nextProps.segMode = 'hex';
    nextProps.segDigits = digits;
    nextProps.bitWidth = digits * 4;
  }
  if (
    oldProps.inputCount !== undefined &&
    ['AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR', 'MUX', 'DEMUX'].includes(newType)
  ) {
    nextProps.inputCount = oldProps.inputCount;
  }
  if (oldProps.selectBits !== undefined && ['MUX', 'DEMUX', 'DECODER'].includes(newType)) {
    nextProps.selectBits = oldProps.selectBits;
  }
  if (oldProps.value !== undefined && ['TOGGLE', 'CONST', 'MODULE_IN'].includes(newType)) {
    nextProps.value = oldProps.value;
  }
  if (oldProps.portSide !== undefined && ['MODULE_IN', 'MODULE_OUT'].includes(newType)) {
    nextProps.portSide = oldProps.portSide;
  }
  if (oldProps.portOrder !== undefined && ['MODULE_IN', 'MODULE_OUT'].includes(newType)) {
    nextProps.portOrder = oldProps.portOrder;
  }
  if (oldProps.hasCarryIn !== undefined && newType === 'ADDER') {
    nextProps.hasCarryIn = oldProps.hasCarryIn;
  }
  if (oldProps.hasEnable !== undefined && ['D_FF', 'REGISTER'].includes(newType)) {
    nextProps.hasEnable = oldProps.hasEnable;
  }
  if (newType === 'SUBCIRCUIT' && newSubcircuitId) {
    nextProps.subcircuitId = newSubcircuitId;
    nextProps.displayMode = oldProps.displayMode ?? 'live';
  }

  let nextLabel = oldGate.label;
  if (newType === 'SUBCIRCUIT' && newSubcircuitId && project?.circuits[newSubcircuitId]) {
    nextLabel = project.circuits[newSubcircuitId].name;
  } else if (!nextLabel && (newType === 'MODULE_IN' || newType === 'MODULE_OUT')) {
    nextLabel = newType === 'MODULE_IN' ? 'IN' : 'OUT';
  } else if (
    oldGate.type === 'SUBCIRCUIT' &&
    newType !== 'SUBCIRCUIT' &&
    oldProps.subcircuitId &&
    project?.circuits[oldProps.subcircuitId]?.name === oldGate.label
  ) {
    nextLabel = '';
  }

  return {
    id: oldGate.id,
    type: newType,
    x: oldGate.x,
    y: oldGate.y,
    rotation: oldGate.rotation,
    label: nextLabel,
    props: nextProps,
  };
}

const PIN_ALIAS_PAIRS: [string, string][] = [
  ['rst', 'clr'],
  ['c', 'cout'],
  ['io', 'out'],
  ['io', 'in'],
  ['in', 'in0'],
  ['in0', 'a'],
  ['in1', 'b'],
  ['d', 'in0'],
  ['q', 'out'],
  ['s', 'out'],
];

/** Map pin IDs from `oldGate` to `newGate` so existing wires stay connected during component replacement */
export function mapReplacementPins(
  oldGate: GateInstance,
  newGate: GateInstance,
  project?: ProjectDocument,
): Map<string, string> {
  const oldPins = getGatePins(oldGate, project);
  const newPins = getGatePins(newGate, project);
  const mapping = new Map<string, string>();
  const usedNewIds = new Set<string>();

  // 1. Exact pin ID match
  for (const op of oldPins) {
    const exact = newPins.find((np) => np.id === op.id && !usedNewIds.has(np.id));
    if (exact) {
      mapping.set(op.id, exact.id);
      usedNewIds.add(exact.id);
    }
  }

  // 2. Semantic alias match (e.g. rst <-> clr, c <-> cout, in0 <-> a)
  for (const op of oldPins) {
    if (mapping.has(op.id)) continue;
    for (const [a, b] of PIN_ALIAS_PAIRS) {
      const targetId = op.id === a ? b : op.id === b ? a : null;
      if (!targetId) continue;
      const cand = newPins.find((np) => np.id === targetId && !usedNewIds.has(np.id));
      if (cand) {
        mapping.set(op.id, cand.id);
        usedNewIds.add(cand.id);
        break;
      }
    }
  }

  // 3. Same-direction positional order match (sorted by y, then x)
  const sortPins = (list: PinDef[]) => [...list].sort((p1, p2) => p1.y - p2.y || p1.x - p2.x);
  const dirsMatch = (d1: PinDef['dir'], d2: PinDef['dir']) =>
    d1 === d2 || d1 === 'inout' || d2 === 'inout';

  for (const op of sortPins(oldPins)) {
    if (mapping.has(op.id)) continue;
    const cand = sortPins(newPins).find(
      (np) => !usedNewIds.has(np.id) && dirsMatch(op.dir, np.dir),
    );
    if (cand) {
      mapping.set(op.id, cand.id);
      usedNewIds.add(cand.id);
    }
  }

  return mapping;
}

/**
 * Replace a gate inside `circuit` in-place while preserving connected wires:
 * mapped pins reattach automatically and any unmapped endpoints become reusable floating wire ends!
 */
export function applyGateReplacement(
  circuit: CircuitDocument,
  gateId: string,
  newType: GateType,
  project?: ProjectDocument,
  newSubcircuitId?: string,
): { replaced: boolean; oldType?: GateType; reattached: number; detachedToFloating: number } {
  const idx = circuit.gates.findIndex((g) => g.id === gateId);
  if (idx === -1) return { replaced: false, reattached: 0, detachedToFloating: 0 };

  const oldGate = circuit.gates[idx];
  if (oldGate.type === newType && oldGate.props.subcircuitId === newSubcircuitId) {
    return { replaced: false, oldType: oldGate.type, reattached: 0, detachedToFloating: 0 };
  }

  const newGate = buildReplacementGate(oldGate, newType, project, newSubcircuitId);
  const pinMap = mapReplacementPins(oldGate, newGate, project);
  circuit.gates[idx] = newGate;

  let reattached = 0;
  let detachedToFloating = 0;
  for (const w of circuit.wires) {
    if (w.from?.gateId === gateId) {
      const mapped = pinMap.get(w.from.pinId);
      if (mapped) {
        w.from = { gateId, pinId: mapped };
        reattached++;
      } else {
        w.from = undefined;
        detachedToFloating++;
      }
    }
    if (w.to?.gateId === gateId) {
      const mapped = pinMap.get(w.to.pinId);
      if (mapped) {
        w.to = { gateId, pinId: mapped };
        reattached++;
      } else {
        w.to = undefined;
        detachedToFloating++;
      }
    }
  }

  return { replaced: true, oldType: oldGate.type, reattached, detachedToFloating };
}
