import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Mouse, Sparkles, Touchpad, ZoomIn, ZoomOut } from 'lucide-react';
import {
  FloatingWireEndHit,
  gatesInRect,
  hitTestFloatingWireEnd,
  hitTestGate,
  hitTestPin,
  hitTestWire,
  hitTestWireHandle,
  PinHit,
  projectPointToSegment,
  screenToWorld,
  Viewport,
  WireHandleHit,
  WireHit,
  wiresInRect,
} from '../canvas/hitTest';
import { renderCanvas } from '../canvas/renderer';
import {
  GATE_CATALOG,
  getGateBounds,
  getPinWorldSide,
  GRID_SIZE,
  snapToGrid,
} from '../core/catalog';
import {
  dragWireSegment,
  dragWireWaypoint,
  inferWireEndOutwardSide,
  routeWire,
  simplifyPolyline,
} from '../core/routing';
import { RuntimeInputOverride } from '../core/simulator';
import { DragGatePayload } from './ComponentPalette';
import {
  CircuitDocument,
  GateInstance,
  GateType,
  InputMode,
  PinRef,
  PinSide,
  Point,
  ProjectDocument,
  SimulationSnapshot,
  Wire,
} from '../core/types';
import { ContextMenuState } from './ContextMenu';

interface CircuitCanvasProps {
  project: ProjectDocument;
  circuit: CircuitDocument;
  snapshot: SimulationSnapshot | null;
  simActive: boolean;
  editLocked: boolean;
  runtimeInputs: Record<string, RuntimeInputOverride>;
  selectedGateIds: Set<string>;
  selectedWireIds: Set<string>;
  onSelect: (gates: Set<string>, wires: Set<string>) => void;
  onAddGateAt: (type: GateType, x: number, y: number, subcircuitId?: string) => void;
  onReplaceGate: (gateId: string, type: GateType, subcircuitId?: string) => void;
  onMoveGates: (positions: Map<string, Point>, recordHistory: boolean) => void;
  onAddWire: (
    startPt: Point,
    endPt: Point,
    from?: PinRef,
    to?: PinRef,
    startSide?: PinSide,
    endSide?: PinSide,
    customPoints?: Point[],
  ) => void;
  onExtendFloatingWire: (
    wireId: string,
    end: 'start' | 'end',
    targetPt: Point,
    targetPin?: PinRef,
    targetSide?: PinSide,
    customPoints?: Point[],
    targetFloatingEnd?: { wireId: string; end: 'start' | 'end' },
  ) => void;
  onUpdateWirePoints: (wireId: string, points: Point[], recordHistory: boolean) => void;
  onInteractGate: (gate: GateInstance) => void;
  onButtonPress: (gateId: string, pressed: boolean) => void;
  onOpenSubcircuit: (circuitId: string) => void;
  onOpenLiveSubcircuitPopup: (gateId: string) => void;
  onQuickEditWireLabel: (wire: Wire) => void;
  onOpenContextMenu: (menu: ContextMenuState) => void;
  onChangeInputMode: (mode: InputMode) => void;
  draggingGate: DragGatePayload | null;
  onDragOverCanvasChange: (over: boolean) => void;
  onDropComplete: () => void;
  viewportRef: React.MutableRefObject<Viewport>;
  fitTrigger: number;
}

interface WiringSession {
  startPt: Point;
  fromPin?: PinRef;
  startSide?: PinSide;
  extendingWire?: { wireId: string; end: 'start' | 'end' };
  waypoints: Point[]; // intermediate points for free routing
}

export const CircuitCanvas: React.FC<CircuitCanvasProps> = ({
  project,
  circuit,
  snapshot,
  simActive,
  editLocked,
  runtimeInputs,
  selectedGateIds,
  selectedWireIds,
  onSelect,
  onAddGateAt,
  onReplaceGate,
  onMoveGates,
  onAddWire,
  onExtendFloatingWire,
  onUpdateWirePoints,
  onInteractGate,
  onButtonPress,
  onOpenSubcircuit,
  onOpenLiveSubcircuitPopup,
  onQuickEditWireLabel,
  onOpenContextMenu,
  onChangeInputMode,
  draggingGate,
  onDragOverCanvasChange,
  onDropComplete,
  viewportRef,
  fitTrigger,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [vp, setVp] = useState<Viewport>({ x: 40, y: 30, zoom: 1 });
  const [hoveredPin, setHoveredPin] = useState<PinHit | null>(null);
  const [hoveredFloatingEnd, setHoveredFloatingEnd] = useState<FloatingWireEndHit | null>(null);
  const [hoveredGateId, setHoveredGateId] = useState<string | null>(null);
  const [hoveredWire, setHoveredWire] = useState<WireHit | null>(null);
  const [hoveredWireHandle, setHoveredWireHandle] = useState<WireHandleHit | null>(null);
  const [wiring, setWiring] = useState<WiringSession | null>(null);
  const [cursorWorld, setCursorWorld] = useState<Point>({ x: 0, y: 0 });
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  const [spacePanning, setSpacePanning] = useState(false);
  const [touchHoldMode, setTouchHoldMode] = useState<'gate-hold' | 'context-hold' | null>(null);
  const [dragGhostWorld, setDragGhostWorld] = useState<Point | null>(null);
  const [replaceTargetGateId, setReplaceTargetGateId] = useState<string | null>(null);

  // Clear canvas ghost whenever drag session ends
  useEffect(() => {
    if (!draggingGate) {
      setDragGhostWorld(null);
      setReplaceTargetGateId(null);
      onDragOverCanvasChange(false);
    }
  }, [draggingGate, onDragOverCanvasChange]);

  const replaceTarget = React.useMemo(() => {
    if (!draggingGate || !replaceTargetGateId || editLocked) return null;
    const newLabel = draggingGate.subcircuitId
      ? (project.circuits[draggingGate.subcircuitId]?.name ?? GATE_CATALOG[draggingGate.type].name)
      : GATE_CATALOG[draggingGate.type].shortName;
    return { gateId: replaceTargetGateId, newLabel };
  }, [draggingGate, replaceTargetGateId, editLocked, project.circuits]);

  const ghostGate: GateInstance | null = React.useMemo(() => {
    if (!draggingGate || !dragGhostWorld || editLocked) return null;
    const entry = GATE_CATALOG[draggingGate.type];
    const gs = project.settings.gridSize || GRID_SIZE;
    const snap = project.settings.routeMode === 'grid';
    const x = snap ? snapToGrid(dragGhostWorld.x, gs) : Math.round(dragGhostWorld.x);
    const y = snap ? snapToGrid(dragGhostWorld.y, gs) : Math.round(dragGhostWorld.y);
    const extra = draggingGate.subcircuitId
      ? { subcircuitId: draggingGate.subcircuitId, displayMode: 'live' as const }
      : {};
    const label = draggingGate.subcircuitId
      ? (project.circuits[draggingGate.subcircuitId]?.name ?? '')
      : draggingGate.type === 'MODULE_IN'
        ? 'IN'
        : draggingGate.type === 'MODULE_OUT'
          ? 'OUT'
          : '';
    return {
      id: '__ghost__',
      type: draggingGate.type,
      x,
      y,
      rotation: 0,
      label,
      props: { ...entry.defaultProps, ...extra },
    };
  }, [draggingGate, dragGhostWorld, editLocked, project]);

  const dragRef = useRef<{
    kind: 'none' | 'pan' | 'gates' | 'marquee' | 'wire-segment' | 'wire-vertex';
    startScreen: Point;
    startWorld: Point;
    startVp: Viewport;
    gateStartPos: Map<string, Point>;
    moved: boolean;
    clickedGate?: GateInstance;
    wireId?: string;
    wireRouteMode?: 'grid' | 'free';
    wireOrigPoints?: Point[];
    wireTargetIndex?: number;
    wireLastPoints?: Point[];
    lastGateMoveSig?: string;
  }>({
    kind: 'none',
    startScreen: { x: 0, y: 0 },
    startWorld: { x: 0, y: 0 },
    startVp: { x: 0, y: 0, zoom: 1 },
    gateStartPos: new Map(),
    moved: false,
  });

  // Sync ref for external access (e.g. quick-add gate at viewport center) & rAF-coalesced pan/zoom
  const vpStateRef = useRef<Viewport>(vp);
  vpStateRef.current = vp;
  const vpRafRef = useRef<number | null>(null);
  const pendingVpRef = useRef<Viewport | null>(null);

  const scheduleVpUpdate = useCallback((updater: (prev: Viewport) => Viewport) => {
    const base = pendingVpRef.current ?? vpStateRef.current;
    const next = updater(base);
    pendingVpRef.current = next;
    vpStateRef.current = next;
    if (vpRafRef.current === null) {
      vpRafRef.current = window.requestAnimationFrame(() => {
        vpRafRef.current = null;
        const target = pendingVpRef.current;
        pendingVpRef.current = null;
        if (target) setVp(target);
      });
    }
  }, []);

  useEffect(() => {
    viewportRef.current = vp;
  }, [vp, viewportRef]);

  useEffect(() => {
    return () => {
      if (vpRafRef.current !== null) window.cancelAnimationFrame(vpRafRef.current);
    };
  }, []);

  const zoomToFit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (circuit.gates.length === 0) {
      setVp({ x: rect.width * 0.15, y: rect.height * 0.15, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of circuit.gates) {
      const b = getGateBounds(g, project);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }
    const pad = 70;
    const cw = Math.max(120, maxX - minX + pad * 2);
    const ch = Math.max(120, maxY - minY + pad * 2);
    const zoom = Math.max(0.35, Math.min(1.5, Math.min(rect.width / cw, rect.height / ch)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setVp({
      x: rect.width / 2 - cx * zoom,
      y: rect.height / 2 - cy * zoom,
      zoom,
    });
  }, [circuit.gates, project]);

  // Preserve per-circuit tab zoom/pan in session memory; auto-fit only on first visit or explicit Fit (F)
  const savedViewportsRef = useRef<Map<string, Viewport>>(new Map());
  const lastCircuitIdRef = useRef<string>('');
  const lastFitTriggerRef = useRef<number>(fitTrigger);
  const zoomToFitRef = useRef(zoomToFit);
  zoomToFitRef.current = zoomToFit;

  // Save current tab's viewport whenever user pans/zooms
  useEffect(() => {
    if (lastCircuitIdRef.current === circuit.id) {
      savedViewportsRef.current.set(circuit.id, vp);
    }
  }, [circuit.id, vp]);

  // Restore saved viewport on tab switch, or fit once on first visit to a tab
  useEffect(() => {
    if (lastCircuitIdRef.current !== circuit.id) {
      if (lastCircuitIdRef.current) {
        savedViewportsRef.current.set(lastCircuitIdRef.current, viewportRef.current);
      }
      lastCircuitIdRef.current = circuit.id;
      const saved = savedViewportsRef.current.get(circuit.id);
      if (saved) {
        setVp(saved);
      } else {
        zoomToFitRef.current();
      }
    }
  }, [circuit.id, viewportRef]);

  // Only run zoomToFit when fitTrigger actually increments (never on unrelated gate/project updates!)
  useEffect(() => {
    if (fitTrigger !== lastFitTriggerRef.current) {
      lastFitTriggerRef.current = fitTrigger;
      if (fitTrigger > 0) zoomToFitRef.current();
    }
  }, [fitTrigger]);

  // Escape cancels wiring; Space enables temporary hand panning while held
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWiring(null);
      }
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        setSpacePanning(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePanning(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Compute live wire preview points
  const wiringPreview: Point[] | null = React.useMemo(() => {
    if (!wiring) return null;
    const validFloatTarget =
      hoveredFloatingEnd && hoveredFloatingEnd.wire.id !== wiring.extendingWire?.wireId
        ? hoveredFloatingEnd
        : null;
    const targetPt = hoveredPin
      ? hoveredPin.pos
      : validFloatTarget
        ? validFloatTarget.pos
        : project.settings.routeMode === 'grid'
          ? {
              x: snapToGrid(cursorWorld.x, project.settings.gridSize),
              y: snapToGrid(cursorWorld.y, project.settings.gridSize),
            }
          : cursorWorld;

    if (project.settings.routeMode === 'free') {
      return simplifyPolyline([wiring.startPt, ...wiring.waypoints, targetPt]);
    }

    const endSide = hoveredPin
      ? getPinWorldSide(hoveredPin.pin.side, hoveredPin.gate.rotation)
      : validFloatTarget
        ? inferWireEndOutwardSide(validFloatTarget.wire.points, validFloatTarget.end)
        : undefined;
    return routeWire(wiring.startPt, targetPt, {
      startSide: wiring.startSide,
      endSide,
      circuit,
      project,
      routeMode: 'grid',
      ignoreWireId: wiring.extendingWire?.wireId,
    });
  }, [wiring, hoveredPin, hoveredFloatingEnd, cursorWorld, circuit, project]);

  // Keep latest render parameters in a ref so ResizeObserver can repaint synchronously
  // BEFORE browser paint (eliminates 1-frame stretching during sidebar slide animations).
  const renderParamsRef = useRef({
    vp,
    circuit,
    project,
    snapshot,
    selectedGateIds,
    selectedWireIds,
    hoveredPin,
    hoveredFloatingEnd,
    hoveredGateId,
    hoveredWire,
    hoveredWireHandle,
    wiringPreview,
    marquee,
    simActive,
    runtimeInputs,
    ghostGate: replaceTarget ? null : ghostGate,
    replaceTarget,
  });
  renderParamsRef.current = {
    vp,
    circuit,
    project,
    snapshot,
    selectedGateIds,
    selectedWireIds,
    hoveredPin,
    hoveredFloatingEnd,
    hoveredGateId,
    hoveredWire,
    hoveredWireHandle,
    wiringPreview,
    marquee,
    simActive,
    runtimeInputs,
    ghostGate: replaceTarget ? null : ghostGate,
    replaceTarget,
  };

  const drawCanvasNow = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(rect.width));
    const h = Math.max(1, Math.ceil(rect.height));
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);

    // Explicitly lock CSS px size to backing store size / dpr so CSS never stretches the bitmap
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    } else if (canvas.style.width !== `${w}px` || canvas.style.height !== `${h}px`) {
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = renderParamsRef.current;
    renderCanvas(ctx, w, h, p.circuit, p.project, p.snapshot, {
      viewport: p.vp,
      selectedGateIds: p.selectedGateIds,
      selectedWireIds: p.selectedWireIds,
      hoveredPin: p.hoveredPin,
      hoveredFloatingEnd: p.hoveredFloatingEnd,
      hoveredGateId: p.hoveredGateId,
      hoveredWire: p.hoveredWire,
      hoveredWireHandle: p.hoveredWireHandle,
      wiringPreview: p.wiringPreview,
      marquee: p.marquee,
      simActive: p.simActive,
      runtimeInputs: p.runtimeInputs,
      ghostGate: p.ghostGate,
      replaceTarget: p.replaceTarget,
    });
  }, []);

  // Resize observer repaints synchronously before paint so sidebar transitions never stretch canvas
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      drawCanvasNow();
    });
    obs.observe(el);
    window.addEventListener('resize', drawCanvasNow);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', drawCanvasNow);
    };
  }, [drawCanvasNow]);

  // Main Canvas Render Effect
  useEffect(() => {
    drawCanvasNow();
  }, [
    drawCanvasNow,
    vp,
    circuit,
    project,
    snapshot,
    selectedGateIds,
    selectedWireIds,
    hoveredPin,
    hoveredFloatingEnd,
    hoveredGateId,
    hoveredWire,
    hoveredWireHandle,
    wiringPreview,
    marquee,
    simActive,
    runtimeInputs,
    ghostGate,
    replaceTarget,
  ]);

  const getLocalScreenPt = (clientX: number, clientY: number): Point => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // --- Mouse Event Handlers ---

  const handleMouseDown = (e: React.MouseEvent) => {
    const screenPt = getLocalScreenPt(e.clientX, e.clientY);
    const worldPt = screenToWorld(screenPt, vp);

    // Middle click or Space+Left or Alt+Left -> Pan
    if (e.button === 1 || (e.button === 0 && (spacePanning || e.altKey))) {
      e.preventDefault();
      dragRef.current = {
        kind: 'pan',
        startScreen: screenPt,
        startWorld: worldPt,
        startVp: { ...vp },
        gateStartPos: new Map(),
        moved: false,
      };
      return;
    }

    if (e.button !== 0) return;

    // In Run-only mode (editLocked), pins don't start wiring and gates/wires can't be moved — only interactive inputs work!
    if (editLocked) {
      const gateHit = hitTestGate(worldPt, circuit, project);
      if (gateHit) {
        if (gateHit.type === 'BUTTON') {
          onButtonPress(gateHit.id, true);
        }
        onSelect(new Set([gateHit.id]), new Set());
        dragRef.current = {
          kind: 'gates',
          startScreen: screenPt,
          startWorld: worldPt,
          startVp: { ...vp },
          gateStartPos: new Map(),
          moved: false,
          clickedGate: gateHit,
        };
        return;
      }
      const wireHit = hitTestWire(worldPt, circuit, 8 / vp.zoom);
      if (wireHit) {
        onSelect(new Set(), new Set([wireHit.wire.id]));
        return;
      }
      onSelect(new Set(), new Set());
      return;
    }

    // 1. Check Pin click -> start or complete wiring!
    const pinHit = hitTestPin(worldPt, circuit, project, 12 / vp.zoom);
    if (pinHit) {
      if (!wiring) {
        setWiring({
          startPt: pinHit.pos,
          fromPin: { gateId: pinHit.gate.id, pinId: pinHit.pin.id },
          startSide: getPinWorldSide(pinHit.pin.side, pinHit.gate.rotation),
          waypoints: [],
        });
      } else if (wiring.extendingWire) {
        const endSide = getPinWorldSide(pinHit.pin.side, pinHit.gate.rotation);
        const customPts =
          project.settings.routeMode === 'free'
            ? simplifyPolyline([wiring.startPt, ...wiring.waypoints, pinHit.pos])
            : undefined;
        onExtendFloatingWire(
          wiring.extendingWire.wireId,
          wiring.extendingWire.end,
          pinHit.pos,
          { gateId: pinHit.gate.id, pinId: pinHit.pin.id },
          endSide,
          customPts,
        );
        setWiring(null);
      } else {
        // Complete wire connection!
        const samePin =
          wiring.fromPin &&
          wiring.fromPin.gateId === pinHit.gate.id &&
          wiring.fromPin.pinId === pinHit.pin.id;
        if (!samePin) {
          const endSide = getPinWorldSide(pinHit.pin.side, pinHit.gate.rotation);
          const customPts =
            project.settings.routeMode === 'free'
              ? simplifyPolyline([wiring.startPt, ...wiring.waypoints, pinHit.pos])
              : undefined;
          onAddWire(
            wiring.startPt,
            pinHit.pos,
            wiring.fromPin,
            { gateId: pinHit.gate.id, pinId: pinHit.pin.id },
            wiring.startSide,
            endSide,
            customPts,
          );
        }
        setWiring(null);
      }
      return;
    }

    // 1.5. Check Floating Wire Endpoint click -> extend directly OR merge seamlessly without midpoint dot!
    const floatHit = hitTestFloatingWireEnd(
      worldPt,
      circuit,
      project,
      12 / vp.zoom,
      wiring?.extendingWire?.wireId,
    );
    if (floatHit) {
      if (!wiring) {
        setWiring({
          startPt: floatHit.pos,
          startSide: inferWireEndOutwardSide(floatHit.wire.points, floatHit.end),
          extendingWire: { wireId: floatHit.wire.id, end: floatHit.end },
          waypoints: [],
        });
      } else if (wiring.extendingWire) {
        const endSide = inferWireEndOutwardSide(floatHit.wire.points, floatHit.end);
        const customPts =
          project.settings.routeMode === 'free'
            ? simplifyPolyline([wiring.startPt, ...wiring.waypoints, floatHit.pos])
            : undefined;
        onExtendFloatingWire(
          wiring.extendingWire.wireId,
          wiring.extendingWire.end,
          floatHit.pos,
          undefined,
          endSide,
          customPts,
          { wireId: floatHit.wire.id, end: floatHit.end },
        );
        setWiring(null);
      } else {
        // Started from a gate pin and clicked an existing floating wire end -> merge cleanly into ONE wire!
        const revCustomPts =
          project.settings.routeMode === 'free'
            ? simplifyPolyline([
                floatHit.pos,
                ...wiring.waypoints.slice().reverse(),
                wiring.startPt,
              ])
            : undefined;
        onExtendFloatingWire(
          floatHit.wire.id,
          floatHit.end,
          wiring.startPt,
          wiring.fromPin,
          wiring.startSide,
          revCustomPts,
        );
        setWiring(null);
      }
      return;
    }

    // 2. If currently wiring and clicked on a wire -> create clean T-junction projected onto that wire!
    if (wiring) {
      const wireHit = hitTestWire(worldPt, circuit, 8 / vp.zoom);
      if (wireHit && wireHit.wire.id !== wiring.extendingWire?.wireId) {
        const a = wireHit.wire.points[wireHit.segIndex];
        const b = wireHit.wire.points[wireHit.segIndex + 1];
        const proj = projectPointToSegment(worldPt, a, b);
        let snapPt = proj;
        if (project.settings.routeMode === 'grid') {
          const gs = project.settings.gridSize;
          if (Math.abs(a.y - b.y) < 0.5) {
            const minX = Math.min(a.x, b.x);
            const maxX = Math.max(a.x, b.x);
            snapPt = { x: Math.max(minX, Math.min(maxX, snapToGrid(proj.x, gs))), y: a.y };
          } else if (Math.abs(a.x - b.x) < 0.5) {
            const minY = Math.min(a.y, b.y);
            const maxY = Math.max(a.y, b.y);
            snapPt = { x: a.x, y: Math.max(minY, Math.min(maxY, snapToGrid(proj.y, gs))) };
          } else {
            snapPt = { x: snapToGrid(proj.x, gs), y: snapToGrid(proj.y, gs) };
          }
        }
        const customPts =
          project.settings.routeMode === 'free'
            ? simplifyPolyline([wiring.startPt, ...wiring.waypoints, snapPt])
            : undefined;
        if (wiring.extendingWire) {
          onExtendFloatingWire(
            wiring.extendingWire.wireId,
            wiring.extendingWire.end,
            snapPt,
            undefined,
            undefined,
            customPts,
          );
        } else {
          onAddWire(
            wiring.startPt,
            snapPt,
            wiring.fromPin,
            undefined,
            wiring.startSide,
            undefined,
            customPts,
          );
        }
        setWiring(null);
        return;
      }
      // In free routing mode, clicking empty canvas adds a waypoint; in grid mode it cancels
      if (project.settings.routeMode === 'free') {
        setWiring((prev) => (prev ? { ...prev, waypoints: [...prev.waypoints, worldPt] } : null));
      } else {
        setWiring(null);
      }
      return;
    }

    // 2.5. Check selected wire handles (corner vertex or segment midpoint) -> drag wire geometry
    const handleHit = hitTestWireHandle(worldPt, circuit, selectedWireIds, 10 / vp.zoom);
    if (handleHit) {
      dragRef.current = {
        kind: handleHit.kind === 'vertex' ? 'wire-vertex' : 'wire-segment',
        startScreen: screenPt,
        startWorld: worldPt,
        startVp: { ...vp },
        gateStartPos: new Map(),
        moved: false,
        wireId: handleHit.wire.id,
        wireRouteMode: handleHit.wire.routeMode,
        wireOrigPoints: handleHit.wire.points.map((p) => ({ x: p.x, y: p.y })),
        wireTargetIndex: handleHit.index,
      };
      return;
    }

    // 3. Check Gate click -> select & start dragging (or press button)
    const gateHit = hitTestGate(worldPt, circuit, project);
    if (gateHit) {
      if (gateHit.type === 'BUTTON') {
        onButtonPress(gateHit.id, true);
      }

      let nextSelected = new Set(selectedGateIds);
      if (e.shiftKey) {
        if (nextSelected.has(gateHit.id)) nextSelected.delete(gateHit.id);
        else nextSelected.add(gateHit.id);
      } else if (!nextSelected.has(gateHit.id)) {
        nextSelected = new Set([gateHit.id]);
      }
      onSelect(nextSelected, e.shiftKey ? new Set(selectedWireIds) : new Set());

      const startPos = new Map<string, Point>();
      for (const g of circuit.gates) {
        if (nextSelected.has(g.id)) startPos.set(g.id, { x: g.x, y: g.y });
      }
      dragRef.current = {
        kind: 'gates',
        startScreen: screenPt,
        startWorld: worldPt,
        startVp: { ...vp },
        gateStartPos: startPos,
        moved: false,
        clickedGate: gateHit,
      };
      return;
    }

    // 4. Check Wire click -> select wire AND allow immediate segment drag adjustment!
    const wireHit = hitTestWire(worldPt, circuit, 8 / vp.zoom);
    if (wireHit) {
      const nextW = e.shiftKey ? new Set(selectedWireIds) : new Set<string>();
      if (e.shiftKey && nextW.has(wireHit.wire.id)) nextW.delete(wireHit.wire.id);
      else nextW.add(wireHit.wire.id);
      onSelect(e.shiftKey ? new Set(selectedGateIds) : new Set(), nextW);

      if (!e.shiftKey) {
        dragRef.current = {
          kind: 'wire-segment',
          startScreen: screenPt,
          startWorld: worldPt,
          startVp: { ...vp },
          gateStartPos: new Map(),
          moved: false,
          wireId: wireHit.wire.id,
          wireRouteMode: wireHit.wire.routeMode,
          wireOrigPoints: wireHit.wire.points.map((p) => ({ x: p.x, y: p.y })),
          wireTargetIndex: wireHit.segIndex,
        };
      }
      return;
    }

    // 5. Empty canvas -> start marquee selection
    if (!e.shiftKey) onSelect(new Set(), new Set());
    dragRef.current = {
      kind: 'marquee',
      startScreen: screenPt,
      startWorld: worldPt,
      startVp: { ...vp },
      gateStartPos: new Map(),
      moved: false,
    };
    setMarquee({ x1: worldPt.x, y1: worldPt.y, x2: worldPt.x, y2: worldPt.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const screenPt = getLocalScreenPt(e.clientX, e.clientY);
    const curVp = pendingVpRef.current ?? vp;
    const worldPt = screenToWorld(screenPt, curVp);
    if (wiring) setCursorWorld(worldPt);

    const d = dragRef.current;
    if (d.kind === 'pan') {
      scheduleVpUpdate(() => ({
        ...d.startVp,
        x: d.startVp.x + (screenPt.x - d.startScreen.x),
        y: d.startVp.y + (screenPt.y - d.startScreen.y),
      }));
      return;
    }

    if (d.kind === 'gates') {
      if (editLocked) return;
      const dist = Math.hypot(screenPt.x - d.startScreen.x, screenPt.y - d.startScreen.y);
      if (dist > 4) {
        if (!d.moved && d.clickedGate?.type === 'BUTTON') {
          onButtonPress(d.clickedGate.id, false);
        }
        const firstMove = !d.moved;
        d.moved = true;
        const dx = worldPt.x - d.startWorld.x;
        const dy = worldPt.y - d.startWorld.y;
        const gs = project.settings.gridSize || GRID_SIZE;
        const snap = project.settings.routeMode === 'grid';
        const nextPos = new Map<string, Point>();
        let sig = '';
        for (const [gid, orig] of d.gateStartPos.entries()) {
          const nx = snap ? snapToGrid(orig.x + dx, gs) : Math.round(orig.x + dx);
          const ny = snap ? snapToGrid(orig.y + dy, gs) : Math.round(orig.y + dy);
          nextPos.set(gid, { x: nx, y: ny });
          sig += `${nx},${ny};`;
        }
        // Skip redundant reroutes & project clones when snapped coordinates haven't changed!
        if (!firstMove && d.lastGateMoveSig === sig) return;
        d.lastGateMoveSig = sig;
        onMoveGates(nextPos, firstMove);
      }
      return;
    }

    if (d.kind === 'wire-segment' || d.kind === 'wire-vertex') {
      const dist = Math.hypot(screenPt.x - d.startScreen.x, screenPt.y - d.startScreen.y);
      if (dist > 3 && d.wireId && d.wireOrigPoints && d.wireTargetIndex !== undefined) {
        const firstMove = !d.moved;
        d.moved = true;
        const gs = project.settings.gridSize || GRID_SIZE;
        const mode = d.wireRouteMode ?? project.settings.routeMode;
        const nextPts =
          d.kind === 'wire-vertex'
            ? dragWireWaypoint(d.wireOrigPoints, d.wireTargetIndex, worldPt, mode, gs)
            : dragWireSegment(d.wireOrigPoints, d.wireTargetIndex, worldPt, mode, gs);
        d.wireLastPoints = nextPts;
        onUpdateWirePoints(d.wireId, nextPts, firstMove);
      }
      return;
    }

    if (d.kind === 'marquee') {
      setMarquee({ x1: d.startWorld.x, y1: d.startWorld.y, x2: worldPt.x, y2: worldPt.y });
      return;
    }

    // Hover hit testing
    const pHit = hitTestPin(worldPt, circuit, project, 12 / vp.zoom);
    setHoveredPin(pHit);
    if (pHit) {
      setHoveredFloatingEnd(null);
      setHoveredGateId(null);
      setHoveredWire(null);
      setHoveredWireHandle(null);
    } else {
      const fHit = !editLocked
        ? hitTestFloatingWireEnd(
            worldPt,
            circuit,
            project,
            12 / vp.zoom,
            wiring?.extendingWire?.wireId,
          )
        : null;
      setHoveredFloatingEnd(fHit);
      if (fHit) {
        setHoveredGateId(null);
        setHoveredWire(null);
        setHoveredWireHandle(null);
      } else {
        const hHit = hitTestWireHandle(worldPt, circuit, selectedWireIds, 10 / vp.zoom);
        setHoveredWireHandle(hHit);
        if (hHit) {
          setHoveredGateId(null);
          setHoveredWire(null);
        } else {
          const gHit = hitTestGate(worldPt, circuit, project);
          setHoveredGateId(gHit?.id ?? null);
          if (gHit) {
            setHoveredWire(null);
          } else {
            const wHit = hitTestWire(worldPt, circuit, 8 / vp.zoom);
            setHoveredWire(wHit);
          }
        }
      }
    }
  };

  const handleMouseUp = () => {
    const d = dragRef.current;
    if (d.kind === 'gates' && d.clickedGate) {
      if (d.clickedGate.type === 'BUTTON') {
        onButtonPress(d.clickedGate.id, false);
      } else if (!d.moved) {
        onInteractGate(d.clickedGate);
      }
    }
    if (
      (d.kind === 'wire-segment' || d.kind === 'wire-vertex') &&
      d.moved &&
      d.wireId &&
      d.wireLastPoints
    ) {
      // Clean up redundant collinear or zero-length points after manual drag
      onUpdateWirePoints(d.wireId, simplifyPolyline(d.wireLastPoints), false);
    }
    if (d.kind === 'marquee' && marquee) {
      const gHits = gatesInRect(marquee, circuit, project);
      const wHits = wiresInRect(marquee, circuit);
      onSelect(new Set(gHits.map((g) => g.id)), new Set(wHits.map((w) => w.id)));
      setMarquee(null);
    }
    dragRef.current.kind = 'none';
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const screenPt = getLocalScreenPt(e.clientX, e.clientY);
    const worldPt = screenToWorld(screenPt, vp);

    if (wiring && project.settings.routeMode === 'free' && wiring.waypoints.length > 0) {
      // Finish free wire at cursor
      const pts = simplifyPolyline([wiring.startPt, ...wiring.waypoints, worldPt]);
      if (wiring.extendingWire) {
        onExtendFloatingWire(
          wiring.extendingWire.wireId,
          wiring.extendingWire.end,
          worldPt,
          undefined,
          undefined,
          pts,
        );
      } else {
        onAddWire(
          wiring.startPt,
          worldPt,
          wiring.fromPin,
          undefined,
          wiring.startSide,
          undefined,
          pts,
        );
      }
      setWiring(null);
      return;
    }

    const gateHit = hitTestGate(worldPt, circuit, project);
    if (gateHit?.type === 'SUBCIRCUIT' && gateHit.props.subcircuitId) {
      const subDoc = project.circuits[gateHit.props.subcircuitId];
      if (!e.shiftKey && subDoc && !subDoc.isStub) {
        onOpenLiveSubcircuitPopup(gateHit.id);
      } else {
        onOpenSubcircuit(gateHit.props.subcircuitId);
      }
      return;
    }
    const wireHit = hitTestWire(worldPt, circuit, 8 / vp.zoom);
    if (wireHit) {
      onQuickEditWireLabel(wireHit.wire);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (wiring) {
      setWiring(null);
      return;
    }
    const screenPt = getLocalScreenPt(e.clientX, e.clientY);
    const worldPt = screenToWorld(screenPt, vp);
    const gateHit = hitTestGate(worldPt, circuit, project);
    const wireHit = gateHit ? null : hitTestWire(worldPt, circuit, 8 / vp.zoom);

    if (gateHit && !selectedGateIds.has(gateHit.id)) {
      onSelect(new Set([gateHit.id]), new Set());
    } else if (wireHit && !selectedWireIds.has(wireHit.wire.id)) {
      onSelect(new Set(), new Set([wireHit.wire.id]));
    }

    onOpenContextMenu({
      screenX: e.clientX,
      screenY: e.clientY,
      worldPos: worldPt,
      gate: gateHit ?? undefined,
      wire: wireHit?.wire ?? undefined,
    });
  };

  const inputMode: InputMode = project.settings.inputMode ?? 'auto';
  const inputModeRef = useRef<InputMode>(inputMode);
  inputModeRef.current = inputMode;
  const lastTrackpadTsRef = useRef<number>(0);

  // Latest interactive state/handlers for native non-passive touch listeners (avoids stale closures)
  const touchCtxRef = useRef({
    circuit,
    project,
    editLocked,
    selectedGateIds,
    selectedWireIds,
    wiring,
    onSelect,
    onMoveGates,
    onAddWire,
    onExtendFloatingWire,
    onInteractGate,
    onButtonPress,
    onOpenSubcircuit,
    onOpenLiveSubcircuitPopup,
    onOpenContextMenu,
  });
  touchCtxRef.current = {
    circuit,
    project,
    editLocked,
    selectedGateIds,
    selectedWireIds,
    wiring,
    onSelect,
    onMoveGates,
    onAddWire,
    onExtendFloatingWire,
    onInteractGate,
    onButtonPress,
    onOpenSubcircuit,
    onOpenLiveSubcircuitPopup,
    onOpenContextMenu,
  };

  // Native non-passive wheel, gesture (Safari), and touch handlers scoped strictly to the canvas.
  // - 1-finger drag pans the canvas (both on empty space and when swiping immediately over gates)
  // - Long-press (300ms) on a gate enters gate-move mode so parts can be repositioned cleanly on mobile
  // - 2-finger touch pinches to zoom and pans simultaneously
  // - Calling preventDefault() on touchstart also eliminates iOS Safari's full-canvas blue tap flash
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoomAtScreenPt = (clientX: number, clientY: number, factor: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      scheduleVpUpdate((prev) => {
        const newZoom = Math.max(0.25, Math.min(3.5, prev.zoom * factor));
        const wx = (sx - prev.x) / prev.zoom;
        const wy = (sy - prev.y) / prev.zoom;
        return {
          zoom: newZoom,
          x: sx - wx * newZoom,
          y: sy - wy * newZoom,
        };
      });
    };

    const onWheel = (e: WheelEvent) => {
      // Stop browser pinch-zoom and overscroll navigation inside the canvas
      e.preventDefault();

      const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * scale;
      const dy = e.deltaY * scale;
      const mode = inputModeRef.current;

      // 1. Trackpad pinch-to-zoom (Ctrl+Wheel in Chromium/Firefox/Edge) or Meta+Wheel -> Always zoom canvas
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.max(0.75, Math.min(1.35, Math.exp(-dy * 0.01)));
        zoomAtScreenPt(e.clientX, e.clientY, factor);
        return;
      }

      // 2. Explicit Trackpad mode -> 2-finger scroll always pans
      if (mode === 'trackpad') {
        scheduleVpUpdate((prev) => ({ ...prev, x: prev.x - dx, y: prev.y - dy }));
        return;
      }

      // 3. Explicit Mouse mode -> Wheel zooms (Shift+Wheel pans horizontally)
      if (mode === 'mouse') {
        if (e.shiftKey) {
          scheduleVpUpdate((prev) => ({ ...prev, x: prev.x - (dx || dy) }));
          return;
        }
        const factor = dy < 0 ? 1.12 : 1 / 1.12;
        zoomAtScreenPt(e.clientX, e.clientY, factor);
        return;
      }

      // 4. Auto mode: heuristically distinguish trackpad 2-finger pan vs discrete mouse wheel zoom
      const now = performance.now();
      const looksLikeTrackpad =
        Math.abs(e.deltaX) > 0 ||
        (e.deltaMode === 0 && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 42)) ||
        now - lastTrackpadTsRef.current < 350;

      if (looksLikeTrackpad) {
        lastTrackpadTsRef.current = now;
        scheduleVpUpdate((prev) => ({ ...prev, x: prev.x - dx, y: prev.y - dy }));
      } else {
        const factor = dy < 0 ? 1.12 : 1 / 1.12;
        zoomAtScreenPt(e.clientX, e.clientY, factor);
      }
    };

    // Safari / WebKit trackpad pinch gesture events
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
        zoomAtScreenPt(
          ge.clientX ?? rect.left + rect.width / 2,
          ge.clientY ?? rect.top + rect.height / 2,
          factor,
        );
      }
    };

    // Unified 1-finger (pan / tap / long-press gate drag & context menu) & 2-finger (pinch + pan) touch controller
    let pinchState: { dist: number; cx: number; cy: number } | null = null;
    let singleTouch: {
      mode: 'pending' | 'pan' | 'drag-gate' | 'context-hold';
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
      startWorld: Point;
      pinHit: PinHit | null;
      floatHit: FloatingWireEndHit | null;
      gateHit: GateInstance | null;
      wireHit: WireHit | null;
      buttonDownId?: string;
      gateStartPos: Map<string, Point>;
      movedGate: boolean;
      lastGateMoveSig: string;
      holdTimer: number | null;
    } | null = null;
    let lastTapInfo: { ts: number; gateId: string } | null = null;

    const clearSingleHoldTimer = () => {
      if (singleTouch?.holdTimer != null) {
        window.clearTimeout(singleTouch.holdTimer);
        singleTouch.holdTimer = null;
      }
    };

    const cancelSingleTouch = () => {
      clearSingleHoldTimer();
      if (singleTouch?.buttonDownId) {
        touchCtxRef.current.onButtonPress(singleTouch.buttonDownId, false);
      }
      if (singleTouch?.mode === 'drag-gate' || singleTouch?.mode === 'context-hold') {
        setTouchHoldMode(null);
      }
      singleTouch = null;
    };

    const clientToWorld = (clientX: number, clientY: number): Point => {
      const rect = canvas.getBoundingClientRect();
      return screenToWorld({ x: clientX - rect.left, y: clientY - rect.top }, vpStateRef.current);
    };

    const onTouchStart = (e: TouchEvent) => {
      // Prevent iOS Safari full-canvas blue tap flash, text/image callout, and page pull-to-refresh
      e.preventDefault();

      if (e.touches.length === 2) {
        cancelSingleTouch();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        pinchState = {
          dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
          cx: (t1.clientX + t2.clientX) / 2,
          cy: (t1.clientY + t2.clientY) / 2,
        };
        return;
      }

      if (e.touches.length === 1) {
        pinchState = null;
        const t = e.touches[0];
        const ctx = touchCtxRef.current;
        const curZoom = vpStateRef.current.zoom;
        const worldPt = clientToWorld(t.clientX, t.clientY);

        const pinHit = !ctx.editLocked
          ? hitTestPin(worldPt, ctx.circuit, ctx.project, 18 / curZoom)
          : null;
        const floatHit =
          !ctx.editLocked && !pinHit
            ? hitTestFloatingWireEnd(
                worldPt,
                ctx.circuit,
                ctx.project,
                18 / curZoom,
                ctx.wiring?.extendingWire?.wireId,
              )
            : null;
        const gateHit =
          !pinHit && !floatHit ? hitTestGate(worldPt, ctx.circuit, ctx.project) : null;
        const wireHit =
          !pinHit && !floatHit && !gateHit ? hitTestWire(worldPt, ctx.circuit, 14 / curZoom) : null;

        let buttonDownId: string | undefined;
        if (gateHit && gateHit.type === 'BUTTON') {
          buttonDownId = gateHit.id;
          ctx.onButtonPress(gateHit.id, true);
        }

        const st = {
          mode: 'pending' as 'pending' | 'pan' | 'drag-gate' | 'context-hold',
          startClientX: t.clientX,
          startClientY: t.clientY,
          lastClientX: t.clientX,
          lastClientY: t.clientY,
          startWorld: worldPt,
          pinHit,
          floatHit,
          gateHit,
          wireHit,
          buttonDownId,
          gateStartPos: new Map<string, Point>(),
          movedGate: false,
          lastGateMoveSig: '',
          holdTimer: null as number | null,
        };
        singleTouch = st;

        // Long-press (300ms):
        // - On a gate (edit mode): drag to move, OR release without moving to open context menu!
        // - On a gate (run mode), wire, or empty canvas: release without moving to open context menu!
        if (!ctx.wiring && !pinHit && !floatHit) {
          st.holdTimer = window.setTimeout(() => {
            if (singleTouch !== st || st.mode !== 'pending') return;
            st.holdTimer = null;
            if (st.buttonDownId) {
              touchCtxRef.current.onButtonPress(st.buttonDownId, false);
              st.buttonDownId = undefined;
            }
            const cur = touchCtxRef.current;
            if (gateHit && !cur.editLocked) {
              st.mode = 'drag-gate';
              const nextSel = cur.selectedGateIds.has(gateHit.id)
                ? new Set(cur.selectedGateIds)
                : new Set([gateHit.id]);
              cur.onSelect(nextSel, new Set());
              st.gateStartPos = new Map();
              for (const g of cur.circuit.gates) {
                if (nextSel.has(g.id)) st.gateStartPos.set(g.id, { x: g.x, y: g.y });
              }
              setTouchHoldMode('gate-hold');
            } else {
              st.mode = 'context-hold';
              if (gateHit && !cur.selectedGateIds.has(gateHit.id)) {
                cur.onSelect(new Set([gateHit.id]), new Set());
              } else if (wireHit && !cur.selectedWireIds.has(wireHit.wire.id)) {
                cur.onSelect(new Set(), new Set([wireHit.wire.id]));
              }
              setTouchHoldMode('context-hold');
            }
            try {
              navigator.vibrate?.(18);
            } catch {
              // ignore unsupported vibration
            }
          }, 300);
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchState) {
        e.preventDefault();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const cx = (t1.clientX + t2.clientX) / 2;
        const cy = (t1.clientY + t2.clientY) / 2;
        const panDx = cx - pinchState.cx;
        const panDy = cy - pinchState.cy;
        const factor = pinchState.dist > 1 ? dist / pinchState.dist : 1;
        const rect = canvas.getBoundingClientRect();
        const sx = cx - rect.left;
        const sy = cy - rect.top;
        scheduleVpUpdate((prev) => {
          const movedX = prev.x + panDx;
          const movedY = prev.y + panDy;
          const newZoom = Math.max(0.25, Math.min(3.5, prev.zoom * factor));
          const wx = (sx - movedX) / prev.zoom;
          const wy = (sy - movedY) / prev.zoom;
          return { zoom: newZoom, x: sx - wx * newZoom, y: sy - wy * newZoom };
        });
        pinchState = { dist, cx, cy };
        return;
      }

      if (e.touches.length === 1 && singleTouch) {
        e.preventDefault();
        const t = e.touches[0];
        const dxTotal = t.clientX - singleTouch.startClientX;
        const dyTotal = t.clientY - singleTouch.startClientY;

        if (singleTouch.mode === 'pending' || singleTouch.mode === 'context-hold') {
          if (Math.hypot(dxTotal, dyTotal) > 8) {
            clearSingleHoldTimer();
            if (singleTouch.mode === 'context-hold') {
              setTouchHoldMode(null);
            }
            if (singleTouch.buttonDownId) {
              touchCtxRef.current.onButtonPress(singleTouch.buttonDownId, false);
              singleTouch.buttonDownId = undefined;
            }
            singleTouch.mode = 'pan';
          }
        }

        if (singleTouch.mode === 'pan') {
          const stepDx = t.clientX - singleTouch.lastClientX;
          const stepDy = t.clientY - singleTouch.lastClientY;
          if (stepDx !== 0 || stepDy !== 0) {
            scheduleVpUpdate((prev) => ({
              ...prev,
              x: prev.x + stepDx,
              y: prev.y + stepDy,
            }));
          }
        } else if (singleTouch.mode === 'drag-gate') {
          const cur = touchCtxRef.current;
          const worldPt = clientToWorld(t.clientX, t.clientY);
          const dx = worldPt.x - singleTouch.startWorld.x;
          const dy = worldPt.y - singleTouch.startWorld.y;
          const gs = cur.project.settings.gridSize;
          const snap = cur.project.settings.routeMode === 'grid';
          const positions = new Map<string, Point>();
          let sig = '';
          for (const [gid, orig] of singleTouch.gateStartPos.entries()) {
            const nx = snap ? snapToGrid(orig.x + dx, gs) : Math.round(orig.x + dx);
            const ny = snap ? snapToGrid(orig.y + dy, gs) : Math.round(orig.y + dy);
            positions.set(gid, { x: nx, y: ny });
            sig += `${gid}:${nx},${ny};`;
          }
          if (sig !== singleTouch.lastGateMoveSig && positions.size > 0) {
            singleTouch.lastGateMoveSig = sig;
            cur.onMoveGates(positions, !singleTouch.movedGate);
            singleTouch.movedGate = true;
          }
        }

        singleTouch.lastClientX = t.clientX;
        singleTouch.lastClientY = t.clientY;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (pinchState && e.touches.length === 1) {
        // Transition smoothly from 2-finger pinch to 1-finger pan without jumping
        pinchState = null;
        const rem = e.touches[0];
        singleTouch = {
          mode: 'pan',
          startClientX: rem.clientX,
          startClientY: rem.clientY,
          lastClientX: rem.clientX,
          lastClientY: rem.clientY,
          startWorld: clientToWorld(rem.clientX, rem.clientY),
          pinHit: null,
          floatHit: null,
          gateHit: null,
          wireHit: null,
          gateStartPos: new Map(),
          movedGate: false,
          lastGateMoveSig: '',
          holdTimer: null,
        };
        return;
      }

      if (e.touches.length < 2) pinchState = null;
      if (e.touches.length > 0) return;

      const st = singleTouch;
      if (!st) return;
      clearSingleHoldTimer();
      singleTouch = null;

      const cur = touchCtxRef.current;
      if (st.buttonDownId) {
        cur.onButtonPress(st.buttonDownId, false);
      }

      if (st.mode === 'drag-gate') {
        setTouchHoldMode(null);
        // Released after >= 300ms long-press WITHOUT moving the gate -> open context menu!
        if (!st.movedGate && st.gateHit) {
          cur.onOpenContextMenu({
            screenX: st.startClientX,
            screenY: st.startClientY,
            worldPos: st.startWorld,
            gate: st.gateHit,
          });
        }
        return;
      }

      if (st.mode === 'context-hold') {
        setTouchHoldMode(null);
        cur.onOpenContextMenu({
          screenX: st.startClientX,
          screenY: st.startClientY,
          worldPos: st.startWorld,
          gate: st.gateHit ?? undefined,
          wire: st.gateHit ? undefined : st.wireHit?.wire,
        });
        return;
      }

      if (st.mode !== 'pending') return;

      // --- Quick single-finger TAP handling ---
      if (st.pinHit && !cur.editLocked) {
        const pinHit = st.pinHit;
        if (!cur.wiring) {
          setWiring({
            startPt: pinHit.pos,
            fromPin: { gateId: pinHit.gate.id, pinId: pinHit.pin.id },
            startSide: getPinWorldSide(pinHit.pin.side, pinHit.gate.rotation),
            waypoints: [],
          });
        } else if (cur.wiring.extendingWire) {
          const endSide = getPinWorldSide(pinHit.pin.side, pinHit.gate.rotation);
          const customPts =
            cur.project.settings.routeMode === 'free'
              ? simplifyPolyline([cur.wiring.startPt, ...cur.wiring.waypoints, pinHit.pos])
              : undefined;
          cur.onExtendFloatingWire(
            cur.wiring.extendingWire.wireId,
            cur.wiring.extendingWire.end,
            pinHit.pos,
            { gateId: pinHit.gate.id, pinId: pinHit.pin.id },
            endSide,
            customPts,
          );
          setWiring(null);
        } else {
          const samePin =
            cur.wiring.fromPin &&
            cur.wiring.fromPin.gateId === pinHit.gate.id &&
            cur.wiring.fromPin.pinId === pinHit.pin.id;
          if (!samePin) {
            const endSide = getPinWorldSide(pinHit.pin.side, pinHit.gate.rotation);
            const customPts =
              cur.project.settings.routeMode === 'free'
                ? simplifyPolyline([cur.wiring.startPt, ...cur.wiring.waypoints, pinHit.pos])
                : undefined;
            cur.onAddWire(
              cur.wiring.startPt,
              pinHit.pos,
              cur.wiring.fromPin,
              { gateId: pinHit.gate.id, pinId: pinHit.pin.id },
              cur.wiring.startSide,
              endSide,
              customPts,
            );
          }
          setWiring(null);
        }
        return;
      }

      if (st.floatHit && !cur.editLocked) {
        const floatHit = st.floatHit;
        if (!cur.wiring) {
          setWiring({
            startPt: floatHit.pos,
            startSide: inferWireEndOutwardSide(floatHit.wire.points, floatHit.end),
            extendingWire: { wireId: floatHit.wire.id, end: floatHit.end },
            waypoints: [],
          });
        } else if (cur.wiring.extendingWire) {
          const endSide = inferWireEndOutwardSide(floatHit.wire.points, floatHit.end);
          cur.onExtendFloatingWire(
            cur.wiring.extendingWire.wireId,
            cur.wiring.extendingWire.end,
            floatHit.pos,
            undefined,
            endSide,
            undefined,
            { wireId: floatHit.wire.id, end: floatHit.end },
          );
          setWiring(null);
        } else {
          cur.onExtendFloatingWire(
            floatHit.wire.id,
            floatHit.end,
            cur.wiring.startPt,
            cur.wiring.fromPin,
            cur.wiring.startSide,
          );
          setWiring(null);
        }
        return;
      }

      if (cur.wiring) {
        if (st.wireHit && st.wireHit.wire.id !== cur.wiring.extendingWire?.wireId) {
          const a = st.wireHit.wire.points[st.wireHit.segIndex];
          const b = st.wireHit.wire.points[st.wireHit.segIndex + 1];
          const proj = projectPointToSegment(st.startWorld, a, b);
          const snapPt =
            cur.project.settings.routeMode === 'grid'
              ? {
                  x: snapToGrid(proj.x, cur.project.settings.gridSize),
                  y: snapToGrid(proj.y, cur.project.settings.gridSize),
                }
              : proj;
          if (cur.wiring.extendingWire) {
            cur.onExtendFloatingWire(
              cur.wiring.extendingWire.wireId,
              cur.wiring.extendingWire.end,
              snapPt,
            );
          } else {
            cur.onAddWire(
              cur.wiring.startPt,
              snapPt,
              cur.wiring.fromPin,
              undefined,
              cur.wiring.startSide,
            );
          }
          setWiring(null);
          return;
        }
        if (cur.project.settings.routeMode === 'free') {
          setWiring((prev) =>
            prev ? { ...prev, waypoints: [...prev.waypoints, st.startWorld] } : null,
          );
        } else {
          setWiring(null);
        }
        return;
      }

      if (st.gateHit) {
        const g = st.gateHit;
        const now = performance.now();
        if (
          g.type === 'SUBCIRCUIT' &&
          g.props.subcircuitId &&
          lastTapInfo &&
          lastTapInfo.gateId === g.id &&
          now - lastTapInfo.ts < 340
        ) {
          lastTapInfo = null;
          const subDoc = cur.project.circuits[g.props.subcircuitId];
          if (subDoc && !subDoc.isStub) {
            cur.onOpenLiveSubcircuitPopup(g.id);
          } else {
            cur.onOpenSubcircuit(g.props.subcircuitId);
          }
          return;
        }
        lastTapInfo = { ts: now, gateId: g.id };
        cur.onSelect(new Set([g.id]), new Set());
        if (g.type !== 'BUTTON') {
          cur.onInteractGate(g);
        }
        return;
      }

      if (st.wireHit) {
        cur.onSelect(new Set(), new Set([st.wireHit.wire.id]));
        return;
      }

      cur.onSelect(new Set(), new Set());
    };

    const onTouchCancel = () => {
      pinchState = null;
      cancelSingleTouch();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', onGestureStart, { passive: false });
    canvas.addEventListener('gesturechange', onGestureChange, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.addEventListener('touchcancel', onTouchCancel);

    return () => {
      cancelSingleTouch();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', onGestureStart);
      canvas.removeEventListener('gesturechange', onGestureChange);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [scheduleVpUpdate]);

  const handleDragOver = (e: React.DragEvent) => {
    if (editLocked) return;
    if (draggingGate || e.dataTransfer.types.includes('application/logicflow-gate')) {
      e.preventDefault();
      const screenPt = getLocalScreenPt(e.clientX, e.clientY);
      const worldPt = screenToWorld(screenPt, vp);
      const hit = hitTestGate(worldPt, circuit, project);
      const canReplace =
        hit !== null &&
        (!draggingGate ||
          hit.type !== draggingGate.type ||
          hit.props.subcircuitId !== draggingGate.subcircuitId);
      e.dataTransfer.dropEffect = canReplace ? 'move' : 'copy';
      setReplaceTargetGateId(canReplace ? hit!.id : null);
      setDragGhostWorld(worldPt);
      onDragOverCanvasChange(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    const container = containerRef.current;
    if (container && !container.contains(e.relatedTarget as Node | null)) {
      setDragGhostWorld(null);
      setReplaceTargetGateId(null);
      onDragOverCanvasChange(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragGhostWorld(null);
    setReplaceTargetGateId(null);
    onDragOverCanvasChange(false);
    onDropComplete();
    if (editLocked) return;
    const raw = e.dataTransfer.getData('application/logicflow-gate');
    let payload: { type: GateType; subcircuitId?: string } | null = null;
    if (raw) {
      try {
        payload = JSON.parse(raw) as { type: GateType; subcircuitId?: string };
      } catch {
        payload = null;
      }
    } else if (draggingGate) {
      payload = { type: draggingGate.type, subcircuitId: draggingGate.subcircuitId };
    }
    if (!payload) return;
    const screenPt = getLocalScreenPt(e.clientX, e.clientY);
    const worldPt = screenToWorld(screenPt, vp);
    const hit = hitTestGate(worldPt, circuit, project);
    if (hit && (hit.type !== payload.type || hit.props.subcircuitId !== payload.subcircuitId)) {
      onReplaceGate(hit.id, payload.type, payload.subcircuitId);
    } else {
      onAddGateAt(payload.type, worldPt.x, worldPt.y, payload.subcircuitId);
    }
  };

  const cursorClass = spacePanning
    ? 'cursor-grab'
    : wiring || hoveredPin || hoveredFloatingEnd
      ? 'cursor-crosshair'
      : hoveredWireHandle?.kind === 'vertex'
        ? 'cursor-move'
        : (hoveredWireHandle?.orientation ?? hoveredWire?.orientation) === 'h'
          ? 'cursor-ns'
          : (hoveredWireHandle?.orientation ?? hoveredWire?.orientation) === 'v'
            ? 'cursor-ew'
            : hoveredWireHandle || hoveredWire
              ? 'cursor-move'
              : hoveredGateId
                ? 'cursor-pointer'
                : 'cursor-default';

  return (
    <div
      ref={containerRef}
      className={`canvas-container ${cursorClass}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <canvas
        ref={canvasRef}
        className="circuit-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />

      {/* Touch Long-Press Banner */}
      {touchHoldMode && (
        <div className="wiring-banner">
          {touchHoldMode === 'gate-hold'
            ? '長押し中 — ドラッグで移動 / そのまま離すとメニュー'
            : '指を離すとメニューを表示します'}
        </div>
      )}

      {/* Wiring Mode Banner */}
      {wiring && (
        <div className="wiring-banner">
          {wiring.extendingWire ? 'フローティング配線を延長中' : '配線中'}:
          接続先の端子・フローティング終端またはワイヤーを左クリック (Esc / 右クリックでキャンセル
          {project.settings.routeMode === 'free' ? '・空き領域クリックで経由点追加' : ''})
        </div>
      )}

      {/* Paused Edit-Mode Banner */}
      {!simActive && (
        <div className="paused-banner">
          編集モード（シミュレーション停止中）—
          上部の「実行開始」または「リアルタイム」で信号計算を再開
        </div>
      )}

      {/* Compiled Run-Mode Banner */}
      {editLocked && (
        <div className="run-banner">
          実行モード（回路編集ロック中・事前コンパイル高速実行）—
          スイッチ/ボタン/クロック操作と信号観測のみ有効
        </div>
      )}

      {/* Floating Bottom Status & Zoom Controls */}
      <div className="canvas-statusbar">
        <div className="statusbar-left">
          <span className="status-chip status-chip-coords">
            X: {Math.round(cursorWorld.x)}, Y: {Math.round(cursorWorld.y)}
          </span>
          <span className="status-chip status-chip-route">
            {project.settings.routeMode === 'grid' ? 'グリッドフィット配線' : '自由配線'}
          </span>
          <span className={`status-chip ${simActive ? 'chip-live' : 'chip-paused'}`}>
            {editLocked
              ? `RUN · ${snapshot?.iterations ?? 0} Δ`
              : simActive
                ? `LIVE · ${snapshot?.iterations ?? 0} Δ`
                : 'EDIT'}
          </span>
        </div>

        {/* Input Mode Switcher (Auto / Trackpad / Mouse) */}
        <div
          className="input-mode-toggle"
          title="操作デバイス切替（自動: 二本指パン＆ホイールズーム自動判別 / トラックパッド: 二本指移動・ピンチズーム / マウス: ホイールズーム）"
        >
          <button
            className={`mode-seg ${inputMode === 'auto' ? 'active' : ''}`}
            onClick={() => onChangeInputMode('auto')}
          >
            <Sparkles size={12} />
            <span>自動</span>
          </button>
          <button
            className={`mode-seg ${inputMode === 'trackpad' ? 'active' : ''}`}
            onClick={() => onChangeInputMode('trackpad')}
          >
            <Touchpad size={12} />
            <span>トラックパッド</span>
          </button>
          <button
            className={`mode-seg ${inputMode === 'mouse' ? 'active' : ''}`}
            onClick={() => onChangeInputMode('mouse')}
          >
            <Mouse size={12} />
            <span>マウス</span>
          </button>
        </div>

        <div className="zoom-controls">
          <button
            className="icon-btn"
            onClick={() => setVp((v) => ({ ...v, zoom: Math.max(0.25, v.zoom / 1.2) }))}
            title="縮小"
          >
            <ZoomOut size={14} />
          </button>
          <span className="zoom-pct">{Math.round(vp.zoom * 100)}%</span>
          <button
            className="icon-btn"
            onClick={() => setVp((v) => ({ ...v, zoom: Math.min(3.5, v.zoom * 1.2) }))}
            title="拡大"
          >
            <ZoomIn size={14} />
          </button>
          <button className="icon-btn" onClick={zoomToFit} title="全体表示 (F)">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
