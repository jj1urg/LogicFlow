import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileCode2,
  FilePlus2,
  FolderGit2,
  GitFork,
  PanelBottom,
  PanelRight,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildHdlModuleTree,
  HdlModuleTreeNode,
  HdlSourceFile,
  listModuleNamesInFiles,
} from '../core/hdl';
import { CircuitDocument, HdlProjectBundle } from '../core/types';

export type HdlDockPosition = 'bottom' | 'right';

const HDL_KEYWORDS = new Set([
  'module',
  'endmodule',
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'bit',
  'assign',
  'always',
  'always_comb',
  'always_ff',
  'always_latch',
  'initial',
  'final',
  'parameter',
  'localparam',
  'begin',
  'end',
  'if',
  'else',
  'for',
  'while',
  'case',
  'casex',
  'casez',
  'endcase',
  'default',
  'posedge',
  'negedge',
  'edge',
  'generate',
  'endgenerate',
  'genvar',
  'function',
  'endfunction',
  'task',
  'endtask',
  'typedef',
  'struct',
  'enum',
  'import',
  'export',
  'package',
  'endpackage',
  'interface',
  'endinterface',
  'assert',
  'assume',
  'cover',
  'property',
  'endproperty',
  'sequence',
  'endsequence',
  'signed',
  'unsigned',
  'automatic',
  'static',
  'unique',
  'priority',
  'return',
]);

function highlightHdlLine(line: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|`[a-zA-Z_]\w*|\$[a-zA-Z_]\w*|\b\d+'s?[bhdoBHDO][0-9a-fA-FxXzZ_?]+\b|\b'[01xXzZ]\b|\b\d+\b|\b[a-zA-Z_]\w*\b)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(line.slice(lastIdx, match.index));
    }
    const tok = match[0];
    if (tok.startsWith('//') || tok.startsWith('/*')) {
      nodes.push(
        <span key={key++} className="hdl-tok-comment">
          {tok}
        </span>,
      );
    } else if (tok.startsWith('"')) {
      nodes.push(
        <span key={key++} className="hdl-tok-str">
          {tok}
        </span>,
      );
    } else if (tok.startsWith('`')) {
      nodes.push(
        <span key={key++} className="hdl-tok-dir">
          {tok}
        </span>,
      );
    } else if (tok.startsWith('$')) {
      nodes.push(
        <span key={key++} className="hdl-tok-sys">
          {tok}
        </span>,
      );
    } else if (/^\d|^'/.test(tok)) {
      nodes.push(
        <span key={key++} className="hdl-tok-num">
          {tok}
        </span>,
      );
    } else if (HDL_KEYWORDS.has(tok)) {
      nodes.push(
        <span key={key++} className="hdl-tok-kw">
          {tok}
        </span>,
      );
    } else {
      nodes.push(tok);
    }
    lastIdx = match.index + tok.length;
  }

  if (lastIdx < line.length) {
    nodes.push(line.slice(lastIdx));
  }
  return nodes.length > 0 ? nodes : [' '];
}

interface HdlDockPanelProps {
  circuit: CircuitDocument;
  circuits: Record<string, CircuitDocument>;
  hdlProject?: HdlProjectBundle;
  dock: HdlDockPosition;
  editLocked: boolean;
  /** Incrementing trigger that opens the panel directly into edit mode (e.g. when creating a new HDL module) */
  autoEditTrigger?: number;
  onChangeDock: (dock: HdlDockPosition) => void;
  onSelectModuleHdl: (circuitId: string) => void;
  onOpenCircuitTab: (circuitId: string) => void;
  onSynthesize: (circuitId: string, newSource: string) => string[];
  onSynthesizeProject?: (
    hdlProjectId: string,
    files: HdlSourceFile[],
    topModuleName?: string,
  ) => string[];
  onCopied: () => void;
  onClose: () => void;
}

export const HdlDockPanel: React.FC<HdlDockPanelProps> = ({
  circuit,
  circuits,
  hdlProject,
  dock,
  editLocked,
  autoEditTrigger,
  onChangeDock,
  onSelectModuleHdl,
  onOpenCircuitTab,
  onSynthesize,
  onSynthesizeProject,
  onCopied,
  onClose,
}) => {
  const savedModuleSource = circuit.hdlSource ?? circuit.hdlFileSource ?? '';
  const hasProjectBundle = Boolean(hdlProject && hdlProject.files.length > 0);
  const hasFullFile =
    !hasProjectBundle &&
    Boolean(
      circuit.hdlFileSource && circuit.hdlFileSource.trim() !== (circuit.hdlSource ?? '').trim(),
    );

  const [scope, setScope] = useState<'module' | 'project' | 'file'>('module');
  const [editing, setEditing] = useState(Boolean(autoEditTrigger && autoEditTrigger > 0));
  const [showTree, setShowTree] = useState(
    Boolean(hdlProject && hdlProject.moduleCircuitIds.length > 1),
  );
  const lastAutoEditRef = useRef<number>(autoEditTrigger ?? 0);
  useEffect(() => {
    if (autoEditTrigger && autoEditTrigger !== lastAutoEditRef.current) {
      lastAutoEditRef.current = autoEditTrigger;
      setScope('module');
      setEditing(true);
    }
  }, [autoEditTrigger]);
  const [collapsedTree, setCollapsedTree] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState(savedModuleSource);
  const [projFiles, setProjFiles] = useState<HdlSourceFile[]>(hdlProject?.files ?? []);
  const [projFileIdx, setProjFileIdx] = useState(0);
  const [projTopName, setProjTopName] = useState(hdlProject?.topModuleName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dockSize, setDockSize] = useState(dock === 'bottom' ? 280 : 450);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Sync module draft when switching inspected circuit or after re-synthesis
  useEffect(() => {
    setDraft(savedModuleSource);
    setScope('module');
    setError(null);
    setWarnings([]);
  }, [circuit.id, savedModuleSource]);

  // Sync HDL project bundle files & top module when bundle changes
  useEffect(() => {
    if (hdlProject) {
      setProjFiles(hdlProject.files.map((f) => ({ ...f })));
      setProjTopName(hdlProject.topModuleName);
      const matchIdx = circuit.hdlFileName
        ? hdlProject.files.findIndex((f) => f.name === circuit.hdlFileName)
        : 0;
      setProjFileIdx(matchIdx >= 0 ? matchIdx : 0);
    } else {
      setProjFiles([]);
      setProjTopName('');
    }
  }, [hdlProject, circuit.hdlFileName]);

  // Reset comfortable default size when switching dock orientation
  useEffect(() => {
    setDockSize(dock === 'bottom' ? 280 : 450);
  }, [dock]);

  const safeProjIdx = Math.min(projFileIdx, Math.max(0, projFiles.length - 1));
  const activeProjFile = projFiles[safeProjIdx] ?? { name: 'module.sv', content: '' };
  const projModules = useMemo(
    () => (scope === 'project' ? listModuleNamesInFiles(projFiles) : []),
    [scope, projFiles],
  );
  const moduleTree = useMemo(
    () => (hdlProject ? buildHdlModuleTree(hdlProject, circuits) : null),
    [hdlProject, circuits],
  );

  const activeSource =
    scope === 'project'
      ? activeProjFile.content
      : scope === 'file' && circuit.hdlFileSource
        ? circuit.hdlFileSource
        : draft;

  const isModuleModified = draft !== savedModuleSource;
  const isProjectModified = useMemo(() => {
    if (!hdlProject) return false;
    if (projTopName !== hdlProject.topModuleName) return true;
    if (projFiles.length !== hdlProject.files.length) return true;
    return projFiles.some(
      (f, i) => f.name !== hdlProject.files[i]?.name || f.content !== hdlProject.files[i]?.content,
    );
  }, [hdlProject, projFiles, projTopName]);

  const isModified = scope === 'project' ? isProjectModified : isModuleModified;
  const canEdit = scope === 'module' || scope === 'project';
  const lines = useMemo(() => activeSource.split(/\r?\n/), [activeSource]);

  const handleSynthesize = () => {
    try {
      setError(null);
      if (scope === 'project' && hdlProject && onSynthesizeProject) {
        const warns = onSynthesizeProject(hdlProject.id, projFiles, projTopName || undefined);
        setWarnings(warns);
      } else {
        const warns = onSynthesize(circuit.id, draft);
        setWarnings(warns);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResetDraft = () => {
    if (scope === 'project' && hdlProject) {
      setProjFiles(hdlProject.files.map((f) => ({ ...f })));
      setProjTopName(hdlProject.topModuleName);
    } else {
      setDraft(savedModuleSource);
    }
    setError(null);
  };

  const handleEditChange = (val: string) => {
    if (scope === 'project') {
      setProjFiles((prev) => prev.map((f, i) => (i === safeProjIdx ? { ...f, content: val } : f)));
    } else {
      setDraft(val);
    }
  };

  const handleCopy = () => {
    void navigator.clipboard.writeText(activeSource).then(onCopied);
  };

  const handleDownload = () => {
    const blob = new Blob([activeSource], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download =
      scope === 'project'
        ? activeProjFile.name || 'module.sv'
        : circuit.hdlFileName || `${circuit.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'module'}.sv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = dockSize;

    const onMove = (ev: MouseEvent) => {
      if (dock === 'bottom') {
        const delta = startY - ev.clientY;
        setDockSize(Math.max(160, Math.min(580, startSize + delta)));
      } else {
        const delta = startX - ev.clientX;
        setDockSize(Math.max(300, Math.min(780, startSize + delta)));
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const style: React.CSSProperties = dock === 'bottom' ? { height: dockSize } : { width: dockSize };

  return (
    <section className={`hdl-dock-panel dock-${dock}`} style={style} aria-label="HDLソースパネル">
      <div
        className={`hdl-resize-handle handle-${dock}`}
        onMouseDown={startResize}
        title="ドラッグでパネルサイズを調整"
      />

      <div className="hdl-dock-header">
        <div className="hdl-dock-title-group">
          {scope === 'project' ? (
            <FolderGit2 size={14} className="accent-blue" />
          ) : (
            <FileCode2 size={14} className="accent-blue" />
          )}
          <span className="hdl-dock-name">
            {scope === 'project' && hdlProject ? hdlProject.name : circuit.name}
          </span>
          {scope !== 'project' && circuit.hdlFileName && (
            <span className="hdl-file-chip">{circuit.hdlFileName}</span>
          )}
          <span className="hdl-line-badge">{lines.length} 行</span>

          {circuit.hdlDiverged && (
            <span
              className="hdl-diverged-badge"
              title="回路図側が手動編集されたため、元のHDLソースとは独立した状態です。「論理合成して反映」を押すとHDLソースから回路を再生成します。"
            >
              <AlertTriangle size={11} />
              回路側で編集済み（元HDLと分離）
            </span>
          )}
          {isModified && <span className="hdl-dirty-badge">ソース未反映</span>}
        </div>

        <div className="hdl-dock-controls">
          {hasProjectBundle && hdlProject && (
            <>
              <button
                className={`mini-btn ${showTree ? 'active-hdl' : ''}`}
                onClick={() => setShowTree((v) => !v)}
                title="プロジェクト内のモジュール階層ツリーを表示/非表示"
              >
                <GitFork size={12} />
                <span>ツリー</span>
              </button>
              <div className="hdl-seg-group">
                <button
                  className={`hdl-seg-btn ${scope === 'module' ? 'active' : ''}`}
                  onClick={() => setScope('module')}
                  title="このモジュールの定義のみ表示・編集"
                >
                  モジュール
                </button>
                <button
                  className={`hdl-seg-btn ${scope === 'project' ? 'active' : ''}`}
                  onClick={() => setScope('project')}
                  title="HDLプロジェクト内の全ソースファイル・トップ指定を管理"
                >
                  プロジェクト ({hdlProject.files.length}F)
                </button>
              </div>
            </>
          )}

          {hasFullFile && (
            <div className="hdl-seg-group">
              <button
                className={`hdl-seg-btn ${scope === 'module' ? 'active' : ''}`}
                onClick={() => setScope('module')}
              >
                モジュール
              </button>
              <button
                className={`hdl-seg-btn ${scope === 'file' ? 'active' : ''}`}
                onClick={() => {
                  setScope('file');
                  setEditing(false);
                }}
              >
                元ファイル全体
              </button>
            </div>
          )}

          {canEdit && (
            <div className="hdl-seg-group">
              <button
                className={`hdl-seg-btn ${!editing ? 'active' : ''}`}
                onClick={() => setEditing(false)}
                title="シンタックスハイライト閲覧モード"
              >
                <Eye size={12} /> 閲覧
              </button>
              <button
                className={`hdl-seg-btn ${editing ? 'active' : ''}`}
                onClick={() => setEditing(true)}
                title="HDLソースを編集して再論理合成"
              >
                <Edit3 size={12} /> 編集
              </button>
            </div>
          )}

          {canEdit && (
            <>
              {isModified && (
                <button
                  className="mini-btn"
                  onClick={handleResetDraft}
                  title="未反映のソース変更を破棄して元に戻す"
                >
                  <RotateCcw size={12} />
                </button>
              )}
              <button
                className={`mini-btn ${isModified || circuit.hdlDiverged ? 'active-synth' : ''}`}
                disabled={editLocked}
                onClick={handleSynthesize}
                title={
                  editLocked
                    ? '実行モード中は論理合成できません（「編集に戻る」で切替）'
                    : scope === 'project'
                      ? 'プロジェクト全ファイルをまとめて再論理合成して回路に反映'
                      : 'このHDLソースを論理合成して回路に反映'
                }
              >
                <Cpu size={12} />
                <span>{scope === 'project' ? 'プロジェクト再合成' : '論理合成して反映'}</span>
              </button>
            </>
          )}

          <button className="icon-btn" onClick={handleCopy} title="ソースをコピー">
            <Copy size={13} />
          </button>
          <button className="icon-btn" onClick={handleDownload} title=".sv ファイルとして保存">
            <Download size={13} />
          </button>
          <button
            className="icon-btn"
            onClick={() => onChangeDock(dock === 'bottom' ? 'right' : 'bottom')}
            title={dock === 'bottom' ? '右側にドッキング' : '下部にドッキング'}
          >
            {dock === 'bottom' ? <PanelRight size={14} /> : <PanelBottom size={14} />}
          </button>
          <button className="icon-btn" onClick={onClose} title="HDLソースパネルを閉じる">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Unified HDL Project multi-file bar + Top Module selector */}
      {scope === 'project' && hdlProject && (
        <div className="hdl-proj-subbar">
          <div className="hdl-file-tabs">
            {projFiles.map((f, idx) => (
              <div
                key={`${f.name}-${idx}`}
                className={`hdl-import-tab ${idx === safeProjIdx ? 'active' : ''}`}
                onClick={() => setProjFileIdx(idx)}
              >
                <span className="hdl-import-tab-name">{f.name}</span>
                {editing && projFiles.length > 1 && (
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      setProjFiles((prev) => prev.filter((_, i) => i !== idx));
                      setProjFileIdx((cur) => Math.max(0, Math.min(cur, projFiles.length - 2)));
                    }}
                    title="ファイルを除外"
                  >
                    <Trash2 size={10} />
                  </button>
                )}
              </div>
            ))}
            {editing && (
              <button
                className="hdl-add-file-btn"
                onClick={() => {
                  const nextName = `sub_${projFiles.length + 1}.sv`;
                  setProjFiles((prev) => [
                    ...prev,
                    {
                      name: nextName,
                      content: `module sub_${projFiles.length + 1} (\n  input  logic a,\n  output logic y\n);\n  assign y = a;\nendmodule\n`,
                    },
                  ]);
                  setProjFileIdx(projFiles.length);
                }}
                title="プロジェクトに新しいHDLファイルを追加"
              >
                <FilePlus2 size={11} /> 追加
              </button>
            )}
          </div>

          <label className="hdl-top-select">
            <span>TOP:</span>
            <select
              value={projTopName}
              onChange={(e) => setProjTopName(e.target.value)}
              disabled={editLocked}
            >
              {projModules.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} ({m.fileName})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {error && <div className="hdl-dock-alert error">{error}</div>}
      {warnings.length > 0 && (
        <div className="hdl-dock-alert warn">
          {warnings.map((w, i) => (
            <div key={i}>• {w}</div>
          ))}
        </div>
      )}

      <div className="hdl-dock-main-split">
        {showTree && moduleTree && (moduleTree.root || moduleTree.orphans.length > 0) && (
          <aside className="hdl-dock-tree" aria-label="HDLモジュールツリー">
            <div className="hdl-dock-tree-hdr">モジュール階層</div>
            <div className="hdl-dock-tree-scroll">
              {(() => {
                const renderDockNode = (
                  node: HdlModuleTreeNode,
                  depth: number,
                ): React.ReactNode => {
                  const hasCh = node.children.length > 0;
                  const isCol = Boolean(collapsedTree[node.key]);
                  const isSel = node.circuitId === circuit.id;
                  return (
                    <div key={node.key}>
                      <div
                        className={`mod-tree-row ${isSel ? 'module-active' : ''}`}
                        style={{ paddingLeft: 4 + depth * 12 }}
                        onClick={() => onSelectModuleHdl(node.circuitId)}
                        title={`${node.instanceName ? `${node.instanceName} : ` : ''}${node.moduleName}`}
                      >
                        {hasCh ? (
                          <button
                            className="mod-tree-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCollapsedTree((p) => ({ ...p, [node.key]: !p[node.key] }));
                            }}
                          >
                            {isCol ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
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
                        </span>
                        <button
                          className="palette-act-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenCircuitTab(node.circuitId);
                          }}
                          title="回路タブを開く"
                        >
                          <ExternalLink size={10} />
                        </button>
                      </div>
                      {hasCh && !isCol && node.children.map((ch) => renderDockNode(ch, depth + 1))}
                    </div>
                  );
                };
                return (
                  <>
                    {moduleTree.root && renderDockNode(moduleTree.root, 0)}
                    {moduleTree.orphans.length > 0 && (
                      <div className="mod-tree-orphans">
                        <div className="mod-tree-orphan-hdr">
                          トップ外 ({moduleTree.orphans.length})
                        </div>
                        {moduleTree.orphans.map((o) => renderDockNode(o, 0))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </aside>
        )}

        <div className="hdl-dock-body">
          {editing && canEdit ? (
            <div className="hdl-editor-wrap">
              <div ref={gutterRef} className="hdl-editor-gutter" aria-hidden="true">
                {lines.map((_, idx) => (
                  <div key={idx} className="hdl-editor-ln">
                    {idx + 1}
                  </div>
                ))}
              </div>
              <textarea
                className="hdl-editor-textarea"
                value={activeSource}
                onChange={(e) => handleEditChange(e.target.value)}
                onScroll={(e) => {
                  if (gutterRef.current) {
                    gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const el = e.currentTarget;
                    const s = el.selectionStart;
                    const end = el.selectionEnd;
                    const next = `${activeSource.slice(0, s)}  ${activeSource.slice(end)}`;
                    handleEditChange(next);
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = s + 2;
                    });
                  } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !editLocked) {
                    e.preventDefault();
                    handleSynthesize();
                  }
                }}
                spellCheck={false}
                placeholder="module ... endmodule"
              />
            </div>
          ) : (
            <div
              className="hdl-code-viewer docked"
              role="region"
              aria-label="Original HDL source"
              onMouseDown={(e) => {
                // Support middle-click (or Alt+left-click) drag panning inside the code viewer
                if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
                e.preventDefault();
                const el = e.currentTarget;
                const startX = e.clientX;
                const startY = e.clientY;
                const origL = el.scrollLeft;
                const origT = el.scrollTop;
                const onMove = (ev: MouseEvent) => {
                  el.scrollLeft = origL - (ev.clientX - startX);
                  el.scrollTop = origT - (ev.clientY - startY);
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              onDoubleClick={() => {
                if (canEdit) setEditing(true);
              }}
              title={
                canEdit
                  ? 'ダブルクリックで編集モードへ切替（二本指スクロール / Shift+ホイール / 中ドラッグで横スクロール）'
                  : undefined
              }
            >
              {lines.map((ln, idx) => (
                <div key={idx} className="hdl-line">
                  <span className="hdl-ln">{idx + 1}</span>
                  <span className="hdl-code">{highlightHdlLine(ln)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
