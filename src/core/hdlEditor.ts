/**
 * Pure DOM-independent VS Code-style text transformation helpers for the HDL code editor.
 * Every operation returns the updated text plus the exact new selection range (and optional clipboard text).
 */

export interface EditorEditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  clipboardText?: string;
}

/** Find line-aligned bounds covering `[selStart, selEnd]` in `text` (0-based line indices). */
function getSelectedLineRange(
  text: string,
  selStart: number,
  selEnd: number,
): { lines: string[]; startLine: number; endLine: number; lineStarts: number[] } {
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const ln of lines) {
    lineStarts.push(offset);
    offset += ln.length + 1;
  }

  let startLine = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i] <= selStart) startLine = i;
    else break;
  }

  // If selection ends exactly at column 0 of a later line, exclude that trailing line (VS Code behavior)
  const effectiveEnd = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
  let endLine = startLine;
  for (let i = startLine; i < lineStarts.length; i++) {
    if (lineStarts[i] <= effectiveEnd) endLine = i;
    else break;
  }

  return { lines, startLine, endLine, lineStarts };
}

/** Cut the entire current line when selection is empty (VS Code Ctrl/Cmd+X). Returns null if text is selected. */
export function cutCurrentLine(
  text: string,
  selStart: number,
  selEnd: number,
): EditorEditResult | null {
  if (selStart !== selEnd) return null;
  const { lines, startLine, lineStarts } = getSelectedLineRange(text, selStart, selEnd);
  const col = selStart - lineStarts[startLine];
  const cutText = `${lines[startLine]}\n`;

  if (lines.length === 1) {
    return { value: '', selectionStart: 0, selectionEnd: 0, clipboardText: cutText };
  }

  const nextLines = lines.slice();
  nextLines.splice(startLine, 1);
  const nextValue = nextLines.join('\n');
  const targetLine = Math.min(startLine, nextLines.length - 1);
  let targetStart = 0;
  for (let i = 0; i < targetLine; i++) targetStart += nextLines[i].length + 1;
  const nextPos = targetStart + Math.min(col, nextLines[targetLine].length);

  return {
    value: nextValue,
    selectionStart: nextPos,
    selectionEnd: nextPos,
    clipboardText: cutText,
  };
}

/** Return the full current line text (+ trailing newline) when selection is empty (VS Code Ctrl/Cmd+C). */
export function copyCurrentLine(text: string, selStart: number, selEnd: number): string | null {
  if (selStart !== selEnd) return null;
  const { lines, startLine } = getSelectedLineRange(text, selStart, selEnd);
  return `${lines[startLine]}\n`;
}

/** Delete current line or all lines covered by the selection (VS Code Ctrl/Cmd+Shift+K). */
export function deleteSelectedLines(
  text: string,
  selStart: number,
  selEnd: number,
): EditorEditResult {
  const { lines, startLine, endLine, lineStarts } = getSelectedLineRange(text, selStart, selEnd);
  const col = selStart - lineStarts[startLine];
  const nextLines = [...lines.slice(0, startLine), ...lines.slice(endLine + 1)];
  if (nextLines.length === 0) {
    return { value: '', selectionStart: 0, selectionEnd: 0 };
  }
  const nextValue = nextLines.join('\n');
  const targetLine = Math.min(startLine, nextLines.length - 1);
  let targetStart = 0;
  for (let i = 0; i < targetLine; i++) targetStart += nextLines[i].length + 1;
  const pos = targetStart + Math.min(col, nextLines[targetLine].length);
  return { value: nextValue, selectionStart: pos, selectionEnd: pos };
}

/** Move current line or selected block of lines up or down (VS Code Alt+Up / Alt+Down). */
export function moveSelectedLines(
  text: string,
  selStart: number,
  selEnd: number,
  direction: -1 | 1,
): EditorEditResult {
  const { lines, startLine, endLine } = getSelectedLineRange(text, selStart, selEnd);
  if (direction === -1 && startLine === 0) {
    return { value: text, selectionStart: selStart, selectionEnd: selEnd };
  }
  if (direction === 1 && endLine === lines.length - 1) {
    return { value: text, selectionStart: selStart, selectionEnd: selEnd };
  }

  const nextLines = lines.slice();
  let shift = 0;
  if (direction === -1) {
    const swappedLine = nextLines[startLine - 1];
    nextLines.splice(startLine - 1, 1);
    nextLines.splice(endLine, 0, swappedLine);
    shift = -(swappedLine.length + 1);
  } else {
    const swappedLine = nextLines[endLine + 1];
    nextLines.splice(endLine + 1, 1);
    nextLines.splice(startLine, 0, swappedLine);
    shift = swappedLine.length + 1;
  }

  return {
    value: nextLines.join('\n'),
    selectionStart: Math.max(0, selStart + shift),
    selectionEnd: Math.max(0, selEnd + shift),
  };
}

/** Duplicate current line or selected block of lines upward or downward (VS Code Shift+Alt+Up/Down). */
export function duplicateSelectedLines(
  text: string,
  selStart: number,
  selEnd: number,
  direction: -1 | 1,
): EditorEditResult {
  const { lines, startLine, endLine } = getSelectedLineRange(text, selStart, selEnd);
  const block = lines.slice(startLine, endLine + 1);
  const blockLen = block.reduce((acc, l) => acc + l.length + 1, 0);
  const nextLines = [...lines.slice(0, endLine + 1), ...block, ...lines.slice(endLine + 1)];
  const shift = direction === 1 ? blockLen : 0;
  return {
    value: nextLines.join('\n'),
    selectionStart: selStart + shift,
    selectionEnd: selEnd + shift,
  };
}

/** Toggle `// ` line comment across current line or all selected lines (VS Code Ctrl/Cmd+/). */
export function toggleLineComment(
  text: string,
  selStart: number,
  selEnd: number,
): EditorEditResult {
  const { lines, startLine, endLine } = getSelectedLineRange(text, selStart, selEnd);
  const targetSlice = lines.slice(startLine, endLine + 1);
  const nonEmpty = targetSlice.filter((l) => l.trim().length > 0);
  const allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*\/\//.test(l));

  const nextLines = lines.slice();
  let firstDelta = 0;
  let totalDelta = 0;

  for (let i = startLine; i <= endLine; i++) {
    const ln = nextLines[i];
    if (allCommented) {
      const m = ln.match(/^(\s*)\/\/ ?(.*)$/);
      if (m) {
        const replaced = `${m[1]}${m[2]}`;
        const delta = replaced.length - ln.length;
        if (i === startLine) firstDelta = delta;
        totalDelta += delta;
        nextLines[i] = replaced;
      }
    } else if (ln.trim().length > 0 || startLine === endLine) {
      const m = ln.match(/^(\s*)(.*)$/);
      const indent = m ? m[1] : '';
      const rest = m ? m[2] : ln;
      const replaced = `${indent}// ${rest}`;
      const delta = replaced.length - ln.length;
      if (i === startLine) firstDelta = delta;
      totalDelta += delta;
      nextLines[i] = replaced;
    }
  }

  return {
    value: nextLines.join('\n'),
    selectionStart: Math.max(0, selStart + firstDelta),
    selectionEnd: Math.max(0, selEnd + totalDelta),
  };
}

/** Indent (`Tab`) or outdent (`Shift+Tab`) by 2 spaces across single cursor or multi-line selection. */
export function indentSelection(
  text: string,
  selStart: number,
  selEnd: number,
  outdent: boolean,
): EditorEditResult {
  const { lines, startLine, endLine, lineStarts } = getSelectedLineRange(text, selStart, selEnd);

  // Plain Tab with empty selection inserts 2 spaces at cursor
  if (!outdent && selStart === selEnd) {
    const value = `${text.slice(0, selStart)}  ${text.slice(selEnd)}`;
    return { value, selectionStart: selStart + 2, selectionEnd: selStart + 2 };
  }

  const nextLines = lines.slice();
  let firstDelta = 0;
  let totalDelta = 0;

  for (let i = startLine; i <= endLine; i++) {
    const ln = nextLines[i];
    if (outdent) {
      const remove = ln.startsWith('  ') ? 2 : ln.startsWith('\t') || ln.startsWith(' ') ? 1 : 0;
      if (remove > 0) {
        nextLines[i] = ln.slice(remove);
        if (i === startLine) firstDelta = -remove;
        totalDelta -= remove;
      }
    } else {
      nextLines[i] = `  ${ln}`;
      if (i === startLine) firstDelta = 2;
      totalDelta += 2;
    }
  }

  const lineStartPos = lineStarts[startLine];
  const nextStart = Math.max(lineStartPos, selStart + firstDelta);
  const nextEnd = Math.max(nextStart, selEnd + totalDelta);
  return {
    value: nextLines.join('\n'),
    selectionStart: nextStart,
    selectionEnd: nextEnd,
  };
}

/** Smart Enter: preserves current line indentation and increases indent after `begin`, `module ...(`, `case (...)`. */
export function insertAutoIndentedNewline(
  text: string,
  selStart: number,
  selEnd: number,
): EditorEditResult {
  const lineStart = text.lastIndexOf('\n', Math.max(0, selStart - 1)) + 1;
  const beforeCursor = text.slice(lineStart, selStart);
  const indentMatch = beforeCursor.match(/^([ \t]*)/);
  let indent = indentMatch ? indentMatch[1] : '';

  const trimmed = beforeCursor.trimEnd();
  if (
    /\b(?:begin|case|casex|casez|generate)\b\s*(?:\([^)]*\))?\s*$/.test(trimmed) ||
    /\bmodule\s+\w+[\s\S]*\(\s*$/.test(trimmed)
  ) {
    indent += '  ';
  }

  const insertion = `\n${indent}`;
  const value = `${text.slice(0, selStart)}${insertion}${text.slice(selEnd)}`;
  const pos = selStart + insertion.length;
  return { value, selectionStart: pos, selectionEnd: pos };
}
