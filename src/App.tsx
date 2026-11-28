import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, FileCode2, FolderOpen, Layers, PanelLeft, PanelRight, Plus } from 'lucide-react';
import { hitTestGate, screenToWorld, Viewport } from './canvas/hitTest';
import { renderGateSymbolPreview } from './canvas/renderer';
import { CircuitCanvas } from './components/CircuitCanvas';
import { ComponentPalette, DragGatePayload } from './components/ComponentPalette';
import { ContextMenu, ContextMenuState } from './components/ContextMenu';
import { HdlDockPanel, HdlDockPosition } from './components/HdlDockPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { LiveSubcircuitPopup } from './components/LiveSubcircuitPopup';
import {
  MemoryEditorModal,
  NetlistExportModal,
  ShortcutsModal,
  SymbolEditorModal,
  VerilogImportModal,
} from './components/Modals';
import { TopBar } from './components/TopBar';
import { WatchWaveformPanel } from './components/WatchWaveformPanel';
import { GATE_CATALOG } from './core/catalog';
import {
  appendWaveformStep,
  buildPinWatchLabel,
  buildWireWatchLabel,
  getDefaultWatchPin,
  hasWatchedSignalsChanged,
  makePinWatchId,
  makeWireWatchId,
  parseStoredWatchTargets,
  pruneWatchTargets,
  sampleWatchedSignals,
  WatchTarget,
  WaveformStep,
} from './core/debug';
import { GateInstance, GateType, Point, ProjectDocument, Wire } from './core/types';
import { useProjectStore } from './store/useProjectStore';

const DragSymbolOverlay: React.FC<{
  payload: DragGatePayload;
  clientX: number;
  clientY: number;
  project: ProjectDocument;
  zoom: number;
}> = ({ payload, clientX, clientY, project, zoom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ cssWidth: 120, cssHeight: 80 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const entry = GATE_CATALOG[payload.type];
    const extra = payload.subcircuitId
      ? { subcircuitId: payload.subcircuitId, displayMode: 'live' as const }
      : {};
    const label = payload.subcircuitId
      ? (project.circuits[payload.subcircuitId]?.name ?? '')
      : payload.type === 'MODULE_IN'
        ? 'IN'
        : payload.type === 'MODULE_OUT'
          ? 'OUT'
          : '';
    const previewGate: GateInstance = {
      id: '__drag_overlay__',
      type: payload.type,
      x: 0,
      y: 0,
      rotation: 0,
      label,
      props: { ...entry.defaultProps, ...extra },
    };
    const dims = renderGateSymbolPreview(canvas, previewGate, project, zoom);
    setSize(dims);
  }, [payload, project, zoom]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        left: clientX - size.cssWidth / 2,
        top: clientY - size.cssHeight / 2,
        width: size.cssWidth,
        height: size.cssHeight,
        pointerEvents: 'none',
        zIndex: 999,
        filter: 'drop-shadow(0 8px 20px rgba(0,0,0,0.6))',
      }}
    />
  );
};

export const App: React.FC = () => {
  const store = useProjectStore();
  const {
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
  } = store;

  const viewportRef = useRef<Viewport>({ x: 40, y: 30, zoom: 1 });
  const [fitTrigger, setFitTrigger] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const [showVerilogModal, setShowVerilogModal] = useState(false);
  const [showNetlistModal, setShowNetlistModal] = useState(false);
  const [showSymbolModal, setShowSymbolModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [hdlSourceCircuitId, setHdlSourceCircuitId] = useState<string | null>(null);
  const [hdlDockPos, setHdlDockPos] = useState<HdlDockPosition>('bottom');
  const [hdlAutoEditTrigger, setHdlAutoEditTrigger] = useState(0);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)').matches : false,
  );
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? !window.matchMedia('(max-width: 900px)').matches : true,
  );
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? !window.matchMedia('(max-width: 900px)').matches : true,
  );
  const canvasHostRef = useRef<HTMLDivElement>(null);

  // Track responsive mobile breakpoint so sidebars default to drawers on phones/small viewports
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (e.matches) {
        setLeftSidebarOpen(false);
        setRightSidebarOpen(false);
      } else {
        setLeftSidebarOpen(true);
        setRightSidebarOpen(true);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarOpen((open) => {
      const next = !open;
      if (next && isMobile) setRightSidebarOpen(false);
      return next;
    });
  }, [isMobile]);

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarOpen((open) => {
      const next = !open;
      if (next && isMobile) setLeftSidebarOpen(false);
      return next;
    });
  }, [isMobile]);

  const handleNewHdlCircuit = useCallback(() => {
    const nonStubCount = Object.values(project.circuits).filter((c) => !c.isStub).length + 1;
    const raw = window.prompt(
      '新規 HDL モジュール名（英数字・アンダースコア）:',
      `hdl_mod_${nonStubCount}`,
    );
    if (raw === null) return;
    const cid = store.createNewHdlCircuit(raw);
    if (cid) {
      setHdlSourceCircuitId(cid);
      setHdlAutoEditTrigger((n) => n + 1);
    }
  }, [project.circuits, store]);
  const WATCH_STORAGE_KEY = 'logicflow_watch_v1';
  const [livePopupPath, setLivePopupPath] = useState<string[] | null>(null);
  const [showWatchPanel, setShowWatchPanel] = useState(false);
  const [watchTargets, setWatchTargets] = useState<WatchTarget[]>(() => {
    try {
      return pruneWatchTargets(
        parseStoredWatchTargets(localStorage.getItem(WATCH_STORAGE_KEY)),
        project,
      );
    } catch {
      return [];
    }
  });
  const [waveHistoryByCircuit, setWaveHistoryByCircuit] = useState<Record<string, WaveformStep[]>>(
    {},
  );
  const [watchRecording, setWatchRecording] = useState(true);

  // Prune watch targets if referenced circuits/wires/gates are removed or another project is loaded
  useEffect(() => {
    setWatchTargets((prev) => {
      const pruned = pruneWatchTargets(prev, project);
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [project]);

  // Persist watch list to localStorage so watched signals and their order survive browser reloads
  useEffect(() => {
    try {
      localStorage.setItem(WATCH_STORAGE_KEY, JSON.stringify(watchTargets));
    } catch {
      // ignore storage quota errors
    }
  }, [watchTargets]);
  const [memoryGateId, setMemoryGateId] = useState<string | null>(null);
  const [draggingGate, setDraggingGate] = useState<DragGatePayload | null>(null);
  const [dragCursor, setDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [dragOverCanvas, setDragOverCanvas] = useState(false);

  // Follow active tab changes in the docked HDL panel and close stale live popup on tab switch
  const activeCircuitId = activeCircuit?.id ?? '';
  const prevActiveCircuitIdRef = useRef<string>(activeCircuitId);
  useEffect(() => {
    if (prevActiveCircuitIdRef.current !== activeCircuitId) {
      prevActiveCircuitIdRef.current = activeCircuitId;
      setLivePopupPath(null);
      setContextMenu(null);
      if (
        hdlSourceCircuitId !== null &&
        activeCircuit &&
        (activeCircuit.hdlSource || activeCircuit.hdlFileSource)
      ) {
        setHdlSourceCircuitId(activeCircuit.id);
      }
    }
  }, [activeCircuitId, activeCircuit, hdlSourceCircuitId]);

  const activeWatchTargets = activeCircuit
    ? watchTargets.filter((t) => t.circuitId === activeCircuit.id)
    : [];
  const activeWaveHistory = activeCircuit ? (waveHistoryByCircuit[activeCircuit.id] ?? []) : [];

  // Auto-record waveform step whenever any watched signal on the active circuit changes
  useEffect(() => {
    if (!activeCircuit || !simActive || !watchRecording || !snapshot) return;
    if (activeWatchTargets.length === 0) return;
    const sampled = sampleWatchedSignals(watchTargets, activeCircuit, project, snapshot);
    setWaveHistoryByCircuit((prev) => {
      const curList = prev[activeCircuit.id] ?? [];
      const lastStep = curList[curList.length - 1];
      if (!hasWatchedSignalsChanged(lastStep, sampled, watchTargets, activeCircuit.id)) {
        return prev;
      }
      return {
        ...prev,
        [activeCircuit.id]: appendWaveformStep(curList, sampled),
      };
    });
  }, [
    snapshot,
    simActive,
    watchRecording,
    watchTargets,
    activeCircuit,
    project,
    activeWatchTargets.length,
  ]);

  const isWireWatched = useCallback(
    (wireId: string) => {
      if (!activeCircuit) return false;
      const id = makeWireWatchId(activeCircuit.id, wireId);
      return watchTargets.some((t) => t.id === id);
    },
    [activeCircuit, watchTargets],
  );

  const isGateWatched = useCallback(
    (gate: GateInstance) => {
      if (!activeCircuit) return false;
      const dp = getDefaultWatchPin(gate, project);
      if (!dp) return false;
      const id = makePinWatchId(activeCircuit.id, gate.id, dp.pinId);
      return watchTargets.some((t) => t.id === id);
    },
    [activeCircuit, project, watchTargets],
  );

  const handleToggleWatchWire = useCallback(
    (wire: Wire) => {
      if (!activeCircuit) return;
      const id = makeWireWatchId(activeCircuit.id, wire.id);
      setWatchTargets((prev) => {
        if (prev.some((t) => t.id === id)) {
          return prev.filter((t) => t.id !== id);
        }
        const label = buildWireWatchLabel(wire, activeCircuit);
        return [
          ...prev,
          { id, circuitId: activeCircuit.id, kind: 'wire', wireId: wire.id, label, radix: 'auto' },
        ];
      });
      setShowWatchPanel(true);
    },
    [activeCircuit],
  );

  const handleToggleWatchGate = useCallback(
    (gate: GateInstance) => {
      if (!activeCircuit) return;
      const dp = getDefaultWatchPin(gate, project);
      if (!dp) {
        store.showToast('このパーツには監視可能な端子がありません');
        return;
      }
      const id = makePinWatchId(activeCircuit.id, gate.id, dp.pinId);
      setWatchTargets((prev) => {
        if (prev.some((t) => t.id === id)) {
          return prev.filter((t) => t.id !== id);
        }
        const label = buildPinWatchLabel(gate, dp.pinId, dp.pinName);
        return [
          ...prev,
          {
            id,
            circuitId: activeCircuit.id,
            kind: 'pin',
            gateId: gate.id,
            pinId: dp.pinId,
            label,
            radix: 'auto',
          },
        ];
      });
      setShowWatchPanel(true);
    },
    [activeCircuit, project, store],
  );

  const handleAddAllCircuitPortsToWatch = useCallback(() => {
    if (!activeCircuit) return;
    const portTypes = new Set(['MODULE_IN', 'MODULE_OUT', 'TOGGLE', 'CLOCK', 'LED', 'NUM_DISPLAY']);
    setWatchTargets((prev) => {
      const existing = new Set(prev.map((t) => t.id));
      const added: WatchTarget[] = [];
      for (const g of activeCircuit.gates) {
        if (!portTypes.has(g.type)) continue;
        const dp = getDefaultWatchPin(g, project);
        if (!dp) continue;
        const id = makePinWatchId(activeCircuit.id, g.id, dp.pinId);
        if (existing.has(id)) continue;
        existing.add(id);
        added.push({
          id,
          circuitId: activeCircuit.id,
          kind: 'pin',
          gateId: g.id,
          pinId: dp.pinId,
          label: buildPinWatchLabel(g, dp.pinId, dp.pinName),
          radix: 'auto',
        });
      }
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  }, [activeCircuit, project]);

  const handleManualWatchSample = useCallback(() => {
    if (!activeCircuit || !simActive || !snapshot) return;
    const sampled = sampleWatchedSignals(watchTargets, activeCircuit, project, snapshot);
    setWaveHistoryByCircuit((prev) => ({
      ...prev,
      [activeCircuit.id]: appendWaveformStep(prev[activeCircuit.id] ?? [], sampled),
    }));
  }, [simActive, snapshot, watchTargets, activeCircuit, project]);

  const handleReorderWatchTarget = useCallback(
    (targetId: string, dir: -1 | 1) => {
      if (!activeCircuit) return;
      setWatchTargets((prev) => {
        const curIds = prev.filter((t) => t.circuitId === activeCircuit.id).map((t) => t.id);
        const pos = curIds.indexOf(targetId);
        const swapPos = pos + dir;
        if (pos === -1 || swapPos < 0 || swapPos >= curIds.length) return prev;
        const idxA = prev.findIndex((t) => t.id === curIds[pos]);
        const idxB = prev.findIndex((t) => t.id === curIds[swapPos]);
        const next = prev.slice();
        const tmp = next[idxA];
        next[idxA] = next[idxB];
        next[idxB] = tmp;
        return next;
      });
    },
    [activeCircuit],
  );

  const handleEndDragGate = useCallback(() => {
    setDraggingGate(null);
    setDragCursor(null);
    setDragOverCanvas(false);
  }, []);

  const quickEditWireLabel = useCallback(
    (wire: Wire) => {
      const next = window.prompt('ワイヤーのネットラベルを入力 (空欄で解除):', wire.netLabel ?? '');
      if (next !== null) {
        store.updateWire(wire.id, { netLabel: next.trim() || undefined });
      }
    },
    [store],
  );

  const quickEditGateLabel = useCallback(
    (gate: GateInstance) => {
      const next = window.prompt('パーツのラベル名を入力:', gate.label);
      if (next !== null) {
        store.updateGate(gate.id, { label: next.trim() });
      }
    },
    [store],
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if ((mod && key === 'y') || (mod && e.shiftKey && key === 'z')) {
        e.preventDefault();
        store.redo();
      } else if (mod && key === 'c') {
        e.preventDefault();
        store.copySelection();
      } else if (mod && key === 'v') {
        e.preventDefault();
        store.pasteClipboard();
      } else if (mod && key === 'd') {
        e.preventDefault();
        store.duplicateSelection();
      } else if (mod && key === 'a') {
        e.preventDefault();
        store.selectAll();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelection();
      } else if (!mod && key === 'r') {
        e.preventDefault();
        store.rotateSelectedGates();
      } else if (!mod && key === 'g') {
        e.preventDefault();
        store.updateSettings({
          routeMode: project.settings.routeMode === 'grid' ? 'free' : 'grid',
        });
      } else if (!mod && key === 'f') {
        e.preventDefault();
        setFitTrigger((t) => t + 1);
      } else if (!mod && key === 'l' && activeCircuit && selectedWireIds.size === 1) {
        e.preventDefault();
        const wid = Array.from(selectedWireIds)[0];
        const w = activeCircuit.wires.find((x) => x.id === wid);
        if (w) quickEditWireLabel(w);
      } else if (!mod && key === 's') {
        e.preventDefault();
        store.stepSimulation();
      } else if (e.key === '?') {
        e.preventDefault();
        setShowShortcutsModal((v) => !v);
      } else if (e.key === 'Escape') {
        setContextMenu(null);
        setLivePopupPath(null);
        setSelectedGateIds(new Set());
        setSelectedWireIds(new Set());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    store,
    project.settings.routeMode,
    selectedWireIds,
    activeCircuit,
    quickEditWireLabel,
    setSelectedGateIds,
    setSelectedWireIds,
  ]);

  const handleQuickAddGate = (type: GateType, subcircuitId?: string) => {
    if (!activeCircuit) {
      store.showToast('パーツを配置するには回路タブを開くか新規モジュールを作成してください');
      return;
    }
    const vp = viewportRef.current;
    const rect = canvasHostRef.current?.getBoundingClientRect();
    const screenCx = rect ? rect.width * 0.5 : window.innerWidth * 0.45;
    const screenCy = rect ? rect.height * 0.48 : window.innerHeight * 0.45;
    const cx = (screenCx - vp.x) / vp.zoom;
    const cy = (screenCy - vp.y) / vp.zoom;
    const jitter = (Math.random() - 0.5) * 60;
    const extra = subcircuitId ? { subcircuitId, displayMode: 'live' as const } : undefined;
    const label = subcircuitId ? project.circuits[subcircuitId]?.name : undefined;
    store.addGate(type, cx + jitter, cy + jitter, extra, label);
    // On mobile tap-add, keep the left sidebar open per UX design and give clear feedback
    if (isMobile) {
      const displayName = subcircuitId
        ? (project.circuits[subcircuitId]?.name ?? 'モジュール')
        : GATE_CATALOG[type].name;
      store.showToast(`${displayName} をキャンバスへ配置しました`);
    }
  };

  const handleTouchDropGate = useCallback(
    (payload: DragGatePayload, clientX: number, clientY: number) => {
      if (!activeCircuit) return;
      const host = canvasHostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return;
      }
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const worldPt = screenToWorld({ x: sx, y: sy }, viewportRef.current);
      const hit = hitTestGate(worldPt, activeCircuit, project);
      if (hit && (hit.type !== payload.type || hit.props.subcircuitId !== payload.subcircuitId)) {
        store.replaceGate(hit.id, payload.type, payload.subcircuitId);
      } else {
        const extra = payload.subcircuitId
          ? { subcircuitId: payload.subcircuitId, displayMode: 'live' as const }
          : undefined;
        const label = payload.subcircuitId
          ? project.circuits[payload.subcircuitId]?.name
          : undefined;
        store.addGate(payload.type, worldPt.x, worldPt.y, extra, label);
      }
    },
    [activeCircuit, project, store],
  );

  const handleAddGateAt = (type: GateType, x: number, y: number, subcircuitId?: string) => {
    const extra = subcircuitId ? { subcircuitId, displayMode: 'live' as const } : undefined;
    const label = subcircuitId ? project.circuits[subcircuitId]?.name : undefined;
    store.addGate(type, x, y, extra, label);
  };

  const handleSaveProject = () => {
    const json = store.exportProjectJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/\s+/g, '_') || 'project'}.lcirc.json`;
    a.click();
    URL.revokeObjectURL(url);
    store.showToast('プロジェクトを .lcirc.json として保存しました');
  };

  const handleLoadProjectFile = (file: File) => {
    void file.text().then((txt) => {
      try {
        store.loadProjectJson(txt);
      } catch (err) {
        store.showToast(err instanceof Error ? err.message : 'ファイル読み込みに失敗しました');
      }
    });
  };

  const handleImportModuleFile = (file: File) => {
    void file.text().then((txt) => {
      try {
        store.importExternalModuleFile(txt, file.name);
      } catch (err) {
        store.showToast(err instanceof Error ? err.message : 'モジュール読み込みに失敗しました');
      }
    });
  };

  const memoryGate =
    activeCircuit && memoryGateId
      ? (activeCircuit.gates.find((g) => g.id === memoryGateId) ?? null)
      : null;

  const availableModules = Object.values(project.circuits).filter((c) => !c.isStub);

  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        if (draggingGate) {
          setDragCursor({ x: e.clientX, y: e.clientY });
        }
      }}
    >
      <TopBar
        project={project}
        simActive={simActive}
        manualSimRunning={manualSimRunning}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        onRenameProject={store.renameProject}
        onSelectCircuit={store.setActiveCircuit}
        onNewCircuit={() => store.createNewCircuit()}
        onNewHdlCircuit={handleNewHdlCircuit}
        onCloseTab={store.closeCircuitTab}
        onReorderTabs={store.reorderCircuitTabs}
        onUndo={store.undo}
        onRedo={store.redo}
        onToggleSimMode={() => {
          const next = project.settings.simMode === 'realtime' ? 'manual' : 'realtime';
          store.updateSettings({ simMode: next });
          if (next === 'manual') setManualSimRunning(false);
        }}
        onToggleManualRun={() => setManualSimRunning((v) => !v)}
        onToggleClock={() => store.updateSettings({ clockRunning: !project.settings.clockRunning })}
        onStepClock={store.stepSimulation}
        onChangeClockHz={(hz) => store.updateSettings({ clockHz: hz })}
        onResetSeq={store.resetSequentialState}
        onToggleRouteMode={() =>
          store.updateSettings({
            routeMode: project.settings.routeMode === 'grid' ? 'free' : 'grid',
          })
        }
        onChangeGlobalDisplay={(mode) => store.updateSettings({ globalSubcircuitDisplay: mode })}
        onSaveProject={handleSaveProject}
        onLoadProjectFile={handleLoadProjectFile}
        onImportModuleFile={handleImportModuleFile}
        onOpenVerilogImport={() => setShowVerilogModal(true)}
        onOpenNetlistExport={() => setShowNetlistModal(true)}
        onOpenSymbolEditor={() => setShowSymbolModal(true)}
        onOpenHdlSource={(cid) => setHdlSourceCircuitId((cur) => (cur === cid ? null : cid))}
        watchPanelOpen={showWatchPanel}
        watchCount={activeWatchTargets.length}
        onToggleWatchPanel={() => setShowWatchPanel((v) => !v)}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
        onLoadSample={store.loadSampleProject}
      />

      <main className="workspace-main">
        {isMobile && (leftSidebarOpen || rightSidebarOpen) && (
          <div
            className="mobile-drawer-backdrop"
            onClick={() => {
              setLeftSidebarOpen(false);
              setRightSidebarOpen(false);
            }}
          />
        )}

        <div className={`sidebar-slot sidebar-left ${leftSidebarOpen ? 'open' : 'closed'}`}>
          <ComponentPalette
            project={project}
            editLocked={editLocked}
            isMobile={isMobile}
            onCloseSidebar={() => setLeftSidebarOpen(false)}
            onQuickAddGate={handleQuickAddGate}
            onDragStartGate={(payload, cx, cy) => {
              setDraggingGate(payload);
              setDragCursor({ x: cx, y: cy });
              setDragOverCanvas(false);
              // On mobile, dragging a component out of the left catalog auto-closes the drawer!
              if (isMobile) setLeftSidebarOpen(false);
            }}
            onDragMoveGate={(cx, cy) => setDragCursor({ x: cx, y: cy })}
            onTouchDropGate={handleTouchDropGate}
            onDragEndGate={handleEndDragGate}
            onOpenCircuit={store.setActiveCircuit}
            onOpenHdlSource={(cid) => setHdlSourceCircuitId(cid)}
            onDeleteModule={(cid) => {
              if (hdlSourceCircuitId === cid) setHdlSourceCircuitId(null);
              store.removeCustomModule(cid);
            }}
            onDeleteHdlProject={(pid) => {
              const b = project.hdlProjects?.[pid];
              if (b && hdlSourceCircuitId && b.moduleCircuitIds.includes(hdlSourceCircuitId)) {
                setHdlSourceCircuitId(null);
              }
              store.deleteHdlProject(pid);
            }}
            onSetHdlTopModule={store.setHdlProjectTopModule}
          />
        </div>

        <div className={`workspace-center ${hdlDockPos === 'right' ? 'dock-row' : 'dock-col'}`}>
          <div ref={canvasHostRef} className="workspace-canvas-col">
            <button
              className={`icon-btn canvas-floating-toggle canvas-floating-left ${leftSidebarOpen ? 'is-hidden' : 'is-visible'}`}
              onClick={toggleLeftSidebar}
              title="左パーツパレットを表示"
              aria-label="コンポーネントを開く"
              tabIndex={leftSidebarOpen ? -1 : 0}
            >
              <PanelLeft size={15} />
              <span>コンポーネントを開く</span>
            </button>
            <button
              className={`icon-btn canvas-floating-toggle canvas-floating-right ${rightSidebarOpen ? 'is-hidden' : 'is-visible'}`}
              onClick={toggleRightSidebar}
              title="右インスペクタを表示"
              aria-label="インスペクタを開く"
              tabIndex={rightSidebarOpen ? -1 : 0}
            >
              <span>インスペクタを開く</span>
              <PanelRight size={15} />
            </button>
            {activeCircuit ? (
              <>
                <CircuitCanvas
                  project={project}
                  circuit={activeCircuit}
                  snapshot={snapshot}
                  simActive={simActive}
                  editLocked={editLocked}
                  runtimeInputs={runtimeInputs}
                  selectedGateIds={selectedGateIds}
                  selectedWireIds={selectedWireIds}
                  onSelect={(g, w) => {
                    setSelectedGateIds(g);
                    setSelectedWireIds(w);
                  }}
                  onAddGateAt={handleAddGateAt}
                  onReplaceGate={store.replaceGate}
                  onMoveGates={store.moveGates}
                  onAddWire={store.addWire}
                  onExtendFloatingWire={store.extendFloatingWire}
                  onUpdateWirePoints={store.updateWirePoints}
                  onInteractGate={store.interactGateClick}
                  onButtonPress={store.setButtonPressed}
                  onOpenSubcircuit={store.setActiveCircuit}
                  onOpenLiveSubcircuitPopup={(gid) => setLivePopupPath([gid])}
                  onQuickEditWireLabel={quickEditWireLabel}
                  onOpenContextMenu={setContextMenu}
                  onChangeInputMode={(mode) => store.updateSettings({ inputMode: mode })}
                  draggingGate={draggingGate}
                  onDragOverCanvasChange={setDragOverCanvas}
                  onDropComplete={handleEndDragGate}
                  viewportRef={viewportRef}
                  fitTrigger={fitTrigger}
                />

                {showWatchPanel && (
                  <WatchWaveformPanel
                    circuit={activeCircuit}
                    project={project}
                    snapshot={snapshot}
                    simActive={simActive}
                    targets={watchTargets}
                    history={activeWaveHistory}
                    recording={watchRecording}
                    onToggleRecording={() => setWatchRecording((v) => !v)}
                    onManualSample={handleManualWatchSample}
                    onClearHistory={() =>
                      setWaveHistoryByCircuit((prev) => ({ ...prev, [activeCircuit.id]: [] }))
                    }
                    onAddTarget={(target) =>
                      setWatchTargets((prev) =>
                        prev.some((t) => t.id === target.id) ? prev : [...prev, target],
                      )
                    }
                    onAddAllCircuitPorts={handleAddAllCircuitPortsToWatch}
                    onRemoveTarget={(tid) =>
                      setWatchTargets((prev) => prev.filter((t) => t.id !== tid))
                    }
                    onUpdateTarget={(tid, patch) =>
                      setWatchTargets((prev) =>
                        prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)),
                      )
                    }
                    onReorderTarget={handleReorderWatchTarget}
                    onClose={() => setShowWatchPanel(false)}
                  />
                )}
              </>
            ) : (
              <div className="empty-workspace">
                <div className="empty-workspace-card">
                  <div className="empty-workspace-icon">
                    <Cpu size={28} className="accent-green" />
                  </div>
                  <h2 className="empty-workspace-title">開いている回路タブがありません</h2>
                  <p className="empty-workspace-desc">
                    モジュール定義は左パレットに保持されています。新しく作成するか、既存のモジュールを開いて作業を再開できます。
                  </p>
                  <div className="empty-workspace-actions">
                    <button
                      className="pill-btn active-green"
                      onClick={() => store.createNewCircuit()}
                    >
                      <Plus size={14} />
                      <span>新規モジュール</span>
                    </button>
                    <button className="pill-btn active-blue" onClick={handleNewHdlCircuit}>
                      <FileCode2 size={14} />
                      <span>新規HDL</span>
                    </button>
                    <button className="pill-btn" onClick={() => setShowVerilogModal(true)}>
                      <FolderOpen size={14} />
                      <span>HDL読込</span>
                    </button>
                  </div>
                  {availableModules.length > 0 && (
                    <div className="empty-workspace-modules">
                      <div className="empty-workspace-sub">
                        <Layers size={12} />
                        <span>プロジェクト内のモジュールを開く ({availableModules.length})</span>
                      </div>
                      <div className="empty-module-chips">
                        {availableModules.slice(0, 10).map((c) => (
                          <button
                            key={c.id}
                            className="empty-module-chip"
                            onClick={() => store.setActiveCircuit(c.id)}
                          >
                            <span className="tab-dot" />
                            <span>{c.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {hdlSourceCircuitId && project.circuits[hdlSourceCircuitId] && (
            <HdlDockPanel
              circuit={project.circuits[hdlSourceCircuitId]}
              circuits={project.circuits}
              hdlProject={
                project.circuits[hdlSourceCircuitId].hdlProjectId
                  ? project.hdlProjects?.[project.circuits[hdlSourceCircuitId].hdlProjectId!]
                  : undefined
              }
              dock={hdlDockPos}
              editLocked={editLocked}
              autoEditTrigger={hdlAutoEditTrigger}
              onChangeDock={setHdlDockPos}
              onSelectModuleHdl={(cid) => setHdlSourceCircuitId(cid)}
              onOpenCircuitTab={store.setActiveCircuit}
              onSynthesize={store.resynthesizeFromHdl}
              onSynthesizeProject={store.resynthesizeHdlProjectBundle}
              onCopied={() => store.showToast('HDL ソースをクリップボードにコピーしました')}
              onClose={() => setHdlSourceCircuitId(null)}
            />
          )}
        </div>

        <div className={`sidebar-slot sidebar-right ${rightSidebarOpen ? 'open' : 'closed'}`}>
          <InspectorPanel
            project={project}
            circuit={activeCircuit}
            snapshot={snapshot}
            simActive={simActive}
            editLocked={editLocked}
            selectedGateIds={selectedGateIds}
            selectedWireIds={selectedWireIds}
            onUpdateGate={store.updateGate}
            onReplaceGate={store.replaceGate}
            onUpdateWire={store.updateWire}
            onRerouteWire={store.rerouteSingleWire}
            onRenameCircuit={store.renameCircuit}
            onOpenCircuit={store.setActiveCircuit}
            onOpenLiveSubcircuitPopup={(gid) => setLivePopupPath([gid])}
            onOpenHdlSource={(cid) => setHdlSourceCircuitId(cid)}
            onOpenMemoryEditor={(gid) => setMemoryGateId(gid)}
            onOpenSymbolEditor={() => setShowSymbolModal(true)}
            onDeleteSelection={store.deleteSelection}
            watchTargets={watchTargets}
            isWireWatched={isWireWatched}
            onToggleWatchWire={handleToggleWatchWire}
            onRemoveWatchTarget={(tid) =>
              setWatchTargets((prev) => prev.filter((t) => t.id !== tid))
            }
            onUpdateWatchTarget={(tid, patch) =>
              setWatchTargets((prev) => prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)))
            }
            onReorderWatchTarget={handleReorderWatchTarget}
            onToggleWatchPanel={() => setShowWatchPanel((v) => !v)}
            onCloseSidebar={() => setRightSidebarOpen(false)}
          />
        </div>
      </main>

      {livePopupPath && activeCircuit && (
        <LiveSubcircuitPopup
          rootCircuit={activeCircuit}
          project={project}
          rootSnapshot={snapshot}
          simActive={simActive}
          gatePath={livePopupPath}
          onChangeGatePath={setLivePopupPath}
          onOpenCircuitTab={(cid) => {
            setLivePopupPath(null);
            store.setActiveCircuit(cid);
          }}
          onClose={() => setLivePopupPath(null)}
        />
      )}

      {contextMenu && activeCircuit && (
        <ContextMenu
          menu={contextMenu}
          routeMode={project.settings.routeMode}
          hasClipboard={store.hasClipboard}
          editLocked={editLocked}
          activeCircuitId={activeCircuit.id}
          circuitHasHdlSource={Boolean(activeCircuit.hdlSource || activeCircuit.hdlFileSource)}
          targetSubHasHdlSource={Boolean(
            contextMenu.gate?.type === 'SUBCIRCUIT' &&
            contextMenu.gate.props.subcircuitId &&
            (project.circuits[contextMenu.gate.props.subcircuitId]?.hdlSource ||
              project.circuits[contextMenu.gate.props.subcircuitId]?.hdlFileSource),
          )}
          targetSubIsStub={Boolean(
            contextMenu.gate?.type === 'SUBCIRCUIT' &&
            contextMenu.gate.props.subcircuitId &&
            project.circuits[contextMenu.gate.props.subcircuitId]?.isStub,
          )}
          isWireWatched={Boolean(contextMenu.wire && isWireWatched(contextMenu.wire.id))}
          canWatchGate={Boolean(
            contextMenu.gate && getDefaultWatchPin(contextMenu.gate, project) !== null,
          )}
          watchGatePinLabel={
            contextMenu.gate ? getDefaultWatchPin(contextMenu.gate, project)?.pinName : undefined
          }
          isGateWatched={Boolean(contextMenu.gate && isGateWatched(contextMenu.gate))}
          onClose={() => setContextMenu(null)}
          onSetWireNetLabel={quickEditWireLabel}
          onToggleWatchWire={handleToggleWatchWire}
          onToggleWatchGate={handleToggleWatchGate}
          onToggleWireRouteMode={(w) =>
            store.updateWire(w.id, { routeMode: w.routeMode === 'grid' ? 'free' : 'grid' })
          }
          onRerouteWire={store.rerouteSingleWire}
          onSetGateLabel={quickEditGateLabel}
          onRotate={store.rotateSelectedGates}
          onCopy={store.copySelection}
          onPaste={store.pasteClipboard}
          onDuplicate={store.duplicateSelection}
          onReplaceGate={store.replaceGate}
          onDeleteKeepWires={() => store.deleteGatesKeepWires()}
          onDelete={store.deleteSelection}
          onSetSubcircuitMode={(gid, mode) => store.updateGate(gid, {}, { displayMode: mode })}
          onOpenSubcircuit={store.setActiveCircuit}
          onOpenLiveSubcircuitPopup={(gid) => setLivePopupPath([gid])}
          onOpenHdlSource={(cid) => setHdlSourceCircuitId(cid)}
          onOpenMemoryEditor={(gid) => setMemoryGateId(gid)}
          onAddTunnelAt={(pt: Point) => {
            const name = window.prompt('ネットラベル (トンネル) 名:', 'NET_1');
            if (name?.trim()) {
              store.addGate(
                'TUNNEL',
                pt.x,
                pt.y,
                { netName: name.trim(), bitWidth: 1 },
                name.trim(),
              );
            }
          }}
          onToggleGlobalRouteMode={() =>
            store.updateSettings({
              routeMode: project.settings.routeMode === 'grid' ? 'free' : 'grid',
            })
          }
          onAlignToGrid={store.alignSelectedToGrid}
          onRerouteAll={store.rerouteAllWires}
          onZoomToFit={() => setFitTrigger((t) => t + 1)}
        />
      )}

      {showVerilogModal && (
        <VerilogImportModal
          onClose={() => setShowVerilogModal(false)}
          onImportFiles={store.importVerilogFiles}
        />
      )}

      {showNetlistModal && activeCircuit && (
        <NetlistExportModal
          project={project}
          circuitId={activeCircuit.id}
          onClose={() => setShowNetlistModal(false)}
          onCopied={() => store.showToast('ネットリストをクリップボードにコピーしました')}
        />
      )}

      {showSymbolModal && activeCircuit && (
        <SymbolEditorModal
          circuit={activeCircuit}
          onClose={() => setShowSymbolModal(false)}
          onSave={(cfg) => store.updateSymbolConfig(activeCircuit.id, cfg)}
        />
      )}

      {memoryGate && (
        <MemoryEditorModal
          gate={memoryGate}
          liveRam={memoryGate.type === 'RAM' ? snapshot?.ramData[memoryGate.id] : undefined}
          onClose={() => setMemoryGateId(null)}
          onSave={(data) => {
            store.updateGate(memoryGate.id, {}, { memoryData: data });
            store.resetSequentialState();
          }}
        />
      )}

      {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}

      {draggingGate && dragCursor && !dragOverCanvas && (
        <DragSymbolOverlay
          payload={draggingGate}
          clientX={dragCursor.x}
          clientY={dragCursor.y}
          project={project}
          zoom={viewportRef.current.zoom}
        />
      )}

      {store.toast && <div className="toast-banner">{store.toast}</div>}
    </div>
  );
};
