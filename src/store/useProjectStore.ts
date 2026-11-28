import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyGateReplacement, GATE_CATALOG, GRID_SIZE, snapToGrid } from '../core/catalog';
import {
  HdlSourceFile,
  importVerilogFilesToCircuits,
  ImportOptions,
  resynthesizeCircuitFromHdl,
  resynthesizeHdlProject,
} from '../core/hdl';
import {
  inferWireEndOutwardSide,
  rerouteWiresForGates,
  routeWire,
  simplifyPolyline,
} from '../core/routing';
import { createBlankCircuit, createSampleProject } from '../core/samples';
import {
  compileCircuit,
  createEmptySequentialState,
  RuntimeInputOverride,
  simulateCompiledCircuit,
} from '../core/simulator';
import { closeCircuitTabState, pickNextActiveTab, resolveOpenTabIds } from '../core/tabs';
import {
  CircuitDocument,
  GateInstance,
  GateProps,
  GateType,
  ModuleSymbolConfig,
  PinRef,
  PinSide,
  Point,
  ProjectDocument,
  ProjectSettings,
  RouteMode,
  SequentialState,
  SimulationSnapshot,
  Wire,
} from '../core/types';

const STORAGE_KEY = 'logicflow_project_v1';
const MAX_HISTORY = 80;

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Mark an HDL-imported circuit as diverged whenever the user structurally edits its schematic */
function markHdlDiverged(circ: CircuitDocument | undefined): void {
  if (circ && (circ.hdlSource || circ.hdlFileSource)) {
    circ.hdlDiverged = true;
  }
}

function cloneProject(p: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(p));
}

function loadInitialProject(): ProjectDocument {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectDocument;
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.circuits &&
        Object.keys(parsed.circuits).length > 0 &&
        (parsed.activeCircuitId === '' || Boolean(parsed.circuits[parsed.activeCircuitId]))
      ) {
        return parsed;
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return createSampleProject();
}

export interface ClipboardData {
  gates: GateInstance[];
  wires: Wire[];
}

export function useProjectStore() {
  const [project, setProject] = useState<ProjectDocument>(loadInitialProject);
  const [past, setPast] = useState<ProjectDocument[]>([]);
  const [future, setFuture] = useState<ProjectDocument[]>([]);

  const [selectedGateIds, setSelectedGateIds] = useState<Set<string>>(new Set());
  const [selectedWireIds, setSelectedWireIds] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<ClipboardData | null>(null);

  // Manual simulation mode state: whether user clicked "Run" in manual mode
  const [manualSimRunning, setManualSimRunningState] = useState(false);
  const [simTickCounter, setSimTickCounter] = useState(0);
  // Lightweight runtime overrides for CLOCK / BUTTON / Run-mode TOGGLE (zero project JSON cloning!)
  const [runtimeInputs, setRuntimeInputs] = useState<Record<string, RuntimeInputOverride>>({});
  const runtimeInputsRef = useRef(runtimeInputs);
  runtimeInputsRef.current = runtimeInputs;
  const [toast, setToast] = useState<string | null>(null);

  // Sequential state persisted per circuitId
  const seqStatesRef = useRef<Record<string, SequentialState>>({});
  // MRU stack of visited circuit tab IDs so closing the active tab returns to the previously viewed tab
  const tabHistoryRef = useRef<string[]>(project.activeCircuitId ? [project.activeCircuitId] : []);

  useEffect(() => {
    const id = project.activeCircuitId;
    if (!id) return;
    const prev = tabHistoryRef.current;
    if (prev[prev.length - 1] !== id) {
      tabHistoryRef.current = [...prev.filter((x) => x !== id), id];
    }
  }, [project.activeCircuitId]);

  const pickPreviousTab = useCallback(
    (closedId: string, remainingTabs: string[], circuits: Record<string, CircuitDocument>) => {
      const res = pickNextActiveTab(closedId, remainingTabs, tabHistoryRef.current, circuits);
      tabHistoryRef.current = res.tabHistory;
      return res.activeCircuitId;
    },
    [],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Debounced auto-save to localStorage (avoids synchronous JSON.stringify stalls during drag/zoom!)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      } catch {
        // ignore quota errors
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [project]);

  const activeCircuit: CircuitDocument | null = useMemo(() => {
    if (!project.activeCircuitId) return null;
    return project.circuits[project.activeCircuitId] ?? null;
  }, [project]);

  const simActive = project.settings.simMode === 'realtime' || manualSimRunning;
  /** In Edit/Run separated mode, entering Run mode locks circuit structure and runs on the pre-compiled netlist */
  const editLocked = project.settings.simMode === 'manual' && manualSimRunning;

  /** Flush any Run-mode TOGGLE / MODULE_IN / CLOCK runtime overrides back into project props when leaving Run mode */
  const flushRuntimeInputsToProject = useCallback(() => {
    const overrides = runtimeInputsRef.current;
    const keys = Object.keys(overrides);
    if (keys.length === 0) return;
    setProject((prev) => {
      const circ = prev.circuits[prev.activeCircuitId];
      if (!circ) return prev;
      let changed = false;
      for (const g of circ.gates) {
        const ov = overrides[g.id];
        if (!ov) continue;
        if (
          (g.type === 'TOGGLE' || g.type === 'MODULE_IN') &&
          ov.value !== undefined &&
          ov.value !== g.props.value
        ) {
          changed = true;
          break;
        }
        if (
          g.type === 'CLOCK' &&
          ov.clockHigh !== undefined &&
          ov.clockHigh !== g.props.clockHigh
        ) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      const next = cloneProject(prev);
      const nextCirc = next.circuits[next.activeCircuitId];
      for (const g of nextCirc.gates) {
        const ov = overrides[g.id];
        if (!ov) continue;
        if ((g.type === 'TOGGLE' || g.type === 'MODULE_IN') && ov.value !== undefined) {
          g.props.value = ov.value;
        } else if (g.type === 'CLOCK' && ov.clockHigh !== undefined) {
          g.props.clockHigh = ov.clockHigh;
        }
      }
      return next;
    });
  }, []);

  const setManualSimRunning = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(manualSimRunning) : next;
      if (manualSimRunning && !resolved) {
        flushRuntimeInputsToProject();
      }
      setManualSimRunningState(resolved);
    },
    [manualSimRunning, flushRuntimeInputsToProject],
  );

  // Reset runtime overrides whenever leaving Run mode or switching circuit tabs
  useEffect(() => {
    setRuntimeInputs({});
  }, [activeCircuit?.id, manualSimRunning, project.settings.simMode]);

  // Commit structural mutation with undo history (blocked when editLocked is true unless allowDuringRun)
  const mutateProject = useCallback(
    (updater: (draft: ProjectDocument) => void, recordHistory = true, allowDuringRun = false) => {
      if (editLocked && !allowDuringRun) {
        showToast('実行モード中は回路を編集できません（「編集に戻る」で編集再開）');
        return;
      }
      setProject((prev) => {
        if (recordHistory) {
          setPast((h) => [...h.slice(-(MAX_HISTORY - 1)), prev]);
          setFuture([]);
        }
        const next = cloneProject(prev);
        updater(next);
        return next;
      });
    },
    [editLocked, showToast],
  );

  const undo = useCallback(() => {
    if (editLocked) return;
    setPast((h) => {
      if (h.length === 0) return h;
      const previous = h[h.length - 1];
      setProject((cur) => {
        setFuture((f) => [cur, ...f.slice(0, MAX_HISTORY - 1)]);
        return previous;
      });
      return h.slice(0, -1);
    });
  }, [editLocked]);

  const redo = useCallback(() => {
    if (editLocked) return;
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setProject((cur) => {
        setPast((h) => [...h.slice(-(MAX_HISTORY - 1)), cur]);
        return next;
      });
      return f.slice(1);
    });
  }, [editLocked]);

  // Pre-compile netlist graph ONCE when topology changes (never rebuilt on clock ticks or Run-mode switch toggles!)
  const compiledCircuit = useMemo(() => {
    if (!simActive || !activeCircuit) return null;
    return compileCircuit(activeCircuit, project);
  }, [simActive, activeCircuit, project]);

  // Compute live simulation snapshot using the pre-compiled circuit
  const snapshot: SimulationSnapshot | null = useMemo(() => {
    if (!simActive || !compiledCircuit) return null;
    if (!seqStatesRef.current[compiledCircuit.circuit.id]) {
      seqStatesRef.current[compiledCircuit.circuit.id] = createEmptySequentialState();
    }
    const seq = seqStatesRef.current[compiledCircuit.circuit.id];
    return simulateCompiledCircuit(compiledCircuit, project, seq, {
      commitSequential: true,
      runtimeInputs,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiledCircuit, simActive, simTickCounter, runtimeInputs]);

  // Automatic clock oscillator timer (updates lightweight runtimeInputs only — zero JSON cloning!)
  const toggleAllClocks = useCallback(() => {
    if (!activeCircuit) return;
    const clocks = activeCircuit.gates.filter((g) => g.type === 'CLOCK');
    if (clocks.length === 0) return;
    setRuntimeInputs((prev) => {
      const next = { ...prev };
      for (const g of clocks) {
        const curHigh = prev[g.id]?.clockHigh ?? !!g.props.clockHigh;
        next[g.id] = { ...prev[g.id], clockHigh: !curHigh };
      }
      return next;
    });
    setSimTickCounter((c) => c + 1);
  }, [activeCircuit]);

  useEffect(() => {
    if (!simActive || !project.settings.clockRunning) return;
    const hz = Math.max(0.1, Math.min(1000, project.settings.clockHz || 1));
    const halfPeriodMs = Math.max(4, Math.round(500 / hz));
    const timer = setInterval(toggleAllClocks, halfPeriodMs);
    return () => clearInterval(timer);
  }, [simActive, project.settings.clockRunning, project.settings.clockHz, toggleAllClocks]);

  // --- Settings & Mode Actions ---

  const updateSettings = useCallback(
    (patch: Partial<ProjectSettings>) => {
      mutateProject(
        (d) => {
          Object.assign(d.settings, patch);
        },
        false,
        true,
      );
    },
    [mutateProject],
  );

  const resetSequentialState = useCallback(() => {
    if (!activeCircuit) return;
    const fresh = createEmptySequentialState();
    // Also attempt initializing any bistable propagated-X gate feedback loops to a clean stable state
    fresh.resetUnknownLoops = true;
    seqStatesRef.current[activeCircuit.id] = fresh;
    setSimTickCounter((c) => c + 1);
    showToast('順序回路(FF/レジスタ/RAM)および伝搬不定ループの状態をリセットしました');
  }, [activeCircuit, showToast]);

  const stepSimulation = useCallback(() => {
    if (project.settings.simMode === 'manual') {
      setManualSimRunning(true);
    }
    toggleAllClocks();
  }, [project.settings.simMode, toggleAllClocks]);

  // --- Circuit / Tab Management ---

  const setActiveCircuit = useCallback(
    (circuitId: string) => {
      const target = project.circuits[circuitId];
      if (!target) return;
      if (target.isStub) {
        showToast(`"${target.name}" は外部仮モジュール（Stub）のため内部回路はありません`);
        return;
      }
      setProject((prev) => {
        if (!prev.circuits[circuitId]) return prev;
        const curTabs = resolveOpenTabIds(prev);
        const nextTabs = curTabs.includes(circuitId) ? curTabs : [...curTabs, circuitId];
        return { ...prev, activeCircuitId: circuitId, openTabIds: nextTabs };
      });
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
    },
    [project.circuits, showToast],
  );

  const createNewCircuit = useCallback(
    (name?: string) => {
      const id = uid('circ');
      const count = Object.keys(project.circuits).length + 1;
      const finalName = name?.trim() || `Module_${count}`;
      mutateProject((d) => {
        const curTabs = resolveOpenTabIds(d);
        d.circuits[id] = createBlankCircuit(id, finalName);
        d.openTabIds = [...curTabs, id];
        d.activeCircuitId = id;
      });
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      showToast(`新しいモジュール "${finalName}" を作成しました`);
    },
    [mutateProject, project.circuits, showToast],
  );

  /** Create a brand-new module from scratch using a starter SystemVerilog template */
  const createNewHdlCircuit = useCallback(
    (rawName?: string): string | null => {
      const nonStubCount = Object.values(project.circuits).filter((c) => !c.isStub).length + 1;
      const cleaned = (rawName ?? '')
        .trim()
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^(\d)/, '_$1');
      const baseName = cleaned || `hdl_mod_${nonStubCount}`;

      // Avoid colliding with an existing module name in the project
      const existingNames = new Set(Object.values(project.circuits).map((c) => c.name));
      let modName = baseName;
      let suffix = 2;
      while (existingNames.has(modName)) {
        modName = `${baseName}_${suffix++}`;
      }

      const fileName = `${modName}.sv`;
      const starterSource = [
        `module ${modName} (`,
        `  input  logic a,`,
        `  input  logic b,`,
        `  output logic y`,
        `);`,
        `  assign y = a & b;`,
        `endmodule`,
        '',
      ].join('\n');

      const result = importVerilogFilesToCircuits([{ name: fileName, content: starterSource }], {
        existingCircuits: project.circuits,
        topModuleName: modName,
        projectName: modName,
      });

      mutateProject((d) => {
        const curTabs = resolveOpenTabIds(d);
        for (const c of result.circuits) {
          d.circuits[c.id] = c;
        }
        d.hdlProjects = {
          ...(d.hdlProjects ?? {}),
          [result.hdlProject.id]: result.hdlProject,
        };
        d.openTabIds = curTabs.includes(result.topCircuitId)
          ? curTabs
          : [...curTabs, result.topCircuitId];
        d.activeCircuitId = result.topCircuitId;
      });
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      showToast(
        `新規 HDL モジュール "${modName}" を作成しました（コードを編集して論理合成できます）`,
      );
      return result.topCircuitId;
    },
    [mutateProject, project.circuits, showToast],
  );

  const renameCircuit = useCallback(
    (circuitId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      mutateProject((d) => {
        if (d.circuits[circuitId]) d.circuits[circuitId].name = trimmed;
      });
    },
    [mutateProject],
  );

  /** Purely close a circuit tab (keeps module definition in project/palette; allows 0 open tabs) */
  const closeCircuitTab = useCallback((circuitId: string) => {
    setProject((prev) => {
      const next = closeCircuitTabState(prev, circuitId, tabHistoryRef.current);
      tabHistoryRef.current = next.tabHistory;
      return {
        ...prev,
        openTabIds: next.openTabIds,
        activeCircuitId: next.activeCircuitId,
      };
    });
    setSelectedGateIds(new Set());
    setSelectedWireIds(new Set());
  }, []);

  const updateSymbolConfig = useCallback(
    (circuitId: string, config: ModuleSymbolConfig) => {
      mutateProject((d) => {
        const c = d.circuits[circuitId];
        if (!c) return;
        c.symbolConfig = config;
        // Also sync MODULE_IN / MODULE_OUT gate props for consistency
        for (const pin of config.pins) {
          const g = c.gates.find((gt) => gt.id === pin.portGateId);
          if (g) {
            g.label = pin.name;
            g.props.portSide = pin.side;
            g.props.portOrder = pin.order;
            g.props.bitWidth = pin.bitWidth;
          }
        }
        markHdlDiverged(c);
      });
      showToast('モジュールシンボル設定を更新しました');
    },
    [mutateProject, showToast],
  );

  // --- Gate Actions ---

  const addGate = useCallback(
    (
      type: GateType,
      x: number,
      y: number,
      extraProps?: Partial<GateProps>,
      customLabel?: string,
    ) => {
      const entry = GATE_CATALOG[type];
      const id = uid('g');
      const gx = snapToGrid(x, project.settings.gridSize);
      const gy = snapToGrid(y, project.settings.gridSize);
      const gate: GateInstance = {
        id,
        type,
        x: gx,
        y: gy,
        rotation: 0,
        label: customLabel ?? (type === 'MODULE_IN' ? 'IN' : type === 'MODULE_OUT' ? 'OUT' : ''),
        props: { ...JSON.parse(JSON.stringify(entry.defaultProps)), ...extraProps },
      };
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        circ.gates.push(gate);
        markHdlDiverged(circ);
      });
      setSelectedGateIds(new Set([id]));
      setSelectedWireIds(new Set());
      return id;
    },
    [mutateProject, project.settings.gridSize],
  );

  const moveGates = useCallback(
    (deltas: Map<string, Point>, recordHistory = true) => {
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const movedIds = new Set<string>();
        for (const g of circ.gates) {
          const pos = deltas.get(g.id);
          if (pos) {
            g.x = pos.x;
            g.y = pos.y;
            movedIds.add(g.id);
          }
        }
        if (movedIds.size > 0) {
          circ.wires = rerouteWiresForGates(movedIds, circ, d);
        }
      }, recordHistory);
    },
    [mutateProject],
  );

  const updateGate = useCallback(
    (
      gateId: string,
      patch: Partial<GateInstance>,
      propsPatch?: Partial<GateProps>,
      recordHistory = true,
    ) => {
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const g = circ.gates.find((x) => x.id === gateId);
        if (!g) return;
        Object.assign(g, patch);
        if (propsPatch) {
          g.props = { ...g.props, ...propsPatch };
        }
        // Only mark HDL diverged on real structural edits (not live TOGGLE/MODULE_IN value clicks!)
        if (recordHistory) {
          markHdlDiverged(circ);
        }
        // Re-route connected wires if rotation or pin count changed
        if (
          patch.rotation !== undefined ||
          propsPatch?.inputCount !== undefined ||
          propsPatch?.selectBits !== undefined ||
          propsPatch?.displayMode !== undefined ||
          propsPatch?.splitWidths !== undefined ||
          propsPatch?.splitMode !== undefined ||
          propsPatch?.bundleMode !== undefined ||
          propsPatch?.interfaceFields !== undefined ||
          propsPatch?.hasCarryIn !== undefined ||
          propsPatch?.hasEnable !== undefined
        ) {
          circ.wires = rerouteWiresForGates(new Set([gateId]), circ, d);
        }
      }, recordHistory);
    },
    [mutateProject],
  );

  /** Replace a gate with another component type while preserving and re-attaching existing wires */
  const replaceGate = useCallback(
    (gateId: string, newType: GateType, subcircuitId?: string) => {
      let info: ReturnType<typeof applyGateReplacement> | null = null;
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        info = applyGateReplacement(circ, gateId, newType, d, subcircuitId);
        if (!info.replaced) return;
        circ.wires = rerouteWiresForGates(new Set([gateId]), circ, d);
        markHdlDiverged(circ);
      });
      if (info && (info as ReturnType<typeof applyGateReplacement>).replaced) {
        const res = info as ReturnType<typeof applyGateReplacement>;
        const newName =
          newType === 'SUBCIRCUIT' && subcircuitId
            ? (project.circuits[subcircuitId]?.name ?? GATE_CATALOG[newType].shortName)
            : GATE_CATALOG[newType].name;
        const detail =
          res.detachedToFloating > 0
            ? `（接続維持 ${res.reattached}本 / フローティング保持 ${res.detachedToFloating}本）`
            : res.reattached > 0
              ? `（配線 ${res.reattached}本を維持）`
              : '';
        showToast(`${newName} に差し替えました${detail}`);
      }
    },
    [mutateProject, project.circuits, showToast],
  );

  /** Delete selected gates while detaching (preserving) connected wires as extendable floating endpoints */
  const deleteGatesKeepWires = useCallback(
    (targetIds?: Set<string>) => {
      const ids = targetIds ?? selectedGateIds;
      if (ids.size === 0) return;
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        circ.gates = circ.gates.filter((g) => !ids.has(g.id));
        for (const w of circ.wires) {
          if (w.from && ids.has(w.from.gateId)) w.from = undefined;
          if (w.to && ids.has(w.to.gateId)) w.to = undefined;
        }
        markHdlDiverged(circ);
      });
      setSelectedGateIds(new Set());
      showToast('配線を残してパーツを削除しました（終端リングから再接続できます）');
    },
    [mutateProject, selectedGateIds, showToast],
  );

  const rotateSelectedGates = useCallback(() => {
    if (selectedGateIds.size === 0) return;
    mutateProject((d) => {
      const circ = d.circuits[d.activeCircuitId];
      if (!circ) return;
      for (const g of circ.gates) {
        if (selectedGateIds.has(g.id)) {
          g.rotation = ((g.rotation + 90) % 360) as GateInstance['rotation'];
        }
      }
      circ.wires = rerouteWiresForGates(selectedGateIds, circ, d);
    });
  }, [mutateProject, selectedGateIds]);

  const alignSelectedToGrid = useCallback(() => {
    if (!activeCircuit) return;
    const targets =
      selectedGateIds.size > 0 ? selectedGateIds : new Set(activeCircuit.gates.map((g) => g.id));
    mutateProject((d) => {
      const circ = d.circuits[d.activeCircuitId];
      if (!circ) return;
      const gs = d.settings.gridSize || GRID_SIZE;
      for (const g of circ.gates) {
        if (targets.has(g.id)) {
          g.x = snapToGrid(g.x, gs);
          g.y = snapToGrid(g.y, gs);
        }
      }
      circ.wires = rerouteWiresForGates(targets, circ, d);
    });
    showToast('グリッドに整列しました');
  }, [activeCircuit, mutateProject, selectedGateIds, showToast]);

  // --- Wire Actions ---

  const addWire = useCallback(
    (
      startPt: Point,
      endPt: Point,
      from?: PinRef,
      to?: PinRef,
      startSide?: PinSide,
      endSide?: PinSide,
      customPoints?: Point[],
      overrideMode?: RouteMode,
    ) => {
      const id = uid('w');
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const mode = overrideMode ?? d.settings.routeMode;
        const points =
          customPoints && customPoints.length >= 2
            ? customPoints
            : routeWire(startPt, endPt, {
                startSide,
                endSide,
                circuit: circ,
                project: d,
                routeMode: mode,
              });
        circ.wires.push({ id, from, to, points, routeMode: mode });
        markHdlDiverged(circ);
      });
      return id;
    },
    [mutateProject],
  );

  /**
   * Extend an existing floating wire endpoint seamlessly into ONE continuous wire (no duplicate wire
   * and no unwanted midpoint solder dot). Can connect to a gate pin, another wire's body (T-junction),
   * or merge cleanly with another floating wire endpoint.
   */
  const extendFloatingWire = useCallback(
    (
      wireId: string,
      end: 'start' | 'end',
      targetPt: Point,
      targetPin?: PinRef,
      targetSide?: PinSide,
      customPoints?: Point[],
      targetFloatingEnd?: { wireId: string; end: 'start' | 'end' },
    ) => {
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const w = circ.wires.find((x) => x.id === wireId);
        if (!w || w.points.length < 2) return;

        const startPt = end === 'start' ? w.points[0] : w.points[w.points.length - 1];
        const startSide = inferWireEndOutwardSide(w.points, end);
        const mode = d.settings.routeMode;

        const extPts =
          customPoints && customPoints.length >= 2
            ? customPoints
            : routeWire(startPt, targetPt, {
                startSide,
                endSide: targetSide,
                circuit: circ,
                project: d,
                routeMode: mode,
                ignoreWireId: wireId,
              });

        // Case A: Connecting to another floating wire end -> merge both into ONE continuous wire!
        if (targetFloatingEnd && targetFloatingEnd.wireId !== wireId) {
          const w2Idx = circ.wires.findIndex((x) => x.id === targetFloatingEnd.wireId);
          if (w2Idx >= 0) {
            const w2 = circ.wires[w2Idx];
            const w2TailPts =
              targetFloatingEnd.end === 'start' ? w2.points : w2.points.slice().reverse();
            const w2OtherPin = targetFloatingEnd.end === 'start' ? w2.to : w2.from;

            if (end === 'end') {
              w.points = simplifyPolyline([...w.points, ...extPts, ...w2TailPts]);
              w.to = w2OtherPin;
            } else {
              w.points = simplifyPolyline([
                ...w2TailPts.slice().reverse(),
                ...extPts.slice().reverse(),
                ...w.points,
              ]);
              w.from = w2OtherPin;
            }
            if (!w.netLabel && w2.netLabel) w.netLabel = w2.netLabel;
            if (mode === 'free') w.routeMode = 'free';
            circ.wires.splice(w2Idx, 1);
            markHdlDiverged(circ);
            return;
          }
        }

        // Case B: Extending to a gate pin or onto another wire's body (T-junction)
        if (end === 'end') {
          w.points = simplifyPolyline([...w.points, ...extPts]);
          w.to = targetPin;
        } else {
          w.points = simplifyPolyline([...extPts.slice().reverse(), ...w.points]);
          w.from = targetPin;
        }
        if (mode === 'free') w.routeMode = 'free';
        markHdlDiverged(circ);
      });
    },
    [mutateProject],
  );

  const updateWire = useCallback(
    (wireId: string, patch: Partial<Wire>) => {
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const w = circ.wires.find((x) => x.id === wireId);
        if (!w) return;
        Object.assign(w, patch);
        if (patch.routeMode !== undefined) {
          const moved = new Set<string>();
          if (w.from) moved.add(w.from.gateId);
          if (w.to) moved.add(w.to.gateId);
          if (moved.size > 0) {
            circ.wires = rerouteWiresForGates(moved, circ, d);
          }
        }
        markHdlDiverged(circ);
      });
    },
    [mutateProject],
  );

  const updateWirePoints = useCallback(
    (wireId: string, points: Point[], recordHistory = true) => {
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const w = circ.wires.find((x) => x.id === wireId);
        if (!w) return;
        w.points = points;
      }, recordHistory);
    },
    [mutateProject],
  );

  const rerouteSingleWire = useCallback(
    (wireId: string) => {
      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        const w = circ.wires.find((x) => x.id === wireId);
        if (!w) return;
        const targets = new Set<string>();
        if (w.from) targets.add(w.from.gateId);
        if (w.to) targets.add(w.to.gateId);
        if (targets.size > 0) {
          const updated = rerouteWiresForGates(targets, circ, d);
          const rerouted = updated.find((x) => x.id === wireId);
          if (rerouted) w.points = rerouted.points;
        }
      });
      showToast('選択したワイヤーを自動再配線しました');
    },
    [mutateProject, showToast],
  );

  const rerouteAllWires = useCallback(() => {
    if (!activeCircuit) return;
    mutateProject((d) => {
      const circ = d.circuits[d.activeCircuitId];
      if (!circ) return;
      const allIds = new Set(circ.gates.map((g) => g.id));
      circ.wires = rerouteWiresForGates(allIds, circ, d);
    });
    showToast('全ワイヤーを自動再配線しました');
  }, [activeCircuit, mutateProject, showToast]);

  // --- Selection, Delete, Copy, Paste, Duplicate ---

  const deleteSelection = useCallback(() => {
    if (selectedGateIds.size === 0 && selectedWireIds.size === 0) return;
    mutateProject((d) => {
      const circ = d.circuits[d.activeCircuitId];
      if (!circ) return;
      circ.gates = circ.gates.filter((g) => !selectedGateIds.has(g.id));
      circ.wires = circ.wires.filter((w) => {
        if (selectedWireIds.has(w.id)) return false;
        if (w.from && selectedGateIds.has(w.from.gateId)) return false;
        if (w.to && selectedGateIds.has(w.to.gateId)) return false;
        return true;
      });
      markHdlDiverged(circ);
    });
    setSelectedGateIds(new Set());
    setSelectedWireIds(new Set());
  }, [mutateProject, selectedGateIds, selectedWireIds]);

  const copySelection = useCallback(() => {
    if (!activeCircuit || selectedGateIds.size === 0) return;
    const gates = activeCircuit.gates.filter((g) => selectedGateIds.has(g.id));
    const wires = activeCircuit.wires.filter(
      (w) =>
        w.from && selectedGateIds.has(w.from.gateId) && w.to && selectedGateIds.has(w.to.gateId),
    );
    setClipboard(JSON.parse(JSON.stringify({ gates, wires })));
    showToast(`${gates.length}個のパーツをコピーしました`);
  }, [activeCircuit, selectedGateIds, showToast]);

  const pasteItems = useCallback(
    (items: ClipboardData, offsetX = 40, offsetY = 40) => {
      if (!activeCircuit || items.gates.length === 0) return;
      const idMap = new Map<string, string>();
      const newGateIds = new Set<string>();
      const newWireIds = new Set<string>();

      mutateProject((d) => {
        const circ = d.circuits[d.activeCircuitId];
        if (!circ) return;
        for (const g of items.gates) {
          const nid = uid('g');
          idMap.set(g.id, nid);
          newGateIds.add(nid);
          circ.gates.push({
            ...JSON.parse(JSON.stringify(g)),
            id: nid,
            x: snapToGrid(g.x + offsetX, d.settings.gridSize),
            y: snapToGrid(g.y + offsetY, d.settings.gridSize),
          });
        }
        for (const w of items.wires) {
          const nid = uid('w');
          newWireIds.add(nid);
          circ.wires.push({
            ...JSON.parse(JSON.stringify(w)),
            id: nid,
            from:
              w.from && idMap.has(w.from.gateId)
                ? { gateId: idMap.get(w.from.gateId)!, pinId: w.from.pinId }
                : undefined,
            to:
              w.to && idMap.has(w.to.gateId)
                ? { gateId: idMap.get(w.to.gateId)!, pinId: w.to.pinId }
                : undefined,
            points: w.points.map((pt) => ({ x: pt.x + offsetX, y: pt.y + offsetY })),
          });
        }
        markHdlDiverged(circ);
      });
      setSelectedGateIds(newGateIds);
      setSelectedWireIds(newWireIds);
    },
    [activeCircuit, mutateProject],
  );

  const pasteClipboard = useCallback(() => {
    if (!clipboard) return;
    pasteItems(clipboard, 40, 40);
  }, [clipboard, pasteItems]);

  const duplicateSelection = useCallback(() => {
    if (!activeCircuit || selectedGateIds.size === 0) return;
    const gates = activeCircuit.gates.filter((g) => selectedGateIds.has(g.id));
    const wires = activeCircuit.wires.filter(
      (w) =>
        w.from && selectedGateIds.has(w.from.gateId) && w.to && selectedGateIds.has(w.to.gateId),
    );
    pasteItems(JSON.parse(JSON.stringify({ gates, wires })), 40, 40);
  }, [activeCircuit, pasteItems, selectedGateIds]);

  const selectAll = useCallback(() => {
    if (!activeCircuit) return;
    setSelectedGateIds(new Set(activeCircuit.gates.map((g) => g.id)));
    setSelectedWireIds(new Set(activeCircuit.wires.map((w) => w.id)));
  }, [activeCircuit]);

  // --- Interactive Live Input Controls (Toggle / Button / Clock / Module_In) ---

  const interactGateClick = useCallback(
    (gate: GateInstance) => {
      if (gate.type === 'TOGGLE' || gate.type === 'MODULE_IN') {
        const bw = gate.props.bitWidth ?? 1;
        const computeNext = (curStr: string) => {
          if (bw === 1) return curStr === '1' ? '0' : '1';
          const cur = parseInt(curStr, 10) || 0;
          return String((cur + 1) & ((1 << bw) - 1));
        };
        if (editLocked) {
          // Run mode: update lightweight runtimeInputs only (zero project clone, zero netlist recompile!)
          setRuntimeInputs((prev) => {
            const curVal = prev[gate.id]?.value ?? gate.props.value ?? '0';
            return { ...prev, [gate.id]: { ...prev[gate.id], value: computeNext(curVal) } };
          });
        } else {
          updateGate(gate.id, {}, { value: computeNext(gate.props.value ?? '0') }, false);
        }
      } else if (gate.type === 'CLOCK') {
        setRuntimeInputs((prev) => {
          const curHigh = prev[gate.id]?.clockHigh ?? !!gate.props.clockHigh;
          return { ...prev, [gate.id]: { ...prev[gate.id], clockHigh: !curHigh } };
        });
      }
    },
    [editLocked, updateGate],
  );

  const setButtonPressed = useCallback((gateId: string, pressed: boolean) => {
    setRuntimeInputs((prev) => ({
      ...prev,
      [gateId]: { ...prev[gateId], pressed },
    }));
  }, []);

  // --- File Persistence, External Module Import & Verilog/SV Import ---

  const exportProjectJson = useCallback(() => {
    return JSON.stringify(project, null, 2);
  }, [project]);

  const loadProjectJson = useCallback(
    (jsonStr: string) => {
      const parsed = JSON.parse(jsonStr) as ProjectDocument;
      if (!parsed || !parsed.circuits) throw new Error('無効なプロジェクトファイル形式です');
      seqStatesRef.current = {};
      setPast([]);
      setFuture([]);
      setProject(parsed);
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      showToast(`プロジェクト "${parsed.name}" を読み込みました`);
    },
    [showToast],
  );

  /** Import another .lcirc.json project or circuit file as reusable module(s) into current project! */
  const importExternalModuleFile = useCallback(
    (jsonStr: string, filename: string) => {
      const parsed = JSON.parse(jsonStr);
      let importedCircuits: CircuitDocument[] = [];
      let topId: string | null = null;

      if (parsed.circuits && typeof parsed.circuits === 'object') {
        importedCircuits = Object.values(parsed.circuits) as CircuitDocument[];
        topId = parsed.activeCircuitId ?? importedCircuits[0]?.id ?? null;
      } else if (parsed.gates && parsed.wires) {
        importedCircuits = [parsed as CircuitDocument];
        topId = parsed.id;
      } else {
        throw new Error('モジュールファイル形式(.lcirc.json)として認識できません');
      }

      const idRemap = new Map<string, string>();
      for (const c of importedCircuits) {
        idRemap.set(c.id, uid('ext'));
      }

      mutateProject((d) => {
        for (const c of importedCircuits) {
          const cloned: CircuitDocument = JSON.parse(JSON.stringify(c));
          cloned.id = idRemap.get(c.id)!;
          // Remap internal subcircuit references
          for (const g of cloned.gates) {
            if (
              g.type === 'SUBCIRCUIT' &&
              g.props.subcircuitId &&
              idRemap.has(g.props.subcircuitId)
            ) {
              g.props.subcircuitId = idRemap.get(g.props.subcircuitId);
            }
          }
          d.circuits[cloned.id] = cloned;
        }
        // Automatically place the imported top module on the active canvas (or open its tab if 0 tabs open)
        if (topId && idRemap.has(topId)) {
          const modId = idRemap.get(topId)!;
          const modDoc = d.circuits[modId];
          const activeDoc = d.circuits[d.activeCircuitId];
          if (activeDoc) {
            activeDoc.gates.push({
              id: uid('g'),
              type: 'SUBCIRCUIT',
              x: snapToGrid(320, d.settings.gridSize),
              y: snapToGrid(240, d.settings.gridSize),
              rotation: 0,
              label: modDoc.name || filename.replace(/\.json$/i, ''),
              props: { subcircuitId: modId, displayMode: 'live' },
            });
          } else {
            const curTabs = resolveOpenTabIds(d);
            d.openTabIds = curTabs.includes(modId) ? curTabs : [...curTabs, modId];
            d.activeCircuitId = modId;
          }
        }
      });
      showToast(`外部ファイル "${filename}" をモジュールとして読み込みました`);
    },
    [mutateProject, showToast],
  );

  const importVerilogFiles = useCallback(
    (
      files: HdlSourceFile[],
      options?: Pick<ImportOptions, 'topModuleName' | 'projectName'>,
    ): string[] => {
      const result = importVerilogFilesToCircuits(files, options);
      mutateProject((d) => {
        // Capture current open tabs BEFORE adding imported submodules/stubs
        const curTabs = resolveOpenTabIds(d);
        for (const c of result.circuits) {
          d.circuits[c.id] = c;
        }
        d.hdlProjects = {
          ...(d.hdlProjects ?? {}),
          [result.hdlProject.id]: result.hdlProject,
        };
        // Only open the designated top module tab; submodules stay accessible via HDL Project in left palette!
        d.openTabIds = curTabs.includes(result.topCircuitId)
          ? curTabs
          : [...curTabs, result.topCircuitId];
        d.activeCircuitId = result.topCircuitId;
      });
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      const topName = result.circuits.find((c) => c.id === result.topCircuitId)?.name ?? 'Module';
      const fileCountNote = files.length > 1 ? `${files.length} ファイル / ` : '';
      showToast(
        `HDLプロジェクト "${result.hdlProject.name}"（トップ: ${topName} / ${fileCountNote}全 ${result.hdlProject.moduleCircuitIds.length} モジュール）をインポートしました`,
      );
      return result.warnings;
    },
    [mutateProject, showToast],
  );

  const importVerilogSource = useCallback(
    (source: string): string[] => {
      return importVerilogFiles([{ name: '', content: source }]);
    },
    [importVerilogFiles],
  );

  /** Permanently remove a custom module (even when its tab is closed) and clean up any references */
  const removeCustomModule = useCallback(
    (circuitId: string) => {
      const target = project.circuits[circuitId];
      if (!target) return;
      const nonStubs = Object.values(project.circuits).filter((c) => !c.isStub);
      if (nonStubs.length <= 1) {
        showToast('最後のモジュールは削除できません');
        return;
      }
      mutateProject((d) => {
        // Remove any SUBCIRCUIT gates referencing this module and their attached wires
        for (const c of Object.values(d.circuits)) {
          if (c.id === circuitId) continue;
          const removedGateIds = new Set(
            c.gates
              .filter((g) => g.type === 'SUBCIRCUIT' && g.props.subcircuitId === circuitId)
              .map((g) => g.id),
          );
          if (removedGateIds.size > 0) {
            c.gates = c.gates.filter((g) => !removedGateIds.has(g.id));
            c.wires = c.wires.filter(
              (w) =>
                !(w.from && removedGateIds.has(w.from.gateId)) &&
                !(w.to && removedGateIds.has(w.to.gateId)),
            );
          }
        }
        delete d.circuits[circuitId];
        if (d.openTabIds) {
          d.openTabIds = d.openTabIds.filter((id) => id !== circuitId && Boolean(d.circuits[id]));
        }
        // Update parent HDL project bundle if present
        if (d.hdlProjects) {
          for (const [pid, bundle] of Object.entries(d.hdlProjects)) {
            if (bundle.moduleCircuitIds.includes(circuitId)) {
              bundle.moduleCircuitIds = bundle.moduleCircuitIds.filter((id) => id !== circuitId);
              if (bundle.moduleCircuitIds.length === 0) {
                for (const sid of bundle.stubCircuitIds) delete d.circuits[sid];
                delete d.hdlProjects[pid];
              } else if (bundle.topCircuitId === circuitId) {
                const nextTop = bundle.moduleCircuitIds[0];
                bundle.topCircuitId = nextTop;
                bundle.topModuleName = d.circuits[nextTop]?.name ?? bundle.topModuleName;
              }
            }
          }
        }
        if (d.activeCircuitId === circuitId) {
          const remaining = resolveOpenTabIds(d);
          d.activeCircuitId = pickPreviousTab(circuitId, remaining, d.circuits);
        }
      });
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      showToast(`モジュール "${target.name}" を削除しました`);
    },
    [mutateProject, pickPreviousTab, project.circuits, showToast],
  );

  /** Delete an entire HDL project bundle (all its modules, stubs, and tabs) at once */
  const deleteHdlProject = useCallback(
    (hdlProjectId: string) => {
      const bundle = project.hdlProjects?.[hdlProjectId];
      if (!bundle) return;
      const removeIds = new Set([...bundle.moduleCircuitIds, ...bundle.stubCircuitIds]);
      const remainingNonStubs = Object.values(project.circuits).filter(
        (c) => !c.isStub && !removeIds.has(c.id),
      );

      mutateProject((d) => {
        for (const rid of removeIds) delete d.circuits[rid];
        // Remove dangling SUBCIRCUIT references in any remaining circuits
        for (const c of Object.values(d.circuits)) {
          const deadGates = new Set(
            c.gates
              .filter(
                (g) =>
                  g.type === 'SUBCIRCUIT' &&
                  g.props.subcircuitId &&
                  removeIds.has(g.props.subcircuitId),
              )
              .map((g) => g.id),
          );
          if (deadGates.size > 0) {
            c.gates = c.gates.filter((g) => !deadGates.has(g.id));
            c.wires = c.wires.filter(
              (w) =>
                !(w.from && deadGates.has(w.from.gateId)) && !(w.to && deadGates.has(w.to.gateId)),
            );
          }
        }
        if (d.hdlProjects) delete d.hdlProjects[hdlProjectId];
        // Guarantee at least one circuit remains
        if (remainingNonStubs.length === 0) {
          const blankId = uid('circ');
          d.circuits[blankId] = createBlankCircuit(blankId, 'Main');
          d.openTabIds = [blankId];
          d.activeCircuitId = blankId;
        } else {
          const nextTabs = resolveOpenTabIds(d).filter((id) => !removeIds.has(id));
          d.openTabIds = nextTabs;
          if (
            removeIds.has(d.activeCircuitId) ||
            (d.activeCircuitId && !d.circuits[d.activeCircuitId])
          ) {
            d.activeCircuitId = nextTabs[nextTabs.length - 1] ?? '';
          }
        }
      });
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      showToast(
        `HDLプロジェクト "${bundle.name}"（${bundle.moduleCircuitIds.length} モジュール）を削除しました`,
      );
    },
    [mutateProject, project.circuits, project.hdlProjects, showToast],
  );

  /** Change the designated top module of an HDL project bundle and open it */
  const setHdlProjectTopModule = useCallback(
    (hdlProjectId: string, circuitId: string) => {
      const bundle = project.hdlProjects?.[hdlProjectId];
      const mod = project.circuits[circuitId];
      if (!bundle || !mod || mod.isStub) return;
      mutateProject(
        (d) => {
          const b = d.hdlProjects?.[hdlProjectId];
          if (!b) return;
          b.topCircuitId = circuitId;
          b.topModuleName = mod.name;
          const curTabs = resolveOpenTabIds(d);
          d.openTabIds = curTabs.includes(circuitId) ? curTabs : [...curTabs, circuitId];
          d.activeCircuitId = circuitId;
        },
        true,
        true,
      );
      showToast(`"${bundle.name}" のトップモジュールを "${mod.name}" に設定しました`);
    },
    [mutateProject, project.circuits, project.hdlProjects, showToast],
  );

  /** Re-synthesize an entire HDL project bundle from its edited files & top module selection */
  const resynthesizeHdlProjectBundle = useCallback(
    (hdlProjectId: string, files: HdlSourceFile[], topModuleName?: string): string[] => {
      if (editLocked) {
        throw new Error('実行モード中は論理合成できません（「編集に戻る」で編集再開してください）');
      }
      const oldBundle = project.hdlProjects?.[hdlProjectId];
      const result = resynthesizeHdlProject(hdlProjectId, files, topModuleName, project);
      const newIds = new Set(result.circuits.map((c) => c.id));
      const oldBundleIds = new Set([
        ...(oldBundle?.moduleCircuitIds ?? []),
        ...(oldBundle?.stubCircuitIds ?? []),
      ]);

      mutateProject((d) => {
        // Remove obsolete modules/stubs that were deleted from the HDL project source
        for (const oldId of oldBundleIds) {
          if (!newIds.has(oldId)) delete d.circuits[oldId];
        }
        for (const c of result.circuits) {
          d.circuits[c.id] = c;
        }
        d.hdlProjects = {
          ...(d.hdlProjects ?? {}),
          [result.hdlProject.id]: result.hdlProject,
        };
        const curTabs = (d.openTabIds ?? []).filter((id) => Boolean(d.circuits[id]));
        if (!curTabs.includes(result.topCircuitId)) curTabs.push(result.topCircuitId);
        d.openTabIds = curTabs;
        if (!d.circuits[d.activeCircuitId]) {
          d.activeCircuitId = result.topCircuitId;
        }
      });

      for (const c of result.circuits) {
        seqStatesRef.current[c.id] = createEmptySequentialState();
      }
      setSimTickCounter((c) => c + 1);
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      showToast(
        `HDLプロジェクト "${result.hdlProject.name}" を再論理合成しました（トップ: ${result.hdlProject.topModuleName}）`,
      );
      return result.warnings;
    },
    [editLocked, mutateProject, project, showToast],
  );

  /** Re-synthesize an existing HDL module in-place from edited HDL source */
  const resynthesizeFromHdl = useCallback(
    (circuitId: string, newSource: string): string[] => {
      if (editLocked) {
        throw new Error('実行モード中は論理合成できません（「編集に戻る」で編集再開してください）');
      }
      const result = resynthesizeCircuitFromHdl(circuitId, newSource, project);
      mutateProject((d) => {
        for (const c of result.circuits) {
          d.circuits[c.id] = c;
        }
        // Re-route wires in any parent circuit that instantiates this updated module (in case ports changed)
        for (const parent of Object.values(d.circuits)) {
          if (parent.id === circuitId || parent.isStub) continue;
          const affectedIds = new Set(
            parent.gates
              .filter((g) => g.type === 'SUBCIRCUIT' && g.props.subcircuitId === circuitId)
              .map((g) => g.id),
          );
          if (affectedIds.size > 0) {
            parent.wires = rerouteWiresForGates(affectedIds, parent, d);
          }
        }
      });
      seqStatesRef.current[circuitId] = createEmptySequentialState();
      setSimTickCounter((c) => c + 1);
      setSelectedGateIds(new Set());
      setSelectedWireIds(new Set());
      const modName =
        result.circuits.find((c) => c.id === circuitId)?.name ??
        project.circuits[circuitId]?.name ??
        'Module';
      showToast(`"${modName}" を HDL ソースから再論理合成して回路に反映しました`);
      return result.warnings;
    },
    [editLocked, mutateProject, project, showToast],
  );

  const loadSampleProject = useCallback(() => {
    seqStatesRef.current = {};
    setPast([]);
    setFuture([]);
    setProject(createSampleProject());
    setSelectedGateIds(new Set());
    setSelectedWireIds(new Set());
    showToast('サンプルプロジェクトを読み込みました');
  }, [showToast]);

  const renameProject = useCallback(
    (name: string) => {
      mutateProject((d) => {
        d.name = name;
      }, false);
    },
    [mutateProject],
  );

  return {
    project,
    activeCircuit,
    snapshot,
    simActive,
    editLocked,
    runtimeInputs,
    manualSimRunning,
    setManualSimRunning,
    selectedGateIds,
    setSelectedGateIds,
    selectedWireIds,
    setSelectedWireIds,
    canUndo: !editLocked && past.length > 0,
    canRedo: !editLocked && future.length > 0,
    hasClipboard: clipboard !== null,
    toast,
    showToast,
    undo,
    redo,
    updateSettings,
    resetSequentialState,
    stepSimulation,
    setActiveCircuit,
    createNewCircuit,
    createNewHdlCircuit,
    renameCircuit,
    closeCircuitTab,
    updateSymbolConfig,
    addGate,
    moveGates,
    updateGate,
    replaceGate,
    rotateSelectedGates,
    alignSelectedToGrid,
    addWire,
    extendFloatingWire,
    updateWire,
    updateWirePoints,
    rerouteSingleWire,
    rerouteAllWires,
    deleteSelection,
    deleteGatesKeepWires,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    selectAll,
    interactGateClick,
    setButtonPressed,
    exportProjectJson,
    loadProjectJson,
    importExternalModuleFile,
    importVerilogSource,
    importVerilogFiles,
    resynthesizeFromHdl,
    resynthesizeHdlProjectBundle,
    removeCustomModule,
    deleteHdlProject,
    setHdlProjectTopModule,
    loadSampleProject,
    renameProject,
  };
}
