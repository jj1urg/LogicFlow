import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitFork,
  Layers,
  List,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { CATEGORY_LABELS, GATE_CATALOG } from '../core/catalog';
import { buildHdlModuleTree, HdlModuleTreeNode } from '../core/hdl';
import { CircuitDocument, GateCategory, GateType, ProjectDocument } from '../core/types';

export interface DragGatePayload {
  type: GateType;
  subcircuitId?: string;
}

interface ComponentPaletteProps {
  project: ProjectDocument;
  editLocked: boolean;
  onQuickAddGate: (type: GateType, subcircuitId?: string) => void;
  onDragStartGate: (payload: DragGatePayload, clientX: number, clientY: number) => void;
  onDragEndGate: () => void;
  onOpenCircuit: (circuitId: string) => void;
  onOpenHdlSource: (circuitId: string) => void;
  onDeleteModule: (circuitId: string) => void;
  onDeleteHdlProject: (hdlProjectId: string) => void;
  onSetHdlTopModule: (hdlProjectId: string, circuitId: string) => void;
}

let transparentDragCanvas: HTMLCanvasElement | null = null;
function getTransparentDragImage(): HTMLCanvasElement {
  if (!transparentDragCanvas) {
    transparentDragCanvas = document.createElement('canvas');
    transparentDragCanvas.width = 1;
    transparentDragCanvas.height = 1;
  }
  return transparentDragCanvas;
}

const ORDERED_CATEGORIES: GateCategory[] = [
  'io',
  'gates',
  'combinational',
  'sequential',
  'memory',
  'wiring',
];

export const ComponentPalette: React.FC<ComponentPaletteProps> = ({
  project,
  editLocked,
  onQuickAddGate,
  onDragStartGate,
  onDragEndGate,
  onOpenCircuit,
  onOpenHdlSource,
  onDeleteModule,
  onDeleteHdlProject,
  onSetHdlTopModule,
}) => {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [projViewMode, setProjViewMode] = useState<Record<string, 'tree' | 'list'>>({});

  const toggleCat = (cat: string) => {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const q = query.trim().toLowerCase();

  const grouped = useMemo(() => {
    const entries = Object.values(GATE_CATALOG).filter((e) => e.type !== 'SUBCIRCUIT');
    return ORDERED_CATEGORIES.map((cat) => {
      const items = entries.filter(
        (e) =>
          e.category === cat &&
          (!q ||
            e.name.toLowerCase().includes(q) ||
            e.shortName.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q)),
      );
      return { cat, label: CATEGORY_LABELS[cat], items };
    }).filter((g) => g.items.length > 0);
  }, [q]);

  // HDL Project bundles with hierarchy trees (excluding all external stubs!)
  const hdlProjectBundles = useMemo(() => {
    const bundles = Object.values(project.hdlProjects ?? {});
    return bundles
      .map((b) => {
        const modules = b.moduleCircuitIds
          .map((id) => project.circuits[id])
          .filter(
            (c): c is CircuitDocument =>
              Boolean(c && !c.isStub) &&
              (!q ||
                c.name.toLowerCase().includes(q) ||
                b.name.toLowerCase().includes(q) ||
                (c.hdlFileName?.toLowerCase().includes(q) ?? false)),
          );
        const tree = buildHdlModuleTree(b, project.circuits);
        return { bundle: b, modules, tree };
      })
      .filter((entry) => entry.modules.length > 0);
  }, [project.hdlProjects, project.circuits, q]);

  const bundledCircuitIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of Object.values(project.hdlProjects ?? {})) {
      for (const id of b.moduleCircuitIds) set.add(id);
    }
    return set;
  }, [project.hdlProjects]);

  // Standalone custom modules (NEVER include external stubs!)
  const standaloneModules = useMemo(() => {
    return Object.values(project.circuits).filter(
      (c) => !c.isStub && !bundledCircuitIds.has(c.id) && (!q || c.name.toLowerCase().includes(q)),
    );
  }, [project.circuits, bundledCircuitIds, q]);

  const totalNonStubs = useMemo(
    () => Object.values(project.circuits).filter((c) => !c.isStub).length,
    [project.circuits],
  );

  const handleDragStart = (e: React.DragEvent, type: GateType, subcircuitId?: string) => {
    if (editLocked || (subcircuitId && subcircuitId === project.activeCircuitId)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('application/logicflow-gate', JSON.stringify({ type, subcircuitId }));
    e.dataTransfer.effectAllowed = 'copy';
    // Suppress the default browser list-row drag ghost so we render the real gate/module symbol instead!
    e.dataTransfer.setDragImage(getTransparentDragImage(), 0, 0);
    onDragStartGate({ type, subcircuitId }, e.clientX, e.clientY);
  };

  const renderModuleRow = (c: CircuitDocument, opts?: { hdlProjectId: string; isTop: boolean }) => {
    const isActive = c.id === project.activeCircuitId;
    const canPlace = !editLocked && !isActive;
    const hasHdl = Boolean(c.hdlSource || c.hdlFileSource);

    return (
      <div
        key={c.id}
        className={`palette-item module-item ${isActive ? 'module-active' : ''}`}
        draggable={canPlace}
        onDragStart={(e) => handleDragStart(e, 'SUBCIRCUIT', c.id)}
        onDragEnd={onDragEndGate}
        onClick={() => {
          if (canPlace) onQuickAddGate('SUBCIRCUIT', c.id);
          else onOpenCircuit(c.id);
        }}
        title={
          isActive
            ? `${c.name}（現在表示中）`
            : `${c.name} をクリック/ドラッグで配置（右ボタンから中身を開く・削除できます）`
        }
      >
        <span className={`item-badge ${opts?.isTop ? 'badge-top-mod' : 'badge-mod'}`}>
          {opts?.isTop ? 'TOP' : 'MOD'}
        </span>
        <div className="item-meta">
          <div className="item-name">
            {c.name}
            {c.hdlDiverged && <span className="palette-div-dot" title="回路側で編集済み" />}
          </div>
          <div className="item-desc">
            {isActive ? '現在表示中' : c.hdlFileName ? c.hdlFileName : 'サブ回路モジュール'}
          </div>
        </div>
        <div className="palette-item-actions" onClick={(e) => e.stopPropagation()}>
          {opts && !opts.isTop && (
            <button
              className="palette-act-btn"
              onClick={() => onSetHdlTopModule(opts.hdlProjectId, c.id)}
              title="トップモジュールに指定して開く"
            >
              <Star size={11} />
            </button>
          )}
          <button
            className="palette-act-btn"
            onClick={() => onOpenCircuit(c.id)}
            title="このモジュールの回路タブを開く"
          >
            <ExternalLink size={11} />
          </button>
          {hasHdl && (
            <button
              className="palette-act-btn"
              onClick={() => onOpenHdlSource(c.id)}
              title="HDLソースを表示"
            >
              <FileCode2 size={11} />
            </button>
          )}
          {!editLocked && totalNonStubs > 1 && (
            <button
              className="palette-act-btn danger"
              onClick={() => onDeleteModule(c.id)}
              title="このカスタムモジュールを削除"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderTreeNode = (node: HdlModuleTreeNode, hdlProjectId: string, depth: number) => {
    const isActive = node.circuitId === project.activeCircuitId;
    const canPlace = !editLocked && !isActive;
    const hasChildren = node.children.length > 0;
    const nodeKey = `tree:${node.key}`;
    const isCollapsed = Boolean(collapsed[nodeKey]);

    return (
      <div key={node.key} className="mod-tree-branch">
        <div
          className={`mod-tree-row ${isActive ? 'module-active' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={canPlace}
          onDragStart={(e) => handleDragStart(e, 'SUBCIRCUIT', node.circuitId)}
          onDragEnd={onDragEndGate}
          onClick={() => onOpenCircuit(node.circuitId)}
          title={`${node.instanceName ? `${node.instanceName} : ` : ''}${node.moduleName}${node.fileName ? ` (${node.fileName})` : ''} — クリックで回路タブを開く / ドラッグで配置`}
        >
          {hasChildren ? (
            <button
              className="mod-tree-toggle"
              onClick={(e) => {
                e.stopPropagation();
                toggleCat(nodeKey);
              }}
              aria-label="展開切替"
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : (
            <span className="mod-tree-spacer" />
          )}

          {node.isTop && <span className="tree-top-tag">TOP</span>}

          <span className="mod-tree-label">
            {node.instanceName ? (
              <>
                <span className="tree-inst-name">{node.instanceName}</span>
                <span className="tree-colon">:</span>
                <span className="tree-mod-name">{node.moduleName}</span>
              </>
            ) : (
              <span className="tree-mod-name">{node.moduleName}</span>
            )}
            {node.hdlDiverged && <span className="palette-div-dot" title="回路側で編集済み" />}
          </span>

          <div className="palette-item-actions" onClick={(e) => e.stopPropagation()}>
            {!node.isTop && (
              <button
                className="palette-act-btn"
                onClick={() => onSetHdlTopModule(hdlProjectId, node.circuitId)}
                title="トップモジュールに指定"
              >
                <Star size={10} />
              </button>
            )}
            {node.hasHdl && (
              <button
                className="palette-act-btn"
                onClick={() => onOpenHdlSource(node.circuitId)}
                title="HDLソースを表示"
              >
                <FileCode2 size={10} />
              </button>
            )}
            {!editLocked && totalNonStubs > 1 && (
              <button
                className="palette-act-btn danger"
                onClick={() => onDeleteModule(node.circuitId)}
                title="モジュールを削除"
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        </div>
        {hasChildren && !isCollapsed && (
          <div className="mod-tree-children">
            {node.children.map((ch) => renderTreeNode(ch, hdlProjectId, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className={`palette-panel ${editLocked ? 'panel-locked' : ''}`}>
      <div className="panel-header">
        <span className="panel-title">コンポーネント</span>
        <span className="panel-hint">
          {editLocked ? '実行中ロック' : 'ドラッグ or クリック配置'}
        </span>
      </div>

      <div className="palette-search">
        <Search size={14} className="search-icon" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ゲート・回路を検索..."
        />
      </div>

      <div className="palette-scroll">
        {/* HDL Project Bundles (multi-file / multi-module unified source groups + hierarchy tree!) */}
        {hdlProjectBundles.map(({ bundle, modules, tree }) => {
          const catKey = `hdlproj:${bundle.id}`;
          const mode = q ? 'list' : (projViewMode[bundle.id] ?? 'tree');
          return (
            <div key={bundle.id} className="palette-group hdl-proj-group">
              <div className="palette-cat-row">
                <button className="palette-cat-btn" onClick={() => toggleCat(catKey)}>
                  {collapsed[catKey] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <FolderGit2 size={13} className="accent-blue" />
                  <span className="palette-proj-title" title={`HDLプロジェクト: ${bundle.name}`}>
                    {bundle.name}
                  </span>
                  <span className="palette-proj-meta">
                    {bundle.files.length}F · {modules.length}M
                  </span>
                </button>
                <div className="palette-proj-actions">
                  <button
                    className={`palette-act-btn ${mode === 'tree' ? 'active-tree-btn' : ''}`}
                    onClick={() =>
                      setProjViewMode((prev) => ({
                        ...prev,
                        [bundle.id]: mode === 'tree' ? 'list' : 'tree',
                      }))
                    }
                    title={mode === 'tree' ? 'フラット一覧に切替' : 'モジュール階層ツリーに切替'}
                  >
                    {mode === 'tree' ? <GitFork size={11} /> : <List size={11} />}
                  </button>
                  <button
                    className="palette-act-btn"
                    onClick={() => onOpenHdlSource(bundle.topCircuitId)}
                    title="このHDLプロジェクトのソース一覧を開く"
                  >
                    <FileCode2 size={11} />
                  </button>
                  {!editLocked && (
                    <button
                      className="palette-act-btn danger"
                      onClick={() => onDeleteHdlProject(bundle.id)}
                      title={`HDLプロジェクト "${bundle.name}" をまとめて削除`}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              </div>
              {!collapsed[catKey] &&
                (mode === 'tree' && tree.root ? (
                  <div className="mod-tree-container">
                    {renderTreeNode(tree.root, bundle.id, 0)}
                    {tree.orphans.length > 0 && (
                      <div className="mod-tree-orphans">
                        <div className="mod-tree-orphan-hdr">
                          トップ外のモジュール ({tree.orphans.length})
                        </div>
                        {tree.orphans.map((o) => renderTreeNode(o, bundle.id, 0))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="palette-items">
                    {modules.map((c) =>
                      renderModuleRow(c, {
                        hdlProjectId: bundle.id,
                        isTop: c.id === bundle.topCircuitId,
                      }),
                    )}
                  </div>
                ))}
            </div>
          );
        })}

        {/* Standalone Custom Modules (stubs strictly excluded!) */}
        {standaloneModules.length > 0 && (
          <div className="palette-group">
            <button className="palette-cat-btn" onClick={() => toggleCat('modules')}>
              {collapsed['modules'] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <Layers size={13} className="accent-green" />
              <span>カスタムモジュール ({standaloneModules.length})</span>
            </button>
            {!collapsed['modules'] && (
              <div className="palette-items">
                {standaloneModules.map((c) => renderModuleRow(c))}
              </div>
            )}
          </div>
        )}

        {grouped.map(({ cat, label, items }) => (
          <div key={cat} className="palette-group">
            <button className="palette-cat-btn" onClick={() => toggleCat(cat)}>
              {collapsed[cat] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span>{label}</span>
            </button>
            {!collapsed[cat] && (
              <div className="palette-items">
                {items.map((item) => (
                  <div
                    key={item.type}
                    className="palette-item"
                    draggable={!editLocked}
                    onDragStart={(e) => handleDragStart(e, item.type)}
                    onDragEnd={onDragEndGate}
                    onClick={() => onQuickAddGate(item.type)}
                    title={item.description}
                  >
                    <span className={`item-badge badge-${cat}`}>{item.shortName}</span>
                    <div className="item-meta">
                      <div className="item-name">{item.name}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
};
