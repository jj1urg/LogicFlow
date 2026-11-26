import { getGateBounds, getGatePins, getPinWorldPos } from '../core/catalog';
import { getSegmentOrientation } from '../core/routing';
import { CircuitDocument, GateInstance, PinDef, Point, ProjectDocument, Wire } from '../core/types';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export function screenToWorld(screen: Point, vp: Viewport): Point {
  return {
    x: (screen.x - vp.x) / vp.zoom,
    y: (screen.y - vp.y) / vp.zoom,
  };
}

export function worldToScreen(world: Point, vp: Viewport): Point {
  return {
    x: world.x * vp.zoom + vp.x,
    y: world.y * vp.zoom + vp.y,
  };
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function projectPointToSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export interface PinHit {
  gate: GateInstance;
  pin: PinDef;
  pos: Point;
  dist: number;
}

export function hitTestPin(
  worldPt: Point,
  circuit: CircuitDocument,
  project: ProjectDocument,
  radius = 11,
): PinHit | null {
  let best: PinHit | null = null;
  for (let i = circuit.gates.length - 1; i >= 0; i--) {
    const gate = circuit.gates[i];
    const pins = getGatePins(gate, project);
    for (const pin of pins) {
      const pos = getPinWorldPos(gate, pin);
      const dist = Math.hypot(worldPt.x - pos.x, worldPt.y - pos.y);
      if (dist <= radius && (!best || dist < best.dist)) {
        best = { gate, pin, pos, dist };
      }
    }
  }
  return best;
}

export function hitTestGate(
  worldPt: Point,
  circuit: CircuitDocument,
  project: ProjectDocument,
): GateInstance | null {
  for (let i = circuit.gates.length - 1; i >= 0; i--) {
    const gate = circuit.gates[i];
    const b = getGateBounds(gate, project);
    if (
      worldPt.x >= b.x &&
      worldPt.x <= b.x + b.width &&
      worldPt.y >= b.y &&
      worldPt.y <= b.y + b.height
    ) {
      return gate;
    }
  }
  return null;
}

export interface WireHit {
  wire: Wire;
  segIndex: number;
  dist: number;
  orientation: 'h' | 'v' | 'diag';
}

export function hitTestWire(
  worldPt: Point,
  circuit: CircuitDocument,
  threshold = 7,
): WireHit | null {
  let best: WireHit | null = null;
  for (let i = circuit.wires.length - 1; i >= 0; i--) {
    const wire = circuit.wires[i];
    for (let s = 0; s < wire.points.length - 1; s++) {
      const a = wire.points[s];
      const b = wire.points[s + 1];
      const d = distToSegment(worldPt, a, b);
      if (d <= threshold && (!best || d < best.dist)) {
        best = { wire, segIndex: s, dist: d, orientation: getSegmentOrientation(a, b) };
      }
    }
  }
  return best;
}

export interface WireHandleHit {
  kind: 'vertex' | 'segment';
  wire: Wire;
  index: number; // pointIndex for 'vertex', segIndex for 'segment'
  pos: Point;
  orientation?: 'h' | 'v' | 'diag';
  dist: number;
}

/** Hit-test draggable corner vertices and segment midpoint handles on selected wires */
export function hitTestWireHandle(
  worldPt: Point,
  circuit: CircuitDocument,
  selectedWireIds: Set<string>,
  radius = 9,
): WireHandleHit | null {
  if (selectedWireIds.size === 0) return null;
  let best: WireHandleHit | null = null;

  for (const wire of circuit.wires) {
    if (!selectedWireIds.has(wire.id)) continue;
    // 1. Interior corner vertices (highest priority)
    for (let i = 1; i < wire.points.length - 1; i++) {
      const pt = wire.points[i];
      const dist = Math.hypot(worldPt.x - pt.x, worldPt.y - pt.y);
      if (dist <= radius && (!best || dist < best.dist)) {
        best = { kind: 'vertex', wire, index: i, pos: pt, dist };
      }
    }
    if (best?.kind === 'vertex') continue;

    // 2. Segment midpoint handles
    for (let s = 0; s < wire.points.length - 1; s++) {
      const a = wire.points[s];
      const b = wire.points[s + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 16) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(worldPt.x - mid.x, worldPt.y - mid.y);
      if (dist <= radius && (!best || dist < best.dist)) {
        best = {
          kind: 'segment',
          wire,
          index: s,
          pos: mid,
          orientation: getSegmentOrientation(a, b),
          dist,
        };
      }
    }
  }
  return best;
}

export function gatesInRect(
  r: { x1: number; y1: number; x2: number; y2: number },
  circuit: CircuitDocument,
  project: ProjectDocument,
): GateInstance[] {
  const minX = Math.min(r.x1, r.x2);
  const maxX = Math.max(r.x1, r.x2);
  const minY = Math.min(r.y1, r.y2);
  const maxY = Math.max(r.y1, r.y2);
  return circuit.gates.filter((g) => {
    const b = getGateBounds(g, project);
    return b.x + b.width >= minX && b.x <= maxX && b.y + b.height >= minY && b.y <= maxY;
  });
}

export interface FloatingWireEnd {
  wire: Wire;
  end: 'start' | 'end';
  pos: Point;
}

export interface FloatingWireEndHit extends FloatingWireEnd {
  dist: number;
}

/**
 * Find all truly floating wire endpoints: ends with no bound pin (`!from` / `!to`) that
 * do NOT touch any gate pin and do NOT touch any other wire's body/endpoints (T-junction).
 */
export function getFloatingWireEndpoints(
  circuit: CircuitDocument,
  project: ProjectDocument,
): FloatingWireEnd[] {
  const EPS = 3.5;
  // Collect all gate pin world positions once
  const pinPositions: Point[] = [];
  for (const gate of circuit.gates) {
    const pins = getGatePins(gate, project);
    for (const pin of pins) {
      pinPositions.push(getPinWorldPos(gate, pin));
    }
  }

  const isTouchingPin = (pt: Point): boolean => {
    for (const pp of pinPositions) {
      if (Math.hypot(pt.x - pp.x, pt.y - pp.y) <= EPS) return true;
    }
    return false;
  };

  const isTouchingOtherWire = (pt: Point, selfWireId: string): boolean => {
    for (const other of circuit.wires) {
      if (other.id === selfWireId || other.points.length < 2) continue;
      for (let s = 0; s < other.points.length - 1; s++) {
        if (distToSegment(pt, other.points[s], other.points[s + 1]) <= EPS) {
          return true;
        }
      }
    }
    return false;
  };

  const floating: FloatingWireEnd[] = [];
  for (const wire of circuit.wires) {
    if (wire.points.length < 2) continue;
    if (!wire.from) {
      const p0 = wire.points[0];
      if (!isTouchingPin(p0) && !isTouchingOtherWire(p0, wire.id)) {
        floating.push({ wire, end: 'start', pos: p0 });
      }
    }
    if (!wire.to) {
      const pLast = wire.points[wire.points.length - 1];
      if (!isTouchingPin(pLast) && !isTouchingOtherWire(pLast, wire.id)) {
        floating.push({ wire, end: 'end', pos: pLast });
      }
    }
  }
  return floating;
}

/** Hit-test floating wire endpoints so users can click & grow wires directly from them */
export function hitTestFloatingWireEnd(
  worldPt: Point,
  circuit: CircuitDocument,
  project: ProjectDocument,
  radius = 11,
  ignoreWireId?: string,
): FloatingWireEndHit | null {
  const ends = getFloatingWireEndpoints(circuit, project);
  let best: FloatingWireEndHit | null = null;
  for (const item of ends) {
    if (ignoreWireId && item.wire.id === ignoreWireId) continue;
    const dist = Math.hypot(worldPt.x - item.pos.x, worldPt.y - item.pos.y);
    if (dist <= radius && (!best || dist < best.dist)) {
      best = { ...item, dist };
    }
  }
  return best;
}

export function wiresInRect(
  r: { x1: number; y1: number; x2: number; y2: number },
  circuit: CircuitDocument,
): Wire[] {
  const minX = Math.min(r.x1, r.x2);
  const maxX = Math.max(r.x1, r.x2);
  const minY = Math.min(r.y1, r.y2);
  const maxY = Math.max(r.y1, r.y2);
  return circuit.wires.filter((w) =>
    w.points.some((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY),
  );
}
