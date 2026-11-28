/**
 * Pure DOM-independent Verilog / SystemVerilog syntax & static diagnostic validator.
 * Gives immediate line-numbered errors/warnings in the HDL editor and prevents broken syntax
 * from silently synthesizing into disconnected circuits.
 */

export type HdlDiagnosticSeverity = 'error' | 'warning';

export interface HdlDiagnostic {
  line: number; // 1-based line number
  severity: HdlDiagnosticSeverity;
  message: string;
}

const SV_KEYWORDS = new Set([
  'module',
  'endmodule',
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'bit',
  'int',
  'integer',
  'real',
  'realtime',
  'string',
  'event',
  'signed',
  'unsigned',
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
  'case',
  'casex',
  'casez',
  'endcase',
  'default',
  'posedge',
  'negedge',
  'edge',
  'generate',
  'endgenerate',
  'genvar',
  'function',
  'endfunction',
  'task',
  'endtask',
  'property',
  'endproperty',
  'sequence',
  'endsequence',
  'typedef',
  'struct',
  'enum',
  'packed',
  'import',
  'export',
  'package',
  'endpackage',
  'interface',
  'endinterface',
  'assert',
  'assume',
  'cover',
  'restrict',
  'expect',
  'unique',
  'priority',
  'return',
  'automatic',
  'static',
  'and',
  'or',
  'xor',
  'nand',
  'nor',
  'xnor',
  'not',
  'buf',
  'bufif0',
  'bufif1',
  'notif0',
  'notif1',
  'timeunit',
  'timeprecision',
  'class',
  'endclass',
  'clocking',
  'endclocking',
  'covergroup',
  'endgroup',
  'specify',
  'endspecify',
  'disable',
  'iff',
]);

/** Replace comments, strings, and compiler directives with spaces while strictly preserving `\n` line numbers. */
function maskNonCodePreservingLines(
  src: string,
  diagnostics: HdlDiagnostic[],
): { masked: string; lineOfOffset: (off: number) => number } {
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOfOffset = (off: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= off) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(1, hi + 1);
  };

  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // Line comment
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && src[i + 1] === '*') {
      const startLine = lineOfOffset(i);
      out.push(' ', ' ');
      i += 2;
      let closed = false;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          out.push(' ', ' ');
          i += 2;
          closed = true;
          break;
        }
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          severity: 'error',
          message: 'ブロックコメント `/* ... */` が閉じられていません',
        });
      }
      continue;
    }
    // Compiler directive at start of line (`timescale, `define, `ifdef, etc.)
    if (ch === '`') {
      // Mask entire line for line-start directives; otherwise mask just the macro token
      let lineStart = i;
      while (lineStart > 0 && src[lineStart - 1] !== '\n') lineStart--;
      const beforeOnLine = src.slice(lineStart, i).trim();
      if (beforeOnLine === '') {
        while (i < n && src[i] !== '\n') {
          out.push(' ');
          i++;
        }
      } else {
        out.push(' ');
        i++;
        while (i < n && /\w/.test(src[i])) {
          out.push(' ');
          i++;
        }
      }
      continue;
    }
    // String literal
    if (ch === '"') {
      const startLine = lineOfOffset(i);
      out.push(' ');
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(' ', src[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          out.push(' ');
          i++;
          closed = true;
          break;
        }
        if (src[i] === '\n') {
          break;
        }
        out.push(' ');
        i++;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          severity: 'error',
          message: '文字列リテラル `"` が閉じられていません',
        });
      }
      continue;
    }

    out.push(ch);
    i++;
  }

  return { masked: out.join(''), lineOfOffset };
}

/** Check balanced `()`, `[]`, `{}` across the masked source. */
function checkBalancedDelimiters(
  masked: string,
  lineOfOffset: (off: number) => number,
  diagnostics: HdlDiagnostic[],
): void {
  const stack: { ch: string; line: number }[] = [];
  const matchOpen: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const matchClose: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, line: lineOfOffset(i) });
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const expectedOpen = matchOpen[ch];
      if (stack.length === 0) {
        diagnostics.push({
          line: lineOfOffset(i),
          severity: 'error',
          message: `対応する開き括弧がない \`${ch}\` があります`,
        });
      } else if (stack[stack.length - 1].ch !== expectedOpen) {
        const top = stack.pop()!;
        diagnostics.push({
          line: lineOfOffset(i),
          severity: 'error',
          message: `括弧の不一致: ${top.line} 行目の \`${top.ch}\` に対して \`${ch}\` が現れました`,
        });
      } else {
        stack.pop();
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      line: unclosed.line,
      severity: 'error',
      message: `\`${unclosed.ch}\` に対応する閉じ括弧 \`${matchClose[unclosed.ch]}\` がありません`,
    });
  }
}

/** Check balanced block keywords: module/endmodule, begin/end, case/endcase, generate/endgenerate, etc. */
function checkBalancedBlockKeywords(
  masked: string,
  lineOfOffset: (off: number) => number,
  diagnostics: HdlDiagnostic[],
): void {
  const openToClose: Record<string, string> = {
    module: 'endmodule',
    begin: 'end',
    case: 'endcase',
    casex: 'endcase',
    casez: 'endcase',
    generate: 'endgenerate',
    function: 'endfunction',
    task: 'endtask',
    property: 'endproperty',
    sequence: 'endsequence',
    package: 'endpackage',
    interface: 'endinterface',
  };
  const closeToExpected: Record<string, string[]> = {
    endmodule: ['module'],
    end: ['begin'],
    endcase: ['case', 'casex', 'casez'],
    endgenerate: ['generate'],
    endfunction: ['function'],
    endtask: ['task'],
    endproperty: ['property'],
    endsequence: ['sequence'],
    endpackage: ['package'],
    endinterface: ['interface'],
  };

  const stack: { kw: string; line: number }[] = [];
  const wordRe = /\b([a-zA-Z_]\w*)\b/g;
  let m: RegExpExecArray | null;
  let moduleCount = 0;

  while ((m = wordRe.exec(masked)) !== null) {
    const word = m[1];
    const pos = m.index;
    // Ignore `.port` or `end : label` preceded by dot or colon
    if (pos > 0 && masked[pos - 1] === '.') continue;

    if (openToClose[word]) {
      // Ignore `export "DPI-C" function` or `import ...` style rare prefixes; normal open pushes
      if (word === 'module') moduleCount++;
      stack.push({ kw: word, line: lineOfOffset(pos) });
    } else if (closeToExpected[word]) {
      const allowed = closeToExpected[word];
      if (stack.length === 0) {
        diagnostics.push({
          line: lineOfOffset(pos),
          severity: 'error',
          message: `対応する開始キーワードがない \`${word}\` があります`,
        });
      } else {
        const top = stack[stack.length - 1];
        if (allowed.includes(top.kw)) {
          stack.pop();
        } else {
          // Search deeper in stack to report accurate missing inner closer
          const matchIdx = [...stack].reverse().findIndex((item) => allowed.includes(item.kw));
          if (matchIdx !== -1) {
            const realIdx = stack.length - 1 - matchIdx;
            for (let k = stack.length - 1; k > realIdx; k--) {
              const missing = stack.pop()!;
              diagnostics.push({
                line: missing.line,
                severity: 'error',
                message: `\`${missing.kw}\` に対応する \`${openToClose[missing.kw]}\` がありません`,
              });
            }
            stack.pop();
          } else {
            diagnostics.push({
              line: lineOfOffset(pos),
              severity: 'error',
              message: `\`${word}\` に対応する開始キーワードが見つかりません`,
            });
          }
        }
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      line: unclosed.line,
      severity: 'error',
      message: `\`${unclosed.kw}\` に対応する \`${openToClose[unclosed.kw]}\` がありません`,
    });
  }

  if (moduleCount === 0 && masked.trim().length > 0) {
    diagnostics.push({
      line: 1,
      severity: 'error',
      message: 'Verilog / SystemVerilog の `module ... endmodule` 定義が見つかりません',
    });
  }
}

/** Validate an expression fragment (RHS of `assign` or assignment) for obvious syntax errors. */
function validateExprSyntax(expr: string, line: number, diagnostics: HdlDiagnostic[]): void {
  const s = expr.trim();
  if (!s) {
    diagnostics.push({ line, severity: 'error', message: '代入の右辺式が空です' });
    return;
  }
  // Trailing binary / ternary operator (e.g. `a &`, `a +`, `a ? b`)
  if (/(?:&&|\|\||==|!=|<=|>=|<<|>>|[+\-*/%&|^?:,])$/.test(s)) {
    diagnostics.push({
      line,
      severity: 'error',
      message: `式の末尾が演算子で途切れています: \`${s.slice(-16)}\``,
    });
    return;
  }
  // Leading binary-only operator (not unary +, -, ~, !, &, |, ^, ~&, ~|, ~^)
  if (/^(?:\*|\/|%|&&|\|\||==|!=|<=|>=|<<|>>|\?|:)/.test(s)) {
    diagnostics.push({
      line,
      severity: 'error',
      message: `式の先頭に不正な演算子があります: \`${s.slice(0, 16)}\``,
    });
    return;
  }
  // Invalid consecutive binary operators (e.g., `a & | b`, `a + * b`)
  if (/(?:[&|^+\-*/%]\s*(?:\*|\/|%|&&|\|\||==|!=|<=|>=))/.test(s)) {
    diagnostics.push({
      line,
      severity: 'error',
      message: `演算子の並びが不正です: \`${s.slice(0, 32)}\``,
    });
    return;
  }
  // Ternary `?` without matching `:`
  let qCount = 0;
  let cCount = 0;
  let bDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[') bDepth++;
    else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
    else if (bDepth === 0) {
      if (ch === '?') qCount++;
      else if (ch === ':') cCount++;
    }
  }
  if (qCount > cCount) {
    diagnostics.push({
      line,
      severity: 'error',
      message: '三項演算子 `? :` の `:` が不足しています',
    });
  }
}

/** Check statements inside each `module ... endmodule` for missing semicolons, malformed assigns, and undeclared signals. */
function checkModuleBodies(
  masked: string,
  lineOfOffset: (off: number) => number,
  diagnostics: HdlDiagnostic[],
): void {
  const modRe =
    /\bmodule\s+(\w+)\s*(?:#\s*\(([\s\S]*?)\)\s*)?(?:\(([\s\S]*?)\)\s*)?;([\s\S]*?)\bendmodule\b/g;
  let m: RegExpExecArray | null;

  // Also detect `module <name> (...)` missing header semicolon before body!
  const badHeaderRe =
    /\bmodule\s+(\w+)\s*(?:#\s*\([\s\S]*?\)\s*)?(?:\([\s\S]*?\)\s*)?(?=[\r\n]+\s*(?:input|output|wire|logic|reg|assign|always|parameter|localparam|endmodule)\b)/g;
  let bh: RegExpExecArray | null;
  while ((bh = badHeaderRe.exec(masked)) !== null) {
    if (!bh[0].includes(';')) {
      diagnostics.push({
        line: lineOfOffset(bh.index + bh[0].length),
        severity: 'error',
        message: `モジュール \`${bh[1]}\` のヘッダ末尾にセミコロン \`;\` がありません`,
      });
    }
  }

  while ((m = modRe.exec(masked)) !== null) {
    const paramsRaw = m[2] ?? '';
    const portsRaw = m[3] ?? '';
    const bodyRaw = m[4] ?? '';
    const bodyStartOff = m.index + m[0].indexOf(bodyRaw);

    // Collect declared identifiers (ports, params, localparams, wires/logic/reg/int/genvar)
    const declared = new Set<string>();
    for (const pm of paramsRaw.matchAll(/\b(\w+)\s*=/g)) {
      if (!SV_KEYWORDS.has(pm[1])) declared.add(pm[1]);
    }
    if (portsRaw) {
      for (const part of portsRaw.split(',')) {
        const cleaned = part.replace(/\s*=[\s\S]*$/, '').trim();
        const nm = cleaned.match(/(\w+)\s*$/);
        if (nm && !SV_KEYWORDS.has(nm[1])) declared.add(nm[1]);
      }
    }

    // Mask non-synthesizable blocks (`initial`, `task`, `function`, `property`, `sequence`, `assert`) preserving newlines
    let scanBody = bodyRaw;
    const maskMatch = (str: string, re: RegExp) =>
      str.replace(re, (seg) => seg.replace(/[^\n]/g, ' '));
    scanBody = maskMatch(
      scanBody,
      /\b(?:task\b[\s\S]*?\bendtask|function\b[\s\S]*?\bendfunction|property\b[\s\S]*?\bendproperty|sequence\b[\s\S]*?\bendsequence|covergroup\b[\s\S]*?\bendgroup|specify\b[\s\S]*?\bendspecify)\b/g,
    );

    // Collect body declarations (input/output/inout/wire/logic/reg/bit/int/integer/parameter/localparam/genvar)
    const declRe =
      /\b(?:input|output|inout|wire|logic|reg|bit|int|integer|genvar|parameter|localparam)\b([^;]*);/g;
    let dm: RegExpExecArray | null;
    while ((dm = declRe.exec(scanBody)) !== null) {
      const seg = dm[1];
      for (const item of seg.split(',')) {
        const lhs = item
          .split('=')[0]
          .replace(/\[[^\]]*\]/g, ' ')
          .trim();
        const nm = lhs.match(/(\w+)\s*$/);
        if (nm && !SV_KEYWORDS.has(nm[1])) declared.add(nm[1]);
      }
    }

    // Remove `always*` / `initial` / `final` blocks before checking top-level module statements,
    // while checking missing semicolons inside simple statements!
    const topLevelChunks: { text: string; offset: number }[] = [];
    let i = 0;
    const blen = scanBody.length;
    let chunkStart = 0;

    const skipBalancedBlock = (startIdx: number): number => {
      let p = startIdx;
      while (p < blen && /\s/.test(scanBody[p])) p++;
      // Optional `@(...)` or `@*`
      if (scanBody[p] === '@') {
        p++;
        while (p < blen && /\s/.test(scanBody[p])) p++;
        if (scanBody[p] === '(') {
          let d = 1;
          p++;
          while (p < blen && d > 0) {
            if (scanBody[p] === '(') d++;
            else if (scanBody[p] === ')') d--;
            p++;
          }
        } else if (scanBody[p] === '*') {
          p++;
        }
        while (p < blen && /\s/.test(scanBody[p])) p++;
      }
      // If `begin ... end`
      if (scanBody.slice(p).match(/^begin\b/)) {
        let depth = 0;
        const kwRe = /\b(begin|end)\b/g;
        kwRe.lastIndex = p;
        let km: RegExpExecArray | null;
        while ((km = kwRe.exec(scanBody)) !== null) {
          if (km[1] === 'begin') depth++;
          else {
            depth--;
            if (depth === 0) return km.index + km[0].length;
          }
        }
        return blen;
      }
      // Single statement until `;` (respecting nested if/else/case)
      const semi = scanBody.indexOf(';', p);
      return semi === -1 ? blen : semi + 1;
    };

    while (i < blen) {
      const procM = scanBody
        .slice(i)
        .match(/^\b(?:always_ff|always_comb|always_latch|always|initial|final)\b/);
      if (procM && (i === 0 || !/\w/.test(scanBody[i - 1]))) {
        if (i > chunkStart) {
          topLevelChunks.push({
            text: scanBody.slice(chunkStart, i),
            offset: bodyStartOff + chunkStart,
          });
        }
        i = skipBalancedBlock(i + procM[0].length);
        chunkStart = i;
        continue;
      }
      i++;
    }
    if (chunkStart < blen) {
      topLevelChunks.push({ text: scanBody.slice(chunkStart), offset: bodyStartOff + chunkStart });
    }

    // Validate top-level statements separated by `;`
    for (const chunk of topLevelChunks) {
      const raw = chunk.text;
      let stmtStart = 0;
      let depth = 0;

      const processStmt = (stmtText: string, absOffset: number, hasSemicolon: boolean) => {
        const trimmed = stmtText.trim();
        if (!trimmed) return;
        const leadWs = stmtText.length - stmtText.trimStart().length;
        const line = lineOfOffset(absOffset + leadWs);

        // Skip pure block-control keywords (`generate`, `endgenerate`, `for (...) begin`, `end`, `if (...)`, `else`)
        if (
          /^(?:generate|endgenerate|begin|end|for|if|else|import|export|typedef|timeunit|timeprecision|assert|assume|cover|restrict|expect)\b/.test(
            trimmed,
          )
        ) {
          return;
        }
        // Skip system task calls like `$display(...)`
        if (/^\$\w+/.test(trimmed)) return;

        if (!hasSemicolon) {
          diagnostics.push({
            line,
            severity: 'error',
            message: `文の末尾にセミコロン \`;\` が不足しています: \`${trimmed.split('\n')[0].slice(0, 40)}\``,
          });
          return;
        }

        // Check if a statement accidentally glued two lines together due to a missing semicolon
        // (e.g. `assign y = a & b\n  assign z = c;` or `logic w\n  assign w = a;`)
        if (
          /\n\s*(?:assign|input|output|inout|wire|logic|reg|bit|parameter|localparam)\b/.test(
            trimmed,
          )
        ) {
          // Allow multi-line `input`/`output` inside module body only if separated by comma
          const linesInStmt = trimmed.split('\n');
          for (let li = 0; li < linesInStmt.length - 1; li++) {
            const curLn = linesInStmt[li].trim();
            const nxtLn = linesInStmt[li + 1].trim();
            if (
              curLn &&
              !curLn.endsWith(',') &&
              !curLn.endsWith('(') &&
              /^(?:assign|wire|logic|reg|bit|parameter|localparam)\b/.test(nxtLn)
            ) {
              diagnostics.push({
                line: line + li,
                severity: 'error',
                message: `行末にセミコロン \`;\` が不足している可能性があります: \`${curLn.slice(0, 40)}\``,
              });
              break;
            }
          }
        }

        // Validate `assign` statements specifically
        if (/^assign\b/.test(trimmed)) {
          const rest = trimmed
            .replace(/^assign\s+(?:\([^)]*\)\s*)?(?:#\s*(?:\([^)]*\)|\d+(?:\.\d+)?)\s*)?/, '')
            .trim();
          const eqIdx = rest.search(/(?<![=!<>])=(?!=)/);
          if (eqIdx === -1) {
            diagnostics.push({
              line,
              severity: 'error',
              message: '`assign` 文に `=` がありません',
            });
            return;
          }
          const lhs = rest.slice(0, eqIdx).trim();
          const rhs = rest.slice(eqIdx + 1).trim();
          if (!lhs) {
            diagnostics.push({ line, severity: 'error', message: '`assign` の左辺が空です' });
            return;
          }
          validateExprSyntax(rhs, line, diagnostics);

          // Warn on undeclared identifiers on RHS (helps catch typos immediately!)
          if (declared.size > 0) {
            // Strip sized literals like 4'b1010, 8'hFF, '0, $clog2 before scanning identifiers
            const rhsNoLit = rhs
              .replace(/\b\d+'s?[bhdoBHDO][0-9a-fA-FxXzZ_?]+\b/g, ' ')
              .replace(/'[01xXzZ]\b/g, ' ')
              .replace(/\$\w+/g, ' ');
            const seenUndeclared = new Set<string>();
            for (const idM of rhsNoLit.matchAll(/\b([a-zA-Z_]\w*)\b/g)) {
              const id = idM[1];
              if (SV_KEYWORDS.has(id) || declared.has(id) || seenUndeclared.has(id)) continue;
              // Skip member access after `.`
              if (idM.index > 0 && rhsNoLit[idM.index - 1] === '.') continue;
              seenUndeclared.add(id);
              diagnostics.push({
                line,
                severity: 'warning',
                message: `未宣言の信号 "${id}" が参照されています（タイポの可能性があります）`,
              });
            }
          }
          return;
        }

        // Detect bare assignment outside `always` (forgot `assign` keyword!)
        if (/^(?:\{[^}]+\}|[a-zA-Z_]\w*(?:\s*\[[^\]]+\])?)\s*(?:<=|=(?!=))/.test(trimmed)) {
          diagnostics.push({
            line,
            severity: 'error',
            message:
              'モジュール直下の代入には `assign` が必要です（順序/組合せブロック内なら `always_comb` / `always_ff` を使用してください）',
          });
          return;
        }

        // Known valid top-level statements: declarations, primitives, module instantiations
        const isDecl =
          /^(?:input|output|inout|wire|logic|reg|bit|int|integer|genvar|parameter|localparam)\b/.test(
            trimmed,
          );
        const isPrimitive =
          /^(?:and|or|xor|nand|nor|xnor|not|buf|bufif0|bufif1|notif0|notif1)\b/.test(trimmed);
        const isInst = /^\w+(?:\s*#\s*\([\s\S]*?\)\s*|\s+)\w+\s*\([\s\S]*\)$/.test(trimmed);

        if (!isDecl && !isPrimitive && !isInst) {
          diagnostics.push({
            line,
            severity: 'error',
            message: `構文エラーまたは未認識の文です: \`${trimmed.split('\n')[0].slice(0, 44)}\``,
          });
        }
      };

      for (let k = 0; k < raw.length; k++) {
        const ch = raw[k];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        else if (ch === ';' && depth === 0) {
          processStmt(raw.slice(stmtStart, k), chunk.offset + stmtStart, true);
          stmtStart = k + 1;
        }
      }
      if (stmtStart < raw.length) {
        processStmt(raw.slice(stmtStart), chunk.offset + stmtStart, false);
      }
    }
  }
}

/**
 * Validate a Verilog / SystemVerilog source string and return line-numbered diagnostics
 * sorted by line number (errors first on the same line).
 */
export function validateHdlSource(source: string): HdlDiagnostic[] {
  const diagnostics: HdlDiagnostic[] = [];
  if (!source.trim()) {
    diagnostics.push({
      line: 1,
      severity: 'error',
      message: 'HDL ソースが空です',
    });
    return diagnostics;
  }

  const { masked, lineOfOffset } = maskNonCodePreservingLines(source, diagnostics);
  checkBalancedDelimiters(masked, lineOfOffset, diagnostics);
  checkBalancedBlockKeywords(masked, lineOfOffset, diagnostics);

  // Only inspect internal module bodies if overall module/delimiter structure isn't catastrophically unclosed
  const hasStructuralErr = diagnostics.some((d) => d.severity === 'error');
  if (!hasStructuralErr) {
    checkModuleBodies(masked, lineOfOffset, diagnostics);
  }

  // Deduplicate identical (line, severity, message)
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.line}:${d.severity}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return 0;
  });
  return unique;
}
