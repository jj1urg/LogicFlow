import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  ChevronDown,
  ChevronUp,
  Circle,
  Pause,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildPinWatchLabel,
  buildWireWatchLabel,
  formatWatchValue,
  getDefaultWatchPin,
  makePinWatchId,
  makeWireWatchId,
  WatchRadix,
  WatchSampleEntry,
  WatchTarget,
  WaveformStep,
} from '../core/debug';
import {
  BIT_0,
  BIT_1,
  BIT_X,
  BIT_Z,
  dominantState,
  SIGNAL_COLORS,
  valuesEqual,
  X_CAUSE_COLORS,
} from '../core/logic4';
import { CircuitDocument, ProjectDocument, SimulationSnapshot } from '../core/types';

interface WatchWaveformPanelProps {
  circuit: CircuitDocument;
  project: ProjectDocument;
  snapshot: SimulationSnapshot | null;
  simActive: boolean;
  targets: WatchTarget[];
  history: WaveformStep[];
  recording: boolean;
  onToggleRecording: () => void;
  onManualSample: () => void;
  onClearHistory: () => void;
  onAddTarget: (target: WatchTarget) => void;
  onAddAllCircuitPorts: () => void;
  onRemoveTarget: (targetId: string) => void;
  onUpdateTarget: (targetId: string, patch: Partial<WatchTarget>) => void;
  onReorderTarget: (targetId: string, dir: -1 | 1) => void;
  onClose: () => void;
}

const ROW_H = 30;
const AXIS_H = 22;

export const WatchWaveformPanel: React.FC<WatchWaveformPanelProps> = ({
  circuit,
  project,
  snapshot,
  simActive,
  targets,
  history,
  recording,
  onToggleRecording,
  onManualSample,
  onClearHistory,
  onAddTarget,
  onAddAllCircuitPorts,
  onRemoveTarget,
  onUpdateTarget,
  onReorderTarget,
  onClose,
}) => {
  const [height, setHeight] = useState(235);
  const [globalRadix, setGlobalRadix] = useState<WatchRadix>('auto');
  const [stepPx, setStepPx] = useState(44);
  const [hoveredStepIdx, setHoveredStepIdx] = useState<number | null>(null);
  const [quickPickVal, setQuickPickVal] = useState('');

  const listScrollRef = useRef<HTMLDivElement>(null);
  const waveScrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resizeRef = useRef<{ startY: number; origH: number } | null>(null);

  const circuitTargets = useMemo(
    () => targets.filter((t) => t.circuitId === circuit.id),
    [targets, circuit.id],
  );

  // Quick-pick list of watchable signals on the active circuit not yet watched
  const quickAddOptions = useMemo(() => {
    const existing = new Set(circuitTargets.map((t) => t.id));
    const opts: { id: string; label: string; target: WatchTarget }[] = [];

    for (const g of circuit.gates) {
      if (
        g.type === 'MODULE_IN' ||
        g.type === 'MODULE_OUT' ||
        g.type === 'TOGGLE' ||
        g.type === 'BUTTON' ||
        g.type === 'CLOCK' ||
        g.type === 'LED' ||
        g.type === 'NUM_DISPLAY' ||
        g.type === 'D_FF' ||
        g.type === 'REGISTER' ||
        g.type === 'COUNTER'
      ) {
        const dp = getDefaultWatchPin(g, project);
        if (!dp) continue;
        const id = makePinWatchId(circuit.id, g.id, dp.pinId);
        if (existing.has(id)) continue;
        const label = buildPinWatchLabel(g, dp.pinId, dp.pinName);
        opts.push({
          id,
          label: `${label} (${g.type}, ${dp.bitWidth}b)`,
          target: {
            id,
            circuitId: circuit.id,
            kind: 'pin',
            gateId: g.id,
            pinId: dp.pinId,
            label,
            radix: 'auto',
          },
        });
      }
    }

    const seenNetLabels = new Set<string>();
    for (const w of circuit.wires) {
      const id = makeWireWatchId(circuit.id, w.id);
      if (existing.has(id)) continue;
      if (w.netLabel?.trim()) {
        const nl = w.netLabel.trim();
        if (seenNetLabels.has(nl)) continue;
        seenNetLabels.add(nl);
        opts.push({
          id,
          label: `Wire: ${nl}`,
          target: {
            id,
            circuitId: circuit.id,
            kind: 'wire',
            wireId: w.id,
            label: nl,
            radix: 'auto',
          },
        });
      }
    }
    return opts;
  }, [circuit, project, circuitTargets]);

  // Vertical dock resize (mouse + mobile touch)
  useEffect(() => {
    const applyY = (clientY: number) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - clientY;
      setHeight(
        Math.max(150, Math.min(window.innerHeight * 0.65, resizeRef.current.origH + delta)),
      );
    };
    const onMove = (e: MouseEvent) => applyY(e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (!resizeRef.current || e.touches.length !== 1) return;
      e.preventDefault();
      applyY(e.touches[0].clientY);
    };
    const onUp = () => {
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
    };
  }, []);

  // Auto-scroll waveform right edge when new samples arrive
  useEffect(() => {
    const sc = waveScrollRef.current;
    if (!sc) return;
    sc.scrollLeft = sc.scrollWidth;
  }, [history.length]);

  const effectiveRadix = (t: WatchTarget): WatchRadix =>
    t.radix === 'auto' ? globalRadix : t.radix;

  const getCurrentEntry = (t: WatchTarget): WatchSampleEntry | undefined => {
    if (hoveredStepIdx !== null && history[hoveredStepIdx]) {
      return history[hoveredStepIdx].values[t.id];
    }
    if (!snapshot) return undefined;
    if (t.kind === 'wire' && t.wireId) {
      const v = snapshot.wireValues[t.wireId];
      if (!v) return undefined;
      return {
        value: v,
        xCause: dominantState(v) === BIT_X ? snapshot.wireXCauses?.[t.wireId] : undefined,
      };
    }
    if (t.kind === 'pin' && t.gateId && t.pinId) {
      const pk = `${t.gateId}:${t.pinId}`;
      const v = snapshot.pinValues[pk];
      if (!v) return undefined;
      return {
        value: v,
        xCause: dominantState(v) === BIT_X ? snapshot.pinXCauses?.[pk] : undefined,
      };
    }
    return undefined;
  };

  // Render Canvas digital waveform chart
  const canvasW = Math.max(360, history.length * stepPx + 40);
  const canvasH = AXIS_H + Math.max(1, circuitTargets.length) * ROW_H;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvasW * dpr);
    canvas.height = Math.floor(canvasH * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Step axis header
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvasW, AXIS_H);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, AXIS_H - 0.5);
    ctx.lineTo(canvasW, AXIS_H - 0.5);
    ctx.stroke();

    // Vertical step gridlines & step numbers
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < history.length; i++) {
      const x = i * stepPx;
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, AXIS_H);
      ctx.lineTo(x + 0.5, canvasH);
      ctx.stroke();

      ctx.fillStyle = hoveredStepIdx === i ? '#38bdf8' : '#64748b';
      ctx.fillText(`#${history[i].step}`, x + stepPx / 2, AXIS_H / 2);
    }

    // Draw each watched signal row
    circuitTargets.forEach((target, rowIdx) => {
      const rowTop = AXIS_H + rowIdx * ROW_H;
      const yHi = rowTop + 6;
      const yMid = rowTop + ROW_H / 2;
      const yLo = rowTop + ROW_H - 6;

      // Subtle alternating row band
      if (rowIdx % 2 === 1) {
        ctx.fillStyle = 'rgba(30, 41, 59, 0.25)';
        ctx.fillRect(0, rowTop, canvasW, ROW_H);
      }
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
      ctx.beginPath();
      ctx.moveTo(0, rowTop + ROW_H - 0.5);
      ctx.lineTo(canvasW, rowTop + ROW_H - 0.5);
      ctx.stroke();

      if (history.length === 0) return;

      // Determine whether this target is 1-bit or multi-bit bus
      const firstVal = history.find((h) => h.values[target.id])?.values[target.id]?.value;
      const isBus = (firstVal?.width ?? 1) > 1;
      const radix = effectiveRadix(target);

      if (!isBus) {
        // --- 1-bit digital square waveform ---
        let prevY: number | null = null;
        for (let i = 0; i < history.length; i++) {
          const entry = history[i].values[target.id];
          const x0 = i * stepPx;
          const x1 = x0 + stepPx;
          const bit = dominantState(entry?.value);
          const color =
            bit === BIT_X && entry?.xCause ? X_CAUSE_COLORS[entry.xCause] : SIGNAL_COLORS[bit];

          if (bit === BIT_X) {
            ctx.fillStyle = `${color}28`;
            ctx.fillRect(x0, yHi, stepPx, yLo - yHi);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(x0, yHi);
            ctx.lineTo(x1, yHi);
            ctx.moveTo(x0, yLo);
            ctx.lineTo(x1, yLo);
            ctx.stroke();
            prevY = null;
          } else if (bit === BIT_Z) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.6;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x0, yMid);
            ctx.lineTo(x1, yMid);
            ctx.stroke();
            ctx.setLineDash([]);
            prevY = yMid;
          } else {
            const curY = bit === BIT_1 ? yHi : yLo;
            if (bit === BIT_1) {
              ctx.fillStyle = 'rgba(34, 197, 94, 0.12)';
              ctx.fillRect(x0, yHi, stepPx, yLo - yHi);
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            if (prevY !== null && prevY !== curY) {
              ctx.moveTo(x0, prevY);
              ctx.lineTo(x0, curY);
            } else {
              ctx.moveTo(x0, curY);
            }
            ctx.lineTo(x1, curY);
            ctx.stroke();
            prevY = curY;
          }
        }
      } else {
        // --- Multi-bit bus hexagonal plateaus (merge consecutive identical values) ---
        let i = 0;
        while (i < history.length) {
          const startEntry = history[i].values[target.id];
          let j = i + 1;
          while (
            j < history.length &&
            valuesEqual(startEntry?.value, history[j].values[target.id]?.value)
          ) {
            j++;
          }
          const x0 = i * stepPx;
          const x1 = j * stepPx;
          const w = x1 - x0;
          const bev = Math.min(5, w / 4);
          const bit = dominantState(startEntry?.value);
          const color =
            bit === BIT_X && startEntry?.xCause
              ? X_CAUSE_COLORS[startEntry.xCause]
              : bit === BIT_0
                ? '#94a3b8'
                : SIGNAL_COLORS[bit];

          ctx.beginPath();
          ctx.moveTo(x0, yMid);
          ctx.lineTo(x0 + bev, yHi);
          ctx.lineTo(x1 - bev, yHi);
          ctx.lineTo(x1, yMid);
          ctx.lineTo(x1 - bev, yLo);
          ctx.lineTo(x0 + bev, yLo);
          ctx.closePath();

          ctx.fillStyle =
            bit === BIT_X
              ? `${color}28`
              : bit === BIT_Z
                ? 'rgba(59, 130, 246, 0.14)'
                : 'rgba(34, 197, 94, 0.10)';
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Label inside bus plateau
          const text = formatWatchValue(startEntry?.value, radix);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + bev + 2, yHi, Math.max(0, w - bev * 2 - 4), yLo - yHi);
          ctx.clip();
          ctx.fillStyle = bit === BIT_X ? color : '#e2e8f0';
          ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, (x0 + x1) / 2, yMid + 0.5);
          ctx.restore();

          i = j;
        }
      }
    });

    // Hovered step vertical scrubber highlight
    if (hoveredStepIdx !== null && hoveredStepIdx >= 0 && hoveredStepIdx < history.length) {
      const hx = hoveredStepIdx * stepPx;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
      ctx.fillRect(hx, AXIS_H, stepPx, canvasH - AXIS_H);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(hx + stepPx / 2, AXIS_H);
      ctx.lineTo(hx + stepPx / 2, canvasH);
      ctx.stroke();
    }
  }, [circuitTargets, history, stepPx, canvasW, canvasH, hoveredStepIdx, globalRadix]);

  const handleWaveMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || history.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.floor(x / stepPx);
    if (idx >= 0 && idx < history.length) {
      setHoveredStepIdx(idx);
    } else {
      setHoveredStepIdx(null);
    }
  };

  return (
    <section className="watch-dock-panel" style={{ height }}>
      <div
        className="hdl-resize-handle handle-bottom"
        onMouseDown={(e) => {
          e.preventDefault();
          resizeRef.current = { startY: e.clientY, origH: height };
        }}
        onTouchStart={(e) => {
          if (e.touches.length !== 1) return;
          resizeRef.current = { startY: e.touches[0].clientY, origH: height };
        }}
        title="ドラッグして高さを変更"
        aria-label="波形パネル高さ調整ハンドル"
      >
        <span className="hdl-resize-grip" aria-hidden="true" />
      </div>

      {/* Header Controls */}
      <div className="watch-dock-header">
        <div className="watch-title-group">
          <Activity size={14} className="accent-green" />
          <span className="watch-dock-title">信号ウォッチ &amp; 波形タイムチャート</span>
          <span className="hdl-line-badge">
            {circuitTargets.length} 信号 · {history.length} ステップ
          </span>
          {hoveredStepIdx !== null && history[hoveredStepIdx] && (
            <span className="watch-cursor-badge">カーソル: #{history[hoveredStepIdx].step}</span>
          )}
        </div>

        <div className="watch-controls">
          <button
            className={`pill-btn ${recording ? 'active-green' : ''}`}
            onClick={onToggleRecording}
            title="信号変化時の自動波形記録 ON/OFF"
          >
            {recording ? <Circle size={11} fill="currentColor" /> : <Pause size={12} />}
            <span>{recording ? '記録中' : '記録一時停止'}</span>
          </button>
          <button
            className="pill-btn"
            onClick={onManualSample}
            disabled={circuitTargets.length === 0 || !simActive}
            title="現在の信号状態を 1 ステップとして手動記録"
          >
            <Camera size={12} />
            <span>サンプル記録</span>
          </button>
          <button
            className="pill-btn"
            onClick={onClearHistory}
            disabled={history.length === 0}
            title="記録した波形履歴をクリア"
          >
            <Trash2 size={12} />
            <span>波形クリア</span>
          </button>

          <div className="divider" />

          <select
            className="watch-select"
            value={quickPickVal}
            onChange={(e) => {
              const found = quickAddOptions.find((o) => o.id === e.target.value);
              if (found) onAddTarget(found.target);
              setQuickPickVal('');
            }}
            title="回路内の信号を選択してウォッチへ追加"
          >
            <option value="">＋ 信号を追加...</option>
            {quickAddOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            className="pill-btn"
            onClick={onAddAllCircuitPorts}
            title="この回路の主要入出力ポート（MODULE_IN/OUT・トグル・LED）を一括登録"
          >
            <Plus size={12} />
            <span>主要I/O一括登録</span>
          </button>

          <select
            className="watch-select compact"
            value={globalRadix}
            onChange={(e) => setGlobalRadix(e.target.value as WatchRadix)}
            title="全体の表示基数"
          >
            <option value="auto">基数: 自動</option>
            <option value="hex">HEX</option>
            <option value="bin">BIN</option>
            <option value="dec">DEC</option>
            <option value="signed">SIGNED</option>
          </select>

          <div className="hdl-seg-group" title="波形ステップ幅">
            {[28, 44, 68].map((px, i) => (
              <button
                key={px}
                className={`hdl-seg-btn ${stepPx === px ? 'active' : ''}`}
                onClick={() => setStepPx(px)}
              >
                {i === 0 ? '密' : i === 1 ? '中' : '広'}
              </button>
            ))}
          </div>
        </div>

        <button
          className="icon-btn watch-close-btn"
          onClick={onClose}
          title="ウォッチパネルを閉じる"
          aria-label="ウォッチパネルを閉じる"
        >
          <X size={14} />
        </button>
      </div>

      {/* Main Split Body */}
      {circuitTargets.length === 0 ? (
        <div className="watch-empty">
          <span>
            まだ信号が登録されていません。キャンバス上の
            <strong>ワイヤー／パーツを右クリック →「ウォッチに追加」</strong>するか、上部の「＋
            信号を追加...」「主要I/O一括登録」から追加してください。
          </span>
        </div>
      ) : (
        <div className="watch-body-split">
          {/* Left: Watched Signals Table */}
          <div
            ref={listScrollRef}
            className="watch-list-col"
            onScroll={() => {
              if (waveScrollRef.current && listScrollRef.current) {
                waveScrollRef.current.scrollTop = listScrollRef.current.scrollTop;
              }
            }}
          >
            <div className="watch-list-head">
              <span>信号名</span>
              <span>
                {hoveredStepIdx !== null ? `#${history[hoveredStepIdx]?.step}` : '現在値'}
              </span>
            </div>
            <div className="watch-list-rows">
              {circuitTargets.map((t, idx) => {
                const entry = getCurrentEntry(t);
                const bit = dominantState(entry?.value);
                const color =
                  simActive && entry
                    ? bit === BIT_X && entry.xCause
                      ? X_CAUSE_COLORS[entry.xCause]
                      : SIGNAL_COLORS[bit]
                    : '#64748b';
                const radix = effectiveRadix(t);
                const displayVal = simActive && entry ? formatWatchValue(entry.value, radix) : '--';
                const bw = entry?.value.width ?? 1;

                return (
                  <div key={t.id} className="watch-row" style={{ height: ROW_H }}>
                    <span className="watch-dot" style={{ backgroundColor: color }} />
                    <span className="watch-name" title={t.label}>
                      {t.label}
                    </span>
                    {bw > 1 && <span className="watch-width">{bw}b</span>}
                    <span
                      className="watch-val"
                      style={{ color }}
                      title="クリックで表示基数を切替"
                      onClick={() => {
                        const order: WatchRadix[] = ['auto', 'hex', 'bin', 'dec', 'signed'];
                        const next = order[(order.indexOf(t.radix) + 1) % order.length];
                        onUpdateTarget(t.id, { radix: next });
                      }}
                    >
                      {displayVal}
                    </span>
                    <div className="watch-row-acts">
                      <button
                        className="palette-act-btn"
                        disabled={idx === 0}
                        onClick={() => onReorderTarget(t.id, -1)}
                        title="上へ"
                      >
                        <ChevronUp size={11} />
                      </button>
                      <button
                        className="palette-act-btn"
                        disabled={idx === circuitTargets.length - 1}
                        onClick={() => onReorderTarget(t.id, 1)}
                        title="下へ"
                      >
                        <ChevronDown size={11} />
                      </button>
                      <button
                        className="palette-act-btn danger"
                        onClick={() => onRemoveTarget(t.id)}
                        title="ウォッチから解除"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Synchronized Scrollable Waveform Canvas */}
          <div
            ref={waveScrollRef}
            className="watch-wave-col"
            onScroll={() => {
              if (listScrollRef.current && waveScrollRef.current) {
                listScrollRef.current.scrollTop = waveScrollRef.current.scrollTop;
              }
            }}
          >
            <canvas
              ref={canvasRef}
              style={{ width: canvasW, height: canvasH, display: 'block' }}
              onMouseMove={handleWaveMouseMove}
              onMouseLeave={() => setHoveredStepIdx(null)}
            />
          </div>
        </div>
      )}
    </section>
  );
};

export { buildPinWatchLabel, buildWireWatchLabel };
