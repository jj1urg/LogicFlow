import {
  getGateBounds,
  getGatePins,
  getGateSize,
  getMuxConfig,
  getPinWorldPos,
  getPinWorldSide,
  GRID_SIZE,
  snapToGrid,
} from './catalog';
import { fromLiteral, toBinString } from './logic4';
import { createBatchWireRouter } from './routing';
import {
  CircuitDocument,
  GateInstance,
  GateType,
  HdlProjectBundle,
  PinRef,
  ProjectDocument,
  StubPort,
  Wire,
} from './types';

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================================
// Verilog / SystemVerilog Structural & RTL Importer (with Stub & Auto-Layout)
// ============================================================================

export interface HdlSourceFile {
  name: string;
  content: string;
}

export interface ImportOptions {
  /** Existing project circuits so re-synthesis or incremental imports link to already-defined modules */
  existingCircuits?: Record<string, CircuitDocument>;
  /** Preserve this exact circuitId for the primary synthesized module (used during in-place HDL re-synthesis) */
  preserveCircuitId?: string;
  /** Preserve circuitIds by module name (used when re-synthesizing an entire HDL project bundle in-place) */
  preserveIdByModuleName?: Map<string, string>;
  /** Explicit top module name designated by the user */
  topModuleName?: string;
  /** Optional custom name for the created HdlProjectBundle */
  projectName?: string;
  /** Preserve an existing HdlProjectBundle ID when re-synthesizing a project bundle */
  hdlProjectId?: string;
}

export interface ImportResult {
  circuits: CircuitDocument[];
  topCircuitId: string;
  hdlProject: HdlProjectBundle;
  warnings: string[];
}

export interface HdlModuleTreeNode {
  key: string;
  circuitId: string;
  moduleName: string;
  instanceName?: string;
  fileName?: string;
  isTop: boolean;
  isStub: boolean;
  hasHdl: boolean;
  hdlDiverged: boolean;
  children: HdlModuleTreeNode[];
}

/**
 * Build the hierarchical module instantiation tree for an HdlProjectBundle,
 * starting at `bundle.topCircuitId`, plus any modules defined in the bundle that are
 * not reachable under the current top module (e.g. separate testbenches or unused helpers).
 */
export function buildHdlModuleTree(
  bundle: HdlProjectBundle,
  circuits: Record<string, CircuitDocument>,
): { root: HdlModuleTreeNode | null; orphans: HdlModuleTreeNode[] } {
  const reachable = new Set<string>();

  const buildNode = (
    circuitId: string,
    pathKey: string,
    ancestors: Set<string>,
    instanceName?: string,
  ): HdlModuleTreeNode | null => {
    const doc = circuits[circuitId];
    if (!doc || doc.isStub) return null;
    reachable.add(circuitId);

    const children: HdlModuleTreeNode[] = [];
    if (!ancestors.has(circuitId)) {
      const nextAnc = new Set(ancestors);
      nextAnc.add(circuitId);
      for (const g of doc.gates) {
        if (g.type !== 'SUBCIRCUIT' || !g.props.subcircuitId) continue;
        const subDoc = circuits[g.props.subcircuitId];
        if (!subDoc || subDoc.isStub) continue;
        const instLabel = g.label.includes(':') ? g.label.split(':')[0].trim() : g.label.trim();
        const child = buildNode(subDoc.id, `${pathKey}/${g.id}`, nextAnc, instLabel || subDoc.name);
        if (child) children.push(child);
      }
    }

    return {
      key: pathKey,
      circuitId: doc.id,
      moduleName: doc.name,
      instanceName,
      fileName: doc.hdlFileName,
      isTop: doc.id === bundle.topCircuitId,
      isStub: false,
      hasHdl: Boolean(doc.hdlSource || doc.hdlFileSource),
      hdlDiverged: Boolean(doc.hdlDiverged),
      children,
    };
  };

  const root = buildNode(bundle.topCircuitId, `root:${bundle.topCircuitId}`, new Set());

  const orphans: HdlModuleTreeNode[] = [];
  for (const cid of bundle.moduleCircuitIds) {
    if (reachable.has(cid)) continue;
    const doc = circuits[cid];
    if (!doc || doc.isStub) continue;
    const node = buildNode(cid, `orphan:${cid}`, new Set());
    if (node) orphans.push(node);
  }

  return { root, orphans };
}

/**
 * Select the most likely top module among parsed modules:
 * 1. Find all uninstantiated root modules (not instantiated by any other parsed module).
 * 2. Score each root by its recursive hierarchy size + direct instance count so a real
 *    top-level system (e.g. `td4_cpu` with 8 instances) always beats an unused/mismatched
 *    leaf module (e.g. `rom_16x8` with 0 instances) regardless of filename/alphabetical order!
 */
function pickBestTopModule<T extends { name: string; instances: { moduleName: string }[] }>(
  parsed: T[],
): T {
  const byName = new Map(parsed.map((p) => [p.name, p]));
  const instantiatedNames = new Set<string>();
  for (const pm of parsed) {
    for (const inst of pm.instances) instantiatedNames.add(inst.moduleName);
  }

  const roots = parsed.filter((pm) => !instantiatedNames.has(pm.name));
  const candidates = roots.length > 0 ? roots : parsed;
  if (candidates.length === 1) return candidates[0];

  const countSubtree = (name: string, seen: Set<string>): number => {
    const mod = byName.get(name);
    if (!mod || seen.has(name)) return 0;
    seen.add(name);
    let total = 0;
    for (const inst of mod.instances) {
      total += 1;
      if (byName.has(inst.moduleName)) {
        total += 2 + countSubtree(inst.moduleName, seen);
      }
    }
    return total;
  };

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const cand of candidates) {
    let score = countSubtree(cand.name, new Set()) * 10 + cand.instances.length * 5;
    if (/(?:^|_)(?:top|cpu|soc|sys|system|main)(?:$|_)/i.test(cand.name)) score += 4;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

export interface HdlFileInspection {
  file: HdlSourceFile;
  valid: boolean;
  reason?: string;
}

const MAX_HDL_FILE_BYTES = 2 * 1024 * 1024; // 2MB per file safety cap
const NON_HDL_EXT_RE =
  /\.(?:xci|xml|xdc|bd|xpr|dcp|bit|ltx|json|yaml|yml|toml|csv|tsv|md|html|htm|css|js|ts|py|c|cpp|h|hpp|pdf|png|jpe?g|gif|svg|zip|tar|gz)(?:\.txt)?$/i;

/**
 * Validate whether a source file contains supported Verilog/SystemVerilog module definitions
 * and reject non-HDL formats (Vivado .xci XML, JSON, binary, oversized files, etc.) cleanly
 * before running heavy parsing/synthesis.
 */
export function inspectHdlSourceFile(file: HdlSourceFile): HdlFileInspection {
  const content = file.content ?? '';
  const trimmed = content.trim();
  if (!trimmed) {
    return { file, valid: false, reason: 'ファイルが空です' };
  }
  if (content.length > MAX_HDL_FILE_BYTES) {
    return {
      file,
      valid: false,
      reason: `ファイルサイズが大きすぎます（${Math.round(content.length / 1024)}KB > 2048KB）`,
    };
  }

  // Binary / NUL byte detection on prefix
  const sampleLen = Math.min(content.length, 2048);
  let ctrlCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) {
      return { file, valid: false, reason: 'バイナリファイルのため解釈できません' };
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      ctrlCount++;
    }
  }
  if (sampleLen > 0 && ctrlCount / sampleLen > 0.05) {
    return {
      file,
      valid: false,
      reason: 'バイナリまたは未対応エンコーディングのため解釈できません',
    };
  }

  // Fast XML / Vivado IP-XACT / HTML / JSON rejection
  const head = trimmed.slice(0, 256);
  if (/^<\?xml\b|^<spirit:|^<ipxact:|^<!doctype\b|^<html\b|^<project\b/i.test(head)) {
    return {
      file,
      valid: false,
      reason: 'XML / Vivado IP設定ファイル（.xci 等）であり Verilog/SystemVerilog ではありません',
    };
  }
  if ((head.startsWith('{') || head.startsWith('[')) && !/\bmodule\s+\w+/.test(content)) {
    return { file, valid: false, reason: 'JSON / 非HDLデータのため解釈できません' };
  }

  const clean = stripCommentsAndDirectives(content);
  const hasModuleEnd =
    /\bmodule\s+\w+/.test(clean) && clean.includes('endmodule') && /\bendmodule\b/.test(clean);
  if (!hasModuleEnd) {
    if (NON_HDL_EXT_RE.test(file.name.trim())) {
      return {
        file,
        valid: false,
        reason: '未対応のファイル形式（Verilog/SystemVerilog 以外）です',
      };
    }
    return {
      file,
      valid: false,
      reason: 'Verilog/SystemVerilog の module ... endmodule 定義が見つかりません',
    };
  }

  return { file, valid: true };
}

/** Quickly list all module names defined across one or more HDL source files (for top-module selection UI) */
export function listModuleNamesInFiles(
  files: HdlSourceFile[],
): { name: string; fileName: string }[] {
  const seen = new Set<string>();
  const list: { name: string; fileName: string }[] = [];
  for (const f of files) {
    if (!inspectHdlSourceFile(f).valid) continue;
    const clean = stripCommentsAndDirectives(f.content);
    const re = /\bmodule\s+(\w+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        list.push({ name, fileName: f.name });
      }
    }
  }
  return list;
}

/** Infer the most likely top module name across one or more HDL source files (for preview in import UI) */
export function inferTopModuleName(files: HdlSourceFile[]): string | null {
  const warnings: string[] = [];
  const all: ParsedModule[] = [];
  for (const f of files) {
    if (!inspectHdlSourceFile(f).valid) continue;
    all.push(...parseModules(f.content, warnings));
  }
  if (all.length === 0) return null;
  return pickBestTopModule(all).name;
}

interface ParsedPort {
  name: string;
  dir: 'in' | 'out';
  bitWidth: number;
}

interface ParsedInst {
  moduleName: string;
  instName: string;
  conns: { portName?: string; signal: string }[];
}

interface ParsedAssign {
  lhs: string;
  rhs: string;
}

interface ParsedFF {
  target: string;
  clkNet: string;
  dExpr: string;
  enExpr?: string;
  rstNet?: string;
  rstActiveLow?: boolean;
}

interface ParsedModule {
  name: string;
  params: Map<string, number>;
  ports: ParsedPort[];
  wires: Map<string, number>;
  signedNets: Set<string>;
  assigns: ParsedAssign[];
  ffs: ParsedFF[];
  primitives: { kind: GateType; instName: string; outNet: string; inNets: string[] }[];
  instances: ParsedInst[];
}

function stripCommentsAndDirectives(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      // Strip Verilog/SV compiler directives like `timescale, `default_nettype, `include, `define, `ifdef...
      .replace(/^[ \t]*`[^\n]*/gm, ' ')
  );
}

/**
 * Extract the exact untouched `module <name> ... endmodule` source text for each module
 * in the raw HDL input, preserving original comments, formatting, and non-synthesizable blocks.
 */
function extractOriginalModuleSources(rawSource: string): Map<string, string> {
  const result = new Map<string, string>();
  const len = rawSource.length;
  let i = 0;
  let inModule = false;
  let modStart = 0;
  let modName = '';

  const isIdentChar = (c: string) => /\w/.test(c);

  const skipWsAndComments = (pos: number): number => {
    let p = pos;
    while (p < len) {
      if (/\s/.test(rawSource[p])) {
        p++;
      } else if (rawSource[p] === '/' && rawSource[p + 1] === '/') {
        p += 2;
        while (p < len && rawSource[p] !== '\n') p++;
      } else if (rawSource[p] === '/' && rawSource[p + 1] === '*') {
        p += 2;
        while (p < len && !(rawSource[p] === '*' && rawSource[p + 1] === '/')) p++;
        p += 2;
      } else {
        break;
      }
    }
    return p;
  };

  while (i < len) {
    const ch = rawSource[i];
    // Skip line comments
    if (ch === '/' && rawSource[i + 1] === '/') {
      i += 2;
      while (i < len && rawSource[i] !== '\n') i++;
      continue;
    }
    // Skip block comments
    if (ch === '/' && rawSource[i + 1] === '*') {
      i += 2;
      while (i < len && !(rawSource[i] === '*' && rawSource[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Skip string literals
    if (ch === '"') {
      i++;
      while (i < len && rawSource[i] !== '"') {
        if (rawSource[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    if (isIdentChar(ch) && (i === 0 || !isIdentChar(rawSource[i - 1]))) {
      let end = i;
      while (end < len && isIdentChar(rawSource[end])) end++;
      const word = rawSource.slice(i, end);

      if (!inModule && word === 'module') {
        // Rewind to beginning of line so indentation stays intact
        let lineStart = i;
        while (lineStart > 0 && rawSource[lineStart - 1] !== '\n') lineStart--;
        const nameStart = skipWsAndComments(end);
        let nameEnd = nameStart;
        while (nameEnd < len && isIdentChar(rawSource[nameEnd])) nameEnd++;
        const name = rawSource.slice(nameStart, nameEnd);
        if (name) {
          inModule = true;
          modStart = lineStart;
          modName = name;
        }
        i = nameEnd;
        continue;
      }

      if (inModule && word === 'endmodule') {
        const snippet = rawSource.slice(modStart, end).replace(/^\n+|\s+$/g, '');
        if (modName && !result.has(modName)) {
          result.set(modName, snippet);
        }
        inModule = false;
        modName = '';
        i = end;
        continue;
      }

      i = end;
      continue;
    }
    i++;
  }

  return result;
}

/** Safely evaluate constant integer expressions like "4", "WIDTH-1", "N / 2", "$clog2(RATIO)", "-17'sd32768" without eval */
function evalParamExpr(expr: string, params: Map<string, number>): number | null {
  let s = expr.trim();
  // Normalize Verilog sized numeric literals (e.g. 17'sd32768, 8'hFF, 4'b1010) to plain integers
  s = s.replace(
    /\b(?:\d+)?'s?([bhdo])([0-9a-f_]+)\b/gi,
    (full, baseRaw: string, digitsRaw: string) => {
      const digits = digitsRaw.replace(/_/g, '');
      const radix =
        baseRaw.toLowerCase() === 'h'
          ? 16
          : baseRaw.toLowerCase() === 'b'
            ? 2
            : baseRaw.toLowerCase() === 'o'
              ? 8
              : 10;
      const v = parseInt(digits, radix);
      return Number.isFinite(v) ? String(v) : full;
    },
  );
  // Resolve SystemVerilog $clog2(...) calls from innermost outward
  for (let pass = 0; pass < 8 && /\$clog2\s*\(/.test(s); pass++) {
    const next = s.replace(/\$clog2\s*\(([^()]+)\)/g, (_, inner: string) => {
      const v = evalParamExpr(inner, params);
      if (v === null) return '__ERR__';
      const cl = v <= 1 ? 0 : Math.ceil(Math.log2(v));
      return String(cl);
    });
    if (next === s || next.includes('__ERR__')) return null;
    s = next;
  }
  for (const [k, v] of params.entries()) {
    s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v));
  }
  const tokens = s.match(/\d+|[+\-*/()]/g);
  if (!tokens || tokens.join('') !== s.replace(/\s+/g, '')) return null;

  let pos = 0;
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parseFactor();
      if (right === null || (op === '/' && right === 0)) return null;
      left = op === '*' ? left * right : Math.trunc(left / right);
    }
    return left;
  };
  const parseFactor = (): number | null => {
    if (tokens[pos] === '(') {
      pos++;
      const inner = parseExpr();
      if (tokens[pos] !== ')') return null;
      pos++;
      return inner;
    }
    if (tokens[pos] === '-') {
      pos++;
      const inner = parseFactor();
      return inner === null ? null : -inner;
    }
    const tok = tokens[pos++];
    if (!tok || !/^\d+$/.test(tok)) return null;
    return parseInt(tok, 10);
  };

  const val = parseExpr();
  return val !== null && pos === tokens.length && Number.isFinite(val) ? Math.trunc(val) : null;
}

function parseWidthSpec(spec: string | undefined, params: Map<string, number>): number {
  if (!spec) return 1;
  const m = spec.match(/\[\s*([^:\]]+)\s*:\s*([^\]]+)\s*\]/);
  if (!m) return 1;
  const msb = evalParamExpr(m[1], params);
  const lsb = evalParamExpr(m[2], params);
  if (msb === null || lsb === null) return 1;
  return Math.max(1, Math.min(64, Math.abs(msb - lsb) + 1));
}

/** Split a string by a single-char separator only at top-level bracket depth (outside (), {}, []) */
function splitTopLevel(str: string, sep = ','): string[] {
  const parts: string[] = [];
  let pDepth = 0;
  let bDepth = 0;
  let cDepth = 0;
  let buf = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') pDepth++;
    else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
    else if (ch === '[') bDepth++;
    else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
    else if (ch === '{') cDepth++;
    else if (ch === '}') cDepth = Math.max(0, cDepth - 1);
    if (ch === sep && pDepth === 0 && bDepth === 0 && cDepth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0 || parts.length > 0) parts.push(buf);
  return parts;
}

/** Find first top-level single `=` assignment operator (skipping ==, !=, <=, >=, ===, !==) */
function findTopLevelAssignEq(str: string): number {
  let pDepth = 0;
  let bDepth = 0;
  let cDepth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') pDepth++;
    else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
    else if (ch === '[') bDepth++;
    else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
    else if (ch === '{') cDepth++;
    else if (ch === '}') cDepth = Math.max(0, cDepth - 1);
    else if (ch === '=' && pDepth === 0 && bDepth === 0 && cDepth === 0) {
      const prev = i > 0 ? str[i - 1] : '';
      const next = i + 1 < str.length ? str[i + 1] : '';
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=') continue;
      return i;
    }
  }
  return -1;
}

function parseParamBlock(raw: string | undefined, params: Map<string, number>): void {
  if (!raw) return;
  for (const item of splitTopLevel(raw, ',')) {
    const m = item.match(
      /(?:parameter\s+)?(?:(?:int|integer|logic|bit)\s+)?(?:\[[^\]]+\]\s+)?(\w+)\s*=\s*([^,]+)/,
    );
    if (m) {
      const val = evalParamExpr(m[2], params);
      if (val !== null) params.set(m[1], val);
    }
  }
}

const PRIMITIVE_MAP: Record<string, GateType> = {
  and: 'AND',
  or: 'OR',
  xor: 'XOR',
  nand: 'NAND',
  nor: 'NOR',
  xnor: 'XNOR',
  not: 'NOT',
  buf: 'BUF',
};

const KEYWORDS = new Set([
  'module',
  'endmodule',
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'bit',
  'assign',
  'always',
  'always_comb',
  'always_ff',
  'always_latch',
  'initial',
  'final',
  'parameter',
  'localparam',
  'begin',
  'end',
  'if',
  'else',
  'for',
  'while',
  'repeat',
  'forever',
  'case',
  'casex',
  'casez',
  'endcase',
  'default',
  'interface',
  'endinterface',
  'task',
  'endtask',
  'function',
  'endfunction',
  'assert',
  'assume',
  'cover',
  'restrict',
  'expect',
  'property',
  'endproperty',
  'sequence',
  'endsequence',
  'covergroup',
  'endgroup',
  'clocking',
  'endclocking',
  'class',
  'endclass',
  'package',
  'endpackage',
  'specify',
  'endspecify',
  'generate',
  'endgenerate',
  'genvar',
  'typedef',
  'struct',
  'enum',
  'union',
  'import',
  'export',
  'return',
  'fork',
  'join',
  'wait',
  'disable',
  'force',
  'release',
  'deassign',
  'timeunit',
  'timeprecision',
  'real',
  'realtime',
  'integer',
  'int',
  'shortint',
  'longint',
  'byte',
  'time',
  'string',
  'void',
  'const',
  'static',
  'automatic',
  'signed',
  'unsigned',
  'unique',
  'priority',
  'posedge',
  'negedge',
  'edge',
  'and',
  'or',
  'xor',
  'nand',
  'nor',
  'xnor',
  'not',
  'buf',
]);

// --- Balanced begin/end & procedural block parser helpers ---

interface BlockRange {
  start: number;
  end: number;
  inner: string;
}

/** Given `src` and an index pointing at or right before a statement/begin-block, extract its balanced span */
function extractProceduralBody(src: string, fromIdx: number): BlockRange | null {
  let i = fromIdx;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (i >= src.length) return null;

  // Optional label: begin : lbl
  if (src.slice(i).startsWith('begin') && (i + 5 >= src.length || !/\w/.test(src[i + 5]))) {
    let cursor = i + 5;
    const lblMatch = src.slice(cursor).match(/^\s*:\s*\w+/);
    if (lblMatch) cursor += lblMatch[0].length;
    const innerStart = cursor;
    let depth = 1;
    const tokenRe = /\b(begin|end)\b/g;
    tokenRe.lastIndex = cursor;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(src)) !== null) {
      if (tm[1] === 'begin') depth++;
      else {
        depth--;
        if (depth === 0) {
          return { start: i, end: tm.index + 3, inner: src.slice(innerStart, tm.index) };
        }
      }
    }
    return { start: i, end: src.length, inner: src.slice(innerStart) };
  }

  // Case block: case (...) ... endcase
  if (/^(?:unique\s+|priority\s+)?case[xz]?\b/.test(src.slice(i))) {
    const endIdx = src.indexOf('endcase', i);
    if (endIdx !== -1) {
      return { start: i, end: endIdx + 7, inner: src.slice(i, endIdx + 7) };
    }
  }

  // If (...) stmt [else stmt]
  if (/^(?:unique\s+|priority\s+)?if\b/.test(src.slice(i))) {
    const parenOpen = src.indexOf('(', i);
    if (parenOpen !== -1) {
      let d = 0;
      let pClose = -1;
      for (let k = parenOpen; k < src.length; k++) {
        if (src[k] === '(') d++;
        else if (src[k] === ')') {
          d--;
          if (d === 0) {
            pClose = k;
            break;
          }
        }
      }
      if (pClose !== -1) {
        const thenPart = extractProceduralBody(src, pClose + 1);
        if (thenPart) {
          let endPos = thenPart.end;
          const afterThen = src.slice(endPos).match(/^\s*else\b/);
          if (afterThen) {
            const elsePart = extractProceduralBody(src, endPos + afterThen[0].length);
            if (elsePart) endPos = elsePart.end;
          }
          return { start: i, end: endPos, inner: src.slice(i, endPos) };
        }
      }
    }
  }

  // For (...) body
  if (/^for\s*\(/.test(src.slice(i))) {
    const parenOpen = src.indexOf('(', i);
    if (parenOpen !== -1) {
      let d = 0;
      let pClose = -1;
      for (let k = parenOpen; k < src.length; k++) {
        if (src[k] === '(') d++;
        else if (src[k] === ')') {
          d--;
          if (d === 0) {
            pClose = k;
            break;
          }
        }
      }
      if (pClose !== -1) {
        const loopBody = extractProceduralBody(src, pClose + 1);
        if (loopBody) {
          return { start: i, end: loopBody.end, inner: src.slice(i, loopBody.end) };
        }
      }
    }
  }

  // Single statement ending with ';'
  const semi = src.indexOf(';', i);
  if (semi === -1) return null;
  return { start: i, end: semi + 1, inner: src.slice(i, semi + 1) };
}

interface ArrayDeclInfo {
  elemWidth: number;
  dims: [number, number][];
  signed: boolean;
}

/** Statically unroll simple compile-time `for` loops inside always_ff / always_comb blocks */
function unrollForLoops(code: string, params: Map<string, number>, depth = 0): string {
  if (depth > 8 || !/\bfor\s*\(/.test(code)) return code;
  const re = /\bfor\s*\(/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    if (m.index < last) continue;
    const parenOpen = m.index + m[0].length - 1;
    let d = 0;
    let pClose = -1;
    for (let k = parenOpen; k < code.length; k++) {
      if (code[k] === '(') d++;
      else if (code[k] === ')') {
        d--;
        if (d === 0) {
          pClose = k;
          break;
        }
      }
    }
    if (pClose === -1) continue;
    const bodyBlk = extractProceduralBody(code, pClose + 1);
    if (!bodyBlk) continue;

    const header = code.slice(parenOpen + 1, pClose);
    const parts = header.split(';').map((s) => s.trim());
    if (parts.length !== 3) continue;

    const initM = parts[0].match(/^(?:(?:int|integer|genvar)\s+)?(\w+)\s*=\s*(.+)$/);
    if (!initM) continue;
    const varName = initM[1];
    const initVal = evalParamExpr(initM[2], params);
    if (initVal === null) continue;

    // Parse loop step: i++, ++i, i--, --i, i += k, i -= k, i = i + k, i = i - k
    const stepStr = parts[2];
    let stepDelta: number | null = null;
    if (new RegExp(`^${varName}\\s*\\+\\+$|^\\+\\+\\s*${varName}$`).test(stepStr)) {
      stepDelta = 1;
    } else if (new RegExp(`^${varName}\\s*--$|^--\\s*${varName}$`).test(stepStr)) {
      stepDelta = -1;
    } else {
      const addEq = stepStr.match(new RegExp(`^${varName}\\s*(\\+|-)=\\s*(.+)$`));
      if (addEq) {
        const delta = evalParamExpr(addEq[2], params);
        if (delta !== null) stepDelta = addEq[1] === '+' ? delta : -delta;
      } else {
        const assignStep = stepStr.match(
          new RegExp(`^${varName}\\s*=\\s*${varName}\\s*(\\+|-)\\s*(.+)$`),
        );
        if (assignStep) {
          const delta = evalParamExpr(assignStep[2], params);
          if (delta !== null) stepDelta = assignStep[1] === '+' ? delta : -delta;
        }
      }
    }
    if (stepDelta === null || stepDelta === 0) continue;

    // Parse condition: lhs (<= | >= | < | > | !=) rhs
    const condM = parts[1].match(/^(.+?)\s*(<=|>=|<|>|!=)\s*(.+)$/);
    if (!condM) continue;
    const condLhs = condM[1].trim();
    const condOp = condM[2];
    const condRhs = condM[3].trim();

    const evalCond = (curVal: number): boolean => {
      const localParams = new Map(params);
      localParams.set(varName, curVal);
      const lv = evalParamExpr(condLhs, localParams);
      const rv = evalParamExpr(condRhs, localParams);
      if (lv === null || rv === null) return false;
      if (condOp === '<') return lv < rv;
      if (condOp === '<=') return lv <= rv;
      if (condOp === '>') return lv > rv;
      if (condOp === '>=') return lv >= rv;
      if (condOp === '!=') return lv !== rv;
      return false;
    };

    out += code.slice(last, m.index);
    const varRe = new RegExp(`\\b${varName}\\b`, 'g');
    let unrolled = '';
    let cur = initVal;
    let iters = 0;
    while (evalCond(cur) && iters < 64) {
      const localParams = new Map(params);
      localParams.set(varName, cur);
      const substituted = bodyBlk.inner.replace(varRe, String(cur));
      unrolled += `${unrollForLoops(substituted, localParams, depth + 1)}\n`;
      cur += stepDelta;
      iters++;
    }
    out += unrolled;
    last = bodyBlk.end;
    re.lastIndex = last;
  }

  out += code.slice(last);
  return out;
}

/** Flatten constant-indexed unpacked array accesses like `integ_reg[i-1]` or `comb_delay_reg[0][0]` into scalar net names */
function flattenArrayAccesses(
  text: string,
  arrayDecls: Map<string, ArrayDeclInfo>,
  params: Map<string, number>,
): string {
  if (arrayDecls.size === 0) return text;
  let out = text;
  for (const [name, info] of arrayDecls.entries()) {
    const dimCount = info.dims.length;
    if (dimCount === 1) {
      const re1 = new RegExp(`\\b${name}\\s*\\[([^\\[\\]:]+)\\]`, 'g');
      out = out.replace(re1, (full, e0: string) => {
        const v0 = evalParamExpr(e0, params);
        return v0 !== null ? `${name}__${v0}` : full;
      });
    } else if (dimCount === 2) {
      const re2 = new RegExp(`\\b${name}\\s*\\[([^\\[\\]:]+)\\]\\s*\\[([^\\[\\]:]+)\\]`, 'g');
      out = out.replace(re2, (full, e0: string, e1: string) => {
        const v0 = evalParamExpr(e0, params);
        const v1 = evalParamExpr(e1, params);
        return v0 !== null && v1 !== null ? `${name}__${v0}__${v1}` : full;
      });
    }
  }
  return out;
}

/** Collect all scalar target net names assigned (`<=` or `=`) inside a procedural block */
function collectAssignedTargets(code: string): Set<string> {
  const targets = new Set<string>();
  const re = /\b([a-zA-Z_]\w*)\s*(?:<=|=(?!=))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const id = m[1];
    if (!KEYWORDS.has(id)) targets.add(id);
  }
  return targets;
}

/**
 * Extract an explicit enable condition when a register's next-state expression preserves itself on one branch:
 *   `(cond) ? (nextVal) : (target)` -> `{ enExpr: cond, dExpr: nextVal }`
 * Also collapses nested guards `(c1) ? ((c2) ? v : target) : target` -> `en = (c1) && (c2)`.
 */
function extractRegisterEnable(
  target: string,
  rawExpr: string,
): { enExpr?: string; dExpr: string } {
  const guards: string[] = [];
  let cur = stripOuterParens(rawExpr);

  for (let depth = 0; depth < 6; depth++) {
    const tern = findTopLevelTernary(cur);
    if (!tern) break;
    const cond = stripOuterParens(cur.slice(0, tern.qIdx));
    const tv = stripOuterParens(cur.slice(tern.qIdx + 1, tern.cIdx));
    const fv = stripOuterParens(cur.slice(tern.cIdx + 1));

    if (fv === target && tv !== target) {
      guards.push(cond);
      cur = tv;
    } else if (tv === target && fv !== target) {
      guards.push(`!(${cond})`);
      cur = fv;
    } else {
      break;
    }
  }

  if (guards.length === 0) return { dExpr: cur };
  const enExpr = guards.length === 1 ? guards[0] : guards.map((g) => `(${g})`).join(' && ');
  return { enExpr, dExpr: cur };
}

/** Strip non-synthesizable blocks (initial, final, task, function, property, sequence, assertions, system tasks) */
function stripNonSynthesizable(body: string): string {
  let out = body;

  // 1. Named end-delimited non-synthesizable constructs
  const pairBlocks = [
    ['task', 'endtask'],
    ['function', 'endfunction'],
    ['property', 'endproperty'],
    ['sequence', 'endsequence'],
    ['covergroup', 'endgroup'],
    ['clocking', 'endclocking'],
    ['class', 'endclass'],
    ['specify', 'endspecify'],
  ];
  for (const [kwStart, kwEnd] of pairBlocks) {
    out = out.replace(new RegExp(`\\b${kwStart}\\b[\\s\\S]*?\\b${kwEnd}\\b`, 'g'), ' ');
  }

  // 2. `initial` and `final` procedural blocks (begin...end or single statement)
  const stripKeywordProc = (text: string, kw: string): string => {
    const re = new RegExp(`\\b${kw}\\b`, 'g');
    let res = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index < last) continue;
      res += text.slice(last, m.index);
      const blk = extractProceduralBody(text, m.index + m[0].length);
      if (blk) {
        last = blk.end;
        re.lastIndex = last;
      } else {
        last = m.index + m[0].length;
      }
    }
    res += text.slice(last);
    return res;
  };
  out = stripKeywordProc(out, 'initial');
  out = stripKeywordProc(out, 'final');

  // 3. SystemVerilog assertions / assumptions / covers / expects (optional label, optional property/final/#0, optional else action)
  out = out.replace(
    /(?:\b\w+\s*:\s*)?\b(?:assert|assume|cover|restrict|expect)\b(?:\s+(?:property|sequence|final|#0))?\s*\([^;]*?(?:\belse\b[^;]*?)?;/g,
    ' ',
  );
  // Also strip multi-line assertions with nested parens using a scanner
  {
    const re = /(?:\b\w+\s*:\s*)?\b(?:assert|assume|cover|restrict|expect)\b/g;
    let res = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      if (m.index < last) continue;
      res += out.slice(last, m.index);
      let k = m.index + m[0].length;
      let pDepth = 0;
      while (k < out.length) {
        const ch = out[k];
        if (ch === '(') pDepth++;
        else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
        else if (ch === ';' && pDepth === 0) {
          k++;
          break;
        }
        k++;
      }
      last = k;
      re.lastIndex = last;
    }
    res += out.slice(last);
    out = res;
  }

  // 4. Standalone system task calls ($display, $finish, $monitor, $dumpvars, $error, etc.)
  // Never strip expression system functions like $clog2 / $bits / $signed / $unsigned!
  out = out.replace(
    /(^|[;\n]\s*)(?:#\s*(?:\([^)]*\)|\d+)\s*)?\$(?!clog2\b|bits\b|signed\b|unsigned\b|size\b|left\b|right\b|high\b|low\b)\w+\s*(?:\([\s\S]*?\))?\s*;/g,
    '$1 ',
  );

  // 5. Non-structural declarations: import, export, typedef, timeunit, timeprecision, genvar, real, string
  out = out.replace(
    /^\s*(?:import|export|typedef|timeunit|timeprecision|genvar|real|realtime|string|event)\b[^;]*;/gm,
    ' ',
  );

  return out;
}

/** Parse combinational statements (assigns, if/else, case) into target -> expression map */
function parseProceduralAssignments(
  blockText: string,
  prevMap: Map<string, string> = new Map(),
): Map<string, string> {
  const result = new Map(prevMap);
  let idx = 0;
  const src = blockText.trim();

  const skipWs = () => {
    while (idx < src.length && /\s/.test(src[idx])) idx++;
  };

  while (idx < src.length) {
    skipWs();
    if (idx >= src.length) break;

    // Strip any leading delay like `#5`
    const delayM = src.slice(idx).match(/^#\s*(?:\([^)]*\)|\d+)\s*/);
    if (delayM) {
      idx += delayM[0].length;
      continue;
    }

    // `if (cond) thenBlock [else elseBlock]`
    const ifM = src.slice(idx).match(/^(?:unique\s+|priority\s+)?if\s*\(/);
    if (ifM) {
      const condStart = idx + ifM[0].length;
      let d = 1;
      let k = condStart;
      while (k < src.length && d > 0) {
        if (src[k] === '(') d++;
        else if (src[k] === ')') d--;
        k++;
      }
      const condExpr = src.slice(condStart, k - 1).trim();
      const thenBlk = extractProceduralBody(src, k);
      if (!thenBlk) break;
      idx = thenBlk.end;

      const thenMap = parseProceduralAssignments(thenBlk.inner, result);
      let elseMap = new Map(result);
      const elseM = src.slice(idx).match(/^\s*else\b/);
      if (elseM) {
        const elseBlk = extractProceduralBody(src, idx + elseM[0].length);
        if (elseBlk) {
          idx = elseBlk.end;
          elseMap = parseProceduralAssignments(elseBlk.inner, result);
        }
      }

      // Merge targets via ternary MUX: (cond) ? thenVal : elseVal
      const allTargets = new Set([...thenMap.keys(), ...elseMap.keys()]);
      for (const t of allTargets) {
        const tv = thenMap.get(t);
        const ev = elseMap.get(t);
        if (tv !== undefined && ev !== undefined && tv !== ev) {
          result.set(t, `(${condExpr}) ? (${tv}) : (${ev})`);
        } else if (tv !== undefined) {
          result.set(t, tv);
        } else if (ev !== undefined) {
          result.set(t, ev);
        }
      }
      continue;
    }

    // `case (sel) ... endcase`
    const caseM = src.slice(idx).match(/^(?:unique\s+|priority\s+)?case[xz]?\s*\(([^)]+)\)/);
    if (caseM) {
      const selExpr = caseM[1].trim();
      const endCaseIdx = src.indexOf('endcase', idx);
      if (endCaseIdx === -1) break;
      const caseInner = src.slice(idx + caseM[0].length, endCaseIdx).trim();
      idx = endCaseIdx + 7;

      // Parse case items: `val: stmt;` or `default: stmt;`
      const branches: { cond: string | null; map: Map<string, string> }[] = [];
      let ci = 0;
      while (ci < caseInner.length) {
        while (ci < caseInner.length && /\s/.test(caseInner[ci])) ci++;
        if (ci >= caseInner.length) break;
        const colon = caseInner.indexOf(':', ci);
        if (colon === -1) break;
        const labelRaw = caseInner.slice(ci, colon).trim();
        const itemBlk = extractProceduralBody(caseInner, colon + 1);
        if (!itemBlk) break;
        ci = itemBlk.end;
        // Pass current `result` so guarded assignments inside a case item (e.g. `2'b01: if (carry_f) PC_we = 1'b1;`)
        // preserve the outer default instead of dropping the `if` condition!
        const itemMap = parseProceduralAssignments(itemBlk.inner, result);
        const isDefault = labelRaw === 'default';
        const cond = isDefault
          ? null
          : splitTopLevel(labelRaw, ',')
              .map((v) => `(${selExpr} == ${v.trim()})`)
              .join(' || ');
        branches.push({ cond, map: itemMap });
      }

      const targets = new Set<string>();
      for (const b of branches) {
        for (const [k, v] of b.map.entries()) {
          if (v !== result.get(k)) targets.add(k);
        }
      }
      const defaultBranch = branches.find((b) => b.cond === null);

      for (const t of targets) {
        const baseFallback = result.get(t);
        let expr = defaultBranch?.map.get(t) ?? baseFallback ?? '__case_undef__';
        for (let bi = branches.length - 1; bi >= 0; bi--) {
          const br = branches[bi];
          if (br.cond === null) continue;
          const val = br.map.get(t);
          if (val !== undefined && val !== baseFallback) {
            expr = `(${br.cond}) ? (${val}) : (${expr})`;
          }
        }
        result.set(t, expr);
      }
      continue;
    }

    // Regular assignment statement: `lhs <= rhs;` or `lhs = rhs;`
    const semi = src.indexOf(';', idx);
    if (semi === -1) break;
    const stmt = src.slice(idx, semi).trim();
    idx = semi + 1;
    if (!stmt) continue;

    // Ignore non-synthesizable statements inside always blocks (like $display or assert)
    if (stmt.startsWith('$') || /^(?:assert|assume|cover)\b/.test(stmt)) continue;

    const assignM = stmt.match(/^([\w[\]:{}, \t]+?)\s*(?:<=|=)\s*([\s\S]+)$/);
    if (assignM) {
      result.set(assignM[1].trim(), assignM[2].trim());
    }
  }

  return result;
}

/**
 * Extract & synthesize `always_comb`, `always @(*)`, `always_ff @(posedge ...)`, and `always @(posedge ...)` blocks!
 */
function extractAndSynthesizeAlwaysBlocks(
  body: string,
  modName: string,
  params: Map<string, number>,
  arrayDecls: Map<string, ArrayDeclInfo>,
  assigns: ParsedAssign[],
  ffs: ParsedFF[],
  warnings: string[],
): string {
  const re = /\b(always_comb|always_ff|always_latch|always)\b/g;
  let rest = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    if (m.index < last) continue;
    rest += body.slice(last, m.index);
    const kind = m[1];
    let cursor = m.index + m[0].length;
    while (cursor < body.length && /\s/.test(body[cursor])) cursor++;

    // Parse optional sensitivity list `@(...)` or `@*`
    let sens = '';
    if (body[cursor] === '@') {
      cursor++;
      while (cursor < body.length && /\s/.test(body[cursor])) cursor++;
      if (body[cursor] === '*') {
        sens = '*';
        cursor++;
      } else if (body[cursor] === '(') {
        let d = 1;
        const sStart = cursor + 1;
        cursor++;
        while (cursor < body.length && d > 0) {
          if (body[cursor] === '(') d++;
          else if (body[cursor] === ')') d--;
          cursor++;
        }
        sens = body.slice(sStart, cursor - 1).trim();
      }
    }

    const blk = extractProceduralBody(body, cursor);
    if (!blk) {
      last = cursor;
      continue;
    }
    last = blk.end;
    re.lastIndex = last;

    // Statically unroll compile-time `for` loops & flatten unpacked array accesses before procedural parsing!
    const expandedInner = flattenArrayAccesses(
      unrollForLoops(blk.inner, params),
      arrayDecls,
      params,
    );

    const isClocked = kind === 'always_ff' || /\b(?:posedge|negedge)\b/.test(sens);

    if (!isClocked) {
      // Combinational always_comb / always @(*) -> synthesize assigns, if/else, case!
      const map = parseProceduralAssignments(expandedInner);
      for (const [lhs, rhs] of map.entries()) {
        assigns.push({ lhs, rhs });
      }
      continue;
    }

    // Sequential always_ff / always @(posedge clk [or posedge/negedge rst])
    const edgeMatches = [...sens.matchAll(/\b(posedge|negedge)\s+(\w+)/g)];
    if (edgeMatches.length === 0) {
      warnings.push(`[${modName}] ${kind} のクロック信号を特定できなかったためスキップしました。`);
      continue;
    }

    const clkNet = edgeMatches[0][2];
    let asyncRstNet: string | undefined;
    let asyncRstLow = false;
    if (edgeMatches.length >= 2) {
      asyncRstNet = edgeMatches[1][2];
      asyncRstLow = edgeMatches[1][1] === 'negedge';
    }

    // Check top-level reset `if (rst) ... else ...` pattern inside clocked block
    const innerTrim = expandedInner.trim();
    const topIfM = innerTrim.match(/^(?:unique\s+|priority\s+)?if\s*\(/);
    let bodyToSynth = innerTrim;
    let resetInner = '';
    let detectedRstNet = asyncRstNet;
    let detectedRstLow = asyncRstLow;

    if (topIfM) {
      const cStart = topIfM[0].length;
      let d = 1;
      let k = cStart;
      while (k < innerTrim.length && d > 0) {
        if (innerTrim[k] === '(') d++;
        else if (innerTrim[k] === ')') d--;
        k++;
      }
      const cond = innerTrim.slice(cStart, k - 1).trim();
      const thenBlk = extractProceduralBody(innerTrim, k);
      const elseM = thenBlk ? innerTrim.slice(thenBlk.end).match(/^\s*else\b/) : null;
      const elseBlk =
        thenBlk && elseM ? extractProceduralBody(innerTrim, thenBlk.end + elseM[0].length) : null;

      // Recognize async or sync reset condition: `rst`, `!rst_n`, `~rst_n`, `rst == 1`, `rst_n == 0`
      const negRstM = cond.match(/^[!~]\s*(\w+)$/) ?? cond.match(/^(\w+)\s*==\s*(?:\d+'[bdh])?0$/);
      const posRstM = cond.match(/^(\w+)$/) ?? cond.match(/^(\w+)\s*==\s*(?:\d+'[bdh])?1$/);

      const isResetCond =
        (negRstM && (negRstM[1] === asyncRstNet || /rst|reset|clr/i.test(negRstM[1]))) ||
        (posRstM && (posRstM[1] === asyncRstNet || /rst|reset|clr/i.test(posRstM[1])));

      if (isResetCond && elseBlk) {
        if (negRstM) {
          detectedRstNet = negRstM[1];
          detectedRstLow = true;
        } else if (posRstM) {
          detectedRstNet = posRstM[1];
          detectedRstLow = false;
        }
        resetInner = thenBlk!.inner;
        bodyToSynth = elseBlk.inner.trim();
      }
    }

    // Seed every register assigned in this always_ff with self-hold (`target -> target`) so
    // partial conditional assignments (`if (en) reg <= next;`) preserve state on unmet branches!
    const allTargets = new Set<string>([
      ...collectAssignedTargets(resetInner),
      ...collectAssignedTargets(bodyToSynth),
    ]);
    const initHoldMap = new Map<string, string>();
    for (const t of allTargets) {
      initHoldMap.set(t, t);
    }

    const regAssigns = parseProceduralAssignments(bodyToSynth, initHoldMap);
    for (const [target, rawExpr] of regAssigns.entries()) {
      if (stripOuterParens(rawExpr) === target) continue;
      const { enExpr, dExpr } = extractRegisterEnable(target, rawExpr);
      ffs.push({
        target,
        clkNet,
        dExpr,
        enExpr,
        rstNet: detectedRstNet,
        rstActiveLow: detectedRstLow,
      });
    }
  }

  rest += body.slice(last);
  return rest;
}

function parseModules(source: string, warnings: string[]): ParsedModule[] {
  const clean = stripCommentsAndDirectives(source);
  const modules: ParsedModule[] = [];
  // Port list `(...)` is OPTIONAL so portless testbench modules like `module tb; ... endmodule` work!
  const modRegex =
    /\bmodule\s+(\w+)\s*(?:#\s*\(([\s\S]*?)\)\s*)?(?:\(([\s\S]*?)\)\s*)?;([\s\S]*?)\bendmodule\b/g;

  let m: RegExpExecArray | null;
  while ((m = modRegex.exec(clean)) !== null) {
    const modName = m[1];
    const paramHeaderRaw = m[2];
    const headerPortsRaw = (m[3] ?? '').trim();
    const rawBody = m[4];

    const params = new Map<string, number>();
    parseParamBlock(paramHeaderRaw, params);

    // Pre-scan body parameter / localparam declarations (including `signed` / `unsigned`)
    const paramBodyRegex =
      /\b(?:parameter|localparam)\s+(?:(?:int|integer|logic|bit|signed|unsigned)\s+)*(?:\[[^\]]+\]\s+)?(\w+)\s*=\s*([^;]+);/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramBodyRegex.exec(rawBody)) !== null) {
      const val = evalParamExpr(pm[2], params);
      if (val !== null) params.set(pm[1], val);
    }

    const portMap = new Map<string, ParsedPort>();
    const wires = new Map<string, number>();
    const signedNets = new Set<string>();
    const arrayDecls = new Map<string, ArrayDeclInfo>();
    const assigns: ParsedAssign[] = [];
    const ffs: ParsedFF[] = [];

    // Parse ANSI port declarations inside header: input logic [3:0] a, b, output logic y
    if (headerPortsRaw) {
      const parts = splitTopLevel(headerPortsRaw, ',');
      let curDir: 'in' | 'out' | null = null;
      let curWidth = 1;
      let curSigned = false;
      for (const rawPart of parts) {
        const partNoInit = rawPart.replace(/\s*=[\s\S]*$/, '').trim();
        if (!partNoInit) continue;
        const dirMatch = partNoInit.match(/^(input|output|inout)\b/);
        if (dirMatch) {
          curDir = dirMatch[1] === 'output' ? 'out' : 'in';
          curSigned = /\bsigned\b/.test(partNoInit);
          const wMatch = partNoInit.match(/(\[[^\]]+\])/);
          curWidth = wMatch ? parseWidthSpec(wMatch[1], params) : 1;
          const nameMatch = partNoInit.match(/(\w+)\s*$/);
          if (nameMatch) {
            portMap.set(nameMatch[1], { name: nameMatch[1], dir: curDir, bitWidth: curWidth });
            if (curSigned) signedNets.add(nameMatch[1]);
          }
        } else {
          if (/\bsigned\b/.test(partNoInit)) curSigned = true;
          const wMatch = partNoInit.match(/(\[[^\]]+\])/);
          if (wMatch) curWidth = parseWidthSpec(wMatch[1], params);
          const nameMatch = partNoInit.match(/(\w+)\s*$/);
          if (nameMatch) {
            portMap.set(nameMatch[1], {
              name: nameMatch[1],
              dir: curDir ?? 'in',
              bitWidth: curWidth,
            });
            if (curSigned) signedNets.add(nameMatch[1]);
          }
        }
      }
    }

    // 1. Strip non-synthesizable statements (assert, initial, final, task, function, $display, etc.)
    const synthBody = stripNonSynthesizable(rawBody);

    // 1b. Pre-scan wire/logic/reg declarations (including 1D/2D unpacked arrays & `signed` flags) BEFORE always unrolling!
    const preDeclRe =
      /\b(?:wire|logic|reg|bit)\s+(?:(signed|unsigned)\s+)?(\[[^\]]+\]\s*)?([^;]+);/g;
    let pd: RegExpExecArray | null;
    while ((pd = preDeclRe.exec(synthBody)) !== null) {
      const isSigned = pd[1] === 'signed';
      const elemWidth = parseWidthSpec(pd[2]?.trim(), params);
      for (const item of splitTopLevel(pd[3], ',')) {
        const tr = item.trim();
        if (!tr || findTopLevelAssignEq(tr) !== -1) continue;
        const arrM = tr.match(/^(\w+)\s*((?:\[[^\]]+\]\s*)+)$/);
        if (arrM) {
          const arrName = arrM[1];
          const dimMatches = [...arrM[2].matchAll(/\[\s*([^:\]]+)\s*:\s*([^\]]+)\s*\]/g)];
          const dims: [number, number][] = [];
          for (const dm of dimMatches) {
            const a = evalParamExpr(dm[1], params);
            const b = evalParamExpr(dm[2], params);
            if (a !== null && b !== null) dims.push([Math.min(a, b), Math.max(a, b)]);
          }
          if (dims.length >= 1 && dims.length <= 2) {
            arrayDecls.set(arrName, { elemWidth, dims, signed: isSigned });
            if (dims.length === 1) {
              for (let i = dims[0][0]; i <= dims[0][1] && i - dims[0][0] < 64; i++) {
                const flat = `${arrName}__${i}`;
                wires.set(flat, elemWidth);
                if (isSigned) signedNets.add(flat);
              }
            } else {
              for (let i = dims[0][0]; i <= dims[0][1] && i - dims[0][0] < 32; i++) {
                for (let j = dims[1][0]; j <= dims[1][1] && j - dims[1][0] < 32; j++) {
                  const flat = `${arrName}__${i}__${j}`;
                  wires.set(flat, elemWidth);
                  if (isSigned) signedNets.add(flat);
                }
              }
            }
          }
        } else if (/^\w+$/.test(tr)) {
          wires.set(tr, elemWidth);
          if (isSigned) signedNets.add(tr);
        }
      }
    }

    // 2. Extract & synthesize always_comb / always / always_ff blocks
    const body = extractAndSynthesizeAlwaysBlocks(
      synthBody,
      modName,
      params,
      arrayDecls,
      assigns,
      ffs,
      warnings,
    );

    const statements = body
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const primitives: ParsedModule['primitives'] = [];
    const instances: ParsedInst[] = [];

    for (const stmt of statements) {
      if (/^(?:parameter|localparam|generate|endgenerate)\b/.test(stmt)) continue;

      // Non-ANSI port declarations in body
      const ioDecl = stmt.match(
        /^(input|output|inout)\s+(?:(?:wire|reg|logic|bit|signed|unsigned)\s+)*(\[[^\]]+\])?\s*(.+)$/,
      );
      if (ioDecl) {
        const dir: 'in' | 'out' = ioDecl[1] === 'output' ? 'out' : 'in';
        const isSigned = /\bsigned\b/.test(stmt);
        const width = parseWidthSpec(ioDecl[2], params);
        for (const n of ioDecl[3].split(',')) {
          const name = n.trim().split(/\s+/).pop();
          if (name && /^\w+$/.test(name)) {
            portMap.set(name, { name, dir, bitWidth: width });
            if (isSigned) signedNets.add(name);
          }
        }
        continue;
      }

      // Wire / logic / reg declarations (supports inline init: logic [3:0] w = {a, b}, x = c;)
      const wireDecl = stmt.match(
        /^(?:wire|logic|reg|bit)\s+(?:(signed|unsigned)\s+)?(\[[^\]]+\])?\s*([\s\S]+)$/,
      );
      if (wireDecl) {
        const isSigned = wireDecl[1] === 'signed';
        const width = parseWidthSpec(wireDecl[2], params);
        for (const n of splitTopLevel(wireDecl[3], ',')) {
          const trimmed = n.trim();
          const eqIdx = findTopLevelAssignEq(trimmed);
          if (eqIdx !== -1) {
            const lhs = flattenArrayAccesses(trimmed.slice(0, eqIdx).trim(), arrayDecls, params);
            const rhs = flattenArrayAccesses(trimmed.slice(eqIdx + 1).trim(), arrayDecls, params);
            if (/^\w+$/.test(lhs)) {
              wires.set(lhs, width);
              if (isSigned) signedNets.add(lhs);
            }
            if (lhs && rhs) assigns.push({ lhs, rhs });
          } else if (/^\w+$/.test(trimmed)) {
            wires.set(trimmed, width);
            if (isSigned) signedNets.add(trimmed);
          }
        }
        continue;
      }

      // Continuous assignment: assign [#delay] a = b & c, d = e | f; or assign {cout, s} = a + b + cin;
      const assignHead = stmt.match(
        /^assign\s+(?:\([^)]*\)\s*)?(?:#\s*(?:\([^)]*\)|\d+(?:\.\d+)?)\s*)?([\s\S]+)$/,
      );
      if (assignHead) {
        for (const item of splitTopLevel(assignHead[1], ',')) {
          const eqIdx = findTopLevelAssignEq(item);
          if (eqIdx !== -1) {
            const lhs = flattenArrayAccesses(item.slice(0, eqIdx).trim(), arrayDecls, params);
            const rhs = flattenArrayAccesses(item.slice(eqIdx + 1).trim(), arrayDecls, params);
            if (lhs && rhs) assigns.push({ lhs, rhs });
          }
        }
        continue;
      }

      // Built-in gate primitive: and u1 (y, a, b); or and (y, a, b);
      const primMatch = stmt.match(
        /^(and|or|xor|nand|nor|xnor|not|buf)\s*(?:(\w+)\s*)?\(([\s\S]+)\)$/,
      );
      if (primMatch) {
        const kind = PRIMITIVE_MAP[primMatch[1]];
        const instName = primMatch[2] || primMatch[1];
        const args = primMatch[3]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (args.length >= 2) {
          primitives.push({ kind, instName, outNet: args[0], inNets: args.slice(1) });
        }
        continue;
      }

      // Module instantiation MUST have whitespace (or `#(...)`) between moduleName and instName!
      // Prevents function-like statements (e.g. `assert(...)`) from ever being split into `asser` + `t`!
      const instMatch = stmt.match(/^(\w+)(?:\s*#\s*\([\s\S]*?\)\s*|\s+)(\w+)\s*\(([\s\S]*)\)$/);
      if (instMatch && !KEYWORDS.has(instMatch[1]) && !KEYWORDS.has(instMatch[2])) {
        const targetMod = instMatch[1];
        const instName = instMatch[2];
        const portList = instMatch[3].trim();
        const conns: { portName?: string; signal: string }[] = [];
        if (portList) {
          let depth = 0;
          let buf = '';
          const rawConns: string[] = [];
          for (const ch of portList) {
            if (ch === '(' || ch === '{') depth++;
            else if (ch === ')' || ch === '}') depth--;
            if (ch === ',' && depth === 0) {
              rawConns.push(buf.trim());
              buf = '';
            } else {
              buf += ch;
            }
          }
          if (buf.trim()) rawConns.push(buf.trim());

          for (const rc of rawConns) {
            const named = rc.match(/^\.(\w+)\s*\(\s*([\s\S]*?)\s*\)$/);
            if (named) {
              conns.push({ portName: named[1], signal: named[2] || named[1] });
            } else if (/^\.\w+$/.test(rc)) {
              const nm = rc.slice(1);
              conns.push({ portName: nm, signal: nm });
            } else if (rc && rc !== '.*') {
              conns.push({ signal: rc });
            }
          }
        }
        instances.push({ moduleName: targetMod, instName, conns });
        continue;
      }
    }

    modules.push({
      name: modName,
      params,
      ports: Array.from(portMap.values()),
      wires,
      signedNets,
      assigns,
      ffs,
      primitives,
      instances,
    });
  }

  return modules;
}

interface NetEntry {
  drivers: PinRef[];
  sinks: PinRef[];
}

interface SynthContext {
  modName: string;
  gates: GateInstance[];
  netPinMap: Map<string, NetEntry>;
  netWidths: Map<string, number>;
  signedNets: Set<string>;
  params: Map<string, number>;
  bitSplitCache: Map<string, string>;
  rangeSplitCache: Map<string, string>;
  constCache: Map<string, string>;
  exprCache: Map<string, string>;
  warnings: string[];
  warnedIssues: Set<string>;
}

const MAX_GATES_PER_MODULE = 2500;
const MAX_EXPR_DEPTH = 48;
const MAX_EXPR_LENGTH = 8192;

function warnOnce(ctx: SynthContext, key: string, message: string): void {
  if (ctx.warnedIssues.has(key)) return;
  ctx.warnedIssues.add(key);
  ctx.warnings.push(message);
}

function ensureNetEntry(map: Map<string, NetEntry>, name: string): NetEntry {
  let e = map.get(name);
  if (!e) {
    e = { drivers: [], sinks: [] };
    map.set(name, e);
  }
  return e;
}

function addNetDriver(map: Map<string, NetEntry>, name: string, ref: PinRef): void {
  const e = ensureNetEntry(map, name);
  if (!e.drivers.some((d) => d.gateId === ref.gateId && d.pinId === ref.pinId)) {
    e.drivers.push(ref);
  }
}

function addNetSink(map: Map<string, NetEntry>, name: string, ref: PinRef): void {
  const e = ensureNetEntry(map, name);
  if (!e.sinks.some((s) => s.gateId === ref.gateId && s.pinId === ref.pinId)) {
    e.sinks.push(ref);
  }
}

function stripOuterParens(raw: string): string {
  let expr = raw.trim();
  while (expr.startsWith('(') && expr.endsWith(')')) {
    let d = 0;
    let wrapsAll = true;
    for (let i = 0; i < expr.length - 1; i++) {
      if (expr[i] === '(') d++;
      else if (expr[i] === ')') d--;
      if (d === 0) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

function hasOuterWrappingBraces(expr: string): boolean {
  if (!expr.startsWith('{') || !expr.endsWith('}')) return false;
  let d = 0;
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '{') d++;
    else if (expr[i] === '}') d--;
    if (d === 0) return false;
  }
  return true;
}

function parseVerilogLiteral(
  expr: string,
): { value: string; width?: number; fillChar?: string } | null {
  const fill = expr.match(/^'([01xz])$/i);
  if (fill) {
    return { value: fill[1].toLowerCase(), fillChar: fill[1].toLowerCase() };
  }
  const lit = expr.match(/^(\d+)?'s?([bhdo])([0-9a-fxz_?]+)$/i);
  if (lit) {
    const w = lit[1] ? parseInt(lit[1], 10) : undefined;
    const base = lit[2].toLowerCase();
    const digits = lit[3].replace(/_/g, '').replace(/\?/g, 'z').toLowerCase();
    if (base === 'h') return { value: `0x${digits}`, width: w };
    if (base === 'b') return { value: `0b${digits}`, width: w };
    if (base === 'o') {
      const bin = digits
        .split('')
        .map((c) => {
          if (c === 'x' || c === 'z') return c.repeat(3);
          const n = parseInt(c, 8);
          return Number.isNaN(n) ? 'xxx' : n.toString(2).padStart(3, '0');
        })
        .join('');
      return { value: `0b${bin}`, width: w };
    }
    return { value: digits, width: w };
  }
  if (/^\d+$/.test(expr)) {
    return { value: expr };
  }
  return null;
}

/** Parse a non-negative constant integer literal or parameter expression (returns null if X/Z or non-constant) */
function parseConstInt(exprRaw: string, params: Map<string, number>): number | null {
  const expr = stripOuterParens(exprRaw);
  const lit = parseVerilogLiteral(expr);
  if (lit && !lit.fillChar) {
    if (/[xz]/i.test(lit.value)) return null;
    if (lit.value.startsWith('0b')) {
      const n = parseInt(lit.value.slice(2), 2);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (lit.value.startsWith('0x')) {
      const n = parseInt(lit.value.slice(2), 16);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const n = parseInt(lit.value, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const evald = evalParamExpr(expr, params);
  return evald !== null && evald >= 0 ? evald : null;
}

function findTopLevelOp(expr: string, ops: string[]): { idx: number; op: string } | null {
  let pDepth = 0;
  let bDepth = 0;
  let cDepth = 0;
  for (let i = expr.length - 1; i >= 0; i--) {
    const ch = expr[i];
    if (ch === ')') pDepth++;
    else if (ch === '(') pDepth--;
    else if (ch === ']') bDepth++;
    else if (ch === '[') bDepth--;
    else if (ch === '}') cDepth++;
    else if (ch === '{') cDepth--;
    if (pDepth !== 0 || bDepth !== 0 || cDepth !== 0) continue;
    for (const op of ops) {
      if (i + op.length > expr.length) continue;
      if (expr.slice(i, i + op.length) !== op) continue;
      const prev = i > 0 ? expr[i - 1] : '';
      const next = i + op.length < expr.length ? expr[i + op.length] : '';
      if (op === '&' && (prev === '&' || next === '&' || prev === '~')) continue;
      if (op === '|' && (prev === '|' || next === '|' || prev === '~')) continue;
      if (op === '^' && (prev === '~' || next === '~')) continue;
      if (op === '<' && (prev === '<' || next === '=' || next === '<')) continue;
      if (op === '>' && (prev === '>' || next === '=' || next === '>')) continue;
      if (op === '<<' && (prev === '<' || next === '<')) continue;
      if (op === '>>' && (prev === '>' || next === '>')) continue;
      if (op === '==' && (prev === '=' || next === '=' || prev === '!')) continue;
      if (op === '!=' && next === '=') continue;
      if (op === '-') {
        // Skip unary minus (at start or immediately after another operator)
        let j = i - 1;
        while (j >= 0 && /\s/.test(expr[j])) j--;
        if (j < 0 || /[+\-*/%&|^~!?:=<>(,[{]/.test(expr[j])) continue;
      }
      return { idx: i, op };
    }
  }
  return null;
}

/** Find top-level ternary `?` and matching `:` respecting (), {}, [] */
function findTopLevelTernary(expr: string): { qIdx: number; cIdx: number } | null {
  let pDepth = 0;
  let bDepth = 0;
  let cDepth = 0;
  let qIdx = -1;
  let qNest = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') pDepth++;
    else if (ch === ')') pDepth--;
    else if (ch === '[') bDepth++;
    else if (ch === ']') bDepth--;
    else if (ch === '{') cDepth++;
    else if (ch === '}') cDepth--;
    else if (pDepth === 0 && bDepth === 0 && cDepth === 0) {
      if (ch === '?') {
        if (qIdx === -1) qIdx = i;
        qNest++;
      } else if (ch === ':' && qIdx !== -1) {
        qNest--;
        if (qNest === 0) {
          return { qIdx, cIdx: i };
        }
      }
    }
  }
  return null;
}

/** Parse a bit-select `sig[idx]`, part-select `sig[hi:lo]`, or indexed part-select `sig[base -: width]` / `sig[base +: width]` */
function parseSliceExpr(
  exprRaw: string,
  params: Map<string, number>,
): { base: string; hi: number; lo: number } | null {
  const s = exprRaw.trim();
  const indexed = s.match(/^(\w+)\[\s*([^\]]+?)\s*([+-]):\s*([^\]]+?)\s*\]$/);
  if (indexed) {
    const baseIdx = evalParamExpr(indexed[2], params);
    const width = evalParamExpr(indexed[4], params);
    if (baseIdx === null || width === null || width <= 0) return null;
    const hi = indexed[3] === '-' ? baseIdx : baseIdx + width - 1;
    const lo = indexed[3] === '-' ? baseIdx - width + 1 : baseIdx;
    if (hi < 0 || lo < 0) return null;
    return hi >= lo ? { base: indexed[1], hi, lo } : { base: indexed[1], hi: lo, lo: hi };
  }
  const m = s.match(/^(\w+)\[\s*([^:\]]+?)(?:\s*:\s*([^\]]+?))?\s*\]$/);
  if (!m) return null;
  const hi = evalParamExpr(m[2], params);
  const lo = m[3] !== undefined ? evalParamExpr(m[3], params) : hi;
  if (hi === null || lo === null || hi < 0 || lo < 0) return null;
  return hi >= lo ? { base: m[1], hi, lo } : { base: m[1], hi: lo, lo: hi };
}

/** Expand replication `{N{a, b}}` and split concatenation `{a, b, ...}` into MSB-first element expressions */
function expandConcatItems(expr: string, params: Map<string, number>): string[] {
  const inner = expr.slice(1, -1).trim();
  const rawItems = splitTopLevel(inner, ',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const item of rawItems) {
    // Replication: `{N{body}}`
    const repM = item.match(/^\{\s*([^{}]+?)\s*\{([\s\S]+)\}\s*\}$/);
    if (repM) {
      const count = evalParamExpr(repM[1], params);
      if (count !== null && count >= 1 && count <= 64) {
        const subItems = expandConcatItems(`{${repM[2]}}`, params);
        for (let k = 0; k < count; k++) out.push(...subItems);
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

function inferExprWidth(
  exprRaw: string,
  netWidths: Map<string, number>,
  fallback: number,
  params?: Map<string, number>,
): number {
  const expr = stripOuterParens(exprRaw);
  const lit = parseVerilogLiteral(expr);
  if (lit?.width) return lit.width;
  if (netWidths.has(expr)) return netWidths.get(expr)!;
  if (params) {
    const sl = parseSliceExpr(expr, params);
    if (sl) return sl.hi - sl.lo + 1;
    if (hasOuterWrappingBraces(expr)) {
      const items = expandConcatItems(expr, params);
      if (items.length > 0) {
        return items.reduce((acc, it) => acc + inferExprWidth(it, netWidths, 1, params), 0);
      }
    }
  }
  return fallback;
}

/** Synthesize a bit-select or part-select from `baseNet[hi:lo]` using a SPLITTER gate */
function synthesizeSlice(baseNet: string, hi: number, lo: number, ctx: SynthContext): string {
  const sliceW = hi - lo + 1;
  const baseW = Math.max(ctx.netWidths.get(baseNet) ?? 1, hi + 1);
  ctx.netWidths.set(baseNet, baseW);

  if (lo === 0 && hi === baseW - 1) {
    return baseNet;
  }

  // Share a single 1-bit SPLITTER per base signal when extracting individual bits (W <= 16)
  if (hi === lo && baseW <= 16) {
    let splId = ctx.bitSplitCache.get(baseNet);
    if (!splId) {
      splId = uid('spl');
      ctx.gates.push({
        id: splId,
        type: 'SPLITTER',
        x: 0,
        y: 0,
        rotation: 0,
        label: baseNet,
        props: { splitMode: 'split', splitWidths: Array(baseW).fill(1), bitWidth: baseW },
      });
      addNetSink(ctx.netPinMap, baseNet, { gateId: splId, pinId: 'bus' });
      ctx.bitSplitCache.set(baseNet, splId);
    }
    const outNet = `__slice_${splId}_b${lo}`;
    addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: `b${lo}` });
    ctx.netWidths.set(outNet, 1);
    return outNet;
  }

  const cacheKey = `${baseNet}:${hi}:${lo}`;
  const cached = ctx.rangeSplitCache.get(cacheKey);
  if (cached) return cached;

  const widths: number[] = [];
  let slicePinIdx = 0;
  if (lo > 0) {
    widths.push(lo);
    slicePinIdx = 1;
  }
  widths.push(sliceW);
  if (hi + 1 < baseW) {
    widths.push(baseW - 1 - hi);
  }

  const splId = uid('spl');
  ctx.gates.push({
    id: splId,
    type: 'SPLITTER',
    x: 0,
    y: 0,
    rotation: 0,
    label: `${baseNet}[${hi}:${lo}]`,
    props: { splitMode: 'split', splitWidths: widths, bitWidth: baseW },
  });
  addNetSink(ctx.netPinMap, baseNet, { gateId: splId, pinId: 'bus' });
  const outNet = `__slice_${splId}_b${slicePinIdx}`;
  addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: `b${slicePinIdx}` });
  ctx.netWidths.set(outNet, sliceW);
  ctx.rangeSplitCache.set(cacheKey, outNet);
  return outNet;
}

/** Parse `(sel == k0) || (sel == k1)` into `{ selExpr, keys }` for multi-input MUX detection */
function parseSelectorEqCondition(
  condRaw: string,
  params: Map<string, number>,
): { selExpr: string; keys: number[] } | null {
  const cond = stripOuterParens(condRaw);
  // Split top-level `||`
  const terms: string[] = [];
  let remaining = cond;
  while (true) {
    const found = findTopLevelOp(remaining, ['||']);
    if (!found) {
      terms.unshift(remaining.trim());
      break;
    }
    terms.unshift(remaining.slice(found.idx + 2).trim());
    remaining = remaining.slice(0, found.idx).trim();
  }

  let commonSel: string | null = null;
  const keys: number[] = [];
  for (const rawTerm of terms) {
    const term = stripOuterParens(rawTerm);
    const eq = findTopLevelOp(term, ['===', '==']);
    if (!eq) return null;
    const lhs = stripOuterParens(term.slice(0, eq.idx));
    const rhs = stripOuterParens(term.slice(eq.idx + eq.op.length));
    const rhsInt = parseConstInt(rhs, params);
    const lhsInt = parseConstInt(lhs, params);
    let selPart: string;
    let keyVal: number;
    if (rhsInt !== null && lhsInt === null) {
      selPart = lhs;
      keyVal = rhsInt;
    } else if (lhsInt !== null && rhsInt === null) {
      selPart = rhs;
      keyVal = lhsInt;
    } else {
      return null;
    }
    if (keyVal < 0 || keyVal > 15) return null;
    if (commonSel === null) commonSel = selPart;
    else if (commonSel !== selPart) return null;
    keys.push(keyVal);
  }
  return commonSel && keys.length > 0 ? { selExpr: commonSel, keys } : null;
}

/**
 * Detect chained equality ternary / `case (sel)` / `if-else if` patterns and synthesize
 * a SINGLE multi-input MUX gate (2..16 channels) instead of chained comparators + 2:1 MUXes!
 */
function tryBuildMultiMux(expr: string, ctx: SynthContext, bitWidth: number): string | null {
  let cur = expr;
  let selExpr: string | null = null;
  const branchMap = new Map<number, string>();
  let levels = 0;

  while (true) {
    const trimmed = stripOuterParens(cur);
    const tern = findTopLevelTernary(trimmed);
    if (!tern) break;
    const condStr = trimmed.slice(0, tern.qIdx).trim();
    const trueStr = stripOuterParens(trimmed.slice(tern.qIdx + 1, tern.cIdx));
    const falseStr = trimmed.slice(tern.cIdx + 1).trim();

    const parsed = parseSelectorEqCondition(condStr, ctx.params);
    if (!parsed) return null;
    if (selExpr === null) selExpr = parsed.selExpr;
    else if (selExpr !== parsed.selExpr) return null;

    for (const k of parsed.keys) {
      if (!branchMap.has(k)) branchMap.set(k, trueStr);
    }
    levels++;
    cur = falseStr;
  }

  if (!selExpr || levels < 2 || branchMap.size < 2) return null;

  const fallbackExpr = stripOuterParens(cur);
  const maxKey = Math.max(...branchMap.keys());
  const isUndefFallback =
    fallbackExpr === '__case_undef__' ||
    /^'x$/i.test(fallbackExpr) ||
    /^(?:\d+)?'s?b[x_]+$/i.test(fallbackExpr);

  const inferredSelW = inferExprWidth(
    selExpr,
    ctx.netWidths,
    Math.max(1, Math.ceil(Math.log2(maxKey + (isUndefFallback ? 1 : 2)))),
    ctx.params,
  );
  const selW = Math.max(1, Math.min(4, inferredSelW));
  const maxSlots = Math.min(16, 1 << selW);
  if (maxKey >= maxSlots) return null;

  let channels: number;
  const channelExprs: string[] = [];

  if (isUndefFallback) {
    channels = Math.min(16, Math.max(2, maxKey + 1));
    for (let i = 0; i < channels; i++) {
      channelExprs.push(branchMap.get(i) ?? `${bitWidth}'b${'x'.repeat(bitWidth)}`);
    }
  } else {
    // Check if all 0..maxSlots-1 are already covered -> ignore unreachable fallback
    let allCovered = true;
    for (let i = 0; i < maxSlots; i++) {
      if (!branchMap.has(i)) {
        allCovered = false;
        break;
      }
    }
    channels = maxSlots;
    for (let i = 0; i < channels; i++) {
      channelExprs.push(allCovered ? branchMap.get(i)! : (branchMap.get(i) ?? fallbackExpr));
    }
  }

  const selectBits = Math.max(1, Math.ceil(Math.log2(channels)));
  const selNet = buildExprGate(selExpr, ctx, selectBits);

  // Deduplicate identical channel expressions (e.g. shared default branches) so we don't spawn redundant CONST gates
  const exprToNet = new Map<string, string>();
  const dataNets = channelExprs.map((ce) => {
    const existing = exprToNet.get(ce);
    if (existing) return existing;
    const net = buildExprGate(ce, ctx, bitWidth);
    exprToNet.set(ce, net);
    return net;
  });

  const gid = uid('g');
  ctx.gates.push({
    id: gid,
    type: 'MUX',
    x: 0,
    y: 0,
    rotation: 0,
    label: `${channels}:1 MUX`,
    props: { bitWidth, inputCount: channels, selectBits },
  });
  dataNets.forEach((dn, idx) => {
    addNetSink(ctx.netPinMap, dn, { gateId: gid, pinId: `d${idx}` });
  });
  addNetSink(ctx.netPinMap, selNet, { gateId: gid, pinId: 'sel' });

  const outNet = `__mux_${gid}`;
  addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
  ctx.netWidths.set(outNet, bitWidth);
  return outNet;
}

/** Shared constant CONST gate creator so identical literals (e.g. 1'b0, 1'b1) are deduplicated per module */
function getOrCreateConstNet(
  bitWidth: number,
  val: string,
  label: string,
  ctx: SynthContext,
): string {
  const canonicalBits = toBinString(fromLiteral(val, bitWidth));
  const key = `${bitWidth}:${canonicalBits}`;
  const cached = ctx.constCache.get(key);
  if (cached) return cached;

  const constGateId = uid('g');
  ctx.gates.push({
    id: constGateId,
    type: 'CONST',
    x: 0,
    y: 0,
    rotation: 0,
    label,
    props: { bitWidth, value: val },
  });
  const tempNet = `__const_${constGateId}`;
  addNetDriver(ctx.netPinMap, tempNet, { gateId: constGateId, pinId: 'out' });
  ctx.netWidths.set(tempNet, bitWidth);
  ctx.constCache.set(key, tempNet);
  return tempNet;
}

/** Synthesize boolean/arithmetic/comparison/ternary/concat/slice/shift expression in `assign` or `always` into gates */
function buildExprGate(exprRaw: string, ctx: SynthContext, bitWidth: number, depth = 0): string {
  const expr = stripOuterParens(exprRaw);
  if (!expr) return expr;

  // Safety guards against pathological expression depth, huge expanded strings, or gate explosion
  if (depth > MAX_EXPR_DEPTH || expr.length > MAX_EXPR_LENGTH) {
    warnOnce(
      ctx,
      'expr_limit',
      `[${ctx.modName}] 非常に複雑または長大な式を検出したため、一部を定数 X として安全に省略しました。`,
    );
    return getOrCreateConstNet(bitWidth, `0b${'x'.repeat(bitWidth)}`, `${bitWidth}'bx`, ctx);
  }
  if (ctx.gates.length >= MAX_GATES_PER_MODULE) {
    warnOnce(
      ctx,
      'gate_limit',
      `[${ctx.modName}] 合成ゲート数が上限（${MAX_GATES_PER_MODULE}）に達したため、残りの式を安全に省略しました。`,
    );
    return getOrCreateConstNet(bitWidth, `0b${'x'.repeat(bitWidth)}`, `${bitWidth}'bx`, ctx);
  }

  // Unspecified case fallback -> X constant
  if (expr === '__case_undef__') {
    return getOrCreateConstNet(bitWidth, `0b${'x'.repeat(bitWidth)}`, `${bitWidth}'bx`, ctx);
  }

  // Constant literal like 1'b0, 4'hA, 1'bx, 1'bz, '0, '1, 0, 1, 42
  const parsedLit = parseVerilogLiteral(expr);
  if (parsedLit) {
    const w = parsedLit.width ?? bitWidth;
    const val = parsedLit.fillChar ? `0b${parsedLit.fillChar.repeat(w)}` : parsedLit.value;
    return getOrCreateConstNet(w, val, expr, ctx);
  }

  // Parameter constant identifier or compile-time constant expression (e.g. `RATIO - 1`, `STAGES - 1`, `-17'sd32768`)
  if (/^\w+$/.test(expr) && ctx.params.has(expr) && !ctx.netWidths.has(expr)) {
    const pVal = ctx.params.get(expr)!;
    return getOrCreateConstNet(bitWidth, String(pVal), expr, ctx);
  }
  const evalConst = evalParamExpr(expr, ctx.params);
  if (evalConst !== null && !ctx.netWidths.has(expr)) {
    return getOrCreateConstNet(bitWidth, String(evalConst), String(evalConst), ctx);
  }

  // Reuse already-synthesized identical pure subexpressions (e.g. shared `opcode[3:2] == 2'b11` comparators!)
  const exprCacheKey = `${bitWidth}:${expr.replace(/\s+/g, ' ')}`;
  const cachedExprNet = ctx.exprCache.get(exprCacheKey);
  if (cachedExprNet) return cachedExprNet;
  const memo = (net: string): string => {
    ctx.exprCache.set(exprCacheKey, net);
    return net;
  };

  // Concatenation / Replication `{a, b, ...}` or `{4{a}}`
  if (hasOuterWrappingBraces(expr)) {
    const msbFirst = expandConcatItems(expr, ctx.params);
    if (msbFirst.length > 0) {
      const lsbFirst = [...msbFirst].reverse();
      const widths = lsbFirst.map((item) => inferExprWidth(item, ctx.netWidths, 1, ctx.params));
      const totalW = widths.reduce((a, b) => a + b, 0);
      const srcNets = lsbFirst.map((item, idx) => buildExprGate(item, ctx, widths[idx], depth + 1));
      if (srcNets.length === 1) return memo(srcNets[0]);

      const splId = uid('cat');
      ctx.gates.push({
        id: splId,
        type: 'SPLITTER',
        x: 0,
        y: 0,
        rotation: 0,
        label: 'CONCAT',
        props: { splitMode: 'merge', splitWidths: widths, bitWidth: totalW },
      });
      srcNets.forEach((sn, idx) => {
        addNetSink(ctx.netPinMap, sn, { gateId: splId, pinId: `b${idx}` });
      });
      const outNet = `__concat_${splId}`;
      addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: 'bus' });
      ctx.netWidths.set(outNet, totalW);
      return memo(outNet);
    }
  }

  // Bit-select or part-select `sig[idx]` / `sig[hi:lo]` / `sig[base -: w]` -> synthesize SPLITTER!
  const slice = parseSliceExpr(expr, ctx.params);
  if (slice) {
    return memo(synthesizeSlice(slice.base, slice.hi, slice.lo, ctx));
  }

  // Simple net identifier
  if (/^\w+$/.test(expr)) {
    return expr;
  }

  // Unsupported user function call (e.g. `atan_lut(0)`, `sat16(z_final)`) -> warn cleanly & return X
  const fnCallM = expr.match(/^(\$?[a-zA-Z_]\w*)\s*\(([\s\S]*)\)$/);
  if (fnCallM) {
    const fnName = fnCallM[1];
    if (fnName === '$signed' || fnName === '$unsigned') {
      const innerNet = buildExprGate(fnCallM[2], ctx, bitWidth, depth + 1);
      if (fnName === '$signed') ctx.signedNets.add(innerNet);
      return memo(innerNet);
    }
    warnOnce(
      ctx,
      `fn:${fnName}`,
      `[${ctx.modName}] 関数呼び出し "${fnName}(...)" は論理合成未対応のため定数 X として扱いました。`,
    );
    return memo(getOrCreateConstNet(bitWidth, `0b${'x'.repeat(bitWidth)}`, `${fnName}()`, ctx));
  }

  // 1a. Multi-input MUX detection (chained `(sel == k) ? ...` or synthesized `case`)
  const multiMuxNet = tryBuildMultiMux(expr, ctx, bitWidth);
  if (multiMuxNet) return memo(multiMuxNet);

  // 1b. Standard 2:1 Ternary MUX / Tri-state Buffer (with clean 1-bit constant boolean simplification)
  const tern = findTopLevelTernary(expr);
  if (tern) {
    const condPart = stripOuterParens(expr.slice(0, tern.qIdx));
    const truePart = stripOuterParens(expr.slice(tern.qIdx + 1, tern.cIdx));
    const falsePart = stripOuterParens(expr.slice(tern.cIdx + 1));

    if (truePart === falsePart) {
      return memo(buildExprGate(truePart, ctx, bitWidth, depth + 1));
    }

    const isZLit = (s: string) => /^(?:\d+)?'s?bz+$|^'z$/i.test(stripOuterParens(s));
    const isBit0Lit = (s: string) => {
      const l = parseVerilogLiteral(stripOuterParens(s));
      return Boolean(
        l && (l.fillChar === '0' || l.value === '0' || l.value === '0b0' || l.value === '0x0'),
      );
    };
    const isBit1Lit = (s: string) => {
      const l = parseVerilogLiteral(stripOuterParens(s));
      return Boolean(
        l && (l.fillChar === '1' || l.value === '1' || l.value === '0b1' || l.value === '0x1'),
      );
    };

    // Simple 1-bit boolean simplifications (dramatically cuts redundant 1'b0/1'b1 MUX chains!)
    if (bitWidth === 1 && !isZLit(truePart) && !isZLit(falsePart)) {
      if (isBit1Lit(truePart) && isBit0Lit(falsePart)) {
        return memo(buildExprGate(condPart, ctx, 1, depth + 1));
      }
      if (isBit0Lit(truePart) && isBit1Lit(falsePart)) {
        return memo(buildExprGate(`~(${condPart})`, ctx, 1, depth + 1));
      }
      if (isBit0Lit(falsePart)) {
        return memo(buildExprGate(`(${condPart}) & (${truePart})`, ctx, 1, depth + 1));
      }
      if (isBit0Lit(truePart)) {
        return memo(buildExprGate(`(~(${condPart})) & (${falsePart})`, ctx, 1, depth + 1));
      }
      if (isBit1Lit(truePart)) {
        return memo(buildExprGate(`(${condPart}) | (${falsePart})`, ctx, 1, depth + 1));
      }
      if (isBit1Lit(falsePart)) {
        return memo(buildExprGate(`(~(${condPart})) | (${truePart})`, ctx, 1, depth + 1));
      }
    }

    // Special case: tri-state buffer idiom `en ? data : 1'bz`
    if (isZLit(falsePart)) {
      const selNet = buildExprGate(condPart, ctx, 1, depth + 1);
      const dataNet = buildExprGate(truePart, ctx, bitWidth, depth + 1);
      const gid = uid('g');
      ctx.gates.push({
        id: gid,
        type: 'TRIBUF',
        x: 0,
        y: 0,
        rotation: 0,
        label: 'TRI',
        props: { bitWidth },
      });
      addNetSink(ctx.netPinMap, dataNet, { gateId: gid, pinId: 'in0' });
      addNetSink(ctx.netPinMap, selNet, { gateId: gid, pinId: 'en' });
      const outNet = `__tri_${gid}`;
      addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
      ctx.netWidths.set(outNet, bitWidth);
      return memo(outNet);
    }
    // Active-low tri-state idiom `en_n ? 1'bz : data`
    if (isZLit(truePart)) {
      const selNet = buildExprGate(`~(${condPart})`, ctx, 1, depth + 1);
      const dataNet = buildExprGate(falsePart, ctx, bitWidth, depth + 1);
      const gid = uid('g');
      ctx.gates.push({
        id: gid,
        type: 'TRIBUF',
        x: 0,
        y: 0,
        rotation: 0,
        label: 'TRI',
        props: { bitWidth },
      });
      addNetSink(ctx.netPinMap, dataNet, { gateId: gid, pinId: 'in0' });
      addNetSink(ctx.netPinMap, selNet, { gateId: gid, pinId: 'en' });
      const outNet = `__tri_${gid}`;
      addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
      ctx.netWidths.set(outNet, bitWidth);
      return memo(outNet);
    }

    const selNet = buildExprGate(condPart, ctx, 1, depth + 1);
    const trueRaw = buildExprGate(truePart, ctx, bitWidth, depth + 1);
    const falseRaw = buildExprGate(falsePart, ctx, bitWidth, depth + 1);
    const trueNet = extendNet(trueRaw, ctx.netWidths.get(trueRaw) ?? bitWidth, bitWidth, ctx);
    const falseNet = extendNet(falseRaw, ctx.netWidths.get(falseRaw) ?? bitWidth, bitWidth, ctx);
    const gid = uid('g');
    ctx.gates.push({
      id: gid,
      type: 'MUX',
      x: 0,
      y: 0,
      rotation: 0,
      label: 'MUX',
      props: { bitWidth, inputCount: 2, selectBits: 1 },
    });
    addNetSink(ctx.netPinMap, falseNet, { gateId: gid, pinId: 'd0' });
    addNetSink(ctx.netPinMap, trueNet, { gateId: gid, pinId: 'd1' });
    addNetSink(ctx.netPinMap, selNet, { gateId: gid, pinId: 'sel' });
    const outNet = `__mux_${gid}`;
    addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
    ctx.netWidths.set(outNet, bitWidth);
    return memo(outNet);
  }

  // 2. Binary operators ordered from lowest to highest Verilog precedence
  const levels: {
    ops: string[];
    kind:
      | GateType
      | 'EQ'
      | 'NEQ'
      | 'LT'
      | 'GT'
      | 'LE'
      | 'GE'
      | 'SUB'
      | 'SHL'
      | 'SHR'
      | 'ASHR'
      | 'UNSUP_ARITH';
  }[] = [
    { ops: ['||'], kind: 'OR' },
    { ops: ['&&'], kind: 'AND' },
    { ops: ['~|'], kind: 'NOR' },
    { ops: ['|'], kind: 'OR' },
    { ops: ['~^', '^~'], kind: 'XNOR' },
    { ops: ['^'], kind: 'XOR' },
    { ops: ['~&'], kind: 'NAND' },
    { ops: ['&'], kind: 'AND' },
    { ops: ['===', '=='], kind: 'EQ' },
    { ops: ['!==', '!='], kind: 'NEQ' },
    { ops: ['<='], kind: 'LE' },
    { ops: ['>='], kind: 'GE' },
    { ops: ['<'], kind: 'LT' },
    { ops: ['>'], kind: 'GT' },
    { ops: ['<<<', '<<'], kind: 'SHL' },
    { ops: ['>>>'], kind: 'ASHR' },
    { ops: ['>>'], kind: 'SHR' },
    { ops: ['+'], kind: 'ADDER' },
    { ops: ['-'], kind: 'SUB' },
    { ops: ['*', '/', '%'], kind: 'UNSUP_ARITH' },
  ];

  for (const lvl of levels) {
    const found = findTopLevelOp(expr, lvl.ops);
    if (found && found.idx > 0) {
      const lhsStr = expr.slice(0, found.idx).trim();
      const rhsStr = expr.slice(found.idx + found.op.length).trim();

      if (lvl.kind === 'UNSUP_ARITH') {
        warnOnce(
          ctx,
          `op:${found.op}`,
          `[${ctx.modName}] 演算子 "${found.op}" は論理合成未対応のため、該当出力を定数 X として扱いました。`,
        );
        return memo(
          getOrCreateConstNet(bitWidth, `0b${'x'.repeat(bitWidth)}`, `${bitWidth}'bx`, ctx),
        );
      }

      if (lvl.kind === 'SHL' || lvl.kind === 'SHR' || lvl.kind === 'ASHR') {
        const shiftAmt = parseConstInt(rhsStr, ctx.params);
        if (shiftAmt === null) {
          warnOnce(
            ctx,
            `varshift:${found.op}`,
            `[${ctx.modName}] 可変シフト演算 "${found.op}" は未対応のため定数 X として扱いました。`,
          );
          return memo(
            getOrCreateConstNet(bitWidth, `0b${'x'.repeat(bitWidth)}`, `${bitWidth}'bx`, ctx),
          );
        }
        const lhsW = inferExprWidth(lhsStr, ctx.netWidths, bitWidth, ctx.params);
        const lhsNet = buildExprGate(lhsStr, ctx, lhsW, depth + 1);
        const curW = ctx.netWidths.get(lhsNet) ?? lhsW;
        if (shiftAmt === 0) {
          return memo(curW < bitWidth ? extendNet(lhsNet, curW, bitWidth, ctx) : lhsNet);
        }
        if (lvl.kind === 'SHL') {
          if (shiftAmt >= bitWidth) {
            return memo(getOrCreateConstNet(bitWidth, '0', `${bitWidth}'b0`, ctx));
          }
          const keepW = Math.min(curW, bitWidth - shiftAmt);
          const lowPart = keepW === curW ? lhsNet : synthesizeSlice(lhsNet, keepW - 1, 0, ctx);
          const zeroPad = getOrCreateConstNet(shiftAmt, '0', `${shiftAmt}'b0`, ctx);
          const widths = [shiftAmt, keepW];
          const srcs = [zeroPad, lowPart];
          const remW = bitWidth - shiftAmt - keepW;
          if (remW > 0) {
            widths.push(remW);
            srcs.push(getOrCreateConstNet(remW, '0', `${remW}'b0`, ctx));
          }
          const splId = uid('shl');
          ctx.gates.push({
            id: splId,
            type: 'SPLITTER',
            x: 0,
            y: 0,
            rotation: 0,
            label: `<<${shiftAmt}`,
            props: { splitMode: 'merge', splitWidths: widths, bitWidth },
          });
          srcs.forEach((s, idx) =>
            addNetSink(ctx.netPinMap, s, { gateId: splId, pinId: `b${idx}` }),
          );
          const outNet = `__shl_${splId}`;
          addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: 'bus' });
          ctx.netWidths.set(outNet, bitWidth);
          return memo(outNet);
        }
        // SHR / ASHR
        const isArith = lvl.kind === 'ASHR' && ctx.signedNets.has(lhsNet);
        if (shiftAmt >= curW) {
          if (isArith) {
            const signBit = synthesizeSlice(lhsNet, curW - 1, curW - 1, ctx);
            ctx.signedNets.add(signBit);
            return memo(extendNet(signBit, 1, bitWidth, ctx));
          }
          return memo(getOrCreateConstNet(bitWidth, '0', `${bitWidth}'b0`, ctx));
        }
        const shiftedSlice = synthesizeSlice(lhsNet, curW - 1, shiftAmt, ctx);
        const sliceW = curW - shiftAmt;
        if (isArith) ctx.signedNets.add(shiftedSlice);
        const outNet =
          sliceW < bitWidth
            ? isArith
              ? extendNet(shiftedSlice, sliceW, bitWidth, ctx)
              : zeroExtendNet(shiftedSlice, sliceW, bitWidth, ctx)
            : sliceW > bitWidth
              ? synthesizeSlice(shiftedSlice, bitWidth - 1, 0, ctx)
              : shiftedSlice;
        return memo(outNet);
      }

      if (
        lvl.kind === 'EQ' ||
        lvl.kind === 'NEQ' ||
        lvl.kind === 'LT' ||
        lvl.kind === 'GT' ||
        lvl.kind === 'LE' ||
        lvl.kind === 'GE'
      ) {
        const leftW = inferExprWidth(lhsStr, ctx.netWidths, 1, ctx.params);
        const rightW = inferExprWidth(rhsStr, ctx.netWidths, 1, ctx.params);
        const cmpW = Math.max(leftW, rightW);
        // Simplify trivial 1-bit equality checks: `sig == 1'b1` -> `sig`, `sig == 1'b0` -> `~sig`
        if (cmpW === 1 && (lvl.kind === 'EQ' || lvl.kind === 'NEQ')) {
          const rLit = parseVerilogLiteral(stripOuterParens(rhsStr));
          const lLit = parseVerilogLiteral(stripOuterParens(lhsStr));
          const isZero = (l: ReturnType<typeof parseVerilogLiteral>) =>
            Boolean(l && (l.fillChar === '0' || l.value === '0' || l.value === '0b0'));
          const isOne = (l: ReturnType<typeof parseVerilogLiteral>) =>
            Boolean(l && (l.fillChar === '1' || l.value === '1' || l.value === '0b1'));
          if (rLit && (isZero(rLit) || isOne(rLit))) {
            const wantInv = (lvl.kind === 'EQ') === isZero(rLit);
            return memo(buildExprGate(wantInv ? `~(${lhsStr})` : lhsStr, ctx, 1));
          }
          if (lLit && (isZero(lLit) || isOne(lLit))) {
            const wantInv = (lvl.kind === 'EQ') === isZero(lLit);
            return memo(buildExprGate(wantInv ? `~(${rhsStr})` : rhsStr, ctx, 1));
          }
        }
        const leftRaw = buildExprGate(lhsStr, ctx, cmpW);
        const rightRaw = buildExprGate(rhsStr, ctx, cmpW);
        const leftNet = extendNet(leftRaw, ctx.netWidths.get(leftRaw) ?? cmpW, cmpW, ctx);
        const rightNet = extendNet(rightRaw, ctx.netWidths.get(rightRaw) ?? cmpW, cmpW, ctx);
        const cmpId = uid('g');
        ctx.gates.push({
          id: cmpId,
          type: 'COMPARATOR',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'CMP',
          props: { bitWidth: cmpW },
        });
        addNetSink(ctx.netPinMap, leftNet, { gateId: cmpId, pinId: 'a' });
        addNetSink(ctx.netPinMap, rightNet, { gateId: cmpId, pinId: 'b' });

        if (lvl.kind === 'NEQ' || lvl.kind === 'LE' || lvl.kind === 'GE') {
          const basePin = lvl.kind === 'NEQ' ? 'eq' : lvl.kind === 'LE' ? 'gt' : 'lt';
          const rawNet = `__cmp_${basePin}_${cmpId}`;
          const notId = uid('g');
          ctx.gates.push({
            id: notId,
            type: 'NOT',
            x: 0,
            y: 0,
            rotation: 0,
            label: '',
            props: { bitWidth: 1 },
          });
          addNetDriver(ctx.netPinMap, rawNet, { gateId: cmpId, pinId: basePin });
          addNetSink(ctx.netPinMap, rawNet, { gateId: notId, pinId: 'in0' });
          const outNet = `__cmp_inv_${notId}`;
          addNetDriver(ctx.netPinMap, outNet, { gateId: notId, pinId: 'out' });
          ctx.netWidths.set(outNet, 1);
          return memo(outNet);
        }

        const pinId = lvl.kind === 'EQ' ? 'eq' : lvl.kind === 'LT' ? 'lt' : 'gt';
        const outNet = `__cmp_${cmpId}_${pinId}`;
        addNetDriver(ctx.netPinMap, outNet, { gateId: cmpId, pinId });
        ctx.netWidths.set(outNet, 1);
        return memo(outNet);
      }

      if (lvl.kind === 'SUB') {
        // Two's complement subtraction: a - b = a + (~b) + 1'b1
        const leftRaw = buildExprGate(lhsStr, ctx, bitWidth);
        const leftNet = zeroExtendNet(
          leftRaw,
          ctx.netWidths.get(leftRaw) ?? bitWidth,
          bitWidth,
          ctx,
        );
        const rightRaw = buildExprGate(rhsStr, ctx, bitWidth);
        const rightExt = zeroExtendNet(
          rightRaw,
          ctx.netWidths.get(rightRaw) ?? bitWidth,
          bitWidth,
          ctx,
        );
        const notId = uid('g');
        ctx.gates.push({
          id: notId,
          type: 'NOT',
          x: 0,
          y: 0,
          rotation: 0,
          label: '',
          props: { bitWidth },
        });
        addNetSink(ctx.netPinMap, rightExt, { gateId: notId, pinId: 'in0' });
        const invRightNet = `__subinv_${notId}`;
        addNetDriver(ctx.netPinMap, invRightNet, { gateId: notId, pinId: 'out' });
        ctx.netWidths.set(invRightNet, bitWidth);

        const oneNet = buildExprGate("1'b1", ctx, 1);
        const gid = uid('g');
        ctx.gates.push({
          id: gid,
          type: 'ADDER',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'SUB',
          props: { bitWidth, hasCarryIn: true },
        });
        addNetSink(ctx.netPinMap, leftNet, { gateId: gid, pinId: 'a' });
        addNetSink(ctx.netPinMap, invRightNet, { gateId: gid, pinId: 'b' });
        addNetSink(ctx.netPinMap, oneNet, { gateId: gid, pinId: 'cin' });
        const outNet = `__sub_${gid}`;
        addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 's' });
        ctx.netWidths.set(outNet, bitWidth);
        return outNet;
      }

      if (lvl.kind === 'ADDER') {
        const leftW = inferExprWidth(lhsStr, ctx.netWidths, bitWidth, ctx.params);
        const rightW = inferExprWidth(rhsStr, ctx.netWidths, bitWidth, ctx.params);
        const opW = Math.max(leftW, rightW);

        // Carry-capturing addition idiom: e.g. `logic [4:0] sum = a[3:0] + b[3:0];`
        // Synthesize an `opW`-bit carryless ADDER (or 1-bit HALF_ADDER) and merge `{cout, s}` into `bitWidth` bits!
        if (bitWidth === opW + 1 && opW >= 1) {
          const leftRaw = buildExprGate(lhsStr, ctx, opW);
          const rightRaw = buildExprGate(rhsStr, ctx, opW);
          const leftNet = zeroExtendNet(leftRaw, ctx.netWidths.get(leftRaw) ?? opW, opW, ctx);
          const rightNet = zeroExtendNet(rightRaw, ctx.netWidths.get(rightRaw) ?? opW, opW, ctx);
          const gid = uid('g');
          const gateType: GateType = opW === 1 ? 'HALF_ADDER' : 'ADDER';
          ctx.gates.push({
            id: gid,
            type: gateType,
            x: 0,
            y: 0,
            rotation: 0,
            label: '',
            props: gateType === 'ADDER' ? { bitWidth: opW, hasCarryIn: false } : { bitWidth: 1 },
          });
          addNetSink(ctx.netPinMap, leftNet, { gateId: gid, pinId: 'a' });
          addNetSink(ctx.netPinMap, rightNet, { gateId: gid, pinId: 'b' });
          const sumNet = `__add_s_${gid}`;
          const coutNet = `__add_c_${gid}`;
          addNetDriver(ctx.netPinMap, sumNet, { gateId: gid, pinId: 's' });
          addNetDriver(ctx.netPinMap, coutNet, {
            gateId: gid,
            pinId: gateType === 'HALF_ADDER' ? 'c' : 'cout',
          });
          ctx.netWidths.set(sumNet, opW);
          ctx.netWidths.set(coutNet, 1);

          const splId = uid('cat');
          ctx.gates.push({
            id: splId,
            type: 'SPLITTER',
            x: 0,
            y: 0,
            rotation: 0,
            label: 'CONCAT',
            props: { splitMode: 'merge', splitWidths: [opW, 1], bitWidth },
          });
          addNetSink(ctx.netPinMap, sumNet, { gateId: splId, pinId: 'b0' });
          addNetSink(ctx.netPinMap, coutNet, { gateId: splId, pinId: 'b1' });
          const outNet = `__op_${gid}`;
          addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: 'bus' });
          ctx.netWidths.set(outNet, bitWidth);
          return outNet;
        }

        const leftRaw = buildExprGate(lhsStr, ctx, bitWidth);
        const rightRaw = buildExprGate(rhsStr, ctx, bitWidth);
        const leftNet = zeroExtendNet(
          leftRaw,
          ctx.netWidths.get(leftRaw) ?? bitWidth,
          bitWidth,
          ctx,
        );
        const rightNet = zeroExtendNet(
          rightRaw,
          ctx.netWidths.get(rightRaw) ?? bitWidth,
          bitWidth,
          ctx,
        );
        const gid = uid('g');
        const gateType: GateType = bitWidth === 1 ? 'HALF_ADDER' : 'ADDER';
        ctx.gates.push({
          id: gid,
          type: gateType,
          x: 0,
          y: 0,
          rotation: 0,
          label: '',
          props: gateType === 'ADDER' ? { bitWidth, hasCarryIn: false } : { bitWidth: 1 },
        });
        addNetSink(ctx.netPinMap, leftNet, { gateId: gid, pinId: 'a' });
        addNetSink(ctx.netPinMap, rightNet, { gateId: gid, pinId: 'b' });
        const outNet = `__op_${gid}`;
        addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 's' });
        ctx.netWidths.set(outNet, bitWidth);
        return outNet;
      }

      const leftNet = buildExprGate(lhsStr, ctx, bitWidth);
      const rightNet = buildExprGate(rhsStr, ctx, bitWidth);
      const gid = uid('g');
      ctx.gates.push({
        id: gid,
        type: lvl.kind,
        x: 0,
        y: 0,
        rotation: 0,
        label: '',
        props: { bitWidth, inputCount: 2 },
      });
      addNetSink(ctx.netPinMap, leftNet, { gateId: gid, pinId: 'in0' });
      addNetSink(ctx.netPinMap, rightNet, { gateId: gid, pinId: 'in1' });
      const outNet = `__op_${gid}`;
      addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
      ctx.netWidths.set(outNet, bitWidth);
      return memo(outNet);
    }
  }

  // 3a. Unary reduction operators: ~&, ~|, ~^, ^~, &, |, ^
  const redMatch = expr.match(/^(~&|~\||~\^|\^~|&|\||\^)\s*([\s\S]+)$/);
  if (redMatch) {
    const op = redMatch[1];
    const operandStr = redMatch[2].trim();
    const opW = inferExprWidth(operandStr, ctx.netWidths, 1, ctx.params);
    const opNet = buildExprGate(operandStr, ctx, opW);
    const redGateMap: Record<string, GateType> = {
      '&': 'AND',
      '|': 'OR',
      '^': 'XOR',
      '~&': 'NAND',
      '~|': 'NOR',
      '~^': 'XNOR',
      '^~': 'XNOR',
    };
    const isNeg = op.startsWith('~') || op === '^~';
    if (opW <= 1) {
      if (!isNeg) return memo(opNet);
      const notId = uid('g');
      ctx.gates.push({
        id: notId,
        type: 'NOT',
        x: 0,
        y: 0,
        rotation: 0,
        label: '',
        props: { bitWidth: 1 },
      });
      addNetSink(ctx.netPinMap, opNet, { gateId: notId, pinId: 'in0' });
      const outNet = `__red_${notId}`;
      addNetDriver(ctx.netPinMap, outNet, { gateId: notId, pinId: 'out' });
      ctx.netWidths.set(outNet, 1);
      return memo(outNet);
    }
    const clampedW = Math.min(8, opW);
    const gid = uid('g');
    ctx.gates.push({
      id: gid,
      type: redGateMap[op],
      x: 0,
      y: 0,
      rotation: 0,
      label: '',
      props: { bitWidth: 1, inputCount: clampedW },
    });
    for (let i = 0; i < clampedW; i++) {
      const bitNet = synthesizeSlice(opNet, i, i, ctx);
      addNetSink(ctx.netPinMap, bitNet, { gateId: gid, pinId: `in${i}` });
    }
    const outNet = `__red_${gid}`;
    addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
    ctx.netWidths.set(outNet, 1);
    return memo(outNet);
  }

  // 3b. Unary NOT (~ or !) or Unary minus (-expr)
  if (expr.startsWith('-')) {
    const innerStr = expr.slice(1).trim();
    if (innerStr) {
      return memo(buildExprGate(`0 - (${innerStr})`, ctx, bitWidth, depth + 1));
    }
  }
  if (expr.startsWith('~') || expr.startsWith('!')) {
    const innerStr = expr.slice(1).trim();
    const isLogicalNot = expr.startsWith('!');
    const innerW = isLogicalNot ? inferExprWidth(innerStr, ctx.netWidths, 1, ctx.params) : bitWidth;
    if (isLogicalNot && innerW > 1) {
      // Logical !bus is equivalent to reduction NOR `~|bus`
      return memo(buildExprGate(`~|(${innerStr})`, ctx, 1, depth + 1));
    }
    const innerNet = buildExprGate(innerStr, ctx, bitWidth, depth + 1);
    const gid = uid('g');
    ctx.gates.push({
      id: gid,
      type: 'NOT',
      x: 0,
      y: 0,
      rotation: 0,
      label: '',
      props: { bitWidth },
    });
    addNetSink(ctx.netPinMap, innerNet, { gateId: gid, pinId: 'in0' });
    const outNet = `__not_${gid}`;
    addNetDriver(ctx.netPinMap, outNet, { gateId: gid, pinId: 'out' });
    ctx.netWidths.set(outNet, bitWidth);
    return memo(outNet);
  }

  return expr;
}

/** Zero-extend a narrower net to `targetW` bits using a shared CONST 0 + merge SPLITTER */
function zeroExtendNet(net: string, curW: number, targetW: number, ctx: SynthContext): string {
  if (curW >= targetW || curW <= 0) return net;
  const padW = targetW - curW;
  const zeroNet = getOrCreateConstNet(padW, '0', `${padW}'b0`, ctx);

  const splId = uid('zext');
  ctx.gates.push({
    id: splId,
    type: 'SPLITTER',
    x: 0,
    y: 0,
    rotation: 0,
    label: 'ZEXT',
    props: { splitMode: 'merge', splitWidths: [curW, padW], bitWidth: targetW },
  });
  addNetSink(ctx.netPinMap, net, { gateId: splId, pinId: 'b0' });
  addNetSink(ctx.netPinMap, zeroNet, { gateId: splId, pinId: 'b1' });
  const outNet = `__zext_${splId}`;
  addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: 'bus' });
  ctx.netWidths.set(outNet, targetW);
  return outNet;
}

/** Sign-extend (for `signed` nets) or zero-extend a narrower net to `targetW` bits so upper bits never float as Z */
function extendNet(net: string, curW: number, targetW: number, ctx: SynthContext): string {
  if (curW >= targetW || curW <= 0) return net;
  if (!ctx.signedNets.has(net)) {
    return zeroExtendNet(net, curW, targetW, ctx);
  }
  const padW = targetW - curW;
  const signBitNet = curW === 1 ? net : synthesizeSlice(net, curW - 1, curW - 1, ctx);
  // Replicate MSB via merge SPLITTER(s) (chunked if padW is large so pin count stays tidy)
  let extBitsNet = signBitNet;
  let extW = 1;
  while (extW < padW) {
    const step = Math.min(8, Math.ceil(padW / extW));
    const widths: number[] = [];
    const srcs: string[] = [];
    let acc = 0;
    for (let k = 0; k < step && acc < padW; k++) {
      const w = Math.min(extW, padW - acc);
      if (w === extW) {
        widths.push(extW);
        srcs.push(extBitsNet);
        acc += extW;
      } else {
        const tail = synthesizeSlice(extBitsNet, w - 1, 0, ctx);
        widths.push(w);
        srcs.push(tail);
        acc += w;
      }
    }
    const repId = uid('srep');
    ctx.gates.push({
      id: repId,
      type: 'SPLITTER',
      x: 0,
      y: 0,
      rotation: 0,
      label: 'SEXT',
      props: { splitMode: 'merge', splitWidths: widths, bitWidth: acc },
    });
    srcs.forEach((s, idx) => addNetSink(ctx.netPinMap, s, { gateId: repId, pinId: `b${idx}` }));
    const nextNet = `__srep_${repId}`;
    addNetDriver(ctx.netPinMap, nextNet, { gateId: repId, pinId: 'bus' });
    ctx.netWidths.set(nextNet, acc);
    extBitsNet = nextNet;
    extW = acc;
  }

  const splId = uid('sext');
  ctx.gates.push({
    id: splId,
    type: 'SPLITTER',
    x: 0,
    y: 0,
    rotation: 0,
    label: 'SEXT',
    props: { splitMode: 'merge', splitWidths: [curW, padW], bitWidth: targetW },
  });
  addNetSink(ctx.netPinMap, net, { gateId: splId, pinId: 'b0' });
  addNetSink(ctx.netPinMap, extBitsNet, { gateId: splId, pinId: 'b1' });
  const outNet = `__sext_${splId}`;
  addNetDriver(ctx.netPinMap, outNet, { gateId: splId, pinId: 'bus' });
  ctx.netWidths.set(outNet, targetW);
  ctx.signedNets.add(outNet);
  return outNet;
}

/** Synthesize `{cout, sum} = a + b` or `{cout, sum} = a + b + cin` directly into an ADDER gate */
function tryBuildConcatAdderAssign(
  lhs: string,
  rhs: string,
  ctx: SynthContext,
  sumWidth: number,
): boolean {
  const lhsMatch = lhs.match(/^\{\s*(\w+)\s*,\s*(\w+)\s*\}$/);
  if (!lhsMatch) return false;
  const coutNet = lhsMatch[1];
  const sumNet = lhsMatch[2];

  const terms = splitTopLevel(rhs, '+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (terms.length < 2 || terms.length > 3) return false;

  const rawAW = inferExprWidth(terms[0], ctx.netWidths, sumWidth, ctx.params);
  const rawBW = inferExprWidth(terms[1], ctx.netWidths, sumWidth, ctx.params);
  const aBuildW = Math.min(rawAW, sumWidth);
  const bBuildW = Math.min(rawBW, sumWidth);
  const aRawNet = buildExprGate(terms[0], ctx, aBuildW);
  const bRawNet = buildExprGate(terms[1], ctx, bBuildW);
  const aNet = zeroExtendNet(aRawNet, ctx.netWidths.get(aRawNet) ?? aBuildW, sumWidth, ctx);
  const bNet = zeroExtendNet(bRawNet, ctx.netWidths.get(bRawNet) ?? bBuildW, sumWidth, ctx);
  const cinNet = terms[2] ? buildExprGate(terms[2], ctx, 1) : null;

  const gid = uid('g');
  const gateType: GateType = sumWidth === 1 ? (cinNet ? 'FULL_ADDER' : 'HALF_ADDER') : 'ADDER';
  ctx.gates.push({
    id: gid,
    type: gateType,
    x: 0,
    y: 0,
    rotation: 0,
    label: gateType,
    props:
      gateType === 'ADDER'
        ? { bitWidth: sumWidth, hasCarryIn: Boolean(cinNet) }
        : { bitWidth: sumWidth },
  });

  addNetSink(ctx.netPinMap, aNet, { gateId: gid, pinId: 'a' });
  addNetSink(ctx.netPinMap, bNet, { gateId: gid, pinId: 'b' });
  if (cinNet && gateType !== 'HALF_ADDER') {
    addNetSink(ctx.netPinMap, cinNet, { gateId: gid, pinId: 'cin' });
  }
  addNetDriver(ctx.netPinMap, sumNet, { gateId: gid, pinId: 's' });
  addNetDriver(ctx.netPinMap, coutNet, {
    gateId: gid,
    pinId: gateType === 'HALF_ADDER' ? 'c' : 'cout',
  });
  return true;
}

const GLOBAL_RAIL_NET_RE =
  /^(?:clk|clock|pclk|hclk|aclk|sclk|rst|rst_n|reset|reset_n|aresetn|nreset|clr|clear|en|ce)(?:_\w+)?$/i;

function isGlobalDistributionNet(
  netName: string,
  entry: NetEntry,
  gateById: Map<string, GateInstance>,
): boolean {
  if (entry.sinks.length < 2) return false;
  if (GLOBAL_RAIL_NET_RE.test(netName)) return true;
  // Any MODULE_IN fanning out to 3+ modules/gates is treated as a global top-rail bus (e.g. clk, rst, global en)
  if (
    entry.sinks.length >= 3 &&
    entry.drivers.some((d) => gateById.get(d.gateId)?.type === 'MODULE_IN')
  ) {
    return true;
  }
  return false;
}

/**
 * Sugiyama-style topological layered auto-layout with DFS cycle breaking (handles CPU-like
 * SUBCIRCUIT feedback loops cleanly!), global clock/reset separation, and 2-pass IO alignment.
 * Guarantees ZERO overlapping components and clean corridors for feedback & global rails!
 */
function autoLayoutGates(
  gates: GateInstance[],
  netPinMap: Map<string, NetEntry>,
  project: ProjectDocument,
): void {
  if (gates.length === 0) return;

  const gateById = new Map(gates.map((g) => [g.id, g]));
  const rawSuccs = new Map<string, Set<string>>();
  const dataPreds = new Map<string, Set<string>>();
  const dataSuccs = new Map<string, Set<string>>();
  const globalSourceGateIds = new Set<string>();

  for (const g of gates) {
    rawSuccs.set(g.id, new Set());
    dataPreds.set(g.id, new Set());
    dataSuccs.set(g.id, new Set());
  }

  // 1. Build directed dataflow graph (excluding high-fanout global clk/rst nets from distorting layering)
  for (const [netName, entry] of netPinMap.entries()) {
    const isGlobal = isGlobalDistributionNet(netName, entry, gateById);
    if (isGlobal) {
      for (const d of entry.drivers) globalSourceGateIds.add(d.gateId);
      continue;
    }

    if (entry.drivers.length > 0 && entry.sinks.length > 0) {
      for (const drv of entry.drivers) {
        const srcId = drv.gateId;
        const srcGate = gateById.get(srcId);
        for (const sink of entry.sinks) {
          const dstId = sink.gateId;
          if (srcId === dstId) continue;
          // Break direct sequential register feedback edges early
          if (
            srcGate &&
            (srcGate.type === 'D_FF' || srcGate.type === 'REGISTER') &&
            gateById.get(dstId)?.type !== 'MODULE_OUT'
          ) {
            continue;
          }
          rawSuccs.get(srcId)?.add(dstId);
        }
      }
    } else {
      // Passive / stub-to-stub net with >=2 endpoints all classified as sinks or all drivers
      const eps = entry.drivers.length >= 2 ? entry.drivers : entry.sinks;
      if (eps.length >= 2) {
        const srcId = eps[0].gateId;
        for (let k = 1; k < eps.length; k++) {
          const dstId = eps[k].gateId;
          if (srcId !== dstId) {
            rawSuccs.get(srcId)?.add(dstId);
          }
        }
      }
    }
  }

  // 2. DFS feedback-arc breaker so cyclic SUBCIRCUIT graphs (e.g. CPU PC -> IF -> ID -> EX -> MEM -> PC)
  //    produce a clean compact DAG instead of exploding into 24 columns!
  const visitState = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=on-stack, 2=done
  const dfsOrder: GateInstance[] = [
    ...gates.filter((g) => g.type === 'MODULE_IN' || g.type === 'CONST'),
    ...gates.filter((g) => g.type !== 'MODULE_IN' && g.type !== 'CONST' && g.type !== 'MODULE_OUT'),
    ...gates.filter((g) => g.type === 'MODULE_OUT'),
  ];

  const dfs = (u: string) => {
    visitState.set(u, 1);
    for (const v of rawSuccs.get(u) ?? []) {
      const st = visitState.get(v) ?? 0;
      if (st === 1) {
        // Back-edge (cycle / right-to-left feedback loop) -> exclude from forward layering!
        continue;
      }
      dataPreds.get(v)?.add(u);
      dataSuccs.get(u)?.add(v);
      if (st === 0) dfs(v);
    }
    visitState.set(u, 2);
  };
  for (const g of dfsOrder) {
    if ((visitState.get(g.id) ?? 0) === 0) dfs(g.id);
  }

  // 3. Assign topological layers on the acyclic forward DAG
  const layer = new Map<string, number>();
  for (const g of gates) {
    if (g.type === 'MODULE_IN' || g.type === 'CONST') layer.set(g.id, 0);
    else layer.set(g.id, 1);
  }

  const maxRelax = Math.min(gates.length + 2, 16);
  for (let pass = 0; pass < maxRelax; pass++) {
    let changed = false;
    for (const g of gates) {
      if (g.type === 'MODULE_IN' || g.type === 'CONST' || g.type === 'MODULE_OUT') continue;
      let best = 1;
      for (const p of dataPreds.get(g.id) ?? []) {
        best = Math.max(best, (layer.get(p) ?? 0) + 1);
      }
      if (best > (layer.get(g.id) ?? 1)) {
        layer.set(g.id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Place all MODULE_OUT cleanly in the rightmost column
  let maxInternalLayer = 0;
  for (const g of gates) {
    if (g.type !== 'MODULE_OUT') {
      maxInternalLayer = Math.max(maxInternalLayer, layer.get(g.id) ?? 0);
    }
  }
  const outLayer = maxInternalLayer + 1;
  for (const g of gates) {
    if (g.type === 'MODULE_OUT') layer.set(g.id, outLayer);
  }

  // 3b. Right-pull (ALAP) pass for output-driving components:
  // Components feeding MODULE_OUT (especially those with many or exclusive MODULE_OUT connections)
  // are placed right next to MODULE_OUT (`outLayer - 1`) on the right side of the canvas!
  if (outLayer >= 3) {
    const outDirectCount = new Map<string, number>();
    const nonOutDirectCount = new Map<string, number>();
    for (const [netName, entry] of netPinMap.entries()) {
      // Exclude global clock/reset nets so high-fanout clocks don't distort output-proximity scoring
      if (isGlobalDistributionNet(netName, entry, gateById)) continue;
      let outSinks = 0;
      let otherSinks = 0;
      for (const s of entry.sinks) {
        const sg = gateById.get(s.gateId);
        if (!sg) continue;
        if (sg.type === 'MODULE_OUT') outSinks++;
        else otherSinks++;
      }
      if (outSinks === 0 && otherSinks === 0) continue;
      for (const d of entry.drivers) {
        if (outSinks > 0) {
          outDirectCount.set(d.gateId, (outDirectCount.get(d.gateId) ?? 0) + outSinks);
        }
        if (otherSinks > 0) {
          nonOutDirectCount.set(d.gateId, (nonOutDirectCount.get(d.gateId) ?? 0) + otherSinks);
        }
      }
    }

    // Pass 1: Move components whose outputs predominantly or exclusively drive MODULE_OUT to `outLayer - 1`
    for (const g of gates) {
      if (g.type === 'MODULE_IN' || g.type === 'CONST' || g.type === 'MODULE_OUT') continue;
      const outCnt = outDirectCount.get(g.id) ?? 0;
      if (outCnt === 0) continue;
      const succs = dataSuccs.get(g.id);
      let minInternalSuccLayer = outLayer;
      let internalSuccCnt = 0;
      if (succs) {
        for (const sid of succs) {
          if (gateById.get(sid)?.type === 'MODULE_OUT') continue;
          internalSuccCnt++;
          minInternalSuccLayer = Math.min(minInternalSuccLayer, layer.get(sid) ?? outLayer);
        }
      }
      const curL = layer.get(g.id) ?? 1;
      const otherCnt = Math.max(internalSuccCnt, nonOutDirectCount.get(g.id) ?? 0);
      if (internalSuccCnt === 0) {
        // Feeds only MODULE_OUT -> pull directly adjacent to MODULE_OUT!
        layer.set(g.id, outLayer - 1);
      } else if (outCnt > otherCnt) {
        // Predominantly feeds MODULE_OUT (more OUT pins than internal fanout) -> prioritize proximity to OUT!
        layer.set(g.id, outLayer - 1);
      } else if (minInternalSuccLayer - 1 > curL) {
        // Otherwise pull as far right as possible without reversing forward edges
        layer.set(g.id, minInternalSuccLayer - 1);
      }
    }

    // Pass 2: Pull immediate upstream gates that only feed right-pulled gates closer to their consumers (clean ALAP)
    for (let pass = 0; pass < 3; pass++) {
      let shifted = false;
      for (const g of gates) {
        if (
          g.type === 'MODULE_IN' ||
          g.type === 'CONST' ||
          g.type === 'MODULE_OUT' ||
          globalSourceGateIds.has(g.id)
        ) {
          continue;
        }
        const succs = dataSuccs.get(g.id);
        if (!succs || succs.size === 0) continue;
        let minSuccLayer = Infinity;
        for (const sid of succs) {
          minSuccLayer = Math.min(minSuccLayer, layer.get(sid) ?? outLayer);
        }
        const curL = layer.get(g.id) ?? 1;
        if (Number.isFinite(minSuccLayer) && minSuccLayer - 1 > curL && minSuccLayer < outLayer) {
          layer.set(g.id, minSuccLayer - 1);
          shifted = true;
        }
      }
      if (!shifted) break;
    }
  }

  // Group gates into columns
  const cols = new Map<number, GateInstance[]>();
  for (const g of gates) {
    const l = layer.get(g.id) ?? 0;
    let arr = cols.get(l);
    if (!arr) {
      arr = [];
      cols.set(l, arr);
    }
    arr.push(g);
  }

  const sortedLayers = [...cols.keys()].sort((a, b) => a - b);

  // Measure column widths & heights with generous vertical breathing room (GAP_Y = 80)
  const GAP_Y = 80;
  const START_X = 120;
  const START_Y = 140;

  const colMaxW = new Map<number, number>();
  const colTotalH = new Map<number, number>();
  for (const l of sortedLayers) {
    const list = cols.get(l)!;
    let maxW = 0;
    let totalH = 0;
    for (let i = 0; i < list.length; i++) {
      const sz = getGateSize(list[i], project);
      maxW = Math.max(maxW, sz.width);
      totalH += sz.height + (i > 0 ? GAP_Y : 0);
    }
    colMaxW.set(l, maxW);
    colTotalH.set(l, totalH);
  }

  // Count how many data nets cross the vertical gap immediately right of each layer l
  const crossingRightOf = new Map<number, number>();
  for (const [netName, entry] of netPinMap.entries()) {
    if (isGlobalDistributionNet(netName, entry, gateById)) continue;
    if (entry.drivers.length === 0 || entry.sinks.length === 0) continue;
    for (const drv of entry.drivers) {
      const lSrc = layer.get(drv.gateId) ?? 0;
      for (const sink of entry.sinks) {
        const lDst = layer.get(sink.gateId) ?? 0;
        const lMin = Math.min(lSrc, lDst);
        const lMax = Math.max(lSrc, lDst);
        for (let cl = lMin; cl < lMax; cl++) {
          crossingRightOf.set(cl, (crossingRightOf.get(cl) ?? 0) + 1);
        }
      }
    }
  }

  const maxColHeight = Math.max(...colTotalH.values(), 120);
  const yAssigned = new Map<string, number>();

  // Put global clock/reset MODULE_IN ports at the very top of column 0 (aligned with top distribution rail!)
  const col0 = cols.get(0);
  if (col0) {
    col0.sort((a, b) => {
      const aGlob = globalSourceGateIds.has(a.id) || GLOBAL_RAIL_NET_RE.test(a.label) ? 0 : 1;
      const bGlob = globalSourceGateIds.has(b.id) || GLOBAL_RAIL_NET_RE.test(b.label) ? 0 : 1;
      if (aGlob !== bGlob) return aGlob - bGlob;
      return (a.props.portOrder ?? 999) - (b.props.portOrder ?? 999);
    });
  }

  let curLeftX = START_X;
  const colCenterX = new Map<number, number>();
  for (const l of sortedLayers) {
    const list = cols.get(l)!;

    // Order column by barycenter of already-placed data predecessors to minimize wire crossings!
    if (l > 0) {
      list.sort((a, b) => {
        const bary = (g: GateInstance) => {
          const ps = [...(dataPreds.get(g.id) ?? [])].filter((p) => yAssigned.has(p));
          if (ps.length === 0) return Number.MAX_SAFE_INTEGER;
          return ps.reduce((acc, p) => acc + yAssigned.get(p)!, 0) / ps.length;
        };
        return bary(a) - bary(b);
      });
    }

    const colW = colMaxW.get(l) ?? 80;
    const centerX = snapToGrid(curLeftX + colW / 2, GRID_SIZE);
    colCenterX.set(l, centerX);
    const totalH = colTotalH.get(l) ?? 0;
    let curTopY = START_Y + Math.max(0, (maxColHeight - totalH) / 2);

    for (const g of list) {
      const sz = getGateSize(g, project);
      const cy = snapToGrid(curTopY + sz.height / 2, GRID_SIZE);
      g.x = centerX;
      g.y = cy;
      yAssigned.set(g.id, cy);
      curTopY = cy + sz.height / 2 + GAP_Y;
    }

    const crossingWires = crossingRightOf.get(l) ?? 0;
    const channelX = Math.min(
      360,
      Math.max(160, snapToGrid(120 + crossingWires * GRID_SIZE, GRID_SIZE)),
    );
    curLeftX = centerX + colW / 2 + channelX;
  }

  // Second pass on column 0: sort non-global data inputs by barycenter of their consumers' Y!
  if (col0 && col0.length > 1) {
    col0.sort((a, b) => {
      const aGlob = globalSourceGateIds.has(a.id) || GLOBAL_RAIL_NET_RE.test(a.label) ? 0 : 1;
      const bGlob = globalSourceGateIds.has(b.id) || GLOBAL_RAIL_NET_RE.test(b.label) ? 0 : 1;
      if (aGlob !== bGlob) return aGlob - bGlob;
      const bary = (g: GateInstance) => {
        const ss = [...(dataSuccs.get(g.id) ?? [])].filter((s) => yAssigned.has(s));
        if (ss.length === 0) return Number.MAX_SAFE_INTEGER;
        return ss.reduce((acc, s) => acc + yAssigned.get(s)!, 0) / ss.length;
      };
      return bary(a) - bary(b);
    });
    const totalH = colTotalH.get(0) ?? 0;
    let curTopY = START_Y + Math.max(0, (maxColHeight - totalH) / 2);
    const cx0 = colCenterX.get(0) ?? START_X;
    for (const g of col0) {
      const sz = getGateSize(g, project);
      const cy = snapToGrid(curTopY + sz.height / 2, GRID_SIZE);
      g.x = cx0;
      g.y = cy;
      curTopY = cy + sz.height / 2 + GAP_Y;
    }
  }
}

const STRONG_OUT_NAMES = new Set([
  'y',
  'o',
  'q',
  'qn',
  's',
  'sum',
  'cout',
  'carry',
  'dout',
  'rdata',
  'rd_data',
  'res',
  'result',
  'valid_o',
  'ready_o',
  'ack',
  'done',
  'busy',
  'err',
  'irq',
  'tx',
  'txd',
  'sdo',
  'miso',
]);

const STRONG_IN_NAMES = new Set([
  'clk',
  'clock',
  'rst',
  'rst_n',
  'reset',
  'reset_n',
  'clr',
  'clear',
  'en',
  'enable',
  'we',
  're',
  'cs',
  'ce',
  'sel',
  'addr',
  'din',
  'wdata',
  'wr_data',
  'cin',
  'rx',
  'rxd',
  'sdi',
  'mosi',
  'a',
  'b',
  'c',
  'd',
  'd0',
  'd1',
  'd2',
  'd3',
]);

function classifyStubPortByName(pname: string): 'in' | 'out' | 'unknown' {
  const lower = pname.toLowerCase();

  // AXI-Stream standard conventions: m_axis_* produces data/valid, receives tready; s_axis_* receives data/valid, produces tready
  if (lower.startsWith('m_axis_')) {
    if (/(?:^|_)tready$/.test(lower)) return 'in';
    if (/(?:^|_)(?:tdata|tvalid|tlast|tuser|tkeep|tstrb)$/.test(lower)) return 'out';
  }
  if (lower.startsWith('s_axis_')) {
    if (/(?:^|_)tready$/.test(lower)) return 'out';
    if (/(?:^|_)(?:tdata|tvalid|tlast|tuser|tkeep|tstrb)$/.test(lower)) return 'in';
  }

  // Clock outputs (e.g. clk_wiz `clk_out1`, `clk_o`) vs clock/reset inputs (`aclk`, `SysClk100`, `ADC_SamplingClk`, `aRst_n`)
  if (/(?:^|_)clk_?out\d*$|^(?:clk_o|clock_o)$/.test(lower)) {
    return 'out';
  }
  if (
    /^(?:a|s|m|sys|adc|dac|ref|core|bus|p|h)?clk\d*$/.test(lower) ||
    /(?:^|_)(?:aclk|sclk|pclk|hclk|clk_?in\d*|samplingclk|inclk|inio_clk|dcoclk|clk)$/.test(
      lower,
    ) ||
    /^(?:a?rst|reset|clr|clear)(?:_?\w*)?$/.test(lower)
  ) {
    return 'in';
  }

  if (
    lower.startsWith('out') ||
    lower.endsWith('_o') ||
    /_out\d*$/.test(lower) ||
    /_dout\d*$/.test(lower) ||
    STRONG_OUT_NAMES.has(lower)
  ) {
    return 'out';
  }
  if (
    lower.startsWith('in') ||
    lower.endsWith('_i') ||
    /_in\d*$/.test(lower) ||
    /_din\d*$/.test(lower) ||
    STRONG_IN_NAMES.has(lower)
  ) {
    return 'in';
  }
  return 'unknown';
}

/** Extract bare base signal name from a port connection expression (e.g. `w[3:0]` -> `w`) */
function extractSimpleNetName(sigRaw: string): string | null {
  const s = sigRaw.trim();
  const m = s.match(/^(\w+)(?:\[[^\]]+\])?$/);
  return m ? m[1] : null;
}

export function importVerilogToCircuits(source: string, options?: ImportOptions): ImportResult {
  return importVerilogFilesToCircuits([{ name: '', content: source }], options);
}

/**
 * Import one or more Verilog / SystemVerilog files together so modules defined across
 * separate `.v` / `.sv` files resolve and reference each other seamlessly!
 */
export function importVerilogFilesToCircuits(
  files: HdlSourceFile[],
  options?: ImportOptions,
): ImportResult {
  const warnings: string[] = [];
  const nonEmptyFiles = files.filter((f) => f.content.trim().length > 0);
  if (nonEmptyFiles.length === 0) {
    throw new Error('Verilog/SystemVerilog のソースが空です。');
  }

  // Validate each file up-front so XML / Vivado .xci / binary / non-HDL files are rejected safely
  const validFiles: HdlSourceFile[] = [];
  const rejectedReasons: string[] = [];
  for (const f of nonEmptyFiles) {
    const check = inspectHdlSourceFile(f);
    if (check.valid) {
      validFiles.push(f);
    } else {
      const fname = f.name.trim() || '無名ファイル';
      const msg = `ファイル "${fname}" をスキップしました（${check.reason ?? '未対応形式'}）。`;
      warnings.push(msg);
      rejectedReasons.push(`${fname}: ${check.reason ?? '未対応形式'}`);
    }
  }
  if (validFiles.length === 0) {
    const detail = rejectedReasons.slice(0, 3).join(' / ');
    throw new Error(
      `有効な Verilog/SystemVerilog ファイルが見つかりませんでした。${detail ? `（${detail}）` : ''}`,
    );
  }

  interface ParsedWithMeta extends ParsedModule {
    hdlSource: string;
    hdlFileSource?: string;
    hdlFileName?: string;
  }

  const parsedByName = new Map<string, ParsedWithMeta>();
  for (const file of validFiles) {
    const fileModules = parseModules(file.content, warnings);
    const origMap = extractOriginalModuleSources(file.content);
    const trimmedFile = file.content.trim();
    const cleanFileName = file.name.trim() || undefined;
    for (const pm of fileModules) {
      const modSrc = origMap.get(pm.name) ?? trimmedFile;
      if (parsedByName.has(pm.name)) {
        warnings.push(
          `モジュール "${pm.name}" が複数ファイルで定義されているため、後の定義（${cleanFileName ?? '入力'}）を採用しました。`,
        );
      }
      parsedByName.set(pm.name, {
        ...pm,
        hdlSource: modSrc,
        hdlFileSource: trimmedFile && trimmedFile !== modSrc.trim() ? trimmedFile : undefined,
        hdlFileName: cleanFileName,
      });
    }
  }

  const parsed = Array.from(parsedByName.values());
  if (parsed.length === 0) {
    throw new Error('Verilog/SystemVerilog の module ... endmodule 定義が見つかりませんでした。');
  }

  // Pick top module (respecting explicit user topModuleName if provided, else highest-hierarchy uninstantiated root)
  const explicitTop = options?.topModuleName
    ? parsed.find((pm) => pm.name === options.topModuleName)
    : undefined;
  const topCandidate = explicitTop ?? pickBestTopModule(parsed);

  const hdlProjectId =
    options?.hdlProjectId ??
    `hdlproj_${topCandidate.name}_${Math.random().toString(36).slice(2, 6)}`;
  const nameToId = new Map<string, string>();
  const reusedExistingIds = new Set<string>();
  const stubCircuits = new Map<string, CircuitDocument>();

  // Index existing project circuits by module name (so re-synthesis links to existing submodules!)
  const existingByName = new Map<string, CircuitDocument>();
  if (options?.existingCircuits) {
    for (const c of Object.values(options.existingCircuits)) {
      const baseName = c.isStub ? c.name.replace(/\s*\(External Stub\)$/, '') : c.name;
      if (!existingByName.has(baseName)) existingByName.set(baseName, c);
    }
  }

  for (const pm of parsed) {
    const preservedByName = options?.preserveIdByModuleName?.get(pm.name);
    if (preservedByName) {
      nameToId.set(pm.name, preservedByName);
    } else if (
      options?.preserveCircuitId &&
      (pm.name === topCandidate.name ||
        options.existingCircuits?.[options.preserveCircuitId]?.name === pm.name)
    ) {
      nameToId.set(pm.name, options.preserveCircuitId);
    } else {
      nameToId.set(pm.name, `mod_${pm.name}_${Math.random().toString(36).slice(2, 6)}`);
    }
  }

  // First pass: collect ALL external unknown module instances & infer stub port directions using
  // both name heuristics AND cross-instance / stub-to-stub dataflow analysis!
  interface StubPortAccum {
    name: string;
    bitWidth: number;
    nameHint: 'in' | 'out' | 'unknown';
    provenIn: boolean;
    provenOut: boolean;
    dir: 'in' | 'out';
  }
  const stubAccum = new Map<string, Map<string, StubPortAccum>>();

  // Pre-register any unknown module that already exists in `existingCircuits`
  for (const pm of parsed) {
    for (const inst of pm.instances) {
      if (nameToId.has(inst.moduleName)) continue;
      const existing = existingByName.get(inst.moduleName);
      if (existing && existing.id !== options?.preserveCircuitId) {
        nameToId.set(inst.moduleName, existing.id);
        reusedExistingIds.add(existing.id);
      }
    }
  }

  // Gather known driven / sink nets in each parent module for dataflow-based stub direction inference
  const parentNetEvidence = new Map<
    string,
    { drivenNets: Set<string>; sinkNets: Set<string>; outPorts: Set<string> }
  >();

  for (const pm of parsed) {
    const drivenNets = new Set<string>();
    const sinkNets = new Set<string>();
    const outPorts = new Set<string>();

    for (const p of pm.ports) {
      if (p.dir === 'in') drivenNets.add(p.name);
      else {
        sinkNets.add(p.name);
        outPorts.add(p.name);
      }
    }
    for (const prim of pm.primitives) {
      const o = extractSimpleNetName(prim.outNet);
      if (o) drivenNets.add(o);
      for (const inp of prim.inNets) {
        const s = extractSimpleNetName(inp);
        if (s) sinkNets.add(s);
      }
    }
    for (const a of pm.assigns) {
      for (const id of a.lhs.match(/\b[a-zA-Z_]\w*\b/g) ?? []) drivenNets.add(id);
      for (const id of a.rhs.match(/\b[a-zA-Z_]\w*\b/g) ?? []) sinkNets.add(id);
    }
    for (const ff of pm.ffs) {
      drivenNets.add(ff.target);
      sinkNets.add(ff.clkNet);
      if (ff.rstNet) sinkNets.add(ff.rstNet);
      for (const id of ff.dExpr.match(/\b[a-zA-Z_]\w*\b/g) ?? []) sinkNets.add(id);
      if (ff.enExpr) {
        for (const id of ff.enExpr.match(/\b[a-zA-Z_]\w*\b/g) ?? []) sinkNets.add(id);
      }
    }
    // Also include defined/reused submodule port directions
    for (const inst of pm.instances) {
      const defMod = parsedByName.get(inst.moduleName);
      if (defMod) {
        inst.conns.forEach((c, idx) => {
          const p = c.portName
            ? defMod.ports.find((pp) => pp.name === c.portName)
            : defMod.ports[idx];
          const net = extractSimpleNetName(c.signal);
          if (!p || !net) return;
          if (p.dir === 'out') drivenNets.add(net);
          else sinkNets.add(net);
        });
      }
    }

    parentNetEvidence.set(pm.name, { drivenNets, sinkNets, outPorts });
  }

  // Count how many stub connections touch each net per parent module so a shared multi-stub net
  // (e.g. clk_wiz `clk_out1` fanning out to 10 stubs + parent always blocks) does NOT falsely mark
  // every stub consumer as `provenOut`!
  const parentStubNetCounts = new Map<string, Map<string, number>>();
  for (const pm of parsed) {
    const counts = new Map<string, number>();
    for (const inst of pm.instances) {
      if (nameToId.has(inst.moduleName)) continue;
      for (const c of inst.conns) {
        const baseSig = extractSimpleNetName(c.signal);
        if (baseSig) counts.set(baseSig, (counts.get(baseSig) ?? 0) + 1);
      }
    }
    parentStubNetCounts.set(pm.name, counts);
  }

  // Collect all stub ports and apply name + parent dataflow evidence
  for (const pm of parsed) {
    const ev = parentNetEvidence.get(pm.name)!;
    const netCounts = parentStubNetCounts.get(pm.name)!;
    for (const inst of pm.instances) {
      if (nameToId.has(inst.moduleName)) continue;
      let pMap = stubAccum.get(inst.moduleName);
      if (!pMap) {
        pMap = new Map();
        stubAccum.set(inst.moduleName, pMap);
      }
      inst.conns.forEach((c, idx) => {
        const pname = c.portName || `p${idx}`;
        const baseSig = extractSimpleNetName(c.signal);
        const inferredW =
          (baseSig
            ? (pm.wires.get(baseSig) ?? pm.ports.find((pp) => pp.name === baseSig)?.bitWidth)
            : undefined) ?? 1;
        let acc = pMap.get(pname);
        if (!acc) {
          const hint = classifyStubPortByName(pname);
          acc = {
            name: pname,
            bitWidth: inferredW,
            nameHint: hint,
            provenIn: false,
            provenOut: false,
            dir: hint === 'out' ? 'out' : 'in',
          };
          pMap.set(pname, acc);
        } else if (inferredW > acc.bitWidth) {
          acc.bitWidth = inferredW;
        }
        if (baseSig) {
          const stubTouches = netCounts.get(baseSig) ?? 1;
          if (ev.outPorts.has(baseSig) && !ev.drivenNets.has(baseSig) && stubTouches === 1) {
            // Directly drives a parent MODULE_OUT port with no other driver -> definitely OUT
            acc.provenOut = true;
          } else if (ev.sinkNets.has(baseSig) && !ev.drivenNets.has(baseSig) && stubTouches === 1) {
            // Sole stub connected to an undriven internal wire consumed by parent logic -> OUT
            acc.provenOut = true;
          } else if (ev.drivenNets.has(baseSig) && !ev.outPorts.has(baseSig)) {
            acc.provenIn = true;
          }
        }
      });
    }
  }

  // Apply dataflow proofs before stub-to-stub pass
  for (const pMap of stubAccum.values()) {
    for (const acc of pMap.values()) {
      if (acc.provenOut && !acc.provenIn) acc.dir = 'out';
      else if (acc.provenIn && !acc.provenOut) acc.dir = 'in';
      else if (acc.nameHint === 'out') acc.dir = 'out';
    }
  }

  // Stub-to-stub net pass: for any internal wire shared by multiple external stubs (e.g. clk_out1
  // or stub-to-stub AXI bus) that still has no `'out'` port driving it, elect ONE best driver!
  for (const pm of parsed) {
    const ev = parentNetEvidence.get(pm.name)!;
    const stubNetRefs = new Map<
      string,
      { modName: string; portName: string; acc: StubPortAccum }[]
    >();
    for (const inst of pm.instances) {
      const pMap = stubAccum.get(inst.moduleName);
      if (!pMap) continue;
      inst.conns.forEach((c, idx) => {
        const pname = c.portName || `p${idx}`;
        const baseSig = extractSimpleNetName(c.signal);
        if (!baseSig || ev.drivenNets.has(baseSig)) return;
        const acc = pMap.get(pname);
        if (!acc) return;
        const list = stubNetRefs.get(baseSig) ?? [];
        list.push({ modName: inst.moduleName, portName: pname, acc });
        stubNetRefs.set(baseSig, list);
      });
    }

    for (const refs of stubNetRefs.values()) {
      if (refs.length < 2) continue;
      if (refs.some((r) => r.acc.dir === 'out')) continue;
      // Pick best driver candidate: prefer nameHint='out', else unknown-name & not provenIn, else first non-provenIn
      const candidate =
        refs.find((r) => r.acc.nameHint === 'out') ??
        refs.find((r) => !r.acc.provenIn && r.acc.nameHint !== 'in') ??
        refs.find((r) => !r.acc.provenIn) ??
        refs[0];
      candidate.acc.dir = 'out';
    }
  }

  // Materialize external stub CircuitDocuments
  for (const [modName, pMap] of stubAccum.entries()) {
    const stubId = `stub_${modName}_${Math.random().toString(36).slice(2, 6)}`;
    nameToId.set(modName, stubId);
    const stubPorts: StubPort[] = Array.from(pMap.values()).map((a) => ({
      name: a.name,
      dir: a.dir,
      bitWidth: a.bitWidth,
    }));
    stubCircuits.set(modName, {
      id: stubId,
      name: `${modName} (External Stub)`,
      description: `外部モジュール ${modName} の仮シンボル（実装なし・IO配線可視化用）`,
      gates: [],
      wires: [],
      isStub: true,
      stubPorts,
      hdlProjectId,
    });
    warnings.push(
      `外部モジュール "${modName}" の定義が見つからないため、IO を再現した仮モジュール（Stub）を配置しました。`,
    );
  }

  const tempProject: ProjectDocument = {
    version: 1,
    name: 'HDL Import',
    activeCircuitId: '',
    circuits: {},
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

  // Seed tempProject with any reused existing project circuits (for pin lookup & sizing!)
  if (options?.existingCircuits) {
    for (const rid of reusedExistingIds) {
      const existing = options.existingCircuits[rid];
      if (existing) tempProject.circuits[rid] = existing;
    }
  }

  for (const stub of stubCircuits.values()) {
    tempProject.circuits[stub.id] = stub;
  }

  // Create placeholder shells for all defined modules so port order works regardless of module definition order
  for (const pm of parsed) {
    const cid = nameToId.get(pm.name)!;
    const portGates: GateInstance[] = [];
    let inOrder = 0;
    let outOrder = 0;
    for (const port of pm.ports) {
      if (port.dir === 'in') {
        portGates.push({
          id: uid('in'),
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: port.name,
          props: { bitWidth: port.bitWidth, value: '0', portSide: 'left', portOrder: inOrder++ },
        });
      } else {
        portGates.push({
          id: uid('out'),
          type: 'MODULE_OUT',
          x: 0,
          y: 0,
          rotation: 0,
          label: port.name,
          props: { bitWidth: port.bitWidth, portSide: 'right', portOrder: outOrder++ },
        });
      }
    }
    tempProject.circuits[cid] = {
      id: cid,
      name: pm.name,
      gates: portGates,
      wires: [],
      hdlSource: pm.hdlSource,
      hdlFileSource: pm.hdlFileSource,
      hdlFileName: pm.hdlFileName,
      hdlProjectId,
      hdlDiverged: false,
    };
  }

  // Second pass: synthesize internal gates, FFs/Registers, submodule instances, auto-layout, and route wires
  for (const pm of parsed) {
    const cid = nameToId.get(pm.name)!;
    const doc = tempProject.circuits[cid];
    const gates = doc.gates;
    const netPinMap = new Map<string, NetEntry>();

    // Build net width lookup for expression synthesis
    const netWidths = new Map<string, number>();
    for (const p of pm.ports) netWidths.set(p.name, p.bitWidth);
    for (const [wn, ww] of pm.wires.entries()) netWidths.set(wn, ww);

    const ctx: SynthContext = {
      modName: pm.name,
      gates,
      netPinMap,
      netWidths,
      signedNets: pm.signedNets,
      params: pm.params,
      bitSplitCache: new Map(),
      rangeSplitCache: new Map(),
      constCache: new Map(),
      exprCache: new Map(),
      warnings,
      warnedIssues: new Set(),
    };

    for (const g of gates) {
      if (g.type === 'MODULE_IN') {
        addNetDriver(netPinMap, g.label, { gateId: g.id, pinId: 'out' });
      } else if (g.type === 'MODULE_OUT') {
        addNetSink(netPinMap, g.label, { gateId: g.id, pinId: 'in' });
      }
    }

    const lhsSliceAssigns = new Map<string, { lo: number; hi: number; srcNet: string }[]>();
    const pendingAliases: { src: string; dst: string; bw: number }[] = [];

    const connectToLhsTarget = (lhsRaw: string, srcNetRaw: string, bw: number) => {
      const lhs = lhsRaw.trim();
      const slice = parseSliceExpr(lhs, pm.params);
      if (slice) {
        const list = lhsSliceAssigns.get(slice.base) ?? [];
        list.push({ lo: slice.lo, hi: slice.hi, srcNet: srcNetRaw });
        lhsSliceAssigns.set(slice.base, list);
        return;
      }
      if (srcNetRaw === lhs) return;
      const srcW = netWidths.get(srcNetRaw) ?? bw;
      const srcNet = srcW < bw ? extendNet(srcNetRaw, srcW, bw, ctx) : srcNetRaw;
      const srcEntry = ensureNetEntry(netPinMap, srcNet);
      if (srcNet.startsWith('__') && srcEntry.drivers.length > 0) {
        for (const drv of srcEntry.drivers) {
          addNetDriver(netPinMap, lhs, drv);
        }
      } else {
        pendingAliases.push({ src: srcNet, dst: lhs, bw });
      }
    };

    // 1. Place primitives
    for (const prim of pm.primitives) {
      const gid = uid('g');
      const w = netWidths.get(prim.outNet) ?? 1;
      gates.push({
        id: gid,
        type: prim.kind,
        x: 0,
        y: 0,
        rotation: 0,
        label: prim.instName,
        props:
          prim.kind === 'NOT' || prim.kind === 'BUF'
            ? { bitWidth: w }
            : { bitWidth: w, inputCount: Math.max(2, prim.inNets.length) },
      });
      addNetDriver(netPinMap, prim.outNet, { gateId: gid, pinId: 'out' });
      prim.inNets.forEach((n, idx) => {
        const inNet = buildExprGate(n, ctx, w);
        addNetSink(netPinMap, inNet, { gateId: gid, pinId: `in${idx}` });
      });
    }

    // 2. Place combinational assigns (including synthesized always_comb / always @*)
    for (const asgn of pm.assigns) {
      const lhsTrim = asgn.lhs.trim();

      // 2a. LHS concatenation `{cout, sum} = a + b` or general `{hi, lo} = expr`
      if (hasOuterWrappingBraces(lhsTrim)) {
        const concatMatch = lhsTrim.match(/^\{\s*\w+\s*,\s*(\w+)\s*\}$/);
        if (concatMatch) {
          const sumName = concatMatch[1];
          const sumW = netWidths.get(sumName) ?? 1;
          if (tryBuildConcatAdderAssign(lhsTrim, asgn.rhs, ctx, sumW)) {
            continue;
          }
        }
        // General LHS concatenation: split RHS into LSB-first chunks via SPLITTER
        const msbItems = expandConcatItems(lhsTrim, pm.params);
        if (msbItems.length > 0) {
          const lsbItems = [...msbItems].reverse();
          const widths = lsbItems.map((it) => inferExprWidth(it, netWidths, 1, pm.params));
          const totalW = widths.reduce((a, b) => a + b, 0);
          const rhsNet = buildExprGate(asgn.rhs, ctx, totalW);
          if (lsbItems.length === 1) {
            connectToLhsTarget(lsbItems[0], rhsNet, totalW);
          } else {
            const splId = uid('lspl');
            gates.push({
              id: splId,
              type: 'SPLITTER',
              x: 0,
              y: 0,
              rotation: 0,
              label: 'SPLIT',
              props: { splitMode: 'split', splitWidths: widths, bitWidth: totalW },
            });
            addNetSink(netPinMap, rhsNet, { gateId: splId, pinId: 'bus' });
            lsbItems.forEach((item, idx) => {
              const partNet = `__lspl_${splId}_b${idx}`;
              addNetDriver(netPinMap, partNet, { gateId: splId, pinId: `b${idx}` });
              netWidths.set(partNet, widths[idx]);
              connectToLhsTarget(item, partNet, widths[idx]);
            });
          }
          continue;
        }
      }

      // 2b. LHS bit-select / part-select `assign y[i] = ...;` or `assign y[hi:lo] = ...;`
      const lhsSlice = parseSliceExpr(lhsTrim, pm.params);
      if (lhsSlice) {
        const sliceW = lhsSlice.hi - lhsSlice.lo + 1;
        const srcNet = buildExprGate(asgn.rhs, ctx, sliceW);
        connectToLhsTarget(lhsTrim, srcNet, sliceW);
        continue;
      }

      // 2c. Standard LHS net assignment
      const bw = netWidths.get(lhsTrim) ?? inferExprWidth(asgn.rhs, netWidths, 1, pm.params);
      netWidths.set(lhsTrim, bw);
      const srcNet = buildExprGate(asgn.rhs, ctx, bw);
      connectToLhsTarget(lhsTrim, srcNet, bw);
    }

    // 3. Place synthesized sequential FFs / Registers from always_ff / always @(posedge ...)
    for (const ff of pm.ffs) {
      const bw = netWidths.get(ff.target) ?? 1;
      const isMulti = bw > 1;
      const ffId = uid('ff');
      gates.push({
        id: ffId,
        type: isMulti ? 'REGISTER' : 'D_FF',
        x: 0,
        y: 0,
        rotation: 0,
        label: ff.target,
        props: { bitWidth: bw, hasEnable: Boolean(ff.enExpr) },
      });

      // Output Q drives target net
      addNetDriver(netPinMap, ff.target, { gateId: ffId, pinId: 'q' });
      // Clock
      addNetSink(netPinMap, ff.clkNet, { gateId: ffId, pinId: 'clk' });
      // Data input D (may reference ff.target itself, e.g. cnt <= cnt + 1!)
      const dRaw = buildExprGate(ff.dExpr, ctx, bw);
      const dNet = extendNet(dRaw, ctx.netWidths.get(dRaw) ?? bw, bw, ctx);
      addNetSink(netPinMap, dNet, { gateId: ffId, pinId: 'd' });

      // Optional Enable
      if (ff.enExpr) {
        const enNet = buildExprGate(ff.enExpr, ctx, 1);
        addNetSink(netPinMap, enNet, { gateId: ffId, pinId: 'en' });
      }

      // Optional Reset (invert via NOT if active-low negedge rst_n!)
      if (ff.rstNet) {
        const rstPin = isMulti ? 'clr' : 'rst';
        if (ff.rstActiveLow) {
          const invId = uid('rstinv');
          gates.push({
            id: invId,
            type: 'NOT',
            x: 0,
            y: 0,
            rotation: 0,
            label: '',
            props: { bitWidth: 1 },
          });
          addNetSink(netPinMap, ff.rstNet, { gateId: invId, pinId: 'in0' });
          const invNet = `__rst_hi_${invId}`;
          addNetDriver(netPinMap, invNet, { gateId: invId, pinId: 'out' });
          addNetSink(netPinMap, invNet, { gateId: ffId, pinId: rstPin });
        } else {
          addNetSink(netPinMap, ff.rstNet, { gateId: ffId, pinId: rstPin });
        }
      }
    }

    // 4. Place submodule instances (defined & external stubs)
    const declaredInParent = new Set<string>([
      ...pm.ports.map((p) => p.name),
      ...pm.wires.keys(),
      ...pm.params.keys(),
    ]);
    for (const inst of pm.instances) {
      const targetId = nameToId.get(inst.moduleName);
      if (!targetId) continue;
      const gid = uid('sub');
      const gate: GateInstance = {
        id: gid,
        type: 'SUBCIRCUIT',
        x: 0,
        y: 0,
        rotation: 0,
        label: `${inst.instName} : ${inst.moduleName}`,
        props: {
          subcircuitId: targetId,
          displayMode: tempProject.circuits[targetId]?.isStub ? 'box' : 'live',
        },
      };
      gates.push(gate);

      const pins = getGatePins(gate, tempProject);
      inst.conns.forEach((conn, cIdx) => {
        const pin = conn.portName ? pins.find((p) => p.name === conn.portName) : pins[cIdx];
        if (!pin) {
          const msg = conn.portName
            ? `[${pm.name}] インスタンス "${inst.instName}" (${inst.moduleName}) に存在しないポート ".${conn.portName}" が指定されています`
            : `[${pm.name}] インスタンス "${inst.instName}" (${inst.moduleName}) の位置指定ポート #${cIdx + 1} が定義ポート数 (${pins.length}) を超えています`;
          warnOnce(ctx, `inst-bad-port:${inst.instName}:${conn.portName ?? cIdx}`, msg);
          return;
        }
        const sigTrim = conn.signal.trim();
        if (!sigTrim) return;

        // Warn when an instantiated port connects to a signal identifier not declared in the parent module
        const sigNoLit = sigTrim
          .replace(/\b\d+'s?[bhdoBHDO][0-9a-fA-FxXzZ_?]+\b/g, ' ')
          .replace(/'[01xXzZ]\b/g, ' ')
          .replace(/\$\w+/g, ' ');
        for (const idM of sigNoLit.matchAll(/\b([a-zA-Z_]\w*)\b/g)) {
          const id = idM[1];
          if (KEYWORDS.has(id) || declaredInParent.has(id)) continue;
          if (idM.index > 0 && sigNoLit[idM.index - 1] === '.') continue;
          warnOnce(
            ctx,
            `inst-undecl-sig:${inst.instName}:${pin.name}:${id}`,
            `[${pm.name}] インスタンス "${inst.instName}" (${inst.moduleName}) のポート ".${pin.name}" に未宣言の信号 "${id}" が接続されています`,
          );
        }

        if (pin.dir === 'out') {
          const outSlice = parseSliceExpr(sigTrim, pm.params);
          if (outSlice) {
            const tmpNet = `__sub_${gid}_${pin.id}`;
            addNetDriver(netPinMap, tmpNet, { gateId: gid, pinId: pin.id });
            netWidths.set(tmpNet, pin.bitWidth);
            connectToLhsTarget(sigTrim, tmpNet, pin.bitWidth);
          } else {
            addNetDriver(netPinMap, sigTrim, { gateId: gid, pinId: pin.id });
          }
        } else {
          const netName = buildExprGate(sigTrim, ctx, pin.bitWidth);
          addNetSink(netPinMap, netName, { gateId: gid, pinId: pin.id });
        }
      });
    }

    // 4b. Materialize per-bit / slice LHS assignments (`assign y[0] = ...; assign y[1] = ...;`) into merge SPLITTERs
    for (const [baseNet, slices] of lhsSliceAssigns.entries()) {
      const sorted = [...slices].sort((a, b) => a.lo - b.lo);
      const maxBit = Math.max(...sorted.map((s) => s.hi));
      const totalW = Math.max(netWidths.get(baseNet) ?? 1, maxBit + 1);
      netWidths.set(baseNet, totalW);

      const chunks: { width: number; net: string }[] = [];
      let cursor = 0;
      for (const sl of sorted) {
        if (sl.lo > cursor) {
          const gapW = sl.lo - cursor;
          const gapNet = buildExprGate(`${gapW}'b${'z'.repeat(gapW)}`, ctx, gapW);
          chunks.push({ width: gapW, net: gapNet });
        }
        if (sl.hi >= cursor) {
          const w = sl.hi - sl.lo + 1;
          chunks.push({ width: w, net: sl.srcNet });
          cursor = sl.hi + 1;
        }
      }
      if (cursor < totalW) {
        const tailW = totalW - cursor;
        const tailNet = buildExprGate(`${tailW}'b${'z'.repeat(tailW)}`, ctx, tailW);
        chunks.push({ width: tailW, net: tailNet });
      }

      if (chunks.length === 1 && chunks[0].width === totalW) {
        connectToLhsTarget(baseNet, chunks[0].net, totalW);
      } else if (chunks.length > 0) {
        const splId = uid('mrg');
        gates.push({
          id: splId,
          type: 'SPLITTER',
          x: 0,
          y: 0,
          rotation: 0,
          label: baseNet,
          props: {
            splitMode: 'merge',
            splitWidths: chunks.map((c) => c.width),
            bitWidth: totalW,
          },
        });
        chunks.forEach((ch, idx) => {
          addNetSink(netPinMap, ch.net, { gateId: splId, pinId: `b${idx}` });
        });
        addNetDriver(netPinMap, baseNet, { gateId: splId, pinId: 'bus' });
      }
    }

    // 4c. Resolve net-to-net `assign dst = src;` aliases cleanly regardless of declaration order!
    const resolvedAlias = new Set<number>();
    for (let pass = 0; pass < pendingAliases.length + 1; pass++) {
      let progress = false;
      for (let i = 0; i < pendingAliases.length; i++) {
        if (resolvedAlias.has(i)) continue;
        const al = pendingAliases[i];
        const srcEntry = ensureNetEntry(netPinMap, al.src);
        if (srcEntry.drivers.length > 0) {
          for (const drv of srcEntry.drivers) {
            addNetDriver(netPinMap, al.dst, drv);
          }
          resolvedAlias.add(i);
          progress = true;
        }
      }
      if (!progress) break;
    }
    // Any remaining unresolved alias (e.g. undriven net or loop) gets an explicit BUF so topology stays visible
    for (let i = 0; i < pendingAliases.length; i++) {
      if (resolvedAlias.has(i)) continue;
      const al = pendingAliases[i];
      const bufId = uid('buf');
      gates.push({
        id: bufId,
        type: 'BUF',
        x: 0,
        y: 0,
        rotation: 0,
        label: '',
        props: { bitWidth: al.bw },
      });
      addNetSink(netPinMap, al.src, { gateId: bufId, pinId: 'in0' });
      addNetDriver(netPinMap, al.dst, { gateId: bufId, pinId: 'out' });
    }

    // 5. Run layered non-overlapping topological auto-layout!
    autoLayoutGates(gates, netPinMap, tempProject);

    // 6. Route wires cleanly with obstacle avoidance + dedicated top/bottom detour corridors
    //    for global CLK/RST rails and right-to-left CPU feedback loops!
    const wires: Wire[] = [];
    const gateMap = new Map(gates.map((g) => [g.id, g]));
    const gateBoxes = gates.map((g) => ({ id: g.id, ...getGateBounds(g, tempProject) }));
    const layoutTopY = gateBoxes.length > 0 ? Math.min(...gateBoxes.map((b) => b.y)) : 100;
    const layoutBottomY =
      gateBoxes.length > 0 ? Math.max(...gateBoxes.map((b) => b.y + b.height)) : 300;

    let topRailIndex = 0;
    let bottomRailIndex = 0;

    const getPinInfo = (ref: PinRef) => {
      const g = gateMap.get(ref.gateId);
      if (!g) return null;
      const pin = getGatePins(g, tempProject).find((p) => p.id === ref.pinId);
      if (!pin) return null;
      return {
        pos: getPinWorldPos(g, pin),
        side: getPinWorldSide(pin.side, g.rotation),
      };
    };

    /**
     * Returns true ONLY when no obstacle-free orthogonal Z-route exists between two forward pins
     * (i.e. at least one intermediate gate genuinely blocks direct routing between them).
     */
    const hasInterveningGate = (
      fromGateId: string,
      toGateId: string,
      fromPos: { x: number; y: number },
      toPos: { x: number; y: number },
    ): boolean => {
      const xStart = snapToGrid(fromPos.x + GRID_SIZE, GRID_SIZE);
      const xEnd = snapToGrid(toPos.x - GRID_SIZE, GRID_SIZE);
      if (xEnd < xStart) return false;
      const yMin = Math.min(fromPos.y, toPos.y);
      const yMax = Math.max(fromPos.y, toPos.y);
      const pad = 6;
      // Pre-filter to only boxes whose bounding box overlaps the wire's XY corridor!
      const others = gateBoxes.filter(
        (b) =>
          b.id !== fromGateId &&
          b.id !== toGateId &&
          b.x + b.width + pad > xStart &&
          b.x - pad < xEnd &&
          b.y + b.height + pad > yMin &&
          b.y - pad < yMax,
      );
      if (others.length === 0) return false;

      const horizBlocked = (x1: number, x2: number, y: number): boolean => {
        const lo = Math.min(x1, x2);
        const hi = Math.max(x1, x2);
        for (const b of others) {
          if (
            b.x + b.width + pad > lo &&
            b.x - pad < hi &&
            b.y - pad < y &&
            b.y + b.height + pad > y
          ) {
            return true;
          }
        }
        return false;
      };
      const vertBlocked = (x: number, y1: number, y2: number): boolean => {
        const lo = Math.min(y1, y2);
        const hi = Math.max(y1, y2);
        for (const b of others) {
          if (
            b.x - pad < x &&
            b.x + b.width + pad > x &&
            b.y + b.height + pad > lo &&
            b.y - pad < hi
          ) {
            return true;
          }
        }
        return false;
      };

      // If ANY grid-aligned vertical channel midX gives a completely obstacle-free Z-route, no detour is needed!
      for (let midX = xStart; midX <= xEnd; midX += GRID_SIZE) {
        if (
          !horizBlocked(xStart, midX, fromPos.y) &&
          !vertBlocked(midX, yMin, yMax) &&
          !horizBlocked(midX, xEnd, toPos.y)
        ) {
          return false;
        }
      }
      return true;
    };

    const tempDoc: CircuitDocument = { ...doc, wires };
    const batchRouter = createBatchWireRouter(tempDoc, tempProject, GRID_SIZE);
    let estimatedWireCount = 0;
    for (const entry of netPinMap.values()) {
      estimatedWireCount += Math.max(entry.sinks.length, entry.drivers.length);
    }
    const useFastRouting = estimatedWireCount > 240;

    for (const [netName, entry] of netPinMap.entries()) {
      const visibleLabel = netName.startsWith('__') ? undefined : netName;
      const isGlobalNet = isGlobalDistributionNet(netName, entry, gateMap);
      // Allocate top corridor rail lazily ONLY if at least one sink genuinely needs to detour over/around modules
      let sharedGlobalRailY: number | undefined;
      const ensureGlobalRailY = (): number => {
        if (sharedGlobalRailY === undefined) {
          sharedGlobalRailY = snapToGrid(layoutTopY - 40 - topRailIndex++ * GRID_SIZE, GRID_SIZE);
        }
        return sharedGlobalRailY;
      };

      const validDrivers = entry.drivers
        .map((drv) => ({ ref: drv, info: getPinInfo(drv) }))
        .filter((x): x is { ref: PinRef; info: NonNullable<ReturnType<typeof getPinInfo>> } =>
          Boolean(x.info),
        );

      // Sort sinks left-to-right for global top rail (clean trunk), else top-to-bottom
      const sortedSinks = entry.sinks
        .map((sink) => ({ ref: sink, info: getPinInfo(sink) }))
        .filter((x): x is { ref: PinRef; info: NonNullable<ReturnType<typeof getPinInfo>> } =>
          Boolean(x.info),
        )
        .sort((a, b) => (isGlobalNet ? a.info.pos.x - b.info.pos.x : a.info.pos.y - b.info.pos.y));

      const routeConnection = (
        fromRef: PinRef,
        fromInfo: NonNullable<ReturnType<typeof getPinInfo>>,
        toRef: PinRef,
        toInfo: NonNullable<ReturnType<typeof getPinInfo>>,
      ) => {
        const isFeedback = fromInfo.pos.x >= toInfo.pos.x - GRID_SIZE;
        const skipsOverGate =
          !isFeedback && hasInterveningGate(fromRef.gateId, toRef.gateId, fromInfo.pos, toInfo.pos);

        let preferredDetourY: number | undefined;
        let allowSharedDetourY = false;

        if (isGlobalNet) {
          // Only detour global CLK/RST wires onto the shared top rail when an intermediate module blocks direct routing!
          if (isFeedback || skipsOverGate) {
            preferredDetourY = ensureGlobalRailY();
            allowSharedDetourY = true;
          }
        } else if (isFeedback) {
          // Right-to-left feedback loop (e.g. CPU WB->RF or ALU->PC): detour cleanly below all modules!
          preferredDetourY = snapToGrid(
            layoutBottomY + 60 + bottomRailIndex++ * GRID_SIZE,
            GRID_SIZE,
          );
          allowSharedDetourY = false;
        } else if (skipsOverGate) {
          // Long forward wire jumping across intermediate modules: detour cleanly above or below!
          const distTop =
            Math.abs(fromInfo.pos.y - layoutTopY) + Math.abs(toInfo.pos.y - layoutTopY);
          const distBot =
            Math.abs(fromInfo.pos.y - layoutBottomY) + Math.abs(toInfo.pos.y - layoutBottomY);
          preferredDetourY =
            distTop < distBot
              ? snapToGrid(layoutTopY - 40 - topRailIndex++ * GRID_SIZE, GRID_SIZE)
              : snapToGrid(layoutBottomY + 60 + bottomRailIndex++ * GRID_SIZE, GRID_SIZE);
          allowSharedDetourY = false;
        }

        const pts = batchRouter.route(fromInfo.pos, toInfo.pos, {
          startSide: fromInfo.side,
          endSide: toInfo.side,
          routeMode: 'grid',
          preferredDetourY,
          allowSharedDetourY,
          fastMode: useFastRouting,
        });
        wires.push({
          id: uid('w'),
          from: fromRef,
          to: toRef,
          points: pts,
          netLabel: visibleLabel,
          routeMode: 'grid',
        });
      };

      if (validDrivers.length > 0 && sortedSinks.length > 0) {
        // Primary driver connects to every sink on the net
        const primary = validDrivers[0];
        for (const { ref: sink, info: toInfo } of sortedSinks) {
          routeConnection(primary.ref, primary.info, sink, toInfo);
        }

        // Additional drivers (e.g. multi-driver tri-state bus) tie cleanly onto the first sink of the same net
        const anchorSink = sortedSinks[0];
        for (let di = 1; di < validDrivers.length; di++) {
          const extra = validDrivers[di];
          routeConnection(extra.ref, extra.info, anchorSink.ref, anchorSink.info);
        }
      } else {
        // Fallback for stub-to-stub / passive nets where all pins were classified as sinks (or all drivers)
        const endpoints = validDrivers.length >= 2 ? validDrivers : sortedSinks;
        if (endpoints.length >= 2) {
          const sortedEps = [...endpoints].sort(
            (a, b) => a.info.pos.x - b.info.pos.x || a.info.pos.y - b.info.pos.y,
          );
          const anchor = sortedEps[0];
          for (let ei = 1; ei < sortedEps.length; ei++) {
            const peer = sortedEps[ei];
            routeConnection(anchor.ref, anchor.info, peer.ref, peer.info);
          }
        }
      }
    }

    doc.wires = wires;
  }

  // Pick top module (the one not instantiated by any other parsed module, or the last one)
  const topCircuitId = nameToId.get(topCandidate.name)!;

  // Return newly synthesized modules & stubs (excluding pre-existing reused circuits)
  const outCircuits = Object.values(tempProject.circuits).filter(
    (c) => !reusedExistingIds.has(c.id),
  );

  const moduleCircuitIds = parsed.map((pm) => nameToId.get(pm.name)!);
  const stubCircuitIds = Array.from(stubCircuits.values()).map((s) => s.id);
  const hdlProject: HdlProjectBundle = {
    id: hdlProjectId,
    name: options?.projectName?.trim() || topCandidate.name,
    files: validFiles.map((f, idx) => ({
      name:
        f.name.trim() ||
        (validFiles.length === 1 ? `${topCandidate.name}.sv` : `file_${idx + 1}.sv`),
      content: f.content,
    })),
    topModuleName: topCandidate.name,
    topCircuitId,
    moduleCircuitIds,
    stubCircuitIds,
  };

  return {
    circuits: outCircuits,
    topCircuitId,
    hdlProject,
    warnings,
  };
}

/**
 * Re-synthesize an existing circuit in-place from edited Verilog / SystemVerilog source,
 * preserving its circuit ID (so parent module instances stay connected!) and resolving any
 * other modules already present in the project.
 */
export function resynthesizeCircuitFromHdl(
  circuitId: string,
  newSource: string,
  project: ProjectDocument,
): ImportResult {
  const existing = project.circuits[circuitId];
  const result = importVerilogFilesToCircuits(
    [{ name: existing?.hdlFileName ?? '', content: newSource }],
    {
      existingCircuits: project.circuits,
      preserveCircuitId: circuitId,
      hdlProjectId: existing?.hdlProjectId,
    },
  );
  // Preserve original filename & project membership metadata, clear divergence flag
  for (const c of result.circuits) {
    if (c.id === circuitId) {
      if (existing?.hdlFileName && !c.hdlFileName) c.hdlFileName = existing.hdlFileName;
      c.hdlProjectId = existing?.hdlProjectId;
      c.hdlDiverged = false;
    }
  }
  return result;
}

/**
 * Re-synthesize an entire multi-file HDL Project Bundle in-place, preserving circuit IDs
 * for every matching module name and updating the designated top module!
 */
export function resynthesizeHdlProject(
  hdlProjectId: string,
  files: HdlSourceFile[],
  topModuleName: string | undefined,
  project: ProjectDocument,
): ImportResult {
  const existingBundle = project.hdlProjects?.[hdlProjectId];
  const preserveMap = new Map<string, string>();
  const otherCircuits: Record<string, CircuitDocument> = {};
  const bundleIds = new Set<string>([
    ...(existingBundle?.moduleCircuitIds ?? []),
    ...(existingBundle?.stubCircuitIds ?? []),
  ]);

  for (const c of Object.values(project.circuits)) {
    if (bundleIds.has(c.id)) {
      if (!c.isStub) preserveMap.set(c.name, c.id);
    } else {
      otherCircuits[c.id] = c;
    }
  }

  return importVerilogFilesToCircuits(files, {
    existingCircuits: otherCircuits,
    preserveIdByModuleName: preserveMap,
    topModuleName: topModuleName || existingBundle?.topModuleName,
    projectName: existingBundle?.name,
    hdlProjectId,
  });
}

// ============================================================================
// Netlist Exporters (Verilog, JSON Netlist, Graphviz DOT)
// ============================================================================

function sanitizeIdent(s: string, fallback: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return cleaned || fallback;
}

interface ExportNetInfo {
  netName: string;
  bitWidth: number;
  connections: { gateId: string; gateLabel: string; pinId: string; pinName: string; dir: string }[];
}

function extractFlatNetlist(
  circuit: CircuitDocument,
  project: ProjectDocument,
): {
  nets: ExportNetInfo[];
  pinToNetName: Map<string, string>;
} {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const initial = parent.get(x);
    if (initial === undefined) {
      parent.set(x, x);
      return x;
    }
    let p: string = initial;
    while (p !== parent.get(p)) {
      const gp: string = parent.get(p) ?? p;
      parent.set(p, gp);
      p = gp;
    }
    parent.set(x, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const labelHints = new Map<string, string>();
  const posMap = new Map<string, string>();

  for (const g of circuit.gates) {
    const pins = getGatePins(g, project);
    for (const p of pins) {
      const pk = `${g.id}:${p.id}`;
      const node = `pin:${pk}`;
      find(node);
      const pos = getPinWorldPos(g, p);
      const xy = `${Math.round(pos.x)},${Math.round(pos.y)}`;
      const ex = posMap.get(xy);
      if (ex) union(ex, node);
      else posMap.set(xy, node);

      if (g.type === 'TUNNEL' && g.props.netName) {
        union(node, `lbl:${g.props.netName}`);
        labelHints.set(`lbl:${g.props.netName}`, g.props.netName);
      }
      if ((g.type === 'MODULE_IN' || g.type === 'MODULE_OUT') && g.label) {
        labelHints.set(node, g.label);
      }
    }
  }

  for (const w of circuit.wires) {
    const wn = `wire:${w.id}`;
    find(wn);
    if (w.from) union(wn, `pin:${w.from.gateId}:${w.from.pinId}`);
    if (w.to) union(wn, `pin:${w.to.gateId}:${w.to.pinId}`);
    if (w.netLabel) {
      union(wn, `lbl:${w.netLabel}`);
      labelHints.set(`lbl:${w.netLabel}`, w.netLabel);
    }
    if (w.points.length >= 2) {
      for (const ep of [w.points[0], w.points[w.points.length - 1]]) {
        const xy = `${Math.round(ep.x)},${Math.round(ep.y)}`;
        const ex = posMap.get(xy);
        if (ex) union(ex, wn);
        else posMap.set(xy, wn);
      }
    }
  }

  const rootName = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const [node, hint] of labelHints.entries()) {
    const r = find(node);
    const base = sanitizeIdent(hint, 'net');
    if (!rootName.has(r) && !usedNames.has(base)) {
      rootName.set(r, base);
      usedNames.add(base);
    }
  }

  const netsByRoot = new Map<string, ExportNetInfo>();
  const pinToNetName = new Map<string, string>();
  let netCounter = 0;

  for (const g of circuit.gates) {
    const pins = getGatePins(g, project);
    for (const p of pins) {
      const pk = `${g.id}:${p.id}`;
      const r = find(`pin:${pk}`);
      let info = netsByRoot.get(r);
      if (!info) {
        let name = rootName.get(r);
        if (!name) {
          do {
            name = `n_${netCounter++}`;
          } while (usedNames.has(name));
          usedNames.add(name);
        }
        info = { netName: name, bitWidth: p.bitWidth, connections: [] };
        netsByRoot.set(r, info);
      }
      if (p.bitWidth > info.bitWidth) info.bitWidth = p.bitWidth;
      info.connections.push({
        gateId: g.id,
        gateLabel: g.label || g.type,
        pinId: p.id,
        pinName: p.name,
        dir: p.dir,
      });
      pinToNetName.set(pk, info.netName);
    }
  }

  return { nets: Array.from(netsByRoot.values()), pinToNetName };
}

export function exportVerilog(project: ProjectDocument, circuitId: string): string {
  const visited = new Set<string>();
  const chunks: string[] = [
    `// Generated by LogicFlow Simulator`,
    `// Project: ${project.name}`,
    ``,
  ];

  const emitCircuit = (cid: string) => {
    if (visited.has(cid)) return;
    visited.add(cid);
    const circuit = project.circuits[cid];
    if (!circuit || circuit.isStub) return;

    for (const g of circuit.gates) {
      if (g.type === 'SUBCIRCUIT' && g.props.subcircuitId) {
        emitCircuit(g.props.subcircuitId);
      }
    }

    const { nets, pinToNetName } = extractFlatNetlist(circuit, project);
    const modName = sanitizeIdent(circuit.name, 'top_module');

    const portGates = circuit.gates.filter(
      (g) => g.type === 'MODULE_IN' || g.type === 'MODULE_OUT',
    );
    const portNames = new Set<string>();
    const portDecls: string[] = [];

    for (const pg of portGates) {
      const dir = pg.type === 'MODULE_IN' ? 'input ' : 'output';
      const w = pg.props.bitWidth ?? 1;
      const range = w > 1 ? `[${w - 1}:0] ` : '';
      const pname = sanitizeIdent(pg.label || pg.id, pg.id);
      portNames.add(pname);
      portDecls.push(`  ${dir} wire ${range}${pname}`);
    }

    chunks.push(`module ${modName} (`);
    chunks.push(portDecls.join(',\n'));
    chunks.push(`);`);

    for (const net of nets) {
      if (portNames.has(net.netName)) continue;
      const range = net.bitWidth > 1 ? `[${net.bitWidth - 1}:0] ` : '';
      chunks.push(`  wire ${range}${net.netName};`);
    }
    chunks.push('');

    for (const pg of portGates) {
      const pname = sanitizeIdent(pg.label || pg.id, pg.id);
      if (pg.type === 'MODULE_IN') {
        const net = pinToNetName.get(`${pg.id}:out`);
        if (net && net !== pname) {
          chunks.push(`  assign ${net} = ${pname};`);
        }
      } else {
        const net = pinToNetName.get(`${pg.id}:in`);
        if (net && net !== pname) {
          chunks.push(`  assign ${pname} = ${net};`);
        }
      }
    }

    const netPinCounts = new Map<string, number>();
    for (const n of nets) netPinCounts.set(n.netName, n.connections.length);

    let idx = 0;
    for (const g of circuit.gates) {
      if (g.type === 'MODULE_IN' || g.type === 'MODULE_OUT' || g.type === 'TUNNEL') continue;
      const getNet = (pinId: string, fallback = "1'bz") => {
        const n = pinToNetName.get(`${g.id}:${pinId}`);
        if (!n || (netPinCounts.get(n) ?? 0) <= 1) return fallback;
        return n;
      };
      const getOutNet = (pinId: string) =>
        pinToNetName.get(`${g.id}:${pinId}`) ?? `unused_${idx++}`;
      const inst = sanitizeIdent(g.label || `${g.type.toLowerCase()}_${idx++}`, `u_${idx++}`);

      switch (g.type) {
        case 'AND':
        case 'OR':
        case 'XOR':
        case 'NAND':
        case 'NOR':
        case 'XNOR': {
          const n = g.props.inputCount ?? 2;
          const ins = Array.from({ length: n }, (_, i) => getNet(`in${i}`));
          const opMap: Record<string, string> = {
            AND: '&',
            NAND: '&',
            OR: '|',
            NOR: '|',
            XOR: '^',
            XNOR: '^',
          };
          const expr = ins.join(` ${opMap[g.type]} `);
          const inv =
            g.type === 'NAND' || g.type === 'NOR' || g.type === 'XNOR' ? `~(${expr})` : expr;
          chunks.push(`  assign ${getOutNet('out')} = ${inv};`);
          break;
        }
        case 'NOT':
          chunks.push(`  assign ${getOutNet('out')} = ~${getNet('in0')};`);
          break;
        case 'BUF':
          chunks.push(`  assign ${getOutNet('out')} = ${getNet('in0')};`);
          break;
        case 'TRIBUF':
          chunks.push(
            `  assign ${getOutNet('out')} = ${getNet('en')} ? ${getNet('in0')} : ${g.props.bitWidth ?? 1}'b${'z'.repeat(g.props.bitWidth ?? 1)};`,
          );
          break;
        case 'CONST':
        case 'TOGGLE': {
          const bw = g.props.bitWidth ?? 1;
          const lv = fromLiteral(g.props.value ?? '0', bw);
          chunks.push(`  assign ${getOutNet('out')} = ${bw}'b${toBinString(lv).toLowerCase()};`);
          break;
        }
        case 'HALF_ADDER':
          chunks.push(
            `  assign {${getOutNet('c')}, ${getOutNet('s')}} = ${getNet('a')} + ${getNet('b')};`,
          );
          break;
        case 'FULL_ADDER':
        case 'ADDER': {
          if (g.type === 'ADDER' && g.props.hasCarryIn === false) {
            chunks.push(
              `  assign {${getOutNet('cout')}, ${getOutNet('s')}} = ${getNet('a')} + ${getNet('b')};`,
            );
          } else {
            const cin = getNet('cin', "1'b0");
            chunks.push(
              `  assign {${getOutNet('cout')}, ${getOutNet('s')}} = ${getNet('a')} + ${getNet('b')} + ${cin};`,
            );
          }
          break;
        }
        case 'MUX': {
          const { channels, selectBits: selBits } = getMuxConfig(g.props);
          const sel = getNet('sel');
          const bw = g.props.bitWidth ?? 1;
          if (channels === 2 && selBits === 1) {
            chunks.push(
              `  assign ${getOutNet('out')} = ${sel} ? ${getNet('d1')} : ${getNet('d0')};`,
            );
          } else {
            const fullSlots = 1 << selBits;
            let expr =
              channels === fullSlots ? getNet(`d${channels - 1}`) : `${bw}'b${'x'.repeat(bw)}`;
            const startIdx = channels === fullSlots ? channels - 2 : channels - 1;
            for (let i = startIdx; i >= 0; i--) {
              expr = `(${sel} == ${selBits}'d${i}) ? ${getNet(`d${i}`)} : (${expr})`;
            }
            chunks.push(`  assign ${getOutNet('out')} = ${expr};`);
          }
          break;
        }
        case 'SUBCIRCUIT': {
          const sub = g.props.subcircuitId ? project.circuits[g.props.subcircuitId] : undefined;
          const subName = sanitizeIdent(
            sub?.name.replace(/\s*\(External Stub\)$/, '') ?? 'submod',
            'submod',
          );
          const pins = getGatePins(g, project);
          const conns = pins.map((p) => {
            const n = p.dir === 'out' ? getOutNet(p.id) : getNet(p.id);
            return `.${sanitizeIdent(p.name, p.id)}(${n})`;
          });
          chunks.push(`  ${subName} ${inst} (${conns.join(', ')});`);
          break;
        }
        default:
          chunks.push(
            `  // ${g.type} ${inst} (${getGatePins(g, project)
              .map((p) => `${p.name}=${pinToNetName.get(`${g.id}:${p.id}`) ?? "1'bz"}`)
              .join(', ')})`,
          );
      }
    }

    chunks.push(`endmodule\n`);
  };

  emitCircuit(circuitId);
  return chunks.join('\n');
}

export function exportJsonNetlist(project: ProjectDocument, circuitId: string): string {
  const circuit = project.circuits[circuitId];
  if (!circuit) return '{}';
  const { nets } = extractFlatNetlist(circuit, project);
  return JSON.stringify(
    {
      format: 'logicflow-netlist-v1',
      module: circuit.name,
      instances: circuit.gates.map((g) => ({
        id: g.id,
        type: g.type,
        label: g.label,
        subcircuit: g.props.subcircuitId ? project.circuits[g.props.subcircuitId]?.name : undefined,
        props: g.props,
      })),
      nets,
    },
    null,
    2,
  );
}

export function exportDotGraph(project: ProjectDocument, circuitId: string): string {
  const circuit = project.circuits[circuitId];
  if (!circuit) return '';
  const { nets } = extractFlatNetlist(circuit, project);
  const lines = [
    `digraph "${circuit.name}" {`,
    `  rankdir=LR;`,
    `  node [shape=box, style=rounded, fontname="monospace"];`,
  ];
  for (const g of circuit.gates) {
    lines.push(`  "${g.id}" [label="${g.label || g.type}\\n(${g.type})"];`);
  }
  for (const net of nets) {
    const drivers = net.connections.filter((c) => c.dir === 'out');
    const sinks = net.connections.filter((c) => c.dir === 'in');
    for (const d of drivers) {
      for (const s of sinks) {
        lines.push(`  "${d.gateId}" -> "${s.gateId}" [label="${net.netName} [${net.bitWidth}]"];`);
      }
    }
  }
  lines.push('}');
  return lines.join('\n');
}
