import {
  getGateBounds,
  getGatePins,
  getPinWorldPos,
  getPinWorldSide,
  GRID_SIZE,
  snapToGrid,
} from './catalog';
import { CircuitDocument, PinSide, Point, ProjectDocument, RouteMode, Wire } from './types';

function sideDir(side?: PinSide): Point {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
}

const COORD_BIAS = 1_000_000;
const COORD_STRIDE = 2_000_000;

function packCell(gx: number, gy: number): number {
  return (gx + COORD_BIAS) * COORD_STRIDE + (gy + COORD_BIAS);
}

export interface BatchWireRouter {
  route(
    start: Point,
    end: Point,
    options: {
      startSide?: PinSide;
      endSide?: PinSide;
      routeMode: RouteMode;
      preferredDetourY?: number;
      allowSharedDetourY?: boolean;
      fastMode?: boolean;
    },
  ): Point[];
}

/**
 * Incremental obstacle-aware wire router for batch routing (e.g. HDL auto-import).
 * Pre-indexes all gate obstacles ONCE and incrementally marks each newly routed wire,
 * reducing multi-hundred-wire batch routing from O(W^3) to ~O(W).
 */
export function createBatchWireRouter(
  circuit: CircuitDocument,
  project?: ProjectDocument,
  gridSize = GRID_SIZE,
): BatchWireRouter {
  const g = gridSize;
  const blockedCells = new Set<number>();
  const usedHoriz = new Set<number>();
  const usedVert = new Set<number>();
  const usedNodes = new Set<number>();

  interface GridGateBox {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    bx0: number;
    bx1: number;
  }
  const gateGridBoxes: GridGateBox[] = [];

  for (const gate of circuit.gates) {
    const b = getGateBounds(gate, project);
    const x0 = Math.floor((b.x - 2) / g);
    const x1 = Math.ceil((b.x + b.width + 2) / g);
    const y0 = Math.floor((b.y - 2) / g);
    const y1 = Math.ceil((b.y + b.height + 2) / g);
    gateGridBoxes.push({ x0, x1, y0, y1, bx0: b.x, bx1: b.x + b.width });
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        blockedCells.add(packCell(x, y));
      }
    }
  }

  const recordWirePoints = (pts: Point[]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const ax = Math.round(a.x / g);
      const ay = Math.round(a.y / g);
      const bx = Math.round(b.x / g);
      const by = Math.round(b.y / g);
      if (ax === bx) {
        const yMin = Math.min(ay, by);
        const yMax = Math.max(ay, by);
        for (let y = yMin; y < yMax; y++) {
          const k = packCell(ax, y);
          usedVert.add(k);
          usedNodes.add(k);
        }
      } else if (ay === by) {
        const xMin = Math.min(ax, bx);
        const xMax = Math.max(ax, bx);
        for (let x = xMin; x < xMax; x++) {
          const k = packCell(x, ay);
          usedHoriz.add(k);
          usedNodes.add(k);
        }
      }
    }
  };

  for (const wire of circuit.wires) {
    recordWirePoints(wire.points);
  }

  const findFreeChannelX = (
    baseGx: number,
    yA: number,
    yB: number,
    preferDir: -1 | 0 | 1 = 0,
    restrictDir: -1 | 0 | 1 = 0,
    horizY?: number,
    skipStartCell?: number,
    skipEndCell?: number,
  ): number => {
    const yMin = Math.min(yA, yB);
    const yMax = Math.max(yA, yB);
    const span = yMax - yMin;
    // Sample stride keeps scoring O(1)-bounded even on 5000px-tall layouts
    const yStep = span > 160 ? Math.ceil(span / 160) : 1;
    const scoreX = (cx: number) => {
      let cost = 0;
      for (let y = yMin; y <= yMax; y += yStep) {
        const k = packCell(cx, y);
        if (y < yMax && usedVert.has(k)) cost += 100;
        if (k !== skipStartCell && k !== skipEndCell && blockedCells.has(k)) cost += 250;
      }
      if (horizY !== undefined && cx !== baseGx) {
        const hxMin = Math.min(baseGx, cx);
        const hxMax = Math.max(baseGx, cx);
        for (let x = hxMin; x <= hxMax; x++) {
          if (x !== baseGx) {
            const hk = packCell(x, horizY);
            if (hk !== skipStartCell && hk !== skipEndCell && blockedCells.has(hk)) cost += 500;
          }
        }
      }
      return cost;
    };
    let bestGx = baseGx;
    let bestCost = scoreX(baseGx);
    if (bestCost === 0) return bestGx * g;
    for (let offset = 1; offset <= 16; offset++) {
      const cands =
        restrictDir > 0
          ? [baseGx + offset]
          : restrictDir < 0
            ? [baseGx - offset]
            : preferDir > 0
              ? [baseGx + offset, baseGx - offset]
              : [baseGx - offset, baseGx + offset];
      for (const cand of cands) {
        const c = scoreX(cand);
        if (c < bestCost) {
          bestCost = c;
          bestGx = cand;
          if (c === 0) return bestGx * g;
        }
      }
    }
    return bestGx * g;
  };

  const findFreeTrackY = (
    baseGy: number,
    xA: number,
    xB: number,
    stepDir: -1 | 1,
    ignoreWireOverlap = false,
    skipStartCell?: number,
    skipEndCell?: number,
  ): number => {
    const xMin = Math.min(xA, xB);
    const xMax = Math.max(xA, xB);
    const span = xMax - xMin;
    const xStep = span > 160 ? Math.ceil(span / 160) : 1;
    const scoreY = (cy: number) => {
      let cost = 0;
      for (let x = xMin; x <= xMax; x += xStep) {
        const k = packCell(x, cy);
        if (!ignoreWireOverlap && x < xMax && usedHoriz.has(k)) cost += 100;
        if (k !== skipStartCell && k !== skipEndCell && blockedCells.has(k)) cost += 250;
      }
      return cost;
    };
    let bestGy = baseGy;
    let bestCost = scoreY(baseGy);
    if (bestCost === 0) return bestGy * g;
    for (let offset = 1; offset <= 18; offset++) {
      const cand = baseGy + stepDir * offset;
      const c = scoreY(cand);
      if (c < bestCost) {
        bestCost = c;
        bestGy = cand;
        if (c === 0) return bestGy * g;
      }
    }
    return bestGy * g;
  };

  return {
    route(start, end, options) {
      const { startSide, endSide, routeMode, preferredDetourY, allowSharedDetourY, fastMode } =
        options;
      if (routeMode === 'free') {
        const pts = simplifyPolyline([start, end]);
        recordWirePoints(pts);
        return pts;
      }

      const sd = sideDir(startSide);
      const ed = sideDir(endSide);
      const sStub: Point = {
        x: snapToGrid(start.x + sd.x * g, g),
        y: snapToGrid(start.y + sd.y * g, g),
      };
      const eStub: Point = {
        x: snapToGrid(end.x + ed.x * g, g),
        y: snapToGrid(end.y + ed.y * g, g),
      };

      const gx0 = Math.round(sStub.x / g);
      const gy0 = Math.round(sStub.y / g);
      const gx1 = Math.round(eStub.x / g);
      const gy1 = Math.round(eStub.y / g);
      const startKey = packCell(gx0, gy0);
      const endKey = packCell(gx1, gy1);

      const buildDetourRoute = (
        detourGy: number,
        stepDir: -1 | 1,
        allowSharedY = false,
      ): Point[] => {
        const exitPref: -1 | 0 | 1 = sd.x > 0 ? 1 : sd.x < 0 ? -1 : 0;
        const entryPref: -1 | 0 | 1 = ed.x > 0 ? 1 : ed.x < 0 ? -1 : 0;
        const exitX = findFreeChannelX(
          gx0,
          gy0,
          detourGy,
          exitPref,
          exitPref,
          gy0,
          startKey,
          endKey,
        );
        const entryX = findFreeChannelX(
          gx1,
          detourGy,
          gy1,
          entryPref,
          entryPref,
          gy1,
          startKey,
          endKey,
        );
        const trackY = findFreeTrackY(
          detourGy,
          Math.round(exitX / g),
          Math.round(entryX / g),
          stepDir,
          allowSharedY,
          startKey,
          endKey,
        );
        return simplifyPolyline([
          start,
          sStub,
          { x: exitX, y: sStub.y },
          { x: exitX, y: trackY },
          { x: entryX, y: trackY },
          { x: entryX, y: eStub.y },
          eStub,
          end,
        ]);
      };

      if (preferredDetourY !== undefined) {
        const detourGy = Math.round(preferredDetourY / g);
        const stepDir: -1 | 1 = detourGy <= Math.min(gy0, gy1) ? -1 : 1;
        const pts = buildDetourRoute(detourGy, stepDir, Boolean(allowSharedDetourY));
        recordWirePoints(pts);
        return pts;
      }

      const spanMinX = Math.min(start.x, end.x) - g * 2;
      const spanMaxX = Math.max(start.x, end.x) + g * 2;
      let obsMinGy = Math.min(gy0, gy1);
      let obsMaxGy = Math.max(gy0, gy1);
      for (const gb of gateGridBoxes) {
        if (gb.bx1 >= spanMinX && gb.bx0 <= spanMaxX) {
          if (gb.y0 < obsMinGy) obsMinGy = gb.y0;
          if (gb.y1 > obsMaxGy) obsMaxGy = gb.y1;
        }
      }

      const buildFallbackRoute = (): Point[] => {
        const midX = findFreeChannelX(
          Math.round((gx0 + gx1) / 2),
          gy0,
          gy1,
          0,
          0,
          undefined,
          startKey,
          endKey,
        );
        const midGx = Math.round(midX / g);
        let hitsObstacle = gx1 < gx0;
        if (!hitsObstacle) {
          const checkH = (xA: number, xB: number, y: number) => {
            for (let x = Math.min(xA, xB); x <= Math.max(xA, xB); x++) {
              const k = packCell(x, y);
              if (k !== startKey && k !== endKey && blockedCells.has(k)) return true;
            }
            return false;
          };
          const checkV = (x: number, yA: number, yB: number) => {
            for (let y = Math.min(yA, yB); y <= Math.max(yA, yB); y++) {
              const k = packCell(x, y);
              if (k !== startKey && k !== endKey && blockedCells.has(k)) return true;
            }
            return false;
          };
          hitsObstacle =
            checkH(gx0, midGx, gy0) || checkV(midGx, gy0, gy1) || checkH(midGx, gx1, gy1);
        }

        if (!hitsObstacle) {
          return simplifyPolyline([
            start,
            sStub,
            { x: midX, y: sStub.y },
            { x: midX, y: eStub.y },
            eStub,
            end,
          ]);
        }

        const topGy = obsMinGy - 2;
        const botGy = obsMaxGy + 2;
        const distTop = Math.abs(gy0 - topGy) + Math.abs(gy1 - topGy);
        const distBot = Math.abs(gy0 - botGy) + Math.abs(gy1 - botGy);
        return distTop <= distBot ? buildDetourRoute(topGy, -1) : buildDetourRoute(botGy, 1);
      };

      const margin = 8;
      const minGx =
        startSide === 'right' && gx1 >= gx0
          ? gx0
          : endSide === 'right' && gx1 <= gx0
            ? gx1
            : Math.min(gx0, gx1) - margin;
      const maxGx =
        endSide === 'left' && gx1 >= gx0
          ? gx1
          : startSide === 'left' && gx1 <= gx0
            ? gx0
            : Math.max(gx0, gx1) + margin;
      const minGy = Math.min(Math.min(gy0, gy1) - margin, obsMinGy - 3);
      const maxGy = Math.max(Math.max(gy0, gy1) + margin, obsMaxGy + 3);

      const gridW = maxGx - minGx + 1;
      const gridH = maxGy - minGy + 1;
      const astarLimit = fastMode ? 2400 : 9000;
      if (
        gridW * gridH > astarLimit ||
        (fastMode && Math.abs(gx1 - gx0) + Math.abs(gy1 - gy0) > 45)
      ) {
        const pts = buildFallbackRoute();
        recordWirePoints(pts);
        return pts;
      }

      const cellCount = gridW * gridH;
      const totalStates = cellCount * 5;
      const bestCost = new Float64Array(totalStates);
      bestCost.fill(Infinity);
      const parentState = new Int32Array(totalStates);
      parentState.fill(-1);

      const heapState: number[] = [];
      const heapF: number[] = [];
      const heapG: number[] = [];

      const heapPush = (st: number, gCost: number, fCost: number) => {
        let i = heapState.length;
        heapState.push(st);
        heapG.push(gCost);
        heapF.push(fCost);
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapF[p] <= fCost) break;
          heapState[i] = heapState[p];
          heapG[i] = heapG[p];
          heapF[i] = heapF[p];
          i = p;
        }
        heapState[i] = st;
        heapG[i] = gCost;
        heapF[i] = fCost;
      };

      const heapPop = (): { st: number; gCost: number } => {
        const topSt = heapState[0];
        const topG = heapG[0];
        const lastIdx = heapState.length - 1;
        const lastSt = heapState.pop()!;
        const lastG = heapG.pop()!;
        const lastF = heapF.pop()!;
        if (lastIdx > 0) {
          let i = 0;
          const len = heapState.length;
          while (true) {
            const l = (i << 1) + 1;
            const r = l + 1;
            let smallest = i;
            if (l < len && heapF[l] < (smallest === i ? lastF : heapF[smallest])) smallest = l;
            if (r < len && heapF[r] < (smallest === i ? lastF : heapF[smallest])) smallest = r;
            if (smallest === i) break;
            heapState[i] = heapState[smallest];
            heapG[i] = heapG[smallest];
            heapF[i] = heapF[smallest];
            i = smallest;
          }
          heapState[i] = lastSt;
          heapG[i] = lastG;
          heapF[i] = lastF;
        }
        return { st: topSt, gCost: topG };
      };

      const dxArr = [1, -1, 0, 0];
      const dyArr = [0, 0, 1, -1];
      const startCell = (gy0 - minGy) * gridW + (gx0 - minGx);
      const goalCell = (gy1 - minGy) * gridW + (gx1 - minGx);
      const startState = startCell * 5 + 4;
      bestCost[startState] = 0;
      heapPush(startState, 0, Math.abs(gx1 - gx0) + Math.abs(gy1 - gy0));

      let foundState = -1;
      let expanded = 0;
      const MAX_EXPAND = fastMode ? 1200 : 6500;
      const midGx = (gx0 + gx1) / 2;
      const halfSpanX = Math.max(1, Math.abs(gx1 - gx0) / 2);
      const hasChannelRoom = Math.abs(gx1 - gx0) >= 3 && gy0 !== gy1;

      while (heapState.length > 0 && expanded < MAX_EXPAND) {
        const { st, gCost } = heapPop();
        if (gCost > bestCost[st]) continue;
        expanded++;

        const cell = Math.trunc(st / 5);
        if (cell === goalCell) {
          foundState = st;
          break;
        }
        const curDir = st - cell * 5;
        const ly = Math.trunc(cell / gridW);
        const lx = cell - ly * gridW;
        const curGx = lx + minGx;
        const curGy = ly + minGy;
        const curKey = packCell(curGx, curGy);

        for (let d = 0; d < 4; d++) {
          const nlx = lx + dxArr[d];
          const nly = ly + dyArr[d];
          if (nlx < 0 || nlx >= gridW || nly < 0 || nly >= gridH) continue;

          const nCell = nly * gridW + nlx;
          const nx = nlx + minGx;
          const ny = nly + minGy;
          const nKey = packCell(nx, ny);

          let stepCost = 1;
          if (curDir !== 4 && curDir !== d) stepCost += 0.65;
          if (nKey !== startKey && nKey !== endKey && blockedCells.has(nKey)) stepCost += 240;

          const segUsed =
            d === 0
              ? usedHoriz.has(curKey)
              : d === 1
                ? usedHoriz.has(nKey)
                : d === 2
                  ? usedVert.has(curKey)
                  : usedVert.has(nKey);
          if (segUsed) stepCost += 85;
          else if (usedNodes.has(nKey)) stepCost += 2.2;

          if (hasChannelRoom && (d === 2 || d === 3)) {
            const distRatio = Math.min(1.5, Math.abs(nx - midGx) / halfSpanX);
            stepCost += distRatio * 0.45;
            if (nx === gx0 || nx === gx1) stepCost += 0.9;
          }

          const ng = gCost + stepCost;
          const nState = nCell * 5 + d;
          if (bestCost[nState] <= ng) continue;
          bestCost[nState] = ng;
          parentState[nState] = st;
          const h = Math.abs(gx1 - nx) + Math.abs(gy1 - ny);
          heapPush(nState, ng, ng + h);
        }
      }

      let pts: Point[];
      if (foundState !== -1) {
        const gridPts: Point[] = [];
        let curSt = foundState;
        while (curSt !== -1) {
          const cell = Math.trunc(curSt / 5);
          const ly = Math.trunc(cell / gridW);
          const lx = cell - ly * gridW;
          gridPts.push({ x: (lx + minGx) * g, y: (ly + minGy) * g });
          curSt = parentState[curSt];
        }
        gridPts.reverse();
        pts = simplifyPolyline([start, ...gridPts, end]);
      } else {
        pts = buildFallbackRoute();
      }
      recordWirePoints(pts);
      return pts;
    },
  };
}

function segKey(ax: number, ay: number, bx: number, by: number): string {
  if (ax < bx || (ax === bx && ay < by)) return `${ax},${ay}-${bx},${by}`;
  return `${bx},${by}-${ax},${ay}`;
}

export function simplifyPolyline(points: Point[]): Point[] {
  if (points.length <= 2) return points;
  const dedup: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) > 0.5) {
      dedup.push(points[i]);
    }
  }
  if (dedup.length <= 2) return dedup;
  const out: Point[] = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = out[out.length - 1];
    const b = dedup[i];
    const c = dedup[i + 1];
    const collinearX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    const collinearY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    if (!collinearX && !collinearY) {
      out.push(b);
    }
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

/**
 * Obstacle-aware, anti-overlap orthogonal A* wire router (Grid-Fit) or direct polyline (Free).
 * Supports dedicated horizontal detour corridors (`preferredDetourY`) for global clock/reset rails
 * and right-to-left feedback signals so wires cleanly route around modules instead of crossing them.
 */
export function routeWire(
  start: Point,
  end: Point,
  options: {
    startSide?: PinSide;
    endSide?: PinSide;
    circuit: CircuitDocument;
    project?: ProjectDocument;
    routeMode: RouteMode;
    ignoreWireId?: string;
    gridSize?: number;
    /** Optional horizontal corridor Y (world coords) for detour routing around modules */
    preferredDetourY?: number;
    /** When true (e.g. shared global CLK/RST trunk), allow sharing the same horizontal rail Y */
    allowSharedDetourY?: boolean;
  },
): Point[] {
  const {
    startSide,
    endSide,
    circuit,
    project,
    routeMode,
    ignoreWireId,
    preferredDetourY,
    allowSharedDetourY,
  } = options;
  const g = options.gridSize ?? GRID_SIZE;

  if (routeMode === 'free') {
    return simplifyPolyline([start, end]);
  }

  // Compute grid-snapped entry/exit stub points slightly outside pins
  const sd = sideDir(startSide);
  const ed = sideDir(endSide);
  const sStub: Point = {
    x: snapToGrid(start.x + sd.x * g, g),
    y: snapToGrid(start.y + sd.y * g, g),
  };
  const eStub: Point = {
    x: snapToGrid(end.x + ed.x * g, g),
    y: snapToGrid(end.y + ed.y * g, g),
  };

  const gx0 = Math.round(sStub.x / g);
  const gy0 = Math.round(sStub.y / g);
  const gx1 = Math.round(eStub.x / g);
  const gy1 = Math.round(eStub.y / g);

  // Build obstacle grid (gate bodies) and track vertical extent of gates between start and end
  const blockedCells = new Set<string>();
  const spanMinX = Math.min(start.x, end.x) - g * 2;
  const spanMaxX = Math.max(start.x, end.x) + g * 2;
  let obsMinGy = Math.min(gy0, gy1);
  let obsMaxGy = Math.max(gy0, gy1);

  for (const gate of circuit.gates) {
    const b = getGateBounds(gate, project);
    const x0 = Math.floor((b.x - 2) / g);
    const x1 = Math.ceil((b.x + b.width + 2) / g);
    const y0 = Math.floor((b.y - 2) / g);
    const y1 = Math.ceil((b.y + b.height + 2) / g);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        blockedCells.add(`${x},${y}`);
      }
    }
    if (b.x + b.width >= spanMinX && b.x <= spanMaxX) {
      obsMinGy = Math.min(obsMinGy, y0);
      obsMaxGy = Math.max(obsMaxGy, y1);
    }
  }
  blockedCells.delete(`${gx0},${gy0}`);
  blockedCells.delete(`${gx1},${gy1}`);

  const margin = 8;
  // Prevent forward A* routes from looping backward behind right-facing source pins or past left-facing target pins!
  const minGx =
    startSide === 'right' && gx1 >= gx0
      ? gx0
      : endSide === 'right' && gx1 <= gx0
        ? gx1
        : Math.min(gx0, gx1) - margin;
  const maxGx =
    endSide === 'left' && gx1 >= gx0
      ? gx1
      : startSide === 'left' && gx1 <= gx0
        ? gx0
        : Math.max(gx0, gx1) + margin;
  const minGy = Math.min(Math.min(gy0, gy1) - margin, obsMinGy - 3);
  const maxGy = Math.max(Math.max(gy0, gy1) + margin, obsMaxGy + 3);

  const usedSegments = new Set<string>();
  const usedNodes = new Set<string>();
  for (const wire of circuit.wires) {
    if (wire.id === ignoreWireId) continue;
    for (let i = 0; i < wire.points.length - 1; i++) {
      const a = wire.points[i];
      const b = wire.points[i + 1];
      const ax = Math.round(a.x / g);
      const ay = Math.round(a.y / g);
      const bx = Math.round(b.x / g);
      const by = Math.round(b.y / g);
      if (ax === bx) {
        const yMin = Math.min(ay, by);
        const yMax = Math.max(ay, by);
        for (let y = yMin; y < yMax; y++) {
          usedSegments.add(segKey(ax, y, ax, y + 1));
          usedNodes.add(`${ax},${y}`);
        }
      } else if (ay === by) {
        const xMin = Math.min(ax, bx);
        const xMax = Math.max(ax, bx);
        for (let x = xMin; x < xMax; x++) {
          usedSegments.add(segKey(x, ay, x + 1, ay));
          usedNodes.add(`${x},${ay}`);
        }
      }
    }
  }

  /** Helper: pick a clean vertical channel X that avoids overlapping existing vertical segments & gates */
  const findFreeChannelX = (
    baseGx: number,
    yA: number,
    yB: number,
    preferDir: -1 | 0 | 1 = 0,
    restrictDir: -1 | 0 | 1 = 0,
    horizY?: number,
  ): number => {
    const yMin = Math.min(yA, yB);
    const yMax = Math.max(yA, yB);
    const scoreX = (cx: number) => {
      let cost = 0;
      for (let y = yMin; y <= yMax; y++) {
        if (y < yMax && usedSegments.has(segKey(cx, y, cx, y + 1))) cost += 100;
        if (blockedCells.has(`${cx},${y}`)) cost += 250;
      }
      if (horizY !== undefined && cx !== baseGx) {
        const hxMin = Math.min(baseGx, cx);
        const hxMax = Math.max(baseGx, cx);
        for (let x = hxMin; x <= hxMax; x++) {
          if (x !== baseGx && blockedCells.has(`${x},${horizY}`)) cost += 500;
        }
      }
      return cost;
    };
    let bestGx = baseGx;
    let bestCost = scoreX(baseGx);
    if (bestCost === 0) return bestGx * g;
    for (let offset = 1; offset <= 16; offset++) {
      const cands =
        restrictDir > 0
          ? [baseGx + offset]
          : restrictDir < 0
            ? [baseGx - offset]
            : preferDir > 0
              ? [baseGx + offset, baseGx - offset]
              : [baseGx - offset, baseGx + offset];
      for (const cand of cands) {
        const c = scoreX(cand);
        if (c < bestCost) {
          bestCost = c;
          bestGx = cand;
          if (c === 0) return bestGx * g;
        }
      }
    }
    return bestGx * g;
  };

  /** Helper: pick a clean horizontal rail Y that avoids overlapping gates and parallel horizontal wires */
  const findFreeTrackY = (
    baseGy: number,
    xA: number,
    xB: number,
    stepDir: -1 | 1,
    ignoreWireOverlap = false,
  ): number => {
    const xMin = Math.min(xA, xB);
    const xMax = Math.max(xA, xB);
    const scoreY = (cy: number) => {
      let cost = 0;
      for (let x = xMin; x <= xMax; x++) {
        if (!ignoreWireOverlap && x < xMax && usedSegments.has(segKey(x, cy, x + 1, cy))) {
          cost += 100;
        }
        if (blockedCells.has(`${x},${cy}`)) cost += 250;
      }
      return cost;
    };
    let bestGy = baseGy;
    let bestCost = scoreY(baseGy);
    if (bestCost === 0) return bestGy * g;
    for (let offset = 1; offset <= 18; offset++) {
      const cand = baseGy + stepDir * offset;
      const c = scoreY(cand);
      if (c < bestCost) {
        bestCost = c;
        bestGy = cand;
        if (c === 0) return bestGy * g;
      }
    }
    return bestGy * g;
  };

  /** Build a clean obstacle-free U-detour path along a horizontal rail at `detourGy` */
  const buildDetourRoute = (detourGy: number, stepDir: -1 | 1, allowSharedY = false): Point[] => {
    const exitPref: -1 | 0 | 1 = sd.x > 0 ? 1 : sd.x < 0 ? -1 : 0;
    const entryPref: -1 | 0 | 1 = ed.x > 0 ? 1 : ed.x < 0 ? -1 : 0;
    // Constrain channel search to the pin's outward half-space so wires NEVER cut backward through their own gate body!
    const exitX = findFreeChannelX(gx0, gy0, detourGy, exitPref, exitPref, gy0);
    const entryX = findFreeChannelX(gx1, detourGy, gy1, entryPref, entryPref, gy1);
    const trackY = findFreeTrackY(
      detourGy,
      Math.round(exitX / g),
      Math.round(entryX / g),
      stepDir,
      allowSharedY,
    );
    return simplifyPolyline([
      start,
      sStub,
      { x: exitX, y: sStub.y },
      { x: exitX, y: trackY },
      { x: entryX, y: trackY },
      { x: entryX, y: eStub.y },
      eStub,
      end,
    ]);
  };

  // Explicit corridor routing (global CLK/RST top rail or right-to-left feedback bottom rail)
  if (preferredDetourY !== undefined) {
    const detourGy = Math.round(preferredDetourY / g);
    const stepDir: -1 | 1 = detourGy <= Math.min(gy0, gy1) ? -1 : 1;
    return buildDetourRoute(detourGy, stepDir, Boolean(allowSharedDetourY));
  }

  /** Obstacle-aware fallback when A* area is huge or exhausted */
  const buildFallbackRoute = (): Point[] => {
    // Check if a clean Z-route intersects any blocked gate cells
    const midX = findFreeChannelX(Math.round((gx0 + gx1) / 2), gy0, gy1);
    const midGx = Math.round(midX / g);
    let hitsObstacle = gx1 < gx0; // right-to-left wires prefer detouring around modules
    if (!hitsObstacle) {
      const checkH = (xA: number, xB: number, y: number) => {
        for (let x = Math.min(xA, xB); x <= Math.max(xA, xB); x++) {
          if (blockedCells.has(`${x},${y}`)) return true;
        }
        return false;
      };
      const checkV = (x: number, yA: number, yB: number) => {
        for (let y = Math.min(yA, yB); y <= Math.max(yA, yB); y++) {
          if (blockedCells.has(`${x},${y}`)) return true;
        }
        return false;
      };
      hitsObstacle = checkH(gx0, midGx, gy0) || checkV(midGx, gy0, gy1) || checkH(midGx, gx1, gy1);
    }

    if (!hitsObstacle) {
      return simplifyPolyline([
        start,
        sStub,
        { x: midX, y: sStub.y },
        { x: midX, y: eStub.y },
        eStub,
        end,
      ]);
    }

    // Choose shorter vertical detour: above all intervening gates vs below all intervening gates
    const topGy = obsMinGy - 2;
    const botGy = obsMaxGy + 2;
    const distTop = Math.abs(gy0 - topGy) + Math.abs(gy1 - topGy);
    const distBot = Math.abs(gy0 - botGy) + Math.abs(gy1 - botGy);
    return distTop <= distBot ? buildDetourRoute(topGy, -1) : buildDetourRoute(botGy, 1);
  };

  // Limit A* search box for very long routes to guarantee snappy frame times
  const gridW = maxGx - minGx + 1;
  const gridH = maxGy - minGy + 1;
  if (gridW * gridH > 9000) {
    return buildFallbackRoute();
  }

  // Fast flat TypedArray lookup grids + Binary Min-Heap A* (50x-100x faster than string Maps + linear scan!)
  const cellCount = gridW * gridH;
  const blockedArr = new Uint8Array(cellCount);
  const usedNodeArr = new Uint8Array(cellCount);
  const usedHorizArr = new Uint8Array(cellCount); // segment (x,y)-(x+1,y)
  const usedVertArr = new Uint8Array(cellCount); // segment (x,y)-(x,y+1)

  for (const gate of circuit.gates) {
    const b = getGateBounds(gate, project);
    const x0 = Math.max(minGx, Math.floor((b.x - 2) / g));
    const x1 = Math.min(maxGx, Math.ceil((b.x + b.width + 2) / g));
    const y0 = Math.max(minGy, Math.floor((b.y - 2) / g));
    const y1 = Math.min(maxGy, Math.ceil((b.y + b.height + 2) / g));
    for (let y = y0; y <= y1; y++) {
      const row = (y - minGy) * gridW;
      for (let x = x0; x <= x1; x++) {
        blockedArr[row + (x - minGx)] = 1;
      }
    }
  }
  blockedArr[(gy0 - minGy) * gridW + (gx0 - minGx)] = 0;
  blockedArr[(gy1 - minGy) * gridW + (gx1 - minGx)] = 0;

  for (const wire of circuit.wires) {
    if (wire.id === ignoreWireId) continue;
    for (let i = 0; i < wire.points.length - 1; i++) {
      const a = wire.points[i];
      const b = wire.points[i + 1];
      const ax = Math.round(a.x / g);
      const ay = Math.round(a.y / g);
      const bx = Math.round(b.x / g);
      const by = Math.round(b.y / g);
      if (ax === bx && ax >= minGx && ax <= maxGx) {
        const yMin = Math.max(minGy, Math.min(ay, by));
        const yMax = Math.min(maxGy, Math.max(ay, by));
        const lx = ax - minGx;
        for (let y = yMin; y < yMax; y++) {
          const idx = (y - minGy) * gridW + lx;
          usedVertArr[idx] = 1;
          usedNodeArr[idx] = 1;
        }
      } else if (ay === by && ay >= minGy && ay <= maxGy) {
        const xMin = Math.max(minGx, Math.min(ax, bx));
        const xMax = Math.min(maxGx, Math.max(ax, bx));
        const row = (ay - minGy) * gridW;
        for (let x = xMin; x < xMax; x++) {
          const idx = row + (x - minGx);
          usedHorizArr[idx] = 1;
          usedNodeArr[idx] = 1;
        }
      }
    }
  }

  // Binary min-heap keyed by fCost with O(1) TypedArray state & parent tracking
  const totalStates = cellCount * 5; // dir: 0..3 plus 4 = start(-1)
  const bestCost = new Float64Array(totalStates);
  bestCost.fill(Infinity);
  const parentState = new Int32Array(totalStates);
  parentState.fill(-1);

  const heapState: number[] = [];
  const heapF: number[] = [];
  const heapG: number[] = [];

  const heapPush = (st: number, gCost: number, fCost: number) => {
    let i = heapState.length;
    heapState.push(st);
    heapG.push(gCost);
    heapF.push(fCost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= fCost) break;
      heapState[i] = heapState[p];
      heapG[i] = heapG[p];
      heapF[i] = heapF[p];
      i = p;
    }
    heapState[i] = st;
    heapG[i] = gCost;
    heapF[i] = fCost;
  };

  const heapPop = (): { st: number; gCost: number } => {
    const topSt = heapState[0];
    const topG = heapG[0];
    const lastIdx = heapState.length - 1;
    const lastSt = heapState.pop()!;
    const lastG = heapG.pop()!;
    const lastF = heapF.pop()!;
    if (lastIdx > 0) {
      let i = 0;
      const len = heapState.length;
      while (true) {
        const l = (i << 1) + 1;
        const r = l + 1;
        let smallest = i;
        if (l < len && heapF[l] < (smallest === i ? lastF : heapF[smallest])) smallest = l;
        if (r < len && heapF[r] < (smallest === i ? lastF : heapF[smallest])) smallest = r;
        if (smallest === i) break;
        heapState[i] = heapState[smallest];
        heapG[i] = heapG[smallest];
        heapF[i] = heapF[smallest];
        i = smallest;
      }
      heapState[i] = lastSt;
      heapG[i] = lastG;
      heapF[i] = lastF;
    }
    return { st: topSt, gCost: topG };
  };

  const dxArr = [1, -1, 0, 0];
  const dyArr = [0, 0, 1, -1];
  const startCell = (gy0 - minGy) * gridW + (gx0 - minGx);
  const goalCell = (gy1 - minGy) * gridW + (gx1 - minGx);
  const startState = startCell * 5 + 4;
  bestCost[startState] = 0;
  heapPush(startState, 0, Math.abs(gx1 - gx0) + Math.abs(gy1 - gy0));

  let foundState = -1;
  let expanded = 0;
  const MAX_EXPAND = 6500;
  const midGx = (gx0 + gx1) / 2;
  const halfSpanX = Math.max(1, Math.abs(gx1 - gx0) / 2);
  const hasChannelRoom = Math.abs(gx1 - gx0) >= 3 && gy0 !== gy1;

  while (heapState.length > 0 && expanded < MAX_EXPAND) {
    const { st, gCost } = heapPop();
    if (gCost > bestCost[st]) continue; // stale duplicate heap entry
    expanded++;

    const cell = Math.trunc(st / 5);
    if (cell === goalCell) {
      foundState = st;
      break;
    }
    const curDir = st - cell * 5;
    const ly = Math.trunc(cell / gridW);
    const lx = cell - ly * gridW;

    for (let d = 0; d < 4; d++) {
      const nlx = lx + dxArr[d];
      const nly = ly + dyArr[d];
      if (nlx < 0 || nlx >= gridW || nly < 0 || nly >= gridH) continue;

      const nCell = nly * gridW + nlx;
      let stepCost = 1;
      if (curDir !== 4 && curDir !== d) stepCost += 0.65;
      if (blockedArr[nCell]) stepCost += 240;

      // Check segment overlap via flat typed arrays (zero string allocations!)
      const segUsed =
        d === 0
          ? usedHorizArr[cell]
          : d === 1
            ? usedHorizArr[nCell]
            : d === 2
              ? usedVertArr[cell]
              : usedVertArr[nCell];
      if (segUsed) stepCost += 85;
      else if (usedNodeArr[nCell]) stepCost += 2.2;

      if (hasChannelRoom && (d === 2 || d === 3)) {
        const nx = nlx + minGx;
        const distRatio = Math.min(1.5, Math.abs(nx - midGx) / halfSpanX);
        stepCost += distRatio * 0.45;
        if (nx === gx0 || nx === gx1) stepCost += 0.9;
      }

      const ng = gCost + stepCost;
      const nState = nCell * 5 + d;
      if (bestCost[nState] <= ng) continue;
      bestCost[nState] = ng;
      parentState[nState] = st;
      const h = Math.abs(gx1 - (nlx + minGx)) + Math.abs(gy1 - (nly + minGy));
      heapPush(nState, ng, ng + h);
    }
  }

  if (foundState !== -1) {
    const gridPts: Point[] = [];
    let curSt = foundState;
    while (curSt !== -1) {
      const cell = Math.trunc(curSt / 5);
      const ly = Math.trunc(cell / gridW);
      const lx = cell - ly * gridW;
      gridPts.push({ x: (lx + minGx) * g, y: (ly + minGy) * g });
      curSt = parentState[curSt];
    }
    gridPts.reverse();
    return simplifyPolyline([start, ...gridPts, end]);
  }

  return buildFallbackRoute();
}

/** Update wires attached to moved gates so they stay cleanly attached and non-overlapping */
export function rerouteWiresForGates(
  movedGateIds: Set<string>,
  circuit: CircuitDocument,
  project?: ProjectDocument,
): Wire[] {
  const gateMap = new Map(circuit.gates.map((g) => [g.id, g]));
  const pinCache = new Map<string, ReturnType<typeof getGatePins>>();

  const lookupPin = (gateId: string, pinId: string) => {
    const gate = gateMap.get(gateId);
    if (!gate) return null;
    let pins = pinCache.get(gateId);
    if (!pins) {
      pins = getGatePins(gate, project);
      pinCache.set(gateId, pins);
    }
    const pin = pins.find((p) => p.id === pinId);
    if (!pin) return null;
    return {
      pos: getPinWorldPos(gate, pin),
      side: getPinWorldSide(pin.side, gate.rotation),
    };
  };

  // Clone array progressively so later re-routed wires avoid earlier ones
  const nextWires = circuit.wires.map((w) => ({ ...w, points: w.points.slice() }));
  const tempCircuit: CircuitDocument = { ...circuit, wires: nextWires };

  for (let i = 0; i < nextWires.length; i++) {
    const w = nextWires[i];
    const fromMoved = w.from && movedGateIds.has(w.from.gateId);
    const toMoved = w.to && movedGateIds.has(w.to.gateId);
    if (!fromMoved && !toMoved) continue;

    const fromInfo = w.from ? lookupPin(w.from.gateId, w.from.pinId) : null;
    const toInfo = w.to ? lookupPin(w.to.gateId, w.to.pinId) : null;

    const startPt = fromInfo ? fromInfo.pos : w.points[0];
    const endPt = toInfo ? toInfo.pos : w.points[w.points.length - 1];

    if (w.routeMode === 'free' && w.points.length > 2) {
      const pts = w.points.slice();
      pts[0] = startPt;
      pts[pts.length - 1] = endPt;
      nextWires[i] = { ...w, points: pts };
    } else {
      const routed = routeWire(startPt, endPt, {
        startSide: fromInfo?.side,
        endSide: toInfo?.side,
        circuit: tempCircuit,
        project,
        routeMode: w.routeMode,
        ignoreWireId: w.id,
      });
      nextWires[i] = { ...w, points: routed };
    }
  }

  return nextWires;
}

export interface WireCrossing {
  wireId: string;
  segIndex: number;
  x: number;
  y: number;
}

/** Detect orthogonal non-connected crossings (horizontal over vertical) so renderer draws bridge hops.
 * Deduplicates overlapping vertical crossings at the same (or very close) X on a horizontal segment
 * so the renderer never backtracks a straight line through an already-drawn bridge arc!
 */
export function findOrthogonalCrossings(wires: Wire[]): WireCrossing[] {
  interface VSeg {
    wireIdx: number;
    x: number;
    yMin: number;
    yMax: number;
  }
  const vSegs: VSeg[] = [];
  for (let j = 0; j < wires.length; j++) {
    const wb = wires[j];
    for (let sj = 0; sj < wb.points.length - 1; sj++) {
      const b1 = wb.points[sj];
      const b2 = wb.points[sj + 1];
      if (Math.abs(b1.x - b2.x) > 0.5) continue;
      const vyMin = Math.min(b1.y, b2.y);
      const vyMax = Math.max(b1.y, b2.y);
      if (vyMax - vyMin < 14) continue;
      vSegs.push({ wireIdx: j, x: b1.x, yMin: vyMin, yMax: vyMax });
    }
  }
  if (vSegs.length === 0) return [];
  vSegs.sort((a, b) => a.x - b.x);

  // Binary search lower bound for vSegs[idx].x > targetX
  const lowerBound = (targetX: number): number => {
    let lo = 0;
    let hi = vSegs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (vSegs[mid].x <= targetX) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const crossings: WireCrossing[] = [];
  for (let i = 0; i < wires.length; i++) {
    const wa = wires[i];
    for (let si = 0; si < wa.points.length - 1; si++) {
      const a1 = wa.points[si];
      const a2 = wa.points[si + 1];
      // Only place hop on horizontal segments crossing vertical segments of other wires
      if (Math.abs(a1.y - a2.y) > 0.5) continue;
      const hy = a1.y;
      const hxMin = Math.min(a1.x, a2.x);
      const hxMax = Math.max(a1.x, a2.x);
      if (hxMax - hxMin < 14) continue;

      const xLo = hxMin + 7;
      const xHi = hxMax - 7;
      let lastX = -Infinity;
      for (let idx = lowerBound(xLo); idx < vSegs.length; idx++) {
        const vs = vSegs[idx];
        if (vs.x >= xHi) break;
        if (vs.wireIdx === i) continue;
        if (hy > vs.yMin + 7 && hy < vs.yMax - 7) {
          // vSegs is already sorted by x, so we can deduplicate on the fly!
          if (vs.x - lastX >= 12) {
            crossings.push({ wireId: wa.id, segIndex: si, x: vs.x, y: hy });
            lastX = vs.x;
          }
        }
      }
    }
  }
  return crossings;
}

/**
 * Detect genuine T-junction / multi-way branch solder dots (degree >= 3).
 * Two wires meeting 1-to-1 end-to-end have branch degree 2 and do NOT get a spurious midpoint dot;
 * an endpoint landing in the interior of another wire counts as 1 + 2 = 3 branches (gets a dot),
 * and 3+ wire endpoints meeting at the same point also count as >= 3 branches (gets a dot).
 */
export function findWireJunctions(wires: Wire[]): { x: number; y: number; wireId: string }[] {
  const junctions: { x: number; y: number; wireId: string }[] = [];
  const seen = new Set<string>();
  const EPS = 3;

  // Spatial grid bucket (cell size = 20px) for O(1) endpoint/segment lookup on huge circuits
  const CELL = 20;
  const endBuckets = new Map<number, { x: number; y: number; wireIdx: number }[]>();
  const hSegBuckets = new Map<
    number,
    { wireIdx: number; y: number; xMin: number; xMax: number }[]
  >();
  const vSegBuckets = new Map<
    number,
    { wireIdx: number; x: number; yMin: number; yMax: number }[]
  >();
  const diagSegs: { wireIdx: number; a: Point; b: Point }[] = [];

  const pushBucket = <T>(map: Map<number, T[]>, key: number, item: T) => {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(item);
  };

  for (let j = 0; j < wires.length; j++) {
    const wb = wires[j];
    if (wb.points.length < 2) continue;
    const wStart = wb.points[0];
    const wEnd = wb.points[wb.points.length - 1];
    pushBucket(endBuckets, packCell(Math.round(wStart.x / CELL), Math.round(wStart.y / CELL)), {
      x: wStart.x,
      y: wStart.y,
      wireIdx: j,
    });
    if (Math.hypot(wEnd.x - wStart.x, wEnd.y - wStart.y) > EPS) {
      pushBucket(endBuckets, packCell(Math.round(wEnd.x / CELL), Math.round(wEnd.y / CELL)), {
        x: wEnd.x,
        y: wEnd.y,
        wireIdx: j,
      });
    }
    for (let k = 0; k < wb.points.length - 1; k++) {
      const a = wb.points[k];
      const b = wb.points[k + 1];
      if (Math.abs(a.y - b.y) <= 0.5) {
        const yKey = Math.round(a.y / CELL);
        pushBucket(hSegBuckets, yKey, {
          wireIdx: j,
          y: a.y,
          xMin: Math.min(a.x, b.x),
          xMax: Math.max(a.x, b.x),
        });
      } else if (Math.abs(a.x - b.x) <= 0.5) {
        const xKey = Math.round(a.x / CELL);
        pushBucket(vSegBuckets, xKey, {
          wireIdx: j,
          x: a.x,
          yMin: Math.min(a.y, b.y),
          yMax: Math.max(a.y, b.y),
        });
      } else {
        diagSegs.push({ wireIdx: j, a, b });
      }
    }
  }

  for (let i = 0; i < wires.length; i++) {
    const wa = wires[i];
    if (wa.points.length < 2) continue;
    const ends = [wa.points[0], wa.points[wa.points.length - 1]];
    for (const ep of ends) {
      const key = `${Math.round(ep.x)},${Math.round(ep.y)}`;
      if (seen.has(key)) continue;

      let branchCount = 0;
      const matchedWireEnd = new Set<number>();
      const cx = Math.round(ep.x / CELL);
      const cy = Math.round(ep.y / CELL);

      // 1. Check nearby endpoints in 3x3 grid neighborhood
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = endBuckets.get(packCell(cx + dx, cy + dy));
          if (!list) continue;
          for (const item of list) {
            if (Math.hypot(ep.x - item.x, ep.y - item.y) <= EPS) {
              branchCount += 1;
              matchedWireEnd.add(item.wireIdx);
            }
          }
        }
      }

      // 2. If < 3 already, check if ep lies strictly in interior of any horizontal/vertical/diagonal segment
      if (branchCount < 3) {
        for (let dy = -1; dy <= 1 && branchCount < 3; dy++) {
          const hList = hSegBuckets.get(cy + dy);
          if (!hList) continue;
          for (const hs of hList) {
            if (matchedWireEnd.has(hs.wireIdx)) continue;
            if (Math.abs(ep.y - hs.y) <= EPS && ep.x >= hs.xMin - EPS && ep.x <= hs.xMax + EPS) {
              branchCount += 2;
              matchedWireEnd.add(hs.wireIdx);
              if (branchCount >= 3) break;
            }
          }
        }
      }

      if (branchCount < 3) {
        for (let dx = -1; dx <= 1 && branchCount < 3; dx++) {
          const vList = vSegBuckets.get(cx + dx);
          if (!vList) continue;
          for (const vs of vList) {
            if (matchedWireEnd.has(vs.wireIdx)) continue;
            if (Math.abs(ep.x - vs.x) <= EPS && ep.y >= vs.yMin - EPS && ep.y <= vs.yMax + EPS) {
              branchCount += 2;
              matchedWireEnd.add(vs.wireIdx);
              if (branchCount >= 3) break;
            }
          }
        }
      }

      if (branchCount < 3 && diagSegs.length > 0) {
        for (const ds of diagSegs) {
          if (matchedWireEnd.has(ds.wireIdx)) continue;
          const minX = Math.min(ds.a.x, ds.b.x) - EPS;
          const maxX = Math.max(ds.a.x, ds.b.x) + EPS;
          const minY = Math.min(ds.a.y, ds.b.y) - EPS;
          const maxY = Math.max(ds.a.y, ds.b.y) + EPS;
          if (ep.x >= minX && ep.x <= maxX && ep.y >= minY && ep.y <= maxY) {
            const dx = ds.b.x - ds.a.x;
            const dy = ds.b.y - ds.a.y;
            const len = Math.hypot(dx, dy);
            const dist =
              len < 1e-6
                ? Math.hypot(ep.x - ds.a.x, ep.y - ds.a.y)
                : Math.abs((ep.x - ds.a.x) * dy - (ep.y - ds.a.y) * dx) / len;
            if (dist <= EPS) {
              branchCount += 2;
              matchedWireEnd.add(ds.wireIdx);
              if (branchCount >= 3) break;
            }
          }
        }
      }

      if (branchCount >= 3) {
        seen.add(key);
        junctions.push({ x: ep.x, y: ep.y, wireId: wa.id });
      }
    }
  }
  return junctions;
}

export function getSegmentOrientation(a: Point, b: Point): 'h' | 'v' | 'diag' {
  if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) >= 0.5) return 'h';
  if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= 0.5) return 'v';
  return 'diag';
}

/** Infer the outward continuation side at a floating wire tip so A* extends smoothly forward */
export function inferWireEndOutwardSide(
  points: Point[],
  end: 'start' | 'end',
): PinSide | undefined {
  if (points.length < 2) return undefined;
  const tip = end === 'start' ? points[0] : points[points.length - 1];
  const neighbor = end === 'start' ? points[1] : points[points.length - 2];
  const dx = tip.x - neighbor.x;
  const dy = tip.y - neighbor.y;
  if (Math.hypot(dx, dy) < 0.5) return undefined;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/**
 * Manually drag a wire segment while keeping both pin endpoints fixed.
 * - Horizontal segment: shifts Y (inserting corner stubs if touching an endpoint)
 * - Vertical segment: shifts X (inserting corner stubs if touching an endpoint)
 * - Diagonal segment: bends the segment by inserting a waypoint at targetWorld
 */
export function dragWireSegment(
  origPoints: Point[],
  segIndex: number,
  targetWorld: Point,
  routeMode: RouteMode,
  gridSize = GRID_SIZE,
): Point[] {
  if (origPoints.length < 2 || segIndex < 0 || segIndex >= origPoints.length - 1) {
    return origPoints.slice();
  }
  const pts = origPoints.map((p) => ({ x: p.x, y: p.y }));
  const a = pts[segIndex];
  const b = pts[segIndex + 1];
  const orient = getSegmentOrientation(a, b);
  const snap = routeMode === 'grid';

  if (orient === 'h') {
    const newY = snap ? snapToGrid(targetWorld.y, gridSize) : Math.round(targetWorld.y);
    const touchesStart = segIndex === 0;
    const touchesEnd = segIndex === pts.length - 2;
    const result: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === segIndex) {
        if (touchesStart) {
          result.push({ x: a.x, y: a.y });
          result.push({ x: a.x, y: newY });
        } else {
          result.push({ x: a.x, y: newY });
        }
      } else if (i === segIndex + 1) {
        if (touchesEnd) {
          result.push({ x: b.x, y: newY });
          result.push({ x: b.x, y: b.y });
        } else {
          result.push({ x: b.x, y: newY });
        }
      } else {
        result.push(pts[i]);
      }
    }
    return result;
  }

  if (orient === 'v') {
    const newX = snap ? snapToGrid(targetWorld.x, gridSize) : Math.round(targetWorld.x);
    const touchesStart = segIndex === 0;
    const touchesEnd = segIndex === pts.length - 2;
    const result: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === segIndex) {
        if (touchesStart) {
          result.push({ x: a.x, y: a.y });
          result.push({ x: newX, y: a.y });
        } else {
          result.push({ x: newX, y: a.y });
        }
      } else if (i === segIndex + 1) {
        if (touchesEnd) {
          result.push({ x: newX, y: b.y });
          result.push({ x: b.x, y: b.y });
        } else {
          result.push({ x: newX, y: b.y });
        }
      } else {
        result.push(pts[i]);
      }
    }
    return result;
  }

  // Diagonal segment: insert a bend waypoint at targetWorld
  const bend: Point = {
    x: snap ? snapToGrid(targetWorld.x, gridSize) : Math.round(targetWorld.x),
    y: snap ? snapToGrid(targetWorld.y, gridSize) : Math.round(targetWorld.y),
  };
  pts.splice(segIndex + 1, 0, bend);
  return pts;
}

/**
 * Manually drag an interior corner/waypoint (0 < pointIndex < points.length - 1).
 * In grid mode, keeps adjacent segments orthogonal while keeping pin endpoints fixed.
 */
export function dragWireWaypoint(
  origPoints: Point[],
  pointIndex: number,
  targetWorld: Point,
  routeMode: RouteMode,
  gridSize = GRID_SIZE,
): Point[] {
  if (pointIndex <= 0 || pointIndex >= origPoints.length - 1) {
    return origPoints.slice();
  }
  const pts = origPoints.map((p) => ({ x: p.x, y: p.y }));
  const nx = routeMode === 'grid' ? snapToGrid(targetWorld.x, gridSize) : Math.round(targetWorld.x);
  const ny = routeMode === 'grid' ? snapToGrid(targetWorld.y, gridSize) : Math.round(targetWorld.y);

  if (routeMode === 'free') {
    pts[pointIndex] = { x: nx, y: ny };
    return pts;
  }

  // Grid mode: preserve orthogonality on both incident segments
  const prev = pts[pointIndex - 1];
  const cur = pts[pointIndex];
  const next = pts[pointIndex + 1];
  const prevOrient = getSegmentOrientation(prev, cur);
  const nextOrient = getSegmentOrientation(cur, next);

  const result: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === pointIndex - 1) {
      if (i === 0) {
        result.push(prev);
        if (prevOrient === 'h') result.push({ x: prev.x, y: ny });
        else if (prevOrient === 'v') result.push({ x: nx, y: prev.y });
      } else {
        if (prevOrient === 'h') result.push({ x: prev.x, y: ny });
        else if (prevOrient === 'v') result.push({ x: nx, y: prev.y });
        else result.push(prev);
      }
    } else if (i === pointIndex) {
      result.push({ x: nx, y: ny });
    } else if (i === pointIndex + 1) {
      if (i === pts.length - 1) {
        if (nextOrient === 'h') result.push({ x: next.x, y: ny });
        else if (nextOrient === 'v') result.push({ x: nx, y: next.y });
        result.push(next);
      } else {
        if (nextOrient === 'h') result.push({ x: next.x, y: ny });
        else if (nextOrient === 'v') result.push({ x: nx, y: next.y });
        else result.push(next);
      }
    } else {
      result.push(pts[i]);
    }
  }
  return result;
}
