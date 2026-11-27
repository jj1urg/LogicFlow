import {
  getGateBounds,
  getGatePins,
  getGateSize,
  getPinWorldPos,
  GRID_SIZE,
} from '../core/catalog';
import {
  BIT_0,
  BIT_1,
  BIT_X,
  BIT_Z,
  Bit,
  dominantState,
  formatValue,
  fromLiteral,
  LogicValue,
  SIGNAL_COLORS,
  SIGNAL_GLOW,
  SIGNAL_LABELS,
  toUnsignedInt,
  X_CAUSE_COLORS,
  X_CAUSE_GLOW,
  X_CAUSE_LABELS,
  XCause,
} from '../core/logic4';
import { findOrthogonalCrossings, findWireJunctions } from '../core/routing';
import { RuntimeInputOverride } from '../core/simulator';
import {
  CircuitDocument,
  GateInstance,
  Point,
  ProjectDocument,
  SimulationSnapshot,
  SubcircuitDisplayMode,
  Wire,
} from '../core/types';
import {
  FloatingWireEndHit,
  getFloatingWireEndpoints,
  PinHit,
  Viewport,
  WireHandleHit,
  WireHit,
} from './hitTest';

export interface RenderContextState {
  viewport: Viewport;
  selectedGateIds: Set<string>;
  selectedWireIds: Set<string>;
  hoveredPin: PinHit | null;
  hoveredFloatingEnd?: FloatingWireEndHit | null;
  hoveredGateId: string | null;
  hoveredWire: WireHit | null;
  hoveredWireHandle: WireHandleHit | null;
  wiringPreview: Point[] | null;
  marquee: { x1: number; y1: number; x2: number; y2: number } | null;
  simActive: boolean;
  runtimeInputs?: Record<string, RuntimeInputOverride>;
  ghostGate?: GateInstance | null;
}

const NEUTRAL_WIRE = '#7c8ca3';

// Geometry & topology caches keyed by immutable array references (0ms overhead during zoom/pan!)
const crossingsCache = new WeakMap<Wire[], Map<string, number[]>>();
const junctionsCache = new WeakMap<Wire[], ReturnType<typeof findWireJunctions>>();
const subBoundsCache = new WeakMap<
  GateInstance[],
  { minX: number; minY: number; maxX: number; maxY: number }
>();

function getCachedCrossings(wires: Wire[]): Map<string, number[]> {
  let cached = crossingsCache.get(wires);
  if (!cached) {
    cached = new Map<string, number[]>();
    const list = findOrthogonalCrossings(wires);
    for (const c of list) {
      const key = `${c.wireId}:${c.segIndex}`;
      const arr = cached.get(key);
      if (arr) arr.push(c.x);
      else cached.set(key, [c.x]);
    }
    crossingsCache.set(wires, cached);
  }
  return cached;
}

function getCachedJunctions(wires: Wire[]): ReturnType<typeof findWireJunctions> {
  let cached = junctionsCache.get(wires);
  if (!cached) {
    cached = findWireJunctions(wires);
    junctionsCache.set(wires, cached);
  }
  return cached;
}

// Reusable 1-tile dot CanvasPattern cache so drawGrid is a SINGLE GPU fillRect instead of 50,000+ calls!
let cachedDotTileStep = -1;
let cachedDotTileCanvas: HTMLCanvasElement | null = null;
function getDotTileCanvas(stepPx: number, dotSize: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const rounded = Math.max(8, Math.round(stepPx));
  if (cachedDotTileCanvas && cachedDotTileStep === rounded) return cachedDotTileCanvas;
  const tile = document.createElement('canvas');
  tile.width = rounded;
  tile.height = rounded;
  const tctx = tile.getContext('2d');
  if (!tctx) return null;
  tctx.fillStyle = 'rgba(148, 163, 184, 0.22)';
  tctx.fillRect(0, 0, dotSize, dotSize);
  cachedDotTileStep = rounded;
  cachedDotTileCanvas = tile;
  return tile;
}

// 7-segment bitmask for 0..F (bits: 0=a, 1=b, 2=c, 3=d, 4=e, 5=f, 6=g)
const HEX_TO_7SEG = [
  0x3f, // 0
  0x06, // 1
  0x5b, // 2
  0x4f, // 3
  0x66, // 4
  0x6d, // 5
  0x7d, // 6
  0x07, // 7
  0x7f, // 8
  0x6f, // 9
  0x77, // A
  0x7c, // b
  0x39, // C
  0x5e, // d
  0x79, // E
  0x71, // F
];

function signalColor(
  val: LogicValue | undefined,
  simActive: boolean,
  xCause?: XCause,
): { color: string; glow: string; bit: Bit } {
  if (!simActive) {
    return { color: NEUTRAL_WIRE, glow: 'rgba(0,0,0,0)', bit: BIT_0 };
  }
  const bit = dominantState(val);
  if (bit === BIT_X && xCause) {
    return { color: X_CAUSE_COLORS[xCause], glow: X_CAUSE_GLOW[xCause], bit };
  }
  return { color: SIGNAL_COLORS[bit], glow: SIGNAL_GLOW[bit], bit };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function renderCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  circuit: CircuitDocument,
  project: ProjectDocument,
  snapshot: SimulationSnapshot | null,
  state: RenderContextState,
): void {
  const { viewport } = state;

  // Background
  ctx.save();
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, width, height);

  // Draw crisp subtle grid
  drawGrid(ctx, width, height, viewport, project.settings.gridSize || GRID_SIZE);

  // Transform to world space
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.zoom, viewport.zoom);

  const pad = 120 / Math.max(0.25, viewport.zoom);
  const viewBounds = {
    minX: -viewport.x / viewport.zoom - pad,
    minY: -viewport.y / viewport.zoom - pad,
    maxX: (width - viewport.x) / viewport.zoom + pad,
    maxY: (height - viewport.y) / viewport.zoom + pad,
  };

  // Draw circuit contents
  drawCircuitContents(ctx, circuit, project, snapshot, state, 0, viewBounds);

  // Draw drag-and-drop ghost symbol preview snapped at exact target coordinates
  if (state.ghostGate) {
    const b = getGateBounds(state.ghostGate, project);
    ctx.save();
    // Subtle drop alignment crosshairs
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
    ctx.lineWidth = 1 / viewport.zoom;
    ctx.setLineDash([4 / viewport.zoom, 4 / viewport.zoom]);
    ctx.beginPath();
    ctx.moveTo(b.x - 18, state.ghostGate.y);
    ctx.lineTo(b.x + b.width + 18, state.ghostGate.y);
    ctx.moveTo(state.ghostGate.x, b.y - 18);
    ctx.lineTo(state.ghostGate.x, b.y + b.height + 18);
    ctx.stroke();
    ctx.setLineDash([]);

    // Render the actual gate / module symbol at slight translucency
    ctx.globalAlpha = 0.86;
    drawGate(
      ctx,
      state.ghostGate,
      project,
      null,
      {
        ...state,
        selectedGateIds: new Set([state.ghostGate.id]),
        hoveredGateId: null,
        hoveredPin: null,
        simActive: false,
      },
      0,
    );
    ctx.restore();
  }

  // Draw live wire routing preview (with rounded corners!)
  if (state.wiringPreview && state.wiringPreview.length >= 2) {
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.6;
    ctx.setLineDash([6, 4]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    traceRoundedWirePath(ctx, state.wiringPreview, undefined, undefined, 9);
    ctx.stroke();
    ctx.restore();
  }

  // Draw selection marquee
  if (state.marquee) {
    const mx = Math.min(state.marquee.x1, state.marquee.x2);
    const my = Math.min(state.marquee.y1, state.marquee.y2);
    const mw = Math.abs(state.marquee.x2 - state.marquee.x1);
    const mh = Math.abs(state.marquee.y2 - state.marquee.y1);
    ctx.save();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.2 / viewport.zoom;
    ctx.setLineDash([5 / viewport.zoom, 3 / viewport.zoom]);
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeRect(mx, my, mw, mh);
    ctx.restore();
  }

  // Draw hovered pin tooltip in world space
  if (state.hoveredPin) {
    drawPinTooltip(ctx, state.hoveredPin, snapshot, state.simActive, viewport.zoom);
  }

  ctx.restore();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  vp: Viewport,
  gridSize: number,
) {
  const step = gridSize * vp.zoom;
  if (step < 5) return;

  const startX = ((vp.x % step) + step) % step;
  const startY = ((vp.y % step) + step) % step;

  // Major lines every 5 cells (single batched path stroke)
  const majorStep = step * 5;
  const mStartX = ((vp.x % majorStep) + majorStep) % majorStep;
  const mStartY = ((vp.y % majorStep) + majorStep) % majorStep;

  ctx.save();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.065)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = mStartX; x < width; x += majorStep) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = mStartY; y < height; y += majorStep) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Subtle grid dots rendered in ONE single GPU pattern fillRect (avoids 50,000+ fillRect calls!)
  if (step >= 10) {
    const r = vp.zoom > 1.2 ? 1.5 : 1;
    const tile = getDotTileCanvas(step, r);
    const pat = tile ? ctx.createPattern(tile, 'repeat') : null;
    if (pat) {
      ctx.translate(startX - r / 2, startY - r / 2);
      ctx.fillStyle = pat;
      ctx.fillRect(-step, -step, width + step * 2, height + step * 2);
    }
  }
  ctx.restore();
}

function drawCircuitContents(
  ctx: CanvasRenderingContext2D,
  circuit: CircuitDocument,
  project: ProjectDocument,
  snapshot: SimulationSnapshot | null,
  state: RenderContextState,
  depth: number,
  viewBounds?: { minX: number; minY: number; maxX: number; maxY: number },
) {
  const isNested = depth > 0;
  const showSignals = state.simActive && snapshot !== null;

  // 1. Draw Wires with cached orthogonal bridge hops (0ms recompute on zoom/pan!)
  const crossingByWireSeg = isNested ? undefined : getCachedCrossings(circuit.wires);

  for (const wire of circuit.wires) {
    drawWire(
      ctx,
      wire,
      snapshot,
      showSignals,
      state,
      crossingByWireSeg,
      isNested,
      project.settings.showNetLabels,
    );
  }

  // 2. Draw Wire T-Junction solder dots (top-level only & cached!)
  if (!isNested) {
    const junctions = getCachedJunctions(circuit.wires);
    for (const j of junctions) {
      const wVal = snapshot?.wireValues[j.wireId];
      const wCause = snapshot?.wireXCauses?.[j.wireId];
      const { color } = signalColor(wVal, showSignals, wCause);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(j.x, j.y, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2.5. Draw Floating Wire Endpoints as extendable hollow terminal rings
    const floatingEnds = getFloatingWireEndpoints(circuit, project);
    for (const fe of floatingEnds) {
      const isHovered =
        state.hoveredFloatingEnd?.wire.id === fe.wire.id &&
        state.hoveredFloatingEnd?.end === fe.end;
      const wVal = snapshot?.wireValues[fe.wire.id];
      const wCause = snapshot?.wireXCauses?.[fe.wire.id];
      const { color } = signalColor(wVal, showSignals, wCause);
      const r = isHovered ? 6 : 4.5;

      if (isHovered) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
        ctx.beginPath();
        ctx.arc(fe.pos.x, fe.pos.y, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#0b1120';
      ctx.strokeStyle = isHovered ? '#38bdf8' : showSignals ? color : '#fbbf24';
      ctx.lineWidth = isHovered ? 2.4 : 1.8;
      ctx.beginPath();
      ctx.arc(fe.pos.x, fe.pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 3. Draw Gates (with viewport frustum culling at top level!)
  for (const gate of circuit.gates) {
    if (viewBounds) {
      const b = getGateBounds(gate, project);
      if (
        b.x + b.width < viewBounds.minX ||
        b.x > viewBounds.maxX ||
        b.y + b.height < viewBounds.minY ||
        b.y > viewBounds.maxY
      ) {
        continue;
      }
    }
    drawGate(ctx, gate, project, snapshot, state, depth);
  }
}

/**
 * Trace a polyline with smooth rounded corners (fillets) and optional orthogonal bridge hops.
 * Rounded corners dramatically improve visual separation when parallel or nearby wires bend.
 */
function traceRoundedWirePath(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  crossingByWireSeg?: Map<string, number[]>,
  wireId?: string,
  maxCornerRadius = 9,
) {
  if (points.length < 2) return;
  const n = points.length;

  // Precompute safe corner pull-back radius for every interior vertex (1 .. n-2)
  const radii = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const len1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const len2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (len1 < 1 || len2 < 1) continue;
    // Skip collinear points
    const cross = Math.abs(
      (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x),
    );
    if (cross / (len1 * len2) < 0.02) continue;
    radii[i] = Math.min(maxCornerRadius, len1 * 0.45, len2 * 0.45);
  }

  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;

    const ux = dx / len;
    const uy = dy / len;
    const startTrim = i > 0 ? radii[i] : 0;
    const endTrim = i < n - 2 ? radii[i + 1] : 0;

    const sx = a.x + ux * startTrim;
    const ex = b.x - ux * endTrim;
    const ey = b.y - uy * endTrim;

    // Draw straight segment body, inserting bridge hops if any non-connected orthogonal crossings fall inside
    const hops = crossingByWireSeg && wireId ? crossingByWireSeg.get(`${wireId}:${i}`) : undefined;

    if (hops && hops.length > 0 && Math.abs(a.y - b.y) < 0.5) {
      const dir = b.x >= a.x ? 1 : -1;
      const hopR = 5.5;
      const minX = Math.min(sx, ex);
      const maxX = Math.max(sx, ex);
      const sortedHops = hops
        .filter((hx) => hx - hopR > minX + 1 && hx + hopR < maxX - 1)
        .sort((u, v) => (dir > 0 ? u - v : v - u));

      // Guard against duplicate/overlapping hop coordinates so path NEVER backtracks straight across an arc!
      let lastDrawnEnd = sx;
      for (const hx of sortedHops) {
        const hopStart = hx - dir * hopR;
        if (dir > 0 ? hopStart < lastDrawnEnd + 0.5 : hopStart > lastDrawnEnd - 0.5) {
          continue;
        }
        ctx.lineTo(hopStart, a.y);
        ctx.arc(hx, a.y, hopR, dir > 0 ? Math.PI : 0, dir > 0 ? 0 : Math.PI, dir < 0);
        lastDrawnEnd = hx + dir * hopR;
      }
      ctx.lineTo(ex, ey);
    } else {
      ctx.lineTo(ex, ey);
    }

    // Round the corner at vertex b (i + 1) into the next segment
    if (i < n - 2 && radii[i + 1] > 0.5) {
      const c = points[i + 2];
      const ndx = c.x - b.x;
      const ndy = c.y - b.y;
      const nlen = Math.hypot(ndx, ndy);
      if (nlen >= 0.5) {
        const nextEntryX = b.x + (ndx / nlen) * radii[i + 1];
        const nextEntryY = b.y + (ndy / nlen) * radii[i + 1];
        ctx.quadraticCurveTo(b.x, b.y, nextEntryX, nextEntryY);
      }
    }
  }
}

function drawWire(
  ctx: CanvasRenderingContext2D,
  wire: Wire,
  snapshot: SimulationSnapshot | null,
  showSignals: boolean,
  state: RenderContextState,
  crossingByWireSeg: Map<string, number[]> | undefined,
  isNested: boolean,
  showNetLabels: boolean,
) {
  if (wire.points.length < 2) return;
  const val = snapshot?.wireValues[wire.id];
  const xCause = snapshot?.wireXCauses?.[wire.id];
  const { color, bit } = signalColor(val, showSignals, xCause);
  const isBus = (val?.width ?? 1) > 1;
  const isSelected = !isNested && state.selectedWireIds.has(wire.id);
  const isHovered = !isNested && state.hoveredWire?.wire.id === wire.id;

  // Fast straight polyline path for miniature nested subcircuit wires (avoids fillet trig overhead!)
  if (isNested) {
    ctx.strokeStyle = color;
    ctx.lineWidth = isBus ? 3.4 : 2.2;
    ctx.beginPath();
    ctx.moveTo(wire.points[0].x, wire.points[0].y);
    for (let i = 1; i < wire.points.length; i++) {
      ctx.lineTo(wire.points[i].x, wire.points[i].y);
    }
    ctx.stroke();
    return;
  }

  const cornerRadius = 9;
  const baseWidth = isBus ? 3.6 : 2.4;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Selection / hover halo (also rounded!)
  if (isSelected || isHovered) {
    ctx.strokeStyle = isSelected ? 'rgba(56, 189, 248, 0.45)' : 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = isBus ? 8.5 : 7;
    ctx.beginPath();
    traceRoundedWirePath(ctx, wire.points, crossingByWireSeg, wire.id, cornerRadius);
    ctx.stroke();
  }

  // Fast GPU-friendly glow halo for HIGH (1) or CONFLICT/OSCILLATION/UNKNOWN (X) — avoids software shadowBlur!
  if (showSignals && (bit === BIT_1 || bit === BIT_X)) {
    ctx.save();
    ctx.globalAlpha = bit === BIT_X ? 0.28 : 0.22;
    ctx.strokeStyle = color;
    ctx.lineWidth = baseWidth + 4.8;
    ctx.beginPath();
    traceRoundedWirePath(ctx, wire.points, crossingByWireSeg, wire.id, cornerRadius);
    ctx.stroke();
    ctx.restore();
  }

  // Render all 4 states (0, 1, X, Z) as clean solid lines
  ctx.strokeStyle = color;
  ctx.lineWidth = baseWidth;

  ctx.beginPath();
  traceRoundedWirePath(ctx, wire.points, crossingByWireSeg, wire.id, cornerRadius);
  ctx.stroke();

  // Interactive adjustment handles on selected wires (and subtle mid-grab hint on hovered wire segment)
  if (!isNested && isSelected) {
    drawWireHandles(ctx, wire, state.hoveredWireHandle);
  } else if (!isNested && isHovered && state.hoveredWire) {
    const s = state.hoveredWire.segIndex;
    if (s >= 0 && s < wire.points.length - 1) {
      const a = wire.points[s];
      const b = wire.points[s + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= 16) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(mx, my, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Net label badge on longest segment
  if (showNetLabels && wire.netLabel && !isNested) {
    let bestMid: Point = wire.points[0];
    let bestLen = -1;
    for (let i = 0; i < wire.points.length - 1; i++) {
      const a = wire.points[i];
      const b = wire.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > bestLen) {
        bestLen = len;
        bestMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    }
    const text = isBus ? `${wire.netLabel}[${val!.width}]` : wire.netLabel;
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(text).width + 10;
    roundRect(ctx, bestMid.x - tw / 2, bestMid.y - 16, tw, 15, 4);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bestMid.x, bestMid.y - 8.5);
  }

  ctx.restore();
}

function drawWireHandles(
  ctx: CanvasRenderingContext2D,
  wire: Wire,
  hoveredHandle: WireHandleHit | null,
) {
  // 1. Segment midpoint drag pills
  for (let s = 0; s < wire.points.length - 1; s++) {
    const a = wire.points[s];
    const b = wire.points[s + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 18) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const active =
      hoveredHandle?.wire.id === wire.id &&
      hoveredHandle.kind === 'segment' &&
      hoveredHandle.index === s;

    const isHoriz = Math.abs(a.y - b.y) < 0.5;
    const isVert = Math.abs(a.x - b.x) < 0.5;

    ctx.save();
    ctx.fillStyle = active ? '#38bdf8' : '#0f172a';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6;
    if (isHoriz) {
      roundRect(ctx, mx - 7, my - 3.2, 14, 6.4, 3);
      ctx.fill();
      ctx.stroke();
    } else if (isVert) {
      roundRect(ctx, mx - 3.2, my - 7, 6.4, 14, 3);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(mx, my, active ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Interior corner/waypoint drag circles
  for (let i = 1; i < wire.points.length - 1; i++) {
    const pt = wire.points[i];
    const active =
      hoveredHandle?.wire.id === wire.id &&
      hoveredHandle.kind === 'vertex' &&
      hoveredHandle.index === i;

    ctx.save();
    ctx.fillStyle = active ? '#38bdf8' : '#e0f2fe';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, active ? 5.2 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawGate(
  ctx: CanvasRenderingContext2D,
  gate: GateInstance,
  project: ProjectDocument,
  snapshot: SimulationSnapshot | null,
  state: RenderContextState,
  depth: number,
) {
  const isNested = depth > 0;
  const showSignals = state.simActive && snapshot !== null;
  const { width, height } = getGateSize(gate, project);
  const hw = width / 2;
  const hh = height / 2;
  const isSelected = !isNested && state.selectedGateIds.has(gate.id);
  const isHovered = !isNested && state.hoveredGateId === gate.id;
  const pins = getGatePins(gate, project);

  ctx.save();
  ctx.translate(gate.x, gate.y);
  ctx.rotate((gate.rotation * Math.PI) / 180);

  // Selection glow behind gate
  if (isSelected || isHovered) {
    ctx.save();
    roundRect(ctx, -hw - 4, -hh - 4, width + 8, height + 8, 9);
    ctx.strokeStyle = isSelected ? '#38bdf8' : 'rgba(148, 163, 184, 0.5)';
    ctx.lineWidth = isSelected ? 2 : 1.2;
    ctx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.08)' : 'rgba(148, 163, 184, 0.04)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Draw shape specific to gate type
  const outPinKey =
    snapshot?.pinValues[`${gate.id}:out`] !== undefined
      ? `${gate.id}:out`
      : snapshot?.pinValues[`${gate.id}:q`] !== undefined
        ? `${gate.id}:q`
        : `${gate.id}:in`;
  const outVal = snapshot?.pinValues[outPinKey];
  const outXCause = snapshot?.pinXCauses?.[outPinKey];
  const sig = signalColor(outVal, showSignals, outXCause);

  switch (gate.type) {
    case 'AND':
    case 'NAND':
      drawAndShape(ctx, hw, hh, gate.type === 'NAND', isSelected);
      break;
    case 'OR':
    case 'NOR':
    case 'XOR':
    case 'XNOR':
      drawOrShape(
        ctx,
        hw,
        hh,
        gate.type === 'NOR' || gate.type === 'XNOR',
        gate.type === 'XOR' || gate.type === 'XNOR',
        isSelected,
      );
      break;
    case 'NOT':
    case 'BUF':
    case 'TRIBUF':
      drawTriangleGate(ctx, hw, hh, gate.type === 'NOT', gate.type === 'TRIBUF', isSelected);
      break;
    case 'MUX':
    case 'DEMUX':
      drawMuxShape(ctx, hw, hh, gate.type, isSelected);
      break;
    case 'TOGGLE':
      drawToggleGate(
        ctx,
        hw,
        hh,
        gate,
        outVal,
        outXCause,
        showSignals,
        state.runtimeInputs?.[gate.id],
      );
      break;
    case 'BUTTON':
      drawButtonGate(
        ctx,
        hw,
        hh,
        gate,
        outVal,
        outXCause,
        showSignals,
        state.runtimeInputs?.[gate.id],
      );
      break;
    case 'CLOCK':
      drawClockGate(
        ctx,
        hw,
        hh,
        gate,
        outVal,
        outXCause,
        showSignals,
        state.runtimeInputs?.[gate.id],
      );
      break;
    case 'CONST':
      drawConstGate(ctx, hw, hh, gate, outVal, showSignals);
      break;
    case 'LED':
      drawLedGate(ctx, hw, hh, outVal, showSignals);
      break;
    case 'SEVEN_SEG':
      drawSevenSegGate(ctx, hw, hh, gate, snapshot?.pinValues[`${gate.id}:in`], showSignals);
      break;
    case 'NUM_DISPLAY':
      drawNumDisplayGate(ctx, hw, hh, gate, snapshot?.pinValues[`${gate.id}:in`], showSignals);
      break;
    case 'MODULE_IN':
    case 'MODULE_OUT':
      drawModulePortGate(ctx, hw, hh, gate, sig.color, showSignals, state.runtimeInputs?.[gate.id]);
      break;
    case 'TUNNEL':
      drawTunnelGate(ctx, hw, hh, gate, snapshot?.pinValues[`${gate.id}:io`], showSignals);
      break;
    case 'SPLITTER':
      drawSplitterGate(ctx, hw, hh, gate);
      break;
    case 'IFACE_BUNDLE':
      drawInterfaceGate(ctx, hw, hh, gate);
      break;
    case 'SUBCIRCUIT':
      drawSubcircuitGate(ctx, hw, hh, gate, project, snapshot, state, depth);
      break;
    default:
      drawIcBlockGate(ctx, hw, hh, gate, snapshot, showSignals);
      break;
  }

  // Draw internal pin labels for box/IC gates when zoomed comfortably
  if (!isNested && project.settings.showPinNames && isBoxLikeGate(gate.type)) {
    ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#94a3b8';
    for (const pin of pins) {
      if (gate.type === 'SUBCIRCUIT' && (gate.props.displayMode ?? 'live') !== 'box') {
        // Draw subtle pill tag near edge so it stays legible over internal view
        ctx.save();
        const tx = pin.side === 'left' ? pin.x + 6 : pin.side === 'right' ? pin.x - 6 : pin.x;
        const ty = pin.side === 'top' ? pin.y + 11 : pin.side === 'bottom' ? pin.y - 10 : pin.y;
        ctx.textAlign = pin.side === 'left' ? 'left' : pin.side === 'right' ? 'right' : 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        const w = ctx.measureText(pin.name).width + 6;
        const rx = pin.side === 'left' ? tx - 2 : pin.side === 'right' ? tx - w + 2 : tx - w / 2;
        ctx.fillRect(rx, ty - 6, w, 12);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(pin.name, tx, ty);
        ctx.restore();
      } else {
        const tx = pin.side === 'left' ? pin.x + 7 : pin.side === 'right' ? pin.x - 7 : pin.x;
        const ty = pin.side === 'top' ? pin.y + 10 : pin.side === 'bottom' ? pin.y - 9 : pin.y;
        ctx.textAlign = pin.side === 'left' ? 'left' : pin.side === 'right' ? 'right' : 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pin.name, tx, ty);
      }
    }
  }

  ctx.restore();

  // Draw pins in world space (unrotated circles so crisp & color-coded by 4-state signal!)
  for (const pin of pins) {
    const pos = getPinWorldPos(gate, pin);
    const pk = `${gate.id}:${pin.id}`;
    const pVal = snapshot?.pinValues[pk];
    const pCause = snapshot?.pinXCauses?.[pk];
    const pSig = signalColor(pVal, showSignals, pCause);
    const isPinHovered =
      !isNested && state.hoveredPin?.gate.id === gate.id && state.hoveredPin?.pin.id === pin.id;

    ctx.save();
    if (isPinHovered) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = pSig.color;
    ctx.strokeStyle = isPinHovered ? '#38bdf8' : '#0f172a';
    ctx.lineWidth = isPinHovered ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, isNested ? 2.6 : pin.bitWidth > 1 ? 4.8 : 4.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // External gate label above gate (unrotated)
  if (
    !isNested &&
    gate.label &&
    gate.type !== 'MODULE_IN' &&
    gate.type !== 'MODULE_OUT' &&
    gate.type !== 'TUNNEL'
  ) {
    const bounds = getGateBounds(gate, project);
    ctx.save();
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(gate.label, gate.x, bounds.y - 6);
    ctx.restore();
  }
}

function isBoxLikeGate(t: GateInstance['type']): boolean {
  return (
    t === 'HALF_ADDER' ||
    t === 'FULL_ADDER' ||
    t === 'ADDER' ||
    t === 'COMPARATOR' ||
    t === 'DECODER' ||
    t === 'SR_LATCH' ||
    t === 'D_LATCH' ||
    t === 'D_FF' ||
    t === 'JK_FF' ||
    t === 'T_FF' ||
    t === 'REGISTER' ||
    t === 'COUNTER' ||
    t === 'RAM' ||
    t === 'ROM' ||
    t === 'SUBCIRCUIT' ||
    t === 'IFACE_BUNDLE'
  );
}

function drawAndShape(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  inverted: boolean,
  selected: boolean,
) {
  const rightX = inverted ? hw - 8 : hw - 2;
  ctx.beginPath();
  ctx.moveTo(-hw + 2, -hh + 2);
  ctx.lineTo(0, -hh + 2);
  ctx.arc(0, 0, hh - 2, -Math.PI / 2, Math.PI / 2, false);
  ctx.lineTo(-hw + 2, hh - 2);
  ctx.closePath();
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = selected ? '#38bdf8' : '#94a3b8';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (inverted) {
    ctx.beginPath();
    ctx.arc(rightX + 3, 0, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(inverted ? 'NAND' : 'AND', -6, 0);
}

function drawOrShape(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  inverted: boolean,
  xor: boolean,
  selected: boolean,
) {
  const shift = xor ? 5 : 0;
  const tipX = inverted ? hw - 9 : hw - 2;
  ctx.beginPath();
  ctx.moveTo(-hw + 2 + shift, -hh + 2);
  ctx.quadraticCurveTo(0, -hh + 2, tipX, 0);
  ctx.quadraticCurveTo(0, hh - 2, -hw + 2 + shift, hh - 2);
  ctx.quadraticCurveTo(-hw + 14 + shift, 0, -hw + 2 + shift, -hh + 2);
  ctx.closePath();
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = selected ? '#38bdf8' : '#94a3b8';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (xor) {
    ctx.beginPath();
    ctx.moveTo(-hw + 1, -hh + 3);
    ctx.quadraticCurveTo(-hw + 13, 0, -hw + 1, hh - 3);
    ctx.stroke();
  }
  if (inverted) {
    ctx.beginPath();
    ctx.arc(tipX + 4.5, 0, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 9.5px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(xor ? (inverted ? 'XNOR' : 'XOR') : inverted ? 'NOR' : 'OR', -2, 0);
}

function drawTriangleGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  inverted: boolean,
  triState: boolean,
  selected: boolean,
) {
  const tipX = inverted ? hw - 9 : hw - 2;
  ctx.beginPath();
  ctx.moveTo(-hw + 2, -hh + 4);
  ctx.lineTo(tipX, 0);
  ctx.lineTo(-hw + 2, hh - 4);
  ctx.closePath();
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = selected ? '#38bdf8' : '#94a3b8';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (inverted) {
    ctx.beginPath();
    ctx.arc(tipX + 4.5, 0, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
  }
  if (triState) {
    // Line from bottom EN pin to triangle bottom edge
    ctx.beginPath();
    ctx.moveTo(0, hh);
    ctx.lineTo(0, hh * 0.45);
    ctx.stroke();
    ctx.fillStyle = '#60a5fa';
    ctx.font = '700 8.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Z', -7, 0);
  }
}

function drawMuxShape(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  type: 'MUX' | 'DEMUX',
  selected: boolean,
) {
  ctx.beginPath();
  if (type === 'MUX') {
    ctx.moveTo(-hw + 2, -hh + 2);
    ctx.lineTo(hw - 2, -hh + 16);
    ctx.lineTo(hw - 2, hh - 16);
    ctx.lineTo(-hw + 2, hh - 2);
  } else {
    ctx.moveTo(-hw + 2, -hh + 16);
    ctx.lineTo(hw - 2, -hh + 2);
    ctx.lineTo(hw - 2, hh - 2);
    ctx.lineTo(-hw + 2, hh - 16);
  }
  ctx.closePath();
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = selected ? '#38bdf8' : '#818cf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(type, 0, 0);
}

function drawToggleGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  xCause: XCause | undefined,
  showSignals: boolean,
  rt?: RuntimeInputOverride,
) {
  const bw = gate.props.bitWidth ?? 1;
  // Physical switch position always reflects the switch's own driven setting (even when the net resolves to X)
  const drivenVal = fromLiteral(rt?.value ?? gate.props.value ?? '0', bw);
  const drivenBit = dominantState(drivenVal);
  const sig = signalColor(val, showSignals, xCause);
  const isUnknownNet = showSignals && sig.bit === BIT_X;

  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 8);
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  // In Edit mode (!showSignals), keep outer frame neutral (or softly tinted when ON) so Edit vs Live is clear
  ctx.strokeStyle = showSignals
    ? sig.color
    : drivenBit === BIT_1
      ? 'rgba(74, 222, 128, 0.5)'
      : '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (bw === 1) {
    const isOn = drivenBit === BIT_1;
    // Tactile toggle pill inside — stays visibly ON (shifted right) even if net resolves to X or in Edit mode!
    roundRect(ctx, -18, -9, 36, 18, 9);
    ctx.fillStyle = isOn
      ? isUnknownNet
        ? sig.glow
        : showSignals
          ? 'rgba(34, 197, 94, 0.28)'
          : 'rgba(74, 222, 128, 0.16)'
      : '#0f172a';
    ctx.fill();
    ctx.strokeStyle = isOn
      ? isUnknownNet
        ? sig.color
        : showSignals
          ? '#22c55e'
          : 'rgba(74, 222, 128, 0.6)'
      : isUnknownNet
        ? sig.color
        : '#475569';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(isOn ? 9 : -9, 0, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = isOn
      ? isUnknownNet
        ? sig.color
        : showSignals
          ? '#22c55e'
          : '#86efac'
      : '#94a3b8';
    ctx.fill();
  } else {
    ctx.fillStyle = isUnknownNet
      ? sig.color
      : showSignals
        ? '#f8fafc'
        : drivenBit === BIT_1
          ? '#bbf7d0'
          : '#cbd5e1';
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatValue(drivenVal, 'hex'), 0, 0);
  }
}

function drawButtonGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  xCause: XCause | undefined,
  showSignals: boolean,
  rt?: RuntimeInputOverride,
) {
  const sig = signalColor(val, showSignals, xCause);
  const pressed = !!(rt?.pressed ?? gate.props.pressed);
  const isUnknownNet = showSignals && sig.bit === BIT_X;

  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 8);
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = showSignals ? sig.color : pressed ? 'rgba(74, 222, 128, 0.55)' : '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Tactile press-in animation works in Edit mode and under X contention too!
  ctx.beginPath();
  ctx.arc(0, 0, pressed ? 10.5 : 13, 0, Math.PI * 2);
  ctx.fillStyle = pressed
    ? isUnknownNet
      ? sig.color
      : showSignals
        ? '#22c55e'
        : '#4ade80'
    : '#334155';
  ctx.fill();
  ctx.strokeStyle = pressed
    ? isUnknownNet
      ? sig.color
      : showSignals
        ? '#86efac'
        : '#bbf7d0'
    : '#64748b';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawClockGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  xCause: XCause | undefined,
  showSignals: boolean,
  rt?: RuntimeInputOverride,
) {
  const sig = signalColor(val, showSignals, xCause);
  const clockHigh = !!(rt?.clockHigh ?? gate.props.clockHigh);
  const isUnknownNet = showSignals && sig.bit === BIT_X;
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 8);
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = showSignals ? sig.color : clockHigh ? 'rgba(74, 222, 128, 0.5)' : '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Square wave glyph
  ctx.beginPath();
  ctx.moveTo(-16, 6);
  ctx.lineTo(-10, 6);
  ctx.lineTo(-10, -6);
  ctx.lineTo(0, -6);
  ctx.lineTo(0, 6);
  ctx.lineTo(10, 6);
  ctx.lineTo(10, -6);
  ctx.lineTo(16, -6);
  ctx.strokeStyle = clockHigh
    ? isUnknownNet
      ? sig.color
      : showSignals
        ? '#22c55e'
        : '#86efac'
    : '#94a3b8';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawConstGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  showSignals: boolean,
) {
  const sig = signalColor(val, showSignals);
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 6);
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = sig.color;
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(val ? formatValue(val, 'hex') : (gate.props.value ?? '1'), 0, 0);
}

function drawLedGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  val: LogicValue | undefined,
  showSignals: boolean,
) {
  const sig = signalColor(val, showSignals);
  // Outer housing
  ctx.beginPath();
  ctx.arc(0, 0, Math.min(hw, hh) - 2, 0, Math.PI * 2);
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner glowing bulb
  ctx.save();
  if (showSignals && (sig.bit === BIT_1 || sig.bit === BIT_X || sig.bit === BIT_Z)) {
    ctx.shadowColor = sig.color;
    ctx.shadowBlur = 16;
  }
  const r = Math.min(hw, hh) - 7;
  const grad = ctx.createRadialGradient(-3, -3, 2, 0, 0, r);
  grad.addColorStop(0, showSignals && sig.bit !== BIT_0 ? '#ffffff' : '#94a3b8');
  grad.addColorStop(0.45, sig.color);
  grad.addColorStop(1, '#0f172a');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // Crisp state letter inside LED
  ctx.fillStyle = '#0b1120';
  ctx.font = '800 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(showSignals ? SIGNAL_LABELS[sig.bit] : '-', 0, 0.5);
}

function drawSevenSegGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  showSignals: boolean,
) {
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 8);
  ctx.fillStyle = '#090d16';
  ctx.fill();
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.stroke();

  let mask = 0;
  let color = '#22c55e';
  if (showSignals && val) {
    const dom = dominantState(val);
    if (dom === BIT_X) {
      mask = 0x79; // E
      color = SIGNAL_COLORS[BIT_X];
    } else if (dom === BIT_Z) {
      mask = 0x40; // -
      color = SIGNAL_COLORS[BIT_Z];
    } else if (gate.props.segMode === 'direct') {
      for (let i = 0; i < 7; i++) {
        if (val.bits[i] === BIT_1) mask |= 1 << i;
      }
    } else {
      const u = toUnsignedInt(val);
      if (u !== null) mask = HEX_TO_7SEG[u & 0xf];
    }
  }

  // Segment coordinates relative to center
  const segs: [number, number, number, number][] = [
    [-14, -32, 14, -32], // a
    [16, -29, 16, -3], // b
    [16, 3, 16, 29], // c
    [-14, 32, 14, 32], // d
    [-16, 3, -16, 29], // e
    [-16, -29, -16, -3], // f
    [-14, 0, 14, 0], // g
  ];

  ctx.lineCap = 'round';
  segs.forEach(([x1, y1, x2, y2], idx) => {
    const lit = (mask & (1 << idx)) !== 0;
    ctx.save();
    if (lit) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
    }
    ctx.strokeStyle = lit ? color : '#1e293b';
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  });
}

function drawNumDisplayGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  showSignals: boolean,
) {
  const sig = signalColor(val, showSignals);
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 7);
  ctx.fillStyle = '#090d16';
  ctx.fill();
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  const text = showSignals && val ? formatValue(val, gate.props.radix ?? 'hex') : '---';
  ctx.fillStyle = showSignals ? (sig.bit === BIT_0 ? '#e2e8f0' : sig.color) : '#64748b';
  ctx.font = '700 14px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, -2);

  ctx.fillStyle = '#64748b';
  ctx.font = '600 8.5px ui-monospace, monospace';
  ctx.fillText(
    `${(gate.props.radix ?? 'hex').toUpperCase()} · ${gate.props.bitWidth ?? 4}b`,
    0,
    13,
  );
}

function drawModulePortGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  color: string,
  showSignals: boolean,
  rt?: RuntimeInputOverride,
) {
  const isIn = gate.type === 'MODULE_IN';
  const bw = gate.props.bitWidth ?? 1;
  const editOn =
    !showSignals &&
    isIn &&
    dominantState(fromLiteral(rt?.value ?? gate.props.value ?? '0', bw)) === BIT_1;

  // Both MODULE_IN and MODULE_OUT share the exact same right-pointing pentagon/tag shape:
  // MODULE_IN connects at the right pointed tip (+hw, 0);
  // MODULE_OUT connects at the midpoint of the opposite flat left edge (-hw, 0)!
  ctx.beginPath();
  ctx.moveTo(-hw, -hh + 4);
  ctx.lineTo(hw - 12, -hh + 4);
  ctx.lineTo(hw, 0);
  ctx.lineTo(hw - 12, hh - 4);
  ctx.lineTo(-hw, hh - 4);
  ctx.closePath();
  ctx.fillStyle = isIn ? '#172554' : '#1e1b4b';
  ctx.fill();
  ctx.strokeStyle = showSignals ? color : editOn ? 'rgba(74, 222, 128, 0.7)' : '#6366f1';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = editOn ? '#bbf7d0' : '#f8fafc';
  ctx.font = '700 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lbl =
    bw > 1 ? `${gate.label || (isIn ? 'IN' : 'OUT')}[${bw}]` : gate.label || (isIn ? 'IN' : 'OUT');
  ctx.fillText(lbl, -4, 0);
}

function drawTunnelGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  val: LogicValue | undefined,
  showSignals: boolean,
) {
  const sig = signalColor(val, showSignals);
  ctx.beginPath();
  ctx.moveTo(-hw, 0);
  ctx.lineTo(-hw + 10, -hh);
  ctx.lineTo(hw, -hh);
  ctx.lineTo(hw, hh);
  ctx.lineTo(-hw + 10, hh);
  ctx.closePath();
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(gate.props.netName || 'NET', 4, 0);
}

function drawSplitterGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
) {
  const isSplit = (gate.props.splitMode ?? 'split') === 'split';
  roundRect(ctx, -hw + 6, -hh + 4, (hw - 6) * 2, (hh - 4) * 2, 5);
  ctx.fillStyle = '#1e293b';
  ctx.fill();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Spine bar
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(isSplit ? -6 : 6, -hh + 10);
  ctx.lineTo(isSplit ? -6 : 6, hh - 10);
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 8.5px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isSplit ? 'SPL' : 'MRG', isSplit ? 6 : -6, 0);
}

function drawInterfaceGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
) {
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 8);
  ctx.fillStyle = '#1e1b4b';
  ctx.fill();
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Header
  ctx.fillStyle = 'rgba(168, 85, 247, 0.25)';
  roundRect(ctx, -hw + 1, -hh + 1, hw * 2 - 2, 18, 7);
  ctx.fill();

  ctx.fillStyle = '#e9d5ff';
  ctx.font = '700 9.5px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const mode = gate.props.bundleMode === 'unpack' ? 'UNPACK' : 'PACK';
  ctx.fillText(`${gate.props.interfaceName || 'if'} (${mode})`, 0, -hh + 10);
}

function drawIcBlockGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  snapshot: SimulationSnapshot | null,
  showSignals: boolean,
) {
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 8);
  ctx.fillStyle = '#162033';
  ctx.fill();
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Accent top bar
  const accent =
    gate.type === 'RAM' || gate.type === 'ROM'
      ? '#f59e0b'
      : gate.type.includes('FF') ||
          gate.type.includes('LATCH') ||
          gate.type === 'REGISTER' ||
          gate.type === 'COUNTER'
        ? '#06b6d4'
        : '#818cf8';
  ctx.fillStyle = accent;
  ctx.fillRect(-hw + 8, -hh, (hw - 8) * 2, 3);

  ctx.fillStyle = '#f1f5f9';
  ctx.font = '700 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const titleMap: Partial<Record<GateInstance['type'], string>> = {
    HALF_ADDER: 'HA (+)',
    FULL_ADDER: 'FA (+)',
    ADDER: `ADD ${gate.props.bitWidth ?? 4}b`,
    COMPARATOR: `CMP ${gate.props.bitWidth ?? 4}b`,
    DECODER: 'DEC',
    SR_LATCH: 'SR',
    D_LATCH: 'D-LAT',
    D_FF: 'D-FF',
    JK_FF: 'JK-FF',
    T_FF: 'T-FF',
    REGISTER: `REG ${gate.props.bitWidth ?? 4}b`,
    COUNTER: `CNT ${gate.props.bitWidth ?? 4}b`,
    RAM: `RAM ${1 << (gate.props.addrBits ?? 4)}×${gate.props.dataBits ?? 4}`,
    ROM: `ROM ${1 << (gate.props.addrBits ?? 4)}×${gate.props.dataBits ?? 4}`,
  };
  ctx.fillText(titleMap[gate.type] ?? gate.type, 0, -6);

  // Show live stored value for sequential components
  const stored = snapshot?.gateInternalValues[gate.id];
  if (showSignals && stored) {
    ctx.fillStyle = '#22c55e';
    ctx.font = '700 11px ui-monospace, monospace';
    ctx.fillText(formatValue(stored, stored.width > 1 ? 'hex' : 'bin'), 0, 12);
  }
}

/**
 * Digital-style Subcircuit rendering:
 * - 'box': clean opaque IC box
 * - 'preview': transparent window rendering the internal schematic WITHOUT signal colors
 * - 'live': transparent window rendering the internal schematic WITH real-time 4-state signal colors!
 */
function drawSubcircuitGate(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  gate: GateInstance,
  project: ProjectDocument,
  snapshot: SimulationSnapshot | null,
  state: RenderContextState,
  depth: number,
) {
  const subId = gate.props.subcircuitId;
  const subDoc = subId ? project.circuits[subId] : undefined;
  const globalMode = project.settings.globalSubcircuitDisplay;
  const mode: SubcircuitDisplayMode =
    globalMode === 'instance' ? (gate.props.displayMode ?? 'live') : globalMode;

  const isStub = subDoc?.isStub;

  // Outer module chassis
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 10);
  ctx.fillStyle = isStub
    ? 'rgba(51, 32, 22, 0.92)'
    : mode === 'box'
      ? '#162033'
      : 'rgba(11, 17, 32, 0.88)';
  ctx.fill();
  ctx.strokeStyle = isStub ? '#f59e0b' : mode === 'live' ? '#22c55e' : '#38bdf8';
  ctx.lineWidth = 2;
  if (isStub) ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Header strip
  const headerH = 20;
  ctx.save();
  roundRect(ctx, -hw + 1, -hh + 1, hw * 2 - 2, headerH, 9);
  ctx.fillStyle = isStub ? 'rgba(245, 158, 11, 0.2)' : 'rgba(30, 41, 59, 0.92)';
  ctx.fill();
  ctx.fillStyle = isStub ? '#fcd34d' : '#e2e8f0';
  ctx.font = '700 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badge = isStub
    ? 'STUB'
    : mode === 'live'
      ? '● LIVE'
      : mode === 'preview'
        ? '◎ VIEW'
        : 'BOX';
  const title = `${subDoc?.name ?? 'Module'}  [${badge}]`;
  ctx.fillText(title, 0, -hh + headerH / 2 + 1);
  ctx.restore();

  if (isStub) {
    ctx.fillStyle = '#fbbf24';
    ctx.font = '600 9.5px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('External Module (No Impl)', 0, 8);
    return;
  }

  // Digital-style live / preview internal schematic rendering (with cached bounds & screen-size LOD!)
  if (subDoc && mode !== 'box' && depth < 3 && subDoc.gates.length > 0) {
    const innerX = -hw + 10;
    const innerY = -hh + headerH + 6;
    const innerW = hw * 2 - 20;
    const innerH = hh * 2 - headerH - 14;
    const screenInnerW = innerW * state.viewport.zoom;

    if (innerW > 20 && innerH > 20 && screenInnerW >= 46) {
      let cachedB = subBoundsCache.get(subDoc.gates);
      if (!cachedB) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const g of subDoc.gates) {
          const b = getGateBounds(g, project);
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.width > maxX) maxX = b.x + b.width;
          if (b.y + b.height > maxY) maxY = b.y + b.height;
        }
        cachedB = { minX, minY, maxX, maxY };
        subBoundsCache.set(subDoc.gates, cachedB);
      }
      const { minX, minY, maxX, maxY } = cachedB;
      const contentW = Math.max(80, maxX - minX + 40);
      const contentH = Math.max(60, maxY - minY + 40);

      const scale = Math.min(innerW / contentW, innerH / contentH);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      ctx.save();
      roundRect(ctx, innerX, innerY, innerW, innerH, 6);
      ctx.clip();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fillRect(innerX, innerY, innerW, innerH);

      ctx.translate(innerX + innerW / 2, innerY + innerH / 2);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);

      const subSnap = mode === 'live' ? (snapshot?.subSnapshots[gate.id] ?? null) : null;
      drawCircuitContents(
        ctx,
        subDoc,
        project,
        subSnap,
        {
          ...state,
          simActive: mode === 'live' && state.simActive,
        },
        depth + 1,
      );
      ctx.restore();
    } else if (innerW > 20 && innerH > 20) {
      // Zoomed far out: crisp lightweight label instead of sub-pixel nested shapes
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${subDoc.gates.length} gates`, 0, 8);
    }
  } else if (mode === 'box') {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(subDoc?.name ?? 'MODULE', 0, 8);
  }
}

function drawPinTooltip(
  ctx: CanvasRenderingContext2D,
  hit: PinHit,
  snapshot: SimulationSnapshot | null,
  simActive: boolean,
  zoom: number,
) {
  const pk = `${hit.gate.id}:${hit.pin.id}`;
  const val = snapshot?.pinValues[pk];
  const xCause = snapshot?.pinXCauses?.[pk];
  const valStr =
    simActive && val
      ? xCause && dominantState(val) === BIT_X
        ? `${formatValue(val, val.width > 1 ? 'hex' : 'bin')} [${X_CAUSE_LABELS[xCause]}]`
        : formatValue(val, val.width > 1 ? 'hex' : 'bin')
      : 'PAUSED';
  const text = `${hit.pin.name} (${hit.pin.bitWidth}b) = ${valStr}`;

  ctx.save();
  const inv = 1 / zoom;
  ctx.translate(hit.pos.x, hit.pos.y - 16 * inv);
  ctx.scale(inv, inv);
  ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
  const tw = ctx.measureText(text).width + 14;
  roundRect(ctx, -tw / 2, -20, tw, 22, 5);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
  ctx.fill();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, -9);
  ctx.restore();
}

/**
 * Render a standalone high-DPI symbol preview of any gate or custom module onto a target canvas.
 * Used for floating drag previews while dragging from the palette before entering the circuit canvas.
 */
export function renderGateSymbolPreview(
  canvas: HTMLCanvasElement,
  gate: GateInstance,
  project: ProjectDocument,
  zoom = 1,
): { cssWidth: number; cssHeight: number } {
  const { width, height } = getGateSize(gate, project);
  const pad = 28;
  const scale = Math.max(0.65, Math.min(1.4, zoom));
  const cssWidth = Math.ceil((width + pad * 2) * scale);
  const cssHeight = Math.ceil((height + pad * 2) * scale);
  const dpr = window.devicePixelRatio || 1;

  if (
    canvas.width !== Math.floor(cssWidth * dpr) ||
    canvas.height !== Math.floor(cssHeight * dpr)
  ) {
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return { cssWidth, cssHeight };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.translate(cssWidth / 2, cssHeight / 2);
  ctx.scale(scale, scale);

  const centeredGate: GateInstance = { ...gate, x: 0, y: 0 };
  drawGate(
    ctx,
    centeredGate,
    project,
    null,
    {
      viewport: { x: 0, y: 0, zoom: scale },
      selectedGateIds: new Set([centeredGate.id]),
      selectedWireIds: new Set(),
      hoveredPin: null,
      hoveredGateId: null,
      hoveredWire: null,
      hoveredWireHandle: null,
      wiringPreview: null,
      marquee: null,
      simActive: false,
    },
    0,
  );
  ctx.restore();
  return { cssWidth, cssHeight };
}
