import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Viewport } from './canvas/hitTest';
import { renderGateSymbolPreview } from './canvas/renderer';
import { CircuitCanvas } from './components/CircuitCanvas';
import { ComponentPalette, DragGatePayload } from './components/ComponentPalette';
import { ContextMenu, ContextMenuState } from './components/ContextMenu';
import { HdlDockPanel, HdlDockPosition } from './components/HdlDockPanel';
import { InspectorPanel } from './components/InspectorPanel';
import {
  MemoryEditorModal,
  NetlistExportModal,
  ShortcutsModal,
  SymbolEditorModal,
  VerilogImportModal,
} from './components/Modals';
import { TopBar } from './components/TopBar';
import { GATE_CATALOG } from './core/catalog';
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
  const [memoryGateId, setMemoryGateId] = useState<string | null>(null);
  const [draggingGate, setDraggingGate] = useState<DragGatePayload | null>(null);
  const [dragCursor, setDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [dragOverCanvas, setDragOverCanvas] = useState(false);

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
      } else if (!mod && key === 'l' && selectedWireIds.size === 1) {
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
    activeCircuit.wires,
    quickEditWireLabel,
    setSelectedGateIds,
    setSelectedWireIds,
  ]);

  const handleQuickAddGate = (type: GateType, subcircuitId?: string) => {
    const vp = viewportRef.current;
    const cx = (window.innerWidth * 0.45 - vp.x) / vp.zoom;
    const cy = (window.innerHeight * 0.45 - vp.y) / vp.zoom;
    const jitter = (Math.random() - 0.5) * 60;
    const extra = subcircuitId ? { subcircuitId, displayMode: 'live' as const } : undefined;
    const label = subcircuitId ? project.circuits[subcircuitId]?.name : undefined;
    store.addGate(type, cx + jitter, cy + jitter, extra, label);
  };

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

  const memoryGate = memoryGateId
    ? (activeCircuit.gates.find((g) => g.id === memoryGateId) ?? null)
    : null;

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
        onDeleteCircuit={store.deleteCircuit}
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
        onOpenShortcuts={() => setShowShortcutsModal(true)}
        onLoadSample={store.loadSampleProject}
      />

      <main className="workspace-main">
        <ComponentPalette
          project={project}
          editLocked={editLocked}
          onQuickAddGate={handleQuickAddGate}
          onDragStartGate={(payload, cx, cy) => {
            setDraggingGate(payload);
            setDragCursor({ x: cx, y: cy });
            setDragOverCanvas(false);
          }}
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

        <div className={`workspace-center ${hdlDockPos === 'right' ? 'dock-row' : 'dock-col'}`}>
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
            onMoveGates={store.moveGates}
            onAddWire={store.addWire}
            onExtendFloatingWire={store.extendFloatingWire}
            onUpdateWirePoints={store.updateWirePoints}
            onInteractGate={store.interactGateClick}
            onButtonPress={store.setButtonPressed}
            onOpenSubcircuit={store.setActiveCircuit}
            onQuickEditWireLabel={quickEditWireLabel}
            onOpenContextMenu={setContextMenu}
            onChangeInputMode={(mode) => store.updateSettings({ inputMode: mode })}
            draggingGate={draggingGate}
            onDragOverCanvasChange={setDragOverCanvas}
            onDropComplete={handleEndDragGate}
            viewportRef={viewportRef}
            fitTrigger={fitTrigger}
          />

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

        <InspectorPanel
          project={project}
          circuit={activeCircuit}
          snapshot={snapshot}
          simActive={simActive}
          editLocked={editLocked}
          selectedGateIds={selectedGateIds}
          selectedWireIds={selectedWireIds}
          onUpdateGate={store.updateGate}
          onUpdateWire={store.updateWire}
          onRerouteWire={store.rerouteSingleWire}
          onRenameCircuit={store.renameCircuit}
          onOpenCircuit={store.setActiveCircuit}
          onOpenHdlSource={(cid) => setHdlSourceCircuitId(cid)}
          onOpenMemoryEditor={(gid) => setMemoryGateId(gid)}
          onOpenSymbolEditor={() => setShowSymbolModal(true)}
          onDeleteSelection={store.deleteSelection}
        />
      </main>

      {contextMenu && (
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
          onClose={() => setContextMenu(null)}
          onSetWireNetLabel={quickEditWireLabel}
          onToggleWireRouteMode={(w) =>
            store.updateWire(w.id, { routeMode: w.routeMode === 'grid' ? 'free' : 'grid' })
          }
          onRerouteWire={store.rerouteSingleWire}
          onSetGateLabel={quickEditGateLabel}
          onRotate={store.rotateSelectedGates}
          onCopy={store.copySelection}
          onPaste={store.pasteClipboard}
          onDuplicate={store.duplicateSelection}
          onDelete={store.deleteSelection}
          onSetSubcircuitMode={(gid, mode) => store.updateGate(gid, {}, { displayMode: mode })}
          onOpenSubcircuit={store.setActiveCircuit}
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

      {showNetlistModal && (
        <NetlistExportModal
          project={project}
          circuitId={activeCircuit.id}
          onClose={() => setShowNetlistModal(false)}
          onCopied={() => store.showToast('ネットリストをクリップボードにコピーしました')}
        />
      )}

      {showSymbolModal && (
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
