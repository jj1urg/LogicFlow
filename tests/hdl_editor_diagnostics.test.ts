import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateHdlSource } from '../src/core/hdlDiagnostics';
import {
  copyCurrentLine,
  cutCurrentLine,
  deleteSelectedLines,
  duplicateSelectedLines,
  indentSelection,
  insertAutoIndentedNewline,
  moveSelectedLines,
  toggleLineComment,
} from '../src/core/hdlEditor';

describe('HDL Editor VS Code Shortcuts', () => {
  it('1. cuts and copies the entire current line when selection is empty (Ctrl+X / Ctrl+C)', () => {
    const src = 'line0\n  assign y = a;\nline2';
    // Cursor inside line 1
    const pos = 'line0\n  ass'.length;
    expect(copyCurrentLine(src, pos, pos)).toBe('  assign y = a;\n');
    expect(copyCurrentLine(src, pos, pos + 3)).toBeNull();

    const cut = cutCurrentLine(src, pos, pos);
    expect(cut).not.toBeNull();
    expect(cut!.value).toBe('line0\nline2');
    expect(cut!.clipboardText).toBe('  assign y = a;\n');
    // When selection is non-empty, cutCurrentLine defers to native cut
    expect(cutCurrentLine(src, pos, pos + 3)).toBeNull();
  });

  it('2. moves single line and multi-line selections up/down (Alt+Up / Alt+Down)', () => {
    const src = 'alpha\nbeta\ngamma\ndelta';
    // Move `beta` down -> `alpha\ngamma\nbeta\ndelta`
    const bStart = 'alpha\n'.length + 1;
    const movedDown = moveSelectedLines(src, bStart, bStart, 1);
    expect(movedDown.value).toBe('alpha\ngamma\nbeta\ndelta');
    expect(movedDown.value.slice(movedDown.selectionStart, movedDown.selectionStart + 3)).toBe(
      'eta',
    );

    // Move multi-line selection (`beta\ngamma`) up -> `beta\ngamma\nalpha\ndelta`
    const s = 'alpha\n'.length;
    const e = 'alpha\nbeta\ngam'.length;
    const movedUp = moveSelectedLines(src, s, e, -1);
    expect(movedUp.value).toBe('beta\ngamma\nalpha\ndelta');
    expect(movedUp.value.slice(movedUp.selectionStart, movedUp.selectionEnd)).toBe('beta\ngam');

    // Moving line 0 up is a safe no-op
    expect(moveSelectedLines(src, 0, 0, -1).value).toBe(src);
  });

  it('3. duplicates lines, deletes lines, toggles // comments, indents/outdents, and auto-indents', () => {
    const src = 'module m;\n  assign y = a;\nendmodule';
    const pos = 'module m;\n  assign'.length;

    // Duplicate line downward (Shift+Alt+Down)
    const dup = duplicateSelectedLines(src, pos, pos, 1);
    expect(dup.value).toBe('module m;\n  assign y = a;\n  assign y = a;\nendmodule');

    // Delete line (Ctrl+Shift+K)
    const del = deleteSelectedLines(src, pos, pos);
    expect(del.value).toBe('module m;\nendmodule');

    // Toggle line comment on & off (Ctrl+/)
    const cmt = toggleLineComment(src, pos, pos);
    expect(cmt.value).toBe('module m;\n  // assign y = a;\nendmodule');
    const uncmt = toggleLineComment(cmt.value, cmt.selectionStart, cmt.selectionEnd);
    expect(uncmt.value).toBe(src);

    // Multi-line Tab / Shift+Tab
    const ind = indentSelection('a\nb\nc', 0, 3, false);
    expect(ind.value).toBe('  a\n  b\nc');
    const out = indentSelection(ind.value, ind.selectionStart, ind.selectionEnd, true);
    expect(out.value).toBe('a\nb\nc');

    // Smart Enter after `begin` increases indent by 2 spaces
    const blk = '  always_comb begin';
    const ent = insertAutoIndentedNewline(blk, blk.length, blk.length);
    expect(ent.value).toBe('  always_comb begin\n    ');
  });
});

describe('HDL Static Syntax Diagnostics Validator', () => {
  it('4. reports line-numbered syntax errors for broken HDL (missing semicolon, unclosed paren, unclosed begin, malformed assign)', () => {
    const missingSemi = [
      'module m (input logic a, output logic y);',
      '  assign y = a',
      'endmodule',
    ].join('\n');
    const d1 = validateHdlSource(missingSemi);
    expect(d1.some((d) => d.severity === 'error' && d.line === 2)).toBe(true);

    const unclosedParen = [
      'module m (input logic a, input logic b, output logic y);',
      '  assign y = (a & b;',
      'endmodule',
    ].join('\n');
    const d2 = validateHdlSource(unclosedParen);
    expect(d2.some((d) => d.severity === 'error' && d.line === 2)).toBe(true);

    const unclosedBegin = [
      'module m (input logic a, output logic y);',
      '  always_comb begin',
      '    y = a;',
      'endmodule',
    ].join('\n');
    const d3 = validateHdlSource(unclosedBegin);
    expect(d3.some((d) => d.severity === 'error' && d.line === 2)).toBe(true);

    const danglingOp = [
      'module m (input logic a, output logic y);',
      '  assign y = a & ;',
      'endmodule',
    ].join('\n');
    const d4 = validateHdlSource(danglingOp);
    expect(d4.some((d) => d.severity === 'error' && d.line === 2)).toBe(true);

    const forgotAssign = [
      'module m (input logic a, output logic y);',
      '  y = a;',
      'endmodule',
    ].join('\n');
    const d5 = validateHdlSource(forgotAssign);
    expect(d5.some((d) => d.severity === 'error' && d.line === 2)).toBe(true);
  });

  it('5. emits warnings (not blocking errors) for undeclared signal typos on assign RHS', () => {
    const src = [
      'module m (input logic a, input logic b, output logic y);',
      '  assign y = a & b_typo;',
      'endmodule',
    ].join('\n');
    const diags = validateHdlSource(src);
    expect(diags.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(
      diags.some((d) => d.severity === 'warning' && d.line === 2 && d.message.includes('b_typo')),
    ).toBe(true);
  });

  it('6. produces ZERO syntax errors on real-world SystemVerilog fixtures (TD4 CPU & CIC decimator)', () => {
    const td4Dir = path.resolve(process.cwd(), 'docs/test_hdl/td4');
    if (fs.existsSync(td4Dir)) {
      for (const fname of fs.readdirSync(td4Dir).filter((f) => /\.(?:v|sv)$/i.test(f))) {
        const content = fs.readFileSync(path.join(td4Dir, fname), 'utf8');
        const errs = validateHdlSource(content).filter((d) => d.severity === 'error');
        expect(errs, `Unexpected syntax errors in td4/${fname}: ${JSON.stringify(errs)}`).toEqual(
          [],
        );
      }
    }

    const cicPath = path.resolve(process.cwd(), 'docs/test_hdl/fm_ip/cic_decimator.sv');
    if (fs.existsSync(cicPath)) {
      const content = fs.readFileSync(cicPath, 'utf8');
      const errs = validateHdlSource(content).filter((d) => d.severity === 'error');
      expect(errs, `Unexpected syntax errors in cic_decimator.sv: ${JSON.stringify(errs)}`).toEqual(
        [],
      );
    }
  });
});
