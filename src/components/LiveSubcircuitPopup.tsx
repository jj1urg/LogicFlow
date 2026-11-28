import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ExternalLink, Maximize2, Minus, Move, Plus, Radio, X } from 'lucide-react';
import { hitTestGate, hitTestPin, PinHit, screenToWorld, Viewport } from '../canvas/hitTest';
import { renderCanvas } from '../canvas/renderer';
import { getGateBounds } from '../core/catalog';
import { resolveLiveSubcircuitPath } from '../core/debug';
import { BIT_X, dominantState, formatValue, SIGNAL_COLORS, X_CAUSE_COLORS } from '../core/logic4';
import { CircuitDocument, ProjectDocument, SimulationSnapshot } from '../core/types';

interface LiveSubcircuitPopupProps {
  rootCircuit: CircuitDocument;
  project: ProjectDocument;
  rootSnapshot: SimulationSnapshot | null;
  simActive: boolean;
  gatePath: string[];
  onChangeGatePath: (nextPath: string[]) => void;
  onOpenCircuitTab: (circuitId: string) => void;
  onClose: () => void;
}

const MIN_W = 460;
const MIN_H = 340;

export const LiveSubcircuitPopup: React.FC<LiveSubcircuitPopupProps> = ({
  rootCircuit,
  project,
  rootSnapshot,
  simActive,
  gatePath,
  onChangeGatePath,
  onOpenCircuitTab,
  onClose,
}) => {
  const resolved = useMemo(
    () => resolveLiveSubcircuitPath(rootCircuit, project, rootSnapshot, gatePath),
    [rootCircuit, project, rootSnapshot, gatePath],
  );

  const [box, setBox] = useState(() => {
    const isNarrow = window.innerWidth <= 900;
    const w = isNarrow
      ? Math.max(300, window.innerWidth - 16)
      : Math.min(760, Math.max(MIN_W, Math.round(window.innerWidth * 0.56)));
    const h = isNarrow
      ? Math.max(300, Math.round(window.innerHeight * 0.68))
      : Math.min(540, Math.max(MIN_H, Math.round(window.innerHeight * 0.6)));
    return {
      x: isNarrow ? 8 : Math.max(24, Math.round((window.innerWidth - w) / 2) + 40),
      y: isNarrow ? 76 : Math.max(88, Math.round((window.innerHeight - h) / 2)),
      w,
      h,
    };
  });
  const [animState, setAnimState] = useState<'enter' | 'open' | 'closing'>('enter');

  // Trigger smooth scale-up entrance animation on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimState('open'));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleAnimatedClose = useCallback(() => {
    setAnimState('closing');
    window.setTimeout(() => onClose(), 160);
  }, [onClose]);

  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<Viewport>({ x: 40, y: 40, zoom: 1 });
  const [zoomPct, setZoomPct] = useState(100);
  const [renderTick, setRenderTick] = useState(0);
  const [hoveredPin, setHoveredPin] = useState<PinHit | null>(null);
  const [hoveredGateId, setHoveredGateId] = useState<string | null>(null);

  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const dragWinRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeWinRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const pathKey = gatePath.join('/');

  const resolvedCircuitId = resolved?.circuit.id ?? '';
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const projectRef = useRef(project);
  projectRef.current = project;
  const inputModeRef = useRef(project.settings.inputMode ?? 'auto');
  inputModeRef.current = project.settings.inputMode ?? 'auto';
  const lastTrackpadTsRef = useRef<number>(0);

  const fitCircuitToPopup = useCallback(() => {
    const wrap = canvasWrapRef.current;
    const curResolved = resolvedRef.current;
    if (!wrap || !curResolved) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const gates = curResolved.circuit.gates;
    if (gates.length === 0) {
      viewportRef.current = { x: rect.width / 2, y: rect.height / 2, zoom: 1 };
      setZoomPct(100);
      setRenderTick((t) => t + 1);
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of gates) {
      const b = getGateBounds(g, projectRef.current);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }

    const contentW = Math.max(120, maxX - minX + 90);
    const contentH = Math.max(90, maxY - minY + 90);
    const zoom = Math.max(
      0.2,
      Math.min(1.8, Math.min(rect.width / contentW, rect.height / contentH)),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    viewportRef.current = {
      x: rect.width / 2 - cx * zoom,
      y: rect.height / 2 - cy * zoom,
      zoom,
    };
    setZoomPct(Math.round(zoom * 100));
    setRenderTick((t) => t + 1);
  }, []);

  // Auto-fit ONLY when opening or navigating to a different instance path (never on live signal updates!)
  useEffect(() => {
    if (!resolvedCircuitId) return;
    const id = requestAnimationFrame(() => fitCircuitToPopup());
    return () => cancelAnimationFrame(id);
  }, [pathKey, resolvedCircuitId, fitCircuitToPopup]);

  // Track popup container resizes so canvas redraws sharply
  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => setRenderTick((t) => t + 1));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Render live subcircuit canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = canvasWrapRef.current;
    if (!canvas || !wrap || !resolved) return;

    const rect = wrap.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.floor(rect.width * dpr);
    const ch = Math.floor(rect.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    renderCanvas(ctx, rect.width, rect.height, resolved.circuit, project, resolved.snapshot, {
      viewport: viewportRef.current,
      selectedGateIds: new Set(),
      selectedWireIds: new Set(),
      hoveredPin,
      hoveredFloatingEnd: null,
      hoveredGateId,
      hoveredWire: null,
      hoveredWireHandle: null,
      wiringPreview: null,
      marquee: null,
      simActive,
    });
  }, [resolved, project, simActive, hoveredPin, hoveredGateId, renderTick, box.w, box.h]);

  // Global mouse listeners for window drag & resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragWinRef.current) {
        const d = dragWinRef.current;
        const nx = Math.max(8, Math.min(window.innerWidth - 160, d.origX + (e.clientX - d.startX)));
        const ny = Math.max(
          48,
          Math.min(window.innerHeight - 80, d.origY + (e.clientY - d.startY)),
        );
        setBox((prev) => ({ ...prev, x: nx, y: ny }));
      } else if (resizeWinRef.current) {
        const r = resizeWinRef.current;
        const nw = Math.max(
          MIN_W,
          Math.min(window.innerWidth - 24, r.origW + (e.clientX - r.startX)),
        );
        const nh = Math.max(
          MIN_H,
          Math.min(window.innerHeight - 64, r.origH + (e.clientY - r.startY)),
        );
        setBox((prev) => ({ ...prev, w: nw, h: nh }));
      }
    };
    const onUp = () => {
      dragWinRef.current = null;
      resizeWinRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Wheel zoom & pan inside the popup canvas (respects project.settings.inputMode: auto / trackpad / mouse!)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoomAtClientPt = (clientX: number, clientY: number, factor: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const vp = viewportRef.current;
      const nextZoom = Math.max(0.15, Math.min(3.5, vp.zoom * factor));
      const wx = (sx - vp.x) / vp.zoom;
      const wy = (sy - vp.y) / vp.zoom;
      viewportRef.current = {
        x: sx - wx * nextZoom,
        y: sy - wy * nextZoom,
        zoom: nextZoom,
      };
      setZoomPct(Math.round(nextZoom * 100));
      setRenderTick((t) => t + 1);
    };

    const panBy = (dx: number, dy: number) => {
      const vp = viewportRef.current;
      viewportRef.current = {
        ...vp,
        x: vp.x - dx,
        y: vp.y - dy,
      };
      setRenderTick((t) => t + 1);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * scale;
      const dy = e.deltaY * scale;
      const mode = inputModeRef.current;

      // 1. Trackpad pinch-to-zoom (Ctrl+Wheel) or Meta+Wheel -> Always zoom popup canvas
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.max(0.75, Math.min(1.35, Math.exp(-dy * 0.01)));
        zoomAtClientPt(e.clientX, e.clientY, factor);
        return;
      }

      // 2. Explicit Trackpad mode -> 2-finger scroll always pans
      if (mode === 'trackpad') {
        panBy(dx, dy);
        return;
      }

      // 3. Explicit Mouse mode -> Wheel zooms (Shift+Wheel pans horizontally)
      if (mode === 'mouse') {
        if (e.shiftKey) {
          panBy(dx || dy, 0);
          return;
        }
        const factor = dy < 0 ? 1.12 : 1 / 1.12;
        zoomAtClientPt(e.clientX, e.clientY, factor);
        return;
      }

      // 4. Auto mode: match CircuitCanvas heuristic so 2-finger vertical scroll never triggers zoom!
      const now = performance.now();
      const looksLikeTrackpad =
        Math.abs(e.deltaX) > 0 ||
        (e.deltaMode === 0 && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 42)) ||
        now - lastTrackpadTsRef.current < 350;

      if (looksLikeTrackpad) {
        lastTrackpadTsRef.current = now;
        panBy(dx, dy);
      } else {
        const factor = dy < 0 ? 1.12 : 1 / 1.12;
        zoomAtClientPt(e.clientX, e.clientY, factor);
      }
    };

    // Safari / WebKit trackpad pinch gestures
    let lastGestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastGestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as unknown as { scale?: number; clientX?: number; clientY?: number };
      if (typeof ge.scale === 'number' && ge.scale > 0) {
        const factor = ge.scale / lastGestureScale;
        lastGestureScale = ge.scale;
        const rect = canvas.getBoundingClientRect();
        zoomAtClientPt(
          ge.clientX ?? rect.left + rect.width / 2,
          ge.clientY ?? rect.top + rect.height / 2,
          factor,
        );
      }
    };

    // Two-finger touchscreen pinch & pan
    let touchState: { dist: number; cx: number; cy: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        touchState = {
          dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
          cx: (t1.clientX + t2.clientX) / 2,
          cy: (t1.clientY + t2.clientY) / 2,
        };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && touchState) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const cx = (t1.clientX + t2.clientX) / 2;
        const cy = (t1.clientY + t2.clientY) / 2;
        const panDx = cx - touchState.cx;
        const panDy = cy - touchState.cy;
        const factor = touchState.dist > 1 ? dist / touchState.dist : 1;
        const rect = canvas.getBoundingClientRect();
        const sx = cx - rect.left;
        const sy = cy - rect.top;
        const vp = viewportRef.current;
        const movedX = vp.x + panDx;
        const movedY = vp.y + panDy;
        const nextZoom = Math.max(0.15, Math.min(3.5, vp.zoom * factor));
        const wx = (sx - movedX) / vp.zoom;
        const wy = (sy - movedY) / vp.zoom;
        viewportRef.current = { zoom: nextZoom, x: sx - wx * nextZoom, y: sy - wy * nextZoom };
        setZoomPct(Math.round(nextZoom * 100));
        setRenderTick((t) => t + 1);
        touchState = { dist, cx, cy };
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) touchState = null;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', onGestureStart, { passive: false });
    canvas.addEventListener('gesturechange', onGestureChange, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', onGestureStart);
      canvas.removeEventListener('gesturechange', onGestureChange);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  if (!resolved) return null;

  const { circuit, snapshot, breadcrumbs, isStub } = resolved;

  const adjustZoom = (factor: number) => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const vp = viewportRef.current;
    const nextZoom = Math.max(0.15, Math.min(3.5, vp.zoom * factor));
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - vp.x) / vp.zoom;
    const wy = (cy - vp.y) / vp.zoom;
    viewportRef.current = {
      x: cx - wx * nextZoom,
      y: cy - wy * nextZoom,
      zoom: nextZoom,
    };
    setZoomPct(Math.round(nextZoom * 100));
    setRenderTick((t) => t + 1);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: viewportRef.current.x,
      origY: viewportRef.current.y,
    };
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (panRef.current) {
      const p = panRef.current;
      viewportRef.current = {
        ...viewportRef.current,
        x: p.origX + (e.clientX - p.startX),
        y: p.origY + (e.clientY - p.startY),
      };
      setRenderTick((t) => t + 1);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, viewportRef.current);
    const pin = hitTestPin(world, circuit, project, 13 / Math.max(0.5, viewportRef.current.zoom));
    setHoveredPin(pin);
    const gate = pin ? null : hitTestGate(world, circuit, project);
    setHoveredGateId(gate ? gate.id : null);
  };

  const handleCanvasMouseUp = () => {
    panRef.current = null;
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, viewportRef.current);
    const gate = hitTestGate(world, circuit, project);
    if (gate?.type === 'SUBCIRCUIT' && gate.props.subcircuitId) {
      const subDoc = project.circuits[gate.props.subcircuitId];
      if (subDoc && !subDoc.isStub) {
        onChangeGatePath([...gatePath, gate.id]);
      }
    }
  };

  const portGates = circuit.gates
    .filter((g) => g.type === 'MODULE_IN' || g.type === 'MODULE_OUT')
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'MODULE_IN' ? -1 : 1;
      return (a.props.portOrder ?? 999) - (b.props.portOrder ?? 999);
    });

  return (
    <div
      className={`live-popup-window live-popup-${animState}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {/* Draggable Header Bar */}
      <div
        className="live-popup-header"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          dragWinRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origX: box.x,
            origY: box.y,
          };
        }}
      >
        <div className="live-popup-title-row">
          <Move size={13} className="live-popup-grip" />
          <span className={`live-popup-badge ${simActive ? 'is-live' : 'is-paused'}`}>
            <Radio size={11} />
            {simActive ? 'LIVE 反映中' : '停止中'}
          </span>
          <div className="live-popup-crumbs" title="パンくずクリックで上位モジュールへ戻る">
            <span className="live-crumb-root">{rootCircuit.name}</span>
            {breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={crumb.gateId}>
                <ChevronRight size={12} className="live-crumb-sep" />
                <button
                  className={`live-crumb-btn ${idx === breadcrumbs.length - 1 ? 'active' : ''}`}
                  onClick={() => onChangeGatePath(gatePath.slice(0, idx + 1))}
                  title={`${crumb.instanceLabel} : ${crumb.moduleName}`}
                >
                  {crumb.instanceLabel}
                  {crumb.instanceLabel !== crumb.moduleName && (
                    <span className="live-crumb-mod">:{crumb.moduleName}</span>
                  )}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="live-popup-actions">
          <button className="icon-btn" onClick={() => adjustZoom(1 / 1.2)} title="縮小">
            <Minus size={13} />
          </button>
          <span className="live-popup-zoom">{zoomPct}%</span>
          <button className="icon-btn" onClick={() => adjustZoom(1.2)} title="拡大">
            <Plus size={13} />
          </button>
          <button className="icon-btn" onClick={fitCircuitToPopup} title="全体表示">
            <Maximize2 size={13} />
          </button>
          {!isStub && (
            <button
              className="pill-btn"
              onClick={() => onOpenCircuitTab(circuit.id)}
              title="定義を別タブで開く（独立編集・単体テスト）"
            >
              <ExternalLink size={12} />
              <span>別タブで編集</span>
            </button>
          )}
          <button className="icon-btn" onClick={handleAnimatedClose} title="ポップアップを閉じる">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Live Canvas Area */}
      <div ref={canvasWrapRef} className="live-popup-canvas-wrap">
        {isStub ? (
          <div className="live-popup-empty">
            外部仮モジュール（Stub）のため内部回路は定義されていません。
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="live-popup-canvas"
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={() => {
                panRef.current = null;
                setHoveredPin(null);
                setHoveredGateId(null);
              }}
              onDoubleClick={handleCanvasDoubleClick}
            />
            <div className="live-popup-hint">
              親回路を操作するとリアルタイム反映 · ドラッグ移動 / ホイール拡大縮小 /
              子モジュールをダブルクリックで潜入
            </div>
          </>
        )}
      </div>

      {/* Live Port Readout Strip */}
      {portGates.length > 0 && (
        <div className="live-popup-ports">
          {portGates.map((pg) => {
            const pk = `${pg.id}:${pg.type === 'MODULE_IN' ? 'out' : 'in'}`;
            const val = snapshot?.pinValues[pk];
            const bit = dominantState(val);
            const xCause = bit === BIT_X ? snapshot?.pinXCauses?.[pk] : undefined;
            const color = simActive
              ? xCause
                ? X_CAUSE_COLORS[xCause]
                : SIGNAL_COLORS[bit]
              : '#64748b';
            return (
              <span key={pg.id} className="live-port-chip">
                <span className={`live-port-dir ${pg.type === 'MODULE_IN' ? 'in' : 'out'}`}>
                  {pg.type === 'MODULE_IN' ? 'IN' : 'OUT'}
                </span>
                <span className="live-port-name">{pg.label}</span>
                <span className="live-port-val" style={{ color }}>
                  {simActive && val ? formatValue(val, val.width > 1 ? 'hex' : 'bin') : '--'}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* Resize Corner Handle */}
      <div
        className="live-popup-resize"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resizeWinRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origW: box.w,
            origH: box.h,
          };
        }}
        title="ドラッグしてサイズ変更"
      />
    </div>
  );
};
