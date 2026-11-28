import { describe, expect, it } from 'vitest';
import {
  gatesInRect,
  getFloatingWireEndpoints,
  hitTestFloatingWireEnd,
  hitTestGate,
  hitTestPin,
  hitTestWire,
  hitTestWireHandle,
  screenToWorld,
  Viewport,
  wiresInRect,
  worldToScreen,
} from '../src/canvas/hitTest';
import {
  applyGateReplacement,
  GATE_CATALOG,
  getCompatibleReplacementTypes,
  getGateBounds,
  getGatePins,
  getGateSize,
  getMuxConfig,
  getPinWorldPos,
  getPinWorldSide,
  getSevenSegConfig,
  rotateLocalPoint,
} from '../src/core/catalog';
import { BIT_X, fromInt, toUnsignedInt } from '../src/core/logic4';
import { createSampleProject } from '../src/core/samples';
import { createEmptySequentialState, simulateCircuit } from '../src/core/simulator';
import {
  dragWireSegment,
  dragWireWaypoint,
  findOrthogonalCrossings,
  findWireJunctions,
  inferWireEndOutwardSide,
  routeWire,
  simplifyPolyline,
} from '../src/core/routing';
import {
  CircuitDocument,
  GateInstance,
  GateType,
  PinSide,
  ProjectDocument,
  Rotation,
  Wire,
} from '../src/core/types';

function makeEmptyProject(
  circuit: CircuitDocument,
  extra: CircuitDocument[] = [],
): ProjectDocument {
  const circuits: Record<string, CircuitDocument> = { [circuit.id]: circuit };
  for (const c of extra) circuits[c.id] = c;
  return {
    version: 1,
    name: 'CatalogTest',
    activeCircuitId: circuit.id,
    circuits,
    settings: {
      gridSize: 20,
      routeMode: 'grid',
      simMode: 'realtime',
      clockHz: 2,
      clockRunning: false,
      globalSubcircuitDisplay: 'instance',
      showNetLabels: true,
      showPinNames: true,
    },
  };
}

describe('Component Catalog & Geometry Invariants', () => {
  it('validates pin definitions, unique pin IDs, and bounds for every GateType in catalog', () => {
    const allTypes = Object.keys(GATE_CATALOG) as GateType[];
    expect(allTypes.length).toBeGreaterThanOrEqual(30);

    for (const type of allTypes) {
      if (type === 'SUBCIRCUIT') continue;
      const entry = GATE_CATALOG[type];
      const gate: GateInstance = {
        id: `g_${type}`,
        type,
        x: 200,
        y: 200,
        rotation: 0,
        label: type,
        props: { ...entry.defaultProps },
      };
      const size = getGateSize(gate);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);

      const pins = getGatePins(gate);
      expect(pins.length).toBeGreaterThan(0);
      const ids = new Set(pins.map((p) => p.id));
      expect(ids.size).toBe(pins.length);
      for (const p of pins) {
        expect(p.bitWidth).toBeGreaterThanOrEqual(1);
      }

      // Check 90/180/270 degree bounding box swap symmetry
      const b0 = getGateBounds({ ...gate, rotation: 0 });
      const b90 = getGateBounds({ ...gate, rotation: 90 });
      const b180 = getGateBounds({ ...gate, rotation: 180 });
      const b270 = getGateBounds({ ...gate, rotation: 270 });
      expect(b90.width).toBe(b0.height);
      expect(b90.height).toBe(b0.width);
      expect(b180.width).toBe(b0.width);
      expect(b270.width).toBe(b0.height);
    }
  });

  it('maintains 4-fold rotational symmetry for pin coordinates and sides', () => {
    const pt = { x: 30, y: -15 };
    let cur = pt;
    for (let i = 0; i < 4; i++) cur = rotateLocalPoint(cur, 90);
    expect(cur).toEqual(pt);

    const sides: PinSide[] = ['left', 'right', 'top', 'bottom'];
    for (const s of sides) {
      expect(getPinWorldSide(s, 0)).toBe(s);
      expect(getPinWorldSide(s, 360)).toBe(s);
      const r180 = getPinWorldSide(s, 180);
      expect(getPinWorldSide(r180, 180)).toBe(s);
    }
  });

  it('lays out custom ModuleSymbolConfig pins across all 4 sides in specified order', () => {
    const sub: CircuitDocument = {
      id: 'sub_4side',
      name: 'QuadMod',
      gates: [
        {
          id: 'p_l1',
          type: 'MODULE_IN',
          x: 0,
          y: 0,
          rotation: 0,
          label: 'L1',
          props: { bitWidth: 1 },
        },
        {
          id: 'p_l2',
          type: 'MODULE_IN',
          x: 0,
          y: 40,
          rotation: 0,
          label: 'L2',
          props: { bitWidth: 4 },
        },
        {
          id: 'p_t',
          type: 'MODULE_IN',
          x: 0,
          y: 80,
          rotation: 0,
          label: 'TOP',
          props: { bitWidth: 1 },
        },
        {
          id: 'p_b',
          type: 'MODULE_IN',
          x: 0,
          y: 120,
          rotation: 0,
          label: 'BOT',
          props: { bitWidth: 1 },
        },
        {
          id: 'p_r',
          type: 'MODULE_OUT',
          x: 200,
          y: 0,
          rotation: 0,
          label: 'OUT',
          props: { bitWidth: 8 },
        },
      ],
      wires: [],
      symbolConfig: {
        width: 200,
        height: 160,
        pins: [
          { portGateId: 'p_l2', name: 'L2', dir: 'in', side: 'left', order: 0, bitWidth: 4 },
          { portGateId: 'p_l1', name: 'L1', dir: 'in', side: 'left', order: 1, bitWidth: 1 },
          { portGateId: 'p_t', name: 'TOP', dir: 'in', side: 'top', order: 0, bitWidth: 1 },
          { portGateId: 'p_b', name: 'BOT', dir: 'in', side: 'bottom', order: 0, bitWidth: 1 },
          { portGateId: 'p_r', name: 'OUT', dir: 'out', side: 'right', order: 0, bitWidth: 8 },
        ],
      },
    };
    const inst: GateInstance = {
      id: 'u_quad',
      type: 'SUBCIRCUIT',
      x: 300,
      y: 300,
      rotation: 0,
      label: 'U1',
      props: { subcircuitId: 'sub_4side', displayMode: 'box' },
    };
    const top: CircuitDocument = { id: 'top', name: 'Top', gates: [inst], wires: [] };
    const proj = makeEmptyProject(top, [sub]);

    expect(getGateSize(inst, proj)).toEqual({ width: 200, height: 160 });
    const pins = getGatePins(inst, proj);
    expect(pins.length).toBe(5);
    const l2 = pins.find((p) => p.id === 'p_l2')!;
    const l1 = pins.find((p) => p.id === 'p_l1')!;
    // Order 0 (L2) must appear above Order 1 (L1) on the left edge
    expect(l2.x).toBe(-100);
    expect(l1.x).toBe(-100);
    expect(l2.y).toBeLessThan(l1.y);
    expect(pins.find((p) => p.id === 'p_t')!.y).toBe(-80);
    expect(pins.find((p) => p.id === 'p_b')!.y).toBe(80);
    expect(pins.find((p) => p.id === 'p_r')!.x).toBe(100);
  });
});

describe('Wire Routing, Anti-Overlap, Crossings & Junctions', () => {
  it('routes two parallel wires without collinear segment overlap', () => {
    const circ: CircuitDocument = { id: 'c', name: 'C', gates: [], wires: [] };
    const w1Pts = routeWire(
      { x: 100, y: 100 },
      { x: 300, y: 200 },
      {
        startSide: 'right',
        endSide: 'left',
        circuit: circ,
        routeMode: 'grid',
      },
    );
    circ.wires.push({ id: 'w1', points: w1Pts, routeMode: 'grid' });

    const w2Pts = routeWire(
      { x: 100, y: 120 },
      { x: 300, y: 220 },
      {
        startSide: 'right',
        endSide: 'left',
        circuit: circ,
        routeMode: 'grid',
      },
    );

    // Collect grid unit edges of w1 and w2 and assert zero shared unit segments
    const toEdges = (pts: { x: number; y: number }[]) => {
      const set = new Set<string>();
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = Math.round(pts[i].x / 20);
        const ay = Math.round(pts[i].y / 20);
        const bx = Math.round(pts[i + 1].x / 20);
        const by = Math.round(pts[i + 1].y / 20);
        if (ax === bx) {
          for (let y = Math.min(ay, by); y < Math.max(ay, by); y++) {
            set.add(`${ax},${y}-${ax},${y + 1}`);
          }
        } else if (ay === by) {
          for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x++) {
            set.add(`${x},${ay}-${x + 1},${ay}`);
          }
        }
      }
      return set;
    };

    const e1 = toEdges(w1Pts);
    const e2 = toEdges(w2Pts);
    let overlapCount = 0;
    for (const edge of e2) if (e1.has(edge)) overlapCount++;
    expect(overlapCount).toBe(0);
  });

  it('distinguishes non-connected orthogonal crossings from connected T-junctions', () => {
    const wires: Wire[] = [
      // Horizontal wire from (0, 100) to (200, 100)
      {
        id: 'wh',
        points: [
          { x: 0, y: 100 },
          { x: 200, y: 100 },
        ],
        routeMode: 'grid',
      },
      // Vertical wire crossing cleanly through (100, 100) from (100, 0) to (100, 200)
      {
        id: 'wv_cross',
        points: [
          { x: 100, y: 0 },
          { x: 100, y: 200 },
        ],
        routeMode: 'grid',
      },
      // T-junction wire terminating AT (160, 100) from (160, 200)
      {
        id: 'wv_tjunc',
        points: [
          { x: 160, y: 200 },
          { x: 160, y: 100 },
        ],
        routeMode: 'grid',
      },
    ];

    const crossings = findOrthogonalCrossings(wires);
    expect(crossings.length).toBe(1);
    expect(crossings[0]).toMatchObject({ wireId: 'wh', x: 100, y: 100 });

    const junctions = findWireJunctions(wires);
    expect(junctions.length).toBe(1);
    expect(junctions[0]).toMatchObject({ wireId: 'wv_tjunc', x: 160, y: 100 });
  });

  it('deduplicates overlapping vertical wires crossing a horizontal wire so bridge arcs never overlap straight lines', () => {
    const wires: Wire[] = [
      {
        id: 'wh',
        points: [
          { x: 0, y: 100 },
          { x: 300, y: 100 },
        ],
        routeMode: 'grid',
      },
      // Three overlapping vertical wires all at x=100
      {
        id: 'wv1',
        points: [
          { x: 100, y: 0 },
          { x: 100, y: 200 },
        ],
        routeMode: 'grid',
      },
      {
        id: 'wv2',
        points: [
          { x: 100, y: 20 },
          { x: 100, y: 240 },
        ],
        routeMode: 'grid',
      },
      {
        id: 'wv3',
        points: [
          { x: 100, y: -20 },
          { x: 100, y: 180 },
        ],
        routeMode: 'grid',
      },
      // Another distinct vertical wire at x=160
      {
        id: 'wv4',
        points: [
          { x: 160, y: 0 },
          { x: 160, y: 200 },
        ],
        routeMode: 'grid',
      },
    ];

    const crossings = findOrthogonalCrossings(wires);
    expect(crossings.length).toBe(2);
    expect(crossings.map((c) => c.x)).toEqual([100, 160]);
  });

  it('routes 4 parallel wires between columns with ZERO overlapping segments', () => {
    const circ: CircuitDocument = { id: 'c_par4', name: 'Par4', gates: [], wires: [] };
    const toEdges = (pts: { x: number; y: number }[]) => {
      const set = new Set<string>();
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = Math.round(pts[i].x / 20);
        const ay = Math.round(pts[i].y / 20);
        const bx = Math.round(pts[i + 1].x / 20);
        const by = Math.round(pts[i + 1].y / 20);
        if (ax === bx) {
          for (let y = Math.min(ay, by); y < Math.max(ay, by); y++) {
            set.add(`${ax},${y}-${ax},${y + 1}`);
          }
        } else if (ay === by) {
          for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x++) {
            set.add(`${x},${ay}-${x + 1},${ay}`);
          }
        }
      }
      return set;
    };

    const allEdges = new Set<string>();
    for (let k = 0; k < 4; k++) {
      const pts = routeWire(
        { x: 100, y: 100 + k * 40 },
        { x: 360, y: 220 + k * 40 },
        { startSide: 'right', endSide: 'left', circuit: circ, routeMode: 'grid' },
      );
      circ.wires.push({ id: `w${k}`, points: pts, routeMode: 'grid' });
      const edges = toEdges(pts);
      for (const e of edges) {
        expect(allEdges.has(e), `Overlapping segment ${e} on wire w${k}`).toBe(false);
        allEdges.add(e);
      }
    }
  });

  it('prefers adjusting Y near the horizontal midpoint of the channel rather than hugging the destination pin edge', () => {
    const circ: CircuitDocument = { id: 'c_mid', name: 'MidBend', gates: [], wires: [] };
    const pts = routeWire(
      { x: 100, y: 100 },
      { x: 400, y: 200 },
      { startSide: 'right', endSide: 'left', circuit: circ, routeMode: 'grid' },
    );

    // Find vertical segments adjusting Y
    const vertXs: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (Math.abs(pts[i].x - pts[i + 1].x) < 0.5 && Math.abs(pts[i].y - pts[i + 1].y) >= 20) {
        vertXs.push(pts[i].x);
      }
    }
    expect(vertXs.length).toBeGreaterThanOrEqual(1);
    // Vertical Y-adjustment should occur near the middle (~250), well away from destination wall (380)
    for (const vx of vertXs) {
      expect(vx).toBeGreaterThanOrEqual(180);
      expect(vx).toBeLessThanOrEqual(320);
    }
  });

  it('supports configurable multi-input MUX (2..16 channels) in catalog and 4-state simulation', () => {
    expect(getMuxConfig({ inputCount: 3 })).toEqual({ channels: 3, selectBits: 2 });
    expect(getMuxConfig({ inputCount: 5 })).toEqual({ channels: 5, selectBits: 3 });
    expect(getMuxConfig({ inputCount: 6 })).toEqual({ channels: 6, selectBits: 3 });
    expect(getMuxConfig({ inputCount: 12 })).toEqual({ channels: 12, selectBits: 4 });
    expect(getMuxConfig({ selectBits: 2 })).toEqual({ channels: 4, selectBits: 2 });

    // Simulate a 3-input 4-bit MUX: sel 0..2 select D0..D2, sel 3 outputs X
    const mux: GateInstance = {
      id: 'm3',
      type: 'MUX',
      x: 200,
      y: 200,
      rotation: 0,
      label: 'MUX3',
      props: { bitWidth: 4, inputCount: 3, selectBits: 2 },
    };
    const pins = getGatePins(mux);
    expect(pins.filter((p) => p.id.startsWith('d')).length).toBe(3);
    expect(pins.find((p) => p.id === 'sel')?.bitWidth).toBe(2);

    const gates: GateInstance[] = [
      mux,
      {
        id: 'sel_in',
        type: 'MODULE_IN',
        x: 60,
        y: 300,
        rotation: 0,
        label: 'sel',
        props: { bitWidth: 2, value: '0' },
      },
      {
        id: 'd0_in',
        type: 'CONST',
        x: 60,
        y: 120,
        rotation: 0,
        label: 'D0',
        props: { bitWidth: 4, value: '0x3' },
      },
      {
        id: 'd1_in',
        type: 'CONST',
        x: 60,
        y: 160,
        rotation: 0,
        label: 'D1',
        props: { bitWidth: 4, value: '0x7' },
      },
      {
        id: 'd2_in',
        type: 'CONST',
        x: 60,
        y: 200,
        rotation: 0,
        label: 'D2',
        props: { bitWidth: 4, value: '0xB' },
      },
      {
        id: 'y_out',
        type: 'MODULE_OUT',
        x: 360,
        y: 200,
        rotation: 0,
        label: 'y',
        props: { bitWidth: 4 },
      },
    ];
    const wires: Wire[] = [
      {
        id: 'ws',
        from: { gateId: 'sel_in', pinId: 'out' },
        to: { gateId: 'm3', pinId: 'sel' },
        points: [],
        routeMode: 'grid',
      },
      {
        id: 'w0',
        from: { gateId: 'd0_in', pinId: 'out' },
        to: { gateId: 'm3', pinId: 'd0' },
        points: [],
        routeMode: 'grid',
      },
      {
        id: 'w1',
        from: { gateId: 'd1_in', pinId: 'out' },
        to: { gateId: 'm3', pinId: 'd1' },
        points: [],
        routeMode: 'grid',
      },
      {
        id: 'w2',
        from: { gateId: 'd2_in', pinId: 'out' },
        to: { gateId: 'm3', pinId: 'd2' },
        points: [],
        routeMode: 'grid',
      },
      {
        id: 'wy',
        from: { gateId: 'm3', pinId: 'out' },
        to: { gateId: 'y_out', pinId: 'in' },
        points: [],
        routeMode: 'grid',
      },
    ];
    const circ: CircuitDocument = { id: 'c_m3', name: 'Mux3', gates, wires };
    const proj = makeEmptyProject(circ);

    const expected = [0x3, 0x7, 0xb];
    for (let s = 0; s < 3; s++) {
      const snap = simulateCircuit(circ, proj, createEmptySequentialState(), {
        externalInputs: { sel_in: fromInt(s, 2) },
      });
      expect(toUnsignedInt(snap.pinValues['y_out:in'])).toBe(expected[s]);
    }
    // Out-of-range channel (sel = 3 on 3-input MUX) outputs X
    const snapX = simulateCircuit(circ, proj, createEmptySequentialState(), {
      externalInputs: { sel_in: fromInt(3, 2) },
    });
    expect(snapX.pinValues['y_out:in'].bits.every((b) => b === BIT_X)).toBe(true);
  });

  it('handles free-mode diagonal segment bending, free vertex dragging, and long-distance fallback routing', () => {
    // Diagonal segment drag inserts a bend point while keeping endpoints pinned
    const diag = [
      { x: 0, y: 0 },
      { x: 200, y: 100 },
    ];
    const bent = dragWireSegment(diag, 0, { x: 110, y: 20 }, 'free', 20);
    expect(bent).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 20 },
      { x: 200, y: 100 },
    ]);

    // Free vertex drag updates only the interior vertex
    const moved = dragWireWaypoint(bent, 1, { x: 130, y: 10 }, 'free', 20);
    expect(moved).toEqual([
      { x: 0, y: 0 },
      { x: 130, y: 10 },
      { x: 200, y: 100 },
    ]);

    // Long-distance grid route (>3600 cells) falls back quickly and stays orthogonal
    const circ: CircuitDocument = { id: 'c_far', name: 'Far', gates: [], wires: [] };
    const farPts = routeWire(
      { x: 0, y: 0 },
      { x: 4000, y: 3000 },
      {
        startSide: 'right',
        endSide: 'left',
        circuit: circ,
        routeMode: 'grid',
      },
    );
    expect(farPts[0]).toEqual({ x: 0, y: 0 });
    expect(farPts[farPts.length - 1]).toEqual({ x: 4000, y: 3000 });
    for (let i = 0; i < farPts.length - 1; i++) {
      expect(
        Math.min(Math.abs(farPts[i + 1].x - farPts[i].x), Math.abs(farPts[i + 1].y - farPts[i].y)),
      ).toBeLessThan(0.5);
    }

    // simplifyPolyline collapses collinear and duplicate points
    expect(
      simplifyPolyline([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 80 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
  });
});

describe('Canvas Hit-Testing & Viewport Coordinate Transforms', () => {
  it('round-trips screenToWorld and worldToScreen across zoom levels and offsets', () => {
    const viewports: Viewport[] = [
      { x: 0, y: 0, zoom: 1 },
      { x: -120, y: 85, zoom: 0.35 },
      { x: 450, y: -230, zoom: 2.75 },
    ];
    for (const vp of viewports) {
      const world = { x: 137.5, y: -42.25 };
      const screen = worldToScreen(world, vp);
      const back = screenToWorld(screen, vp);
      expect(back.x).toBeCloseTo(world.x, 6);
      expect(back.y).toBeCloseTo(world.y, 6);
    }
  });

  it('accurately hit-tests rotated gate pins, z-ordered gates, wires, handles, and inverted marquees', () => {
    const g1: GateInstance = {
      id: 'g1',
      type: 'AND',
      x: 200,
      y: 200,
      rotation: 90 as Rotation,
      label: 'A1',
      props: { inputCount: 2, bitWidth: 1 },
    };
    const g2: GateInstance = {
      id: 'g2',
      type: 'OR',
      x: 210,
      y: 200,
      rotation: 0,
      label: 'O1',
      props: { inputCount: 2, bitWidth: 1 },
    };
    const w1: Wire = {
      id: 'w1',
      points: [
        { x: 400, y: 100 },
        { x: 500, y: 100 },
        { x: 500, y: 220 },
      ],
      routeMode: 'grid',
    };
    const circ: CircuitDocument = { id: 'c_ht', name: 'HT', gates: [g1, g2], wires: [w1] };
    const proj = makeEmptyProject(circ);

    // Z-order: g2 is later in array, so overlapping point hits g2
    expect(hitTestGate({ x: 205, y: 200 }, circ, proj)?.id).toBe('g2');

    // Rotated pin hit test: g1 rotated 90 deg puts its 'out' pin at bottom (y = 200 + hw)
    const g1OutPin = getGatePins(g1, proj).find((p) => p.id === 'out')!;
    const outPos = getPinWorldPos(g1, g1OutPin);
    const pHit = hitTestPin({ x: outPos.x + 2, y: outPos.y - 2 }, circ, proj, 10);
    expect(pHit?.gate.id).toBe('g1');
    expect(pHit?.pin.id).toBe('out');

    // Wire segment orientation hit test
    const hHit = hitTestWire({ x: 450, y: 103 }, circ, 7);
    expect(hHit?.wire.id).toBe('w1');
    expect(hHit?.segIndex).toBe(0);
    expect(hHit?.orientation).toBe('h');

    const vHit = hitTestWire({ x: 502, y: 160 }, circ, 7);
    expect(vHit?.segIndex).toBe(1);
    expect(vHit?.orientation).toBe('v');

    // Wire handle hit test: corner vertex (500, 100) takes priority over segment midpoints
    const selectedW = new Set(['w1']);
    const cornerHandle = hitTestWireHandle({ x: 501, y: 99 }, circ, selectedW, 10);
    expect(cornerHandle?.kind).toBe('vertex');
    expect(cornerHandle?.index).toBe(1);

    const midHandle = hitTestWireHandle({ x: 450, y: 101 }, circ, selectedW, 10);
    expect(midHandle?.kind).toBe('segment');
    expect(midHandle?.index).toBe(0);
    expect(midHandle?.orientation).toBe('h');

    // Inverted marquee (dragged bottom-right to top-left) selects enclosed gates & wires
    const boxedGates = gatesInRect({ x1: 260, y1: 260, x2: 150, y2: 150 }, circ, proj);
    expect(boxedGates.map((g) => g.id)).toEqual(['g1', 'g2']);
    const boxedWires = wiresInRect({ x1: 520, y1: 240, x2: 390, y2: 90 }, circ);
    expect(boxedWires.map((w) => w.id)).toEqual(['w1']);
  });

  it('omits midpoint dots on 1-to-1 wire splices, keeps 3-way junctions, and detects floating wire endpoints', () => {
    // 1. Two wires meeting end-to-end (branch degree 2) -> ZERO midpoint dots
    const spliceWires: Wire[] = [
      {
        id: 'ws1',
        points: [
          { x: 0, y: 100 },
          { x: 100, y: 100 },
        ],
        routeMode: 'grid',
      },
      {
        id: 'ws2',
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
        ],
        routeMode: 'grid',
      },
    ];
    expect(findWireJunctions(spliceWires).length).toBe(0);

    // 2. Three wire ends meeting at (100, 100) (branch degree 3) -> ONE solder dot
    const starWires: Wire[] = [
      ...spliceWires,
      {
        id: 'ws3',
        points: [
          { x: 100, y: 100 },
          { x: 100, y: 200 },
        ],
        routeMode: 'grid',
      },
    ];
    const starJuncs = findWireJunctions(starWires);
    expect(starJuncs.length).toBe(1);
    expect(starJuncs[0].x).toBe(100);
    expect(starJuncs[0].y).toBe(100);

    // 3. Floating wire endpoint detection before vs after deleting host wire
    const gateA: GateInstance = {
      id: 'ga',
      type: 'TOGGLE',
      x: 40,
      y: 100,
      rotation: 0,
      label: 'A',
      props: { bitWidth: 1, value: '0' },
    };
    const gateB: GateInstance = {
      id: 'gb',
      type: 'LED',
      x: 240,
      y: 100,
      rotation: 0,
      label: 'B',
      props: { bitWidth: 1 },
    };
    const gateC: GateInstance = {
      id: 'gc',
      type: 'LED',
      x: 240,
      y: 220,
      rotation: 0,
      label: 'C',
      props: { bitWidth: 1 },
    };
    const aOut = getPinWorldPos(gateA, getGatePins(gateA)[0]);
    const bIn = getPinWorldPos(gateB, getGatePins(gateB)[0]);
    const cIn = getPinWorldPos(gateC, getGatePins(gateC)[0]);

    const hostWire: Wire = {
      id: 'w_host',
      from: { gateId: 'ga', pinId: 'out' },
      to: { gateId: 'gb', pinId: 'in' },
      points: [aOut, bIn],
      routeMode: 'grid',
    };
    const branchWire: Wire = {
      id: 'w_branch',
      from: { gateId: 'gc', pinId: 'in' },
      to: undefined,
      points: [cIn, { x: 140, y: cIn.y }, { x: 140, y: aOut.y }],
      routeMode: 'grid',
    };

    const circBefore: CircuitDocument = {
      id: 'c_float',
      name: 'Float',
      gates: [gateA, gateB, gateC],
      wires: [hostWire, branchWire],
    };
    const projBefore = makeEmptyProject(circBefore);
    // While hostWire exists, branchWire's open end touches hostWire -> NOT floating
    expect(getFloatingWireEndpoints(circBefore, projBefore).length).toBe(0);

    // Delete hostWire -> branchWire's tip at (140, aOut.y) becomes floating & hit-testable!
    const circAfter: CircuitDocument = {
      ...circBefore,
      wires: [branchWire],
    };
    const projAfter = makeEmptyProject(circAfter);
    const floats = getFloatingWireEndpoints(circAfter, projAfter);
    expect(floats.length).toBe(1);
    expect(floats[0].wire.id).toBe('w_branch');
    expect(floats[0].end).toBe('end');
    expect(floats[0].pos).toEqual({ x: 140, y: aOut.y });

    const hit = hitTestFloatingWireEnd({ x: 142, y: aOut.y + 2 }, circAfter, projAfter, 10);
    expect(hit?.wire.id).toBe('w_branch');
    expect(hit?.end).toBe('end');
    // Respects ignoreWireId when extending a wire so it doesn't target itself
    expect(
      hitTestFloatingWireEnd({ x: 140, y: aOut.y }, circAfter, projAfter, 10, 'w_branch'),
    ).toBeNull();

    // Outward direction inference
    expect(inferWireEndOutwardSide(branchWire.points, 'end')).toBe('top');
    expect(
      inferWireEndOutwardSide(
        [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
        ],
        'end',
      ),
    ).toBe('right');
    expect(
      inferWireEndOutwardSide(
        [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
        ],
        'start',
      ),
    ).toBe('left');
  });

  it('replaces components in-place while preserving wires, mapping semantic aliases, and floating excess endpoints', () => {
    expect(getCompatibleReplacementTypes('TOGGLE')).toContain('CLOCK');
    expect(getCompatibleReplacementTypes('AND')).toContain('OR');

    // 1. TOGGLE -> CLOCK keeps out wire attached & preserves position/rotation/label
    const circ1: CircuitDocument = {
      id: 'c_rep1',
      name: 'Rep1',
      gates: [
        {
          id: 'src',
          type: 'TOGGLE',
          x: 100,
          y: 120,
          rotation: 90,
          label: 'CLK_SRC',
          props: { bitWidth: 1, value: '1' },
        },
        {
          id: 'led',
          type: 'LED',
          x: 260,
          y: 120,
          rotation: 0,
          label: 'L',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        {
          id: 'w_clk',
          from: { gateId: 'src', pinId: 'out' },
          to: { gateId: 'led', pinId: 'in' },
          points: [
            { x: 100, y: 148 },
            { x: 238, y: 120 },
          ],
          routeMode: 'grid',
        },
      ],
    };
    const proj1 = makeEmptyProject(circ1);
    const res1 = applyGateReplacement(circ1, 'src', 'CLOCK', proj1);
    expect(res1.replaced).toBe(true);
    expect(res1.reattached).toBe(1);
    expect(res1.detachedToFloating).toBe(0);
    expect(circ1.gates[0].type).toBe('CLOCK');
    expect(circ1.gates[0].rotation).toBe(90);
    expect(circ1.gates[0].label).toBe('CLK_SRC');
    expect(circ1.wires[0].from).toEqual({ gateId: 'src', pinId: 'out' });

    // 2. 3-input AND -> 1-input NOT reattaches in0 & out and preserves in1/in2 wires as floating ends (never deletes them!)
    const circ2: CircuitDocument = {
      id: 'c_rep2',
      name: 'Rep2',
      gates: [
        {
          id: 'g_and',
          type: 'AND',
          x: 200,
          y: 120,
          rotation: 0,
          label: 'U1',
          props: { bitWidth: 4, inputCount: 3 },
        },
      ],
      wires: [
        {
          id: 'w0',
          to: { gateId: 'g_and', pinId: 'in0' },
          points: [
            { x: 60, y: 100 },
            { x: 166, y: 100 },
          ],
          routeMode: 'grid',
        },
        {
          id: 'w1',
          to: { gateId: 'g_and', pinId: 'in1' },
          points: [
            { x: 60, y: 120 },
            { x: 166, y: 120 },
          ],
          routeMode: 'grid',
        },
        {
          id: 'w2',
          to: { gateId: 'g_and', pinId: 'in2' },
          points: [
            { x: 60, y: 140 },
            { x: 166, y: 140 },
          ],
          routeMode: 'grid',
        },
        {
          id: 'wout',
          from: { gateId: 'g_and', pinId: 'out' },
          points: [
            { x: 234, y: 120 },
            { x: 320, y: 120 },
          ],
          routeMode: 'grid',
        },
      ],
    };
    const proj2 = makeEmptyProject(circ2);
    const res2 = applyGateReplacement(circ2, 'g_and', 'NOT', proj2);
    expect(res2.replaced).toBe(true);
    expect(res2.reattached).toBe(2);
    expect(res2.detachedToFloating).toBe(2);
    expect(circ2.wires.length).toBe(4);
    expect(circ2.gates[0].props.bitWidth).toBe(4);
    expect(circ2.wires.find((w) => w.id === 'w0')?.to).toEqual({ gateId: 'g_and', pinId: 'in0' });
    expect(circ2.wires.find((w) => w.id === 'w1')?.to).toBeUndefined();
    expect(circ2.wires.find((w) => w.id === 'w2')?.to).toBeUndefined();
    expect(circ2.wires.find((w) => w.id === 'wout')?.from).toEqual({
      gateId: 'g_and',
      pinId: 'out',
    });

    // 3. D_FF -> REGISTER maps semantic alias rst -> clr automatically
    const circ3: CircuitDocument = {
      id: 'c_rep3',
      name: 'Rep3',
      gates: [
        {
          id: 'ff',
          type: 'D_FF',
          x: 200,
          y: 120,
          rotation: 0,
          label: 'R',
          props: { bitWidth: 1 },
        },
      ],
      wires: [
        {
          id: 'wrst',
          to: { gateId: 'ff', pinId: 'rst' },
          points: [
            { x: 200, y: 200 },
            { x: 200, y: 164 },
          ],
          routeMode: 'grid',
        },
      ],
    };
    const proj3 = makeEmptyProject(circ3);
    const res3 = applyGateReplacement(circ3, 'ff', 'REGISTER', proj3);
    expect(res3.replaced).toBe(true);
    expect(circ3.wires[0].to).toEqual({ gateId: 'ff', pinId: 'clr' });
  });

  it('routes 2bit_Adder_Live sample with spacious left-to-right layout and minimal wire detours', () => {
    const sample = createSampleProject();
    const main = sample.circuits.circ_main;
    expect(main).toBeDefined();

    // No two gates overlap
    for (let i = 0; i < main.gates.length; i++) {
      const a = getGateBounds(main.gates[i], sample);
      for (let j = i + 1; j < main.gates.length; j++) {
        const b = getGateBounds(main.gates[j], sample);
        const overlaps =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlaps, `${main.gates[i].id} overlaps ${main.gates[j].id}`).toBe(false);
      }
    }

    // Every wire should flow cleanly left-to-right with minimal bends (no backward detours)
    const badWires: string[] = [];
    for (const w of main.wires) {
      let backtracks = false;
      for (let k = 1; k < w.points.length; k++) {
        if (w.points[k].x < w.points[k - 1].x) backtracks = true;
      }
      if (w.points.length > 6 || backtracks) {
        badWires.push(
          `${w.id} (${w.from?.gateId}->${w.to?.gateId}) len=${w.points.length} back=${backtracks} pts=${JSON.stringify(w.points)}`,
        );
      }
    }
    expect(badWires).toEqual([]);
  });

  it('supports 1..4 digit HEX configuration on SEVEN_SEG with clamped bit widths, sizes, and replacement inference', () => {
    expect(getSevenSegConfig({ segMode: 'hex' })).toEqual({
      mode: 'hex',
      digits: 1,
      bitWidth: 4,
    });
    expect(getSevenSegConfig({ segMode: 'hex', segDigits: 2 })).toEqual({
      mode: 'hex',
      digits: 2,
      bitWidth: 8,
    });
    expect(getSevenSegConfig({ segMode: 'hex', segDigits: 4 })).toEqual({
      mode: 'hex',
      digits: 4,
      bitWidth: 16,
    });
    // Clamped to 1..4 digits
    expect(getSevenSegConfig({ segMode: 'hex', segDigits: 0 }).digits).toBe(1);
    expect(getSevenSegConfig({ segMode: 'hex', segDigits: 8 })).toEqual({
      mode: 'hex',
      digits: 4,
      bitWidth: 16,
    });
    // Direct mode always 1 digit, 7 bits
    expect(getSevenSegConfig({ segMode: 'direct', segDigits: 4 })).toEqual({
      mode: 'direct',
      digits: 1,
      bitWidth: 7,
    });

    const seg1: GateInstance = {
      id: 's1',
      type: 'SEVEN_SEG',
      x: 100,
      y: 100,
      rotation: 0,
      label: '',
      props: { segMode: 'hex', segDigits: 1 },
    };
    const seg2: GateInstance = {
      ...seg1,
      id: 's2',
      props: { segMode: 'hex', segDigits: 2 },
    };
    const seg4: GateInstance = {
      ...seg1,
      id: 's4',
      props: { segMode: 'hex', segDigits: 4 },
    };
    expect(getGateSize(seg1)).toEqual({ width: 68, height: 96 });
    expect(getGateSize(seg2)).toEqual({ width: 120, height: 96 });
    expect(getGateSize(seg4)).toEqual({ width: 220, height: 96 });
    expect(getGatePins(seg1)[0].bitWidth).toBe(4);
    expect(getGatePins(seg2)[0].bitWidth).toBe(8);
    expect(getGatePins(seg4)[0].bitWidth).toBe(16);

    // Replacing an 8-bit NUM_DISPLAY with SEVEN_SEG auto-selects 2 digits (8bit)
    const circ: CircuitDocument = {
      id: 'c_seg_rep',
      name: 'SegRep',
      gates: [
        {
          id: 'nd',
          type: 'NUM_DISPLAY',
          x: 200,
          y: 100,
          rotation: 0,
          label: 'HEX8',
          props: { bitWidth: 8, radix: 'hex' },
        },
      ],
      wires: [],
    };
    const proj = makeEmptyProject(circ);
    applyGateReplacement(circ, 'nd', 'SEVEN_SEG', proj);
    expect(circ.gates[0].type).toBe('SEVEN_SEG');
    expect(circ.gates[0].props.segDigits).toBe(2);
    expect(circ.gates[0].props.bitWidth).toBe(8);
  });
});
