import React, { useEffect, useRef } from 'react';
import {
  AlignCenter,
  Copy,
  CopyPlus,
  Database,
  ExternalLink,
  Eye,
  FileCode2,
  Grid,
  Maximize2,
  ClipboardPaste,
  RefreshCw,
  RotateCw,
  Spline,
  Tag,
  Trash2,
} from 'lucide-react';
import { GateInstance, Point, RouteMode, SubcircuitDisplayMode, Wire } from '../core/types';

export interface ContextMenuState {
  screenX: number;
  screenY: number;
  worldPos: Point;
  gate?: GateInstance;
  wire?: Wire;
}

interface ContextMenuProps {
  menu: ContextMenuState;
  routeMode: RouteMode;
  hasClipboard: boolean;
  editLocked: boolean;
  activeCircuitId: string;
  circuitHasHdlSource: boolean;
  targetSubHasHdlSource: boolean;
  onClose: () => void;
  onSetWireNetLabel: (wire: Wire) => void;
  onToggleWireRouteMode: (wire: Wire) => void;
  onRerouteWire: (wireId: string) => void;
  onSetGateLabel: (gate: GateInstance) => void;
  onRotate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetSubcircuitMode: (gateId: string, mode: SubcircuitDisplayMode) => void;
  onOpenSubcircuit: (circuitId: string) => void;
  onOpenHdlSource: (circuitId: string) => void;
  onOpenMemoryEditor: (gateId: string) => void;
  onAddTunnelAt: (pt: Point) => void;
  onToggleGlobalRouteMode: () => void;
  onAlignToGrid: () => void;
  onRerouteAll: () => void;
  onZoomToFit: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  menu,
  routeMode,
  hasClipboard,
  editLocked,
  activeCircuitId,
  circuitHasHdlSource,
  targetSubHasHdlSource,
  onClose,
  onSetWireNetLabel,
  onToggleWireRouteMode,
  onRerouteWire,
  onSetGateLabel,
  onRotate,
  onCopy,
  onPaste,
  onDuplicate,
  onDelete,
  onSetSubcircuitMode,
  onOpenSubcircuit,
  onOpenHdlSource,
  onOpenMemoryEditor,
  onAddTunnelAt,
  onToggleGlobalRouteMode,
  onAlignToGrid,
  onRerouteAll,
  onZoomToFit,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.min(menu.screenX, window.innerWidth - 250);
  const top = Math.min(menu.screenY, window.innerHeight - 320);

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="context-menu" style={{ left, top }}>
      {editLocked ? (
        <>
          <div className="ctx-header">実行モード（編集ロック中）</div>
          {menu.gate?.type === 'SUBCIRCUIT' && menu.gate.props.subcircuitId && (
            <>
              <button
                className="ctx-item"
                onClick={() => run(() => onOpenSubcircuit(menu.gate!.props.subcircuitId!))}
              >
                <ExternalLink size={14} /> <span>内部回路タブを開く</span>
              </button>
              {targetSubHasHdlSource && (
                <button
                  className="ctx-item"
                  onClick={() => run(() => onOpenHdlSource(menu.gate!.props.subcircuitId!))}
                >
                  <FileCode2 size={14} /> <span>元の HDL ソースを表示</span>
                </button>
              )}
            </>
          )}
          {!menu.gate && !menu.wire && circuitHasHdlSource && (
            <button
              className="ctx-item"
              onClick={() => run(() => onOpenHdlSource(activeCircuitId))}
            >
              <FileCode2 size={14} /> <span>このモジュールの元 HDL ソースを表示</span>
            </button>
          )}
          <button className="ctx-item" onClick={() => run(onZoomToFit)}>
            <Maximize2 size={14} /> <span>回路全体を表示 (ズーム調整)</span> <kbd>F</kbd>
          </button>
        </>
      ) : (
        <>
          {menu.wire && (
            <>
              <div className="ctx-header">ワイヤー設定</div>
              <button className="ctx-item" onClick={() => run(() => onSetWireNetLabel(menu.wire!))}>
                <Tag size={14} /> <span>ネットラベルを設定 / 編集</span> <kbd>L</kbd>
              </button>
              <button
                className="ctx-item"
                onClick={() => run(() => onToggleWireRouteMode(menu.wire!))}
              >
                {menu.wire.routeMode === 'grid' ? <Spline size={14} /> : <Grid size={14} />}
                <span>
                  {menu.wire.routeMode === 'grid'
                    ? 'この配線を自由配線に変更'
                    : 'この配線をグリッド配線に変更'}
                </span>
              </button>
              <button className="ctx-item" onClick={() => run(() => onRerouteWire(menu.wire!.id))}>
                <RefreshCw size={14} /> <span>この配線を自動再レイアウト</span>
              </button>
              <div className="ctx-sep" />
              <button className="ctx-item danger" onClick={() => run(onDelete)}>
                <Trash2 size={14} /> <span>ワイヤーを削除</span> <kbd>Del</kbd>
              </button>
            </>
          )}

          {menu.gate && !menu.wire && (
            <>
              <div className="ctx-header">{menu.gate.label || menu.gate.type}</div>
              <button className="ctx-item" onClick={() => run(() => onSetGateLabel(menu.gate!))}>
                <Tag size={14} /> <span>ラベル名を変更</span>
              </button>
              <button className="ctx-item" onClick={() => run(onRotate)}>
                <RotateCw size={14} /> <span>90° 回転</span> <kbd>R</kbd>
              </button>
              <button className="ctx-item" onClick={() => run(onCopy)}>
                <Copy size={14} /> <span>コピー</span> <kbd>Ctrl+C</kbd>
              </button>
              <button className="ctx-item" onClick={() => run(onDuplicate)}>
                <CopyPlus size={14} /> <span>複製</span> <kbd>Ctrl+D</kbd>
              </button>

              {menu.gate.type === 'SUBCIRCUIT' && (
                <>
                  <div className="ctx-sep" />
                  <div className="ctx-header">モジュール表示モード</div>
                  <button
                    className="ctx-item"
                    onClick={() => run(() => onSetSubcircuitMode(menu.gate!.id, 'live'))}
                  >
                    <Eye size={14} /> <span>中身表示 + リアルタイム信号色</span>
                  </button>
                  <button
                    className="ctx-item"
                    onClick={() => run(() => onSetSubcircuitMode(menu.gate!.id, 'preview'))}
                  >
                    <Eye size={14} /> <span>中身表示のみ (信号色なし)</span>
                  </button>
                  <button
                    className="ctx-item"
                    onClick={() => run(() => onSetSubcircuitMode(menu.gate!.id, 'box'))}
                  >
                    <Eye size={14} /> <span>シンプル箱表示</span>
                  </button>
                  {menu.gate.props.subcircuitId && (
                    <>
                      <button
                        className="ctx-item"
                        onClick={() => run(() => onOpenSubcircuit(menu.gate!.props.subcircuitId!))}
                      >
                        <ExternalLink size={14} /> <span>内部回路タブを開く</span>
                      </button>
                      {targetSubHasHdlSource && (
                        <button
                          className="ctx-item"
                          onClick={() => run(() => onOpenHdlSource(menu.gate!.props.subcircuitId!))}
                        >
                          <FileCode2 size={14} /> <span>元の HDL ソースを表示</span>
                        </button>
                      )}
                    </>
                  )}
                </>
              )}

              {(menu.gate.type === 'RAM' || menu.gate.type === 'ROM') && (
                <>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item"
                    onClick={() => run(() => onOpenMemoryEditor(menu.gate!.id))}
                  >
                    <Database size={14} /> <span>メモリHEXエディタを開く</span>
                  </button>
                </>
              )}

              <div className="ctx-sep" />
              <button className="ctx-item danger" onClick={() => run(onDelete)}>
                <Trash2 size={14} /> <span>削除</span> <kbd>Del</kbd>
              </button>
            </>
          )}

          {!menu.gate && !menu.wire && (
            <>
              <div className="ctx-header">キャンバス操作</div>
              <button className="ctx-item" disabled={!hasClipboard} onClick={() => run(onPaste)}>
                <ClipboardPaste size={14} /> <span>貼り付け</span> <kbd>Ctrl+V</kbd>
              </button>
              <button className="ctx-item" onClick={() => run(() => onAddTunnelAt(menu.worldPos))}>
                <Tag size={14} /> <span>ここにネットラベル (トンネル) を配置</span>
              </button>
              <div className="ctx-sep" />
              <button className="ctx-item" onClick={() => run(onToggleGlobalRouteMode)}>
                {routeMode === 'grid' ? <Spline size={14} /> : <Grid size={14} />}
                <span>
                  {routeMode === 'grid' ? '自由配線モードに切替' : 'グリッド配線モードに切替'}
                </span>
                <kbd>G</kbd>
              </button>
              <button className="ctx-item" onClick={() => run(onAlignToGrid)}>
                <AlignCenter size={14} /> <span>全パーツをグリッド整列</span>
              </button>
              <button className="ctx-item" onClick={() => run(onRerouteAll)}>
                <RefreshCw size={14} /> <span>全ワイヤーを重なり回避再配線</span>
              </button>
              <button className="ctx-item" onClick={() => run(onZoomToFit)}>
                <Maximize2 size={14} /> <span>回路全体を表示 (ズーム調整)</span> <kbd>F</kbd>
              </button>
              {circuitHasHdlSource && (
                <>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item"
                    onClick={() => run(() => onOpenHdlSource(activeCircuitId))}
                  >
                    <FileCode2 size={14} /> <span>このモジュールの元 HDL ソースを表示</span>
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};
