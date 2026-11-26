// 4-state IEEE 1364 logic values: 0 (LOW), 1 (HIGH), X (UNKNOWN/CONFLICT), Z (HIGH-Z)

export const BIT_0 = 0 as const;
export const BIT_1 = 1 as const;
export const BIT_X = 2 as const;
export const BIT_Z = 3 as const;

export type Bit = 0 | 1 | 2 | 3;

export interface LogicValue {
  width: number;
  /** LSB-first array of 4-state bits */
  bits: Bit[];
}

export type XCause = 'conflict' | 'oscillation' | 'stub' | 'unknown';

export const SIGNAL_COLORS: Record<Bit, string> = {
  [BIT_0]: '#64748b', // Slate Gray (0)
  [BIT_1]: '#22c55e', // Vibrant Emerald Green (1)
  [BIT_X]: '#f97316', // Warm Orange-Red (X default / propagated)
  [BIT_Z]: '#3b82f6', // Azure Blue (Z)
};

export const X_CAUSE_COLORS: Record<XCause, string> = {
  conflict: '#ef4444', // Vivid Crimson Red (0 vs 1 bus contention)
  oscillation: '#ec4899', // Electric Magenta (combinational feedback oscillation)
  stub: '#f59e0b', // Amber (unimplemented external HDL stub output)
  unknown: '#f97316', // Warm Orange-Red (uninitialized / floating / propagated X)
};

export const X_CAUSE_GLOW: Record<XCause, string> = {
  conflict: 'rgba(239, 68, 68, 0.72)',
  oscillation: 'rgba(236, 72, 153, 0.72)',
  stub: 'rgba(245, 158, 11, 0.55)',
  unknown: 'rgba(249, 115, 22, 0.62)',
};

export const X_CAUSE_LABELS: Record<XCause, string> = {
  conflict: 'X (0/1 衝突)',
  oscillation: 'X (発振)',
  stub: 'X (未実装Stub)',
  unknown: 'X (不定/伝播)',
};

export const SIGNAL_GLOW: Record<Bit, string> = {
  [BIT_0]: 'rgba(100, 116, 139, 0)',
  [BIT_1]: 'rgba(34, 197, 94, 0.55)',
  [BIT_X]: 'rgba(249, 115, 22, 0.65)',
  [BIT_Z]: 'rgba(59, 130, 246, 0.45)',
};

export const SIGNAL_LABELS: Record<Bit, string> = {
  [BIT_0]: '0',
  [BIT_1]: '1',
  [BIT_X]: 'X',
  [BIT_Z]: 'Z',
};

export function makeValue(bits: Bit[]): LogicValue {
  return { width: bits.length, bits };
}

export function makeUniform(bit: Bit, width = 1): LogicValue {
  const w = Math.max(1, Math.min(64, width));
  return { width: w, bits: new Array<Bit>(w).fill(bit) };
}

export function fromInt(num: number, width = 1): LogicValue {
  const w = Math.max(1, Math.min(64, width));
  const bits: Bit[] = new Array(w);
  const u = num >>> 0;
  for (let i = 0; i < w; i++) {
    bits[i] = ((u >>> i) & 1) === 1 ? BIT_1 : BIT_0;
  }
  return { width: w, bits };
}

export function fromLiteral(raw: string, width = 1): LogicValue {
  const w = Math.max(1, Math.min(64, width));
  const s = raw.trim().toLowerCase();
  if (s === 'x') return makeUniform(BIT_X, w);
  if (s === 'z') return makeUniform(BIT_Z, w);
  if (s.startsWith('0x')) {
    const parsed = parseInt(s.slice(2), 16);
    if (!Number.isNaN(parsed)) return fromInt(parsed, w);
  }
  if (s.startsWith('0b')) {
    const bin = s.slice(2);
    const bits: Bit[] = new Array(w).fill(BIT_0);
    for (let i = 0; i < w && i < bin.length; i++) {
      const ch = bin[bin.length - 1 - i];
      bits[i] = ch === '1' ? BIT_1 : ch === '0' ? BIT_0 : ch === 'z' ? BIT_Z : BIT_X;
    }
    return { width: w, bits };
  }
  if (/^[01xz]+$/.test(s) && (s.includes('x') || s.includes('z') || (w > 1 && s.length === w))) {
    const bits: Bit[] = new Array(w).fill(BIT_0);
    for (let i = 0; i < w && i < s.length; i++) {
      const ch = s[s.length - 1 - i];
      bits[i] = ch === '1' ? BIT_1 : ch === '0' ? BIT_0 : ch === 'z' ? BIT_Z : BIT_X;
    }
    return { width: w, bits };
  }
  const dec = parseInt(s, 10);
  if (!Number.isNaN(dec)) return fromInt(dec, w);
  return makeUniform(BIT_X, w);
}

export function resizeValue(val: LogicValue, width: number, fill: Bit = BIT_0): LogicValue {
  const w = Math.max(1, Math.min(64, width));
  if (val.width === w) return val;
  const bits: Bit[] = new Array(w);
  for (let i = 0; i < w; i++) {
    bits[i] = i < val.bits.length ? val.bits[i] : fill;
  }
  return { width: w, bits };
}

export function valuesEqual(a: LogicValue | undefined, b: LogicValue | undefined): boolean {
  if (!a || !b || a.width !== b.width) return false;
  for (let i = 0; i < a.width; i++) {
    if (a.bits[i] !== b.bits[i]) return false;
  }
  return true;
}

/** Determine the representative 4-state color for a wire or bus */
export function dominantState(val: LogicValue | undefined): Bit {
  if (!val || val.bits.length === 0) return BIT_Z;
  let has1 = false;
  let has0 = false;
  let hasZ = false;
  for (const b of val.bits) {
    if (b === BIT_X) return BIT_X;
    if (b === BIT_1) has1 = true;
    else if (b === BIT_0) has0 = true;
    else if (b === BIT_Z) hasZ = true;
  }
  if (hasZ && !has1 && !has0) return BIT_Z;
  if (has1) return BIT_1;
  if (hasZ) return BIT_Z;
  return BIT_0;
}

export function toUnsignedInt(val: LogicValue): number | null {
  let acc = 0;
  for (let i = 0; i < val.width; i++) {
    const b = val.bits[i];
    if (b !== BIT_0 && b !== BIT_1) return null;
    if (b === BIT_1) acc += Math.pow(2, i);
  }
  return acc;
}

export function toBinString(val: LogicValue): string {
  let out = '';
  for (let i = val.width - 1; i >= 0; i--) {
    out += SIGNAL_LABELS[val.bits[i]];
  }
  return out;
}

export function toHexString(val: LogicValue): string {
  const nibbles = Math.ceil(val.width / 4);
  let out = '';
  for (let n = nibbles - 1; n >= 0; n--) {
    let allZ = true;
    let hasUnknown = false;
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const idx = n * 4 + k;
      const b = idx < val.width ? val.bits[idx] : BIT_0;
      if (b !== BIT_Z) allZ = false;
      if (b === BIT_X || b === BIT_Z) {
        hasUnknown = true;
      } else if (b === BIT_1) {
        v |= 1 << k;
      }
    }
    if (allZ) out += 'Z';
    else if (hasUnknown) out += 'X';
    else out += v.toString(16).toUpperCase();
  }
  return out;
}

export function formatValue(
  val: LogicValue,
  radix: 'hex' | 'dec' | 'signed' | 'bin' = 'hex',
): string {
  if (val.width === 1) return SIGNAL_LABELS[val.bits[0]];
  if (radix === 'bin') return toBinString(val);
  if (radix === 'hex') return '0x' + toHexString(val);
  const u = toUnsignedInt(val);
  if (u === null) {
    return dominantState(val) === BIT_Z ? 'Z' : 'X';
  }
  if (radix === 'signed') {
    const signBit = val.bits[val.width - 1];
    if (signBit === BIT_1) {
      return String(u - Math.pow(2, val.width));
    }
  }
  return String(u);
}

// --- Primitive 4-State Bit Operations (IEEE 1364 compliant) ---

export function bitNot(a: Bit): Bit {
  if (a === BIT_0) return BIT_1;
  if (a === BIT_1) return BIT_0;
  return BIT_X;
}

export function bitBuf(a: Bit): Bit {
  if (a === BIT_0 || a === BIT_1) return a;
  return BIT_X;
}

export function bitAnd(a: Bit, b: Bit): Bit {
  if (a === BIT_0 || b === BIT_0) return BIT_0;
  if (a === BIT_1 && b === BIT_1) return BIT_1;
  return BIT_X;
}

export function bitOr(a: Bit, b: Bit): Bit {
  if (a === BIT_1 || b === BIT_1) return BIT_1;
  if (a === BIT_0 && b === BIT_0) return BIT_0;
  return BIT_X;
}

export function bitXor(a: Bit, b: Bit): Bit {
  if (a === BIT_0 && b === BIT_0) return BIT_0;
  if (a === BIT_1 && b === BIT_1) return BIT_0;
  if ((a === BIT_0 && b === BIT_1) || (a === BIT_1 && b === BIT_0)) return BIT_1;
  return BIT_X;
}

export function bitTriBuf(data: Bit, en: Bit): Bit {
  if (en === BIT_0) return BIT_Z;
  if (en === BIT_1) return data === BIT_Z ? BIT_X : data;
  return BIT_X;
}

/** Resolve multiple drivers connected to the same net bit */
export function resolveBit(drivers: Bit[]): Bit {
  let resolved: Bit = BIT_Z;
  for (const d of drivers) {
    if (d === BIT_Z) continue;
    if (d === BIT_X) return BIT_X;
    if (resolved === BIT_Z) {
      resolved = d;
    } else if (resolved !== d) {
      // Bus contention: 0 vs 1 -> X
      return BIT_X;
    }
  }
  return resolved;
}

/** Returns true if multiple drivers actively contend (at least one 0 and one 1 on the same bit) */
export function hasBusContention(drivers: LogicValue[], width: number): boolean {
  if (drivers.length < 2) return false;
  for (let i = 0; i < width; i++) {
    let seen0 = false;
    let seen1 = false;
    for (const d of drivers) {
      const b = i < d.bits.length ? d.bits[i] : BIT_Z;
      if (b === BIT_0) seen0 = true;
      else if (b === BIT_1) seen1 = true;
      if (seen0 && seen1) return true;
    }
  }
  return false;
}

export function resolveValues(drivers: LogicValue[], width: number): LogicValue {
  if (drivers.length === 0) return makeUniform(BIT_Z, width);
  if (drivers.length === 1) return resizeValue(drivers[0], width, BIT_Z);
  const bits: Bit[] = new Array(width);
  for (let i = 0; i < width; i++) {
    const col: Bit[] = [];
    for (const d of drivers) {
      col.push(i < d.bits.length ? d.bits[i] : BIT_Z);
    }
    bits[i] = resolveBit(col);
  }
  return { width, bits };
}

// --- Vectorized Gate Operations ---

export function vecUnary(v: LogicValue, fn: (b: Bit) => Bit): LogicValue {
  return { width: v.width, bits: v.bits.map(fn) };
}

export function vecReduce(
  inputs: LogicValue[],
  width: number,
  op: (a: Bit, b: Bit) => Bit,
  identity: Bit,
): LogicValue {
  const bits: Bit[] = new Array(width);
  for (let i = 0; i < width; i++) {
    let acc: Bit =
      inputs.length > 0 ? (i < inputs[0].bits.length ? inputs[0].bits[i] : BIT_Z) : identity;
    if (inputs.length === 1) {
      acc = bitBuf(acc);
    } else {
      for (let k = 1; k < inputs.length; k++) {
        const b = i < inputs[k].bits.length ? inputs[k].bits[i] : BIT_Z;
        acc = op(acc, b);
      }
    }
    bits[i] = acc;
  }
  return { width, bits };
}

export function vecTriBuf(data: LogicValue, en: Bit): LogicValue {
  return { width: data.width, bits: data.bits.map((b) => bitTriBuf(b, en)) };
}

export function addVectors(
  a: LogicValue,
  b: LogicValue,
  cin: Bit,
  width: number,
): { sum: LogicValue; cout: Bit } {
  const aR = resizeValue(a, width, BIT_0);
  const bR = resizeValue(b, width, BIT_0);
  // Check for any X/Z in inputs -> full X propagation (standard Verilog arithmetic)
  const hasUnknown =
    cin === BIT_X ||
    cin === BIT_Z ||
    aR.bits.some((bit) => bit === BIT_X || bit === BIT_Z) ||
    bR.bits.some((bit) => bit === BIT_X || bit === BIT_Z);
  if (hasUnknown) {
    return { sum: makeUniform(BIT_X, width), cout: BIT_X };
  }
  const bits: Bit[] = new Array(width);
  let carry = cin === BIT_1 ? 1 : 0;
  for (let i = 0; i < width; i++) {
    const s = (aR.bits[i] === BIT_1 ? 1 : 0) + (bR.bits[i] === BIT_1 ? 1 : 0) + carry;
    bits[i] = (s & 1) === 1 ? BIT_1 : BIT_0;
    carry = (s >> 1) & 1;
  }
  return { sum: { width, bits }, cout: carry === 1 ? BIT_1 : BIT_0 };
}

export function compareVectors(
  a: LogicValue,
  b: LogicValue,
  width: number,
): { lt: Bit; eq: Bit; gt: Bit } {
  const ua = toUnsignedInt(resizeValue(a, width, BIT_0));
  const ub = toUnsignedInt(resizeValue(b, width, BIT_0));
  if (ua === null || ub === null) {
    return { lt: BIT_X, eq: BIT_X, gt: BIT_X };
  }
  return {
    lt: ua < ub ? BIT_1 : BIT_0,
    eq: ua === ub ? BIT_1 : BIT_0,
    gt: ua > ub ? BIT_1 : BIT_0,
  };
}
