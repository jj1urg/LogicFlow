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

  // Auto fit when circuit tab changes or fitTrigger increments
  const lastCircuitIdRef = useRef<string>('');
  useEffect(() => {
    if (lastCircuitIdRef.current !== circuit.id) {
      lastCircuitIdRef.current = circuit.id;
      zoomToFit();
    }
  }, [circuit.id, zoomToFit]);

  useEffect(() => {
    if (fitTrigger > 0) zoomToFit();
  }, [fitTrigger, zoomToFit]);

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

  // Resize observer so canvas fills window & dock panels smoothly and redraws immediately
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bump = () => setResizeTick((t) => t + 1);
    const obs = new ResizeObserver(bump);
    obs.observe(el);
    window.addEventListener('resize', bump);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', bump);
    };
  }, []);

  // Main Canvas Render Effect
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    renderCanvas(ctx, w, h, circuit, project, snapshot, {
      viewport: vp,
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
  }, [
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
    resizeTick,
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
      onOpenSubcircuit(gateHit.props.subcircuitId);
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

  // Native non-passive wheel, gesture (Safari), and 2-finger touch handlers scoped strictly to the canvas.
  // Preventing default here blocks browser page zoom ONLY when pinching/scrolling inside the circuit canvas!
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

    // Two-finger touch pinch & pan support on touchscreens
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
        scheduleVpUpdate((prev) => {
          const movedX = prev.x + panDx;
          const movedY = prev.y + panDy;
          const newZoom = Math.max(0.25, Math.min(3.5, prev.zoom * factor));
          const wx = (sx - movedX) / prev.zoom;
          const wy = (sy - movedY) / prev.zoom;
          return { zoom: newZoom, x: sx - wx * newZoom, y: sy - wy * newZoom };
        });
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
        <span className="status-chip">
          X: {Math.round(cursorWorld.x)}, Y: {Math.round(cursorWorld.y)}
        </span>
        <span className="status-chip">
          {project.settings.routeMode === 'grid' ? 'グリッドフィット配線' : '自由配線'}
        </span>
        <span className={`status-chip ${simActive ? 'chip-live' : 'chip-paused'}`}>
          {editLocked
            ? `RUN (COMPILED) · ${snapshot?.iterations ?? 0} Δ`
            : simActive
              ? `LIVE · ${snapshot?.iterations ?? 0} Δ`
              : 'EDIT MODE'}
        </span>

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
