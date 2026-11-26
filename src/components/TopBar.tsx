import React, { useRef } from 'react';
import {
  Cpu,
  Download,
  Eye,
  FileCode2,
  FolderOpen,
  GitBranch,
  Grid,
  HelpCircle,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Share2,
  SkipForward,
  Sparkles,
  Spline,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import { ProjectDocument, SubcircuitDisplayMode } from '../core/types';

interface TopBarProps {
  project: ProjectDocument;
  simActive: boolean;
  manualSimRunning: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onRenameProject: (name: string) => void;
  onSelectCircuit: (id: string) => void;
  onNewCircuit: () => void;
  onDeleteCircuit: (id: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleSimMode: () => void;
  onToggleManualRun: () => void;
  onToggleClock: () => void;
  onStepClock: () => void;
  onChangeClockHz: (hz: number) => void;
  onResetSeq: () => void;
  onToggleRouteMode: () => void;
  onChangeGlobalDisplay: (mode: 'instance' | SubcircuitDisplayMode) => void;
  onSaveProject: () => void;
  onLoadProjectFile: (file: File) => void;
  onImportModuleFile: (file: File) => void;
  onOpenVerilogImport: () => void;
  onOpenNetlistExport: () => void;
  onOpenSymbolEditor: () => void;
  onOpenHdlSource: (circuitId: string) => void;
  onOpenShortcuts: () => void;
  onLoadSample: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  project,
  simActive,
  manualSimRunning,
  canUndo,
  canRedo,
  onRenameProject,
  onSelectCircuit,
  onNewCircuit,
  onDeleteCircuit,
  onUndo,
  onRedo,
  onToggleSimMode,
  onToggleManualRun,
  onToggleClock,
  onStepClock,
  onChangeClockHz,
  onResetSeq,
  onToggleRouteMode,
  onChangeGlobalDisplay,
  onSaveProject,
  onLoadProjectFile,
  onImportModuleFile,
  onOpenVerilogImport,
  onOpenNetlistExport,
  onOpenSymbolEditor,
  onOpenHdlSource,
  onOpenShortcuts,
  onLoadSample,
}) => {
  const openFileRef = useRef<HTMLInputElement>(null);
  const importModRef = useRef<HTMLInputElement>(null);
  const { settings } = project;
  const openIds = project.openTabIds?.length
    ? project.openTabIds.filter((id) => Boolean(project.circuits[id]))
    : Object.keys(project.circuits).filter((id) => !project.circuits[id].isStub);
  const circuits = openIds.map((id) => project.circuits[id]);
  const activeCircuit = project.circuits[project.activeCircuitId];
  const activeHasHdl = Boolean(activeCircuit?.hdlSource || activeCircuit?.hdlFileSource);

  return (
    <header className="topbar">
      <div className="topbar-row main-toolbar">
        {/* Brand + Project Name */}
        <div className="toolbar-group brand-group">
          <div className="brand-logo">
            <Cpu size={18} className="accent-green" />
            <span>LogicFlow</span>
          </div>
          <input
            className="project-name-input"
            value={project.name}
            onChange={(e) => onRenameProject(e.target.value)}
            title="プロジェクト名"
          />
        </div>

        {/* Simulation Mode & Clock Controls */}
        <div className="toolbar-group sim-group">
          <button
            className={`pill-btn ${settings.simMode === 'realtime' ? 'active-green' : 'active-amber'}`}
            onClick={onToggleSimMode}
            title="リアルタイム実行モード / 編集・実行分離モードの切替"
          >
            <Zap size={14} />
            <span>{settings.simMode === 'realtime' ? 'リアルタイム' : '編集/実行分離'}</span>
          </button>

          {settings.simMode === 'manual' && (
            <button
              className={`pill-btn ${manualSimRunning ? 'active-green' : ''}`}
              onClick={onToggleManualRun}
              title={
                manualSimRunning
                  ? '実行を停止して編集モードに戻る'
                  : '回路をロック・事前コンパイルして高速実行を開始'
              }
            >
              {manualSimRunning ? <Pause size={14} /> : <Play size={14} />}
              <span>{manualSimRunning ? '実行中（編集に戻る）' : '実行開始'}</span>
            </button>
          )}

          <div className="divider" />

          <button
            className={`icon-btn ${settings.clockRunning && simActive ? 'active-green' : ''}`}
            onClick={onToggleClock}
            title="クロック自動発振 ON/OFF (Space)"
          >
            {settings.clockRunning ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button className="icon-btn" onClick={onStepClock} title="クロック1ステップ反転 (S)">
            <SkipForward size={15} />
          </button>
          <label className="hz-control" title="クロック周波数 (0.1〜1000 Hz)">
            <input
              type="number"
              min={0.1}
              max={1000}
              step="any"
              value={settings.clockHz}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v) && v >= 0) onChangeClockHz(v);
              }}
            />
            <span>Hz</span>
          </label>
          <button className="icon-btn" onClick={onResetSeq} title="順序回路(FF/RAM)リセット">
            <RotateCcw size={14} />
          </button>
        </div>

        {/* Routing & Module Peek Controls */}
        <div className="toolbar-group">
          <button
            className={`pill-btn ${settings.routeMode === 'grid' ? 'active-blue' : 'active-purple'}`}
            onClick={onToggleRouteMode}
            title="配線モード切替: グリッドフィット(重なり回避自動配線) / 自由配線 (G)"
          >
            {settings.routeMode === 'grid' ? <Grid size={14} /> : <Spline size={14} />}
            <span>{settings.routeMode === 'grid' ? 'グリッド配線' : '自由配線'}</span>
          </button>

          <div className="select-pill" title="モジュール内部表示の一括切替">
            <Eye size={13} />
            <select
              value={settings.globalSubcircuitDisplay}
              onChange={(e) =>
                onChangeGlobalDisplay(e.target.value as 'instance' | SubcircuitDisplayMode)
              }
            >
              <option value="instance">モジュール表示: 個別設定</option>
              <option value="live">全て中身＋リアルタイム色</option>
              <option value="preview">全て中身のみ(色なし)</option>
              <option value="box">全てシンプル箱表示</option>
            </select>
          </div>
        </div>

        {/* History + File / HDL Actions */}
        <div className="toolbar-group right-group">
          <button
            className="icon-btn"
            disabled={!canUndo}
            onClick={onUndo}
            title="元に戻す (Ctrl+Z)"
          >
            <Undo2 size={15} />
          </button>
          <button
            className="icon-btn"
            disabled={!canRedo}
            onClick={onRedo}
            title="やり直す (Ctrl+Y)"
          >
            <Redo2 size={15} />
          </button>

          <div className="divider" />

          <button className="pill-btn" onClick={onSaveProject} title="プロジェクトをJSON保存">
            <Save size={14} />
            <span>保存</span>
          </button>
          <button
            className="pill-btn"
            onClick={() => openFileRef.current?.click()}
            title="保存したプロジェクト(.lcirc.json)を開く"
          >
            <FolderOpen size={14} />
            <span>開く</span>
          </button>
          <button
            className="pill-btn"
            onClick={() => importModRef.current?.click()}
            title="別ファイルをモジュールとして読み込む"
          >
            <GitBranch size={14} />
            <span>外部モジュール</span>
          </button>
          <button
            className="pill-btn"
            onClick={onOpenVerilogImport}
            title="Verilog / SystemVerilog インポート"
          >
            <FileCode2 size={14} />
            <span>HDL読込</span>
          </button>
          <button
            className="pill-btn"
            onClick={onOpenNetlistExport}
            title="ネットリスト出力 (Verilog / JSON / DOT)"
          >
            <Share2 size={14} />
            <span>ネットリスト</span>
          </button>
          <button className="icon-btn" onClick={onLoadSample} title="サンプルプロジェクトを復元">
            <Sparkles size={15} />
          </button>
          <button className="icon-btn" onClick={onOpenShortcuts} title="ショートカット一覧 (?)">
            <HelpCircle size={15} />
          </button>

          <input
            ref={openFileRef}
            type="file"
            accept=".json,.lcirc.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLoadProjectFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={importModRef}
            type="file"
            accept=".json,.lcirc.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportModuleFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* Circuit Tabs Bar */}
      <div className="topbar-row tabs-bar">
        <div className="tabs-list">
          {circuits.map((c) => {
            const active = c.id === project.activeCircuitId;
            return (
              <div
                key={c.id}
                className={`circuit-tab ${active ? 'active' : ''} ${c.isStub ? 'stub' : ''}`}
                onClick={() => onSelectCircuit(c.id)}
              >
                <span className="tab-dot" />
                <span className="tab-name">{c.name}</span>
                {circuits.length > 1 && (
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteCircuit(c.id);
                    }}
                    title="回路タブを削除"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <button className="tab-add" onClick={onNewCircuit} title="新しい回路 / モジュールを作成">
            <Plus size={14} />
            <span>新規モジュール</span>
          </button>
        </div>

        <div className="tabs-actions">
          {activeHasHdl && activeCircuit && (
            <button
              className={`mini-btn active-hdl ${activeCircuit.hdlDiverged ? 'hdl-diverged' : ''}`}
              onClick={() => onOpenHdlSource(activeCircuit.id)}
              title={
                activeCircuit.hdlDiverged
                  ? 'このモジュールのHDLソースを表示・再合成（回路図側が手動編集され元ソースと分離しています）'
                  : 'このモジュールのHDLソースを表示・編集・再合成'
              }
            >
              <FileCode2 size={12} />
              <span>HDLソース</span>
              {activeCircuit.hdlDiverged && <span className="diverged-dot" title="回路側編集済" />}
            </button>
          )}
          <button
            className="mini-btn"
            onClick={onOpenSymbolEditor}
            title="この回路のモジュール端子方向・配置を編集"
          >
            <Download size={12} style={{ transform: 'rotate(-90deg)' }} />
            <span>シンボル定義</span>
          </button>
          <div className="signal-legend" title="4値信号カラー凡例">
            <span className="leg leg-0">0</span>
            <span className="leg leg-1">1</span>
            <span className="leg leg-x">X</span>
            <span className="leg leg-z">Z</span>
          </div>
        </div>
      </div>
    </header>
  );
};
