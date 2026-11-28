import React from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Database,
  ExternalLink,
  FileCode2,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCw,
  Sliders,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react';
import { GATE_CATALOG, getCompatibleReplacementTypes } from '../core/catalog';
import { formatWatchValue, sampleWatchedSignals, WatchRadix, WatchTarget } from '../core/debug';
import {
  BIT_X,
  dominantState,
  formatValue,
  SIGNAL_COLORS,
  SIGNAL_LABELS,
  X_CAUSE_COLORS,
  X_CAUSE_LABELS,
} from '../core/logic4';
import {
  CircuitDocument,
  GateInstance,
  GateProps,
  GateType,
  PinSide,
  ProjectDocument,
  RouteMode,
  SimulationSnapshot,
  SubcircuitDisplayMode,
  Wire,
} from '../core/types';

interface InspectorPanelProps {
  project: ProjectDocument;
  circuit: CircuitDocument | null;
  snapshot: SimulationSnapshot | null;
  simActive: boolean;
  editLocked: boolean;
  selectedGateIds: Set<string>;
  selectedWireIds: Set<string>;
  onUpdateGate: (
    gateId: string,
    patch: Partial<GateInstance>,
    propsPatch?: Partial<GateProps>,
  ) => void;
  onReplaceGate: (gateId: string, newType: GateType) => void;
  onUpdateWire: (wireId: string, patch: Partial<Wire>) => void;
  onRerouteWire: (wireId: string) => void;
  onRenameCircuit: (circuitId: string, name: string) => void;
  onOpenCircuit: (circuitId: string) => void;
  onOpenLiveSubcircuitPopup: (gateId: string) => void;
  onOpenHdlSource: (circuitId: string) => void;
  onOpenMemoryEditor: (gateId: string) => void;
  onOpenSymbolEditor: () => void;
  onDeleteSelection: () => void;
  watchTargets: WatchTarget[];
  isWireWatched: (wireId: string) => boolean;
  onToggleWatchWire: (wire: Wire) => void;
  onRemoveWatchTarget: (targetId: string) => void;
  onUpdateWatchTarget: (targetId: string, patch: Partial<WatchTarget>) => void;
  onReorderWatchTarget: (targetId: string, dir: -1 | 1) => void;
  onToggleWatchPanel: () => void;
  onCloseSidebar?: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  project,
  circuit,
  snapshot,
  simActive,
  editLocked,
  selectedGateIds,
  selectedWireIds,
  onUpdateGate,
  onReplaceGate,
  onUpdateWire,
  onRerouteWire,
  onRenameCircuit,
  onOpenCircuit,
  onOpenLiveSubcircuitPopup,
  onOpenHdlSource,
  onOpenMemoryEditor,
  onOpenSymbolEditor,
  onDeleteSelection,
  watchTargets,
  isWireWatched,
  onToggleWatchWire,
  onRemoveWatchTarget,
  onUpdateWatchTarget,
  onReorderWatchTarget,
  onToggleWatchPanel,
  onCloseSidebar,
}) => {
  const activeWatchTargets = circuit ? watchTargets.filter((t) => t.circuitId === circuit.id) : [];
  const sampledWatch =
    circuit && simActive && snapshot && activeWatchTargets.length > 0
      ? sampleWatchedSignals(activeWatchTargets, circuit, project, snapshot)
      : {};
  const selectedGate =
    circuit && selectedGateIds.size === 1
      ? (circuit.gates.find((g) => selectedGateIds.has(g.id)) ?? null)
      : null;

  const selectedWire =
    circuit && selectedGateIds.size === 0 && selectedWireIds.size === 1
      ? (circuit.wires.find((w) => selectedWireIds.has(w.id)) ?? null)
      : null;

  const totalSelected = circuit ? selectedGateIds.size + selectedWireIds.size : 0;
  const nonStubCount = Object.values(project.circuits).filter((c) => !c.isStub).length;

  return (
    <aside className="inspector-panel">
      <div className="panel-header">
        <span className="panel-title">
          <Sliders size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
          インスペクタ
        </span>
        <div className="panel-header-right">
          {totalSelected > 0 && !editLocked && (
            <button
              className="danger-mini-btn"
              onClick={onDeleteSelection}
              title="選択項目を削除 (Del)"
            >
              <Trash2 size={12} />
              削除
            </button>
          )}
          {onCloseSidebar && (
            <button
              className="icon-btn panel-close-btn"
              onClick={onCloseSidebar}
              title="右インスペクタを隠す"
              aria-label="右インスペクタを隠す"
            >
              <PanelRight size={15} />
            </button>
          )}
        </div>
      </div>

      <div className={`inspector-scroll ${editLocked ? 'inspector-locked' : ''}`}>
        {editLocked && (
          <div className="locked-notice">
            実行モード中（読み取り専用）— 編集するには上部の「実行中（編集に戻る）」を押してください
          </div>
        )}
        {!circuit ? (
          <div className="inspector-section">
            <div className="section-title">開いているタブがありません</div>
            <p className="muted-text">
              現在プロジェクト内には <strong>{nonStubCount}</strong> 個のモジュール定義があります。
            </p>
            <p className="muted-text">
              左のコンポーネントパレットまたは中央のスタート画面からモジュールを開くか、新しく作成してください。
            </p>
          </div>
        ) : selectedGate ? (
          <GateInspector
            gate={selectedGate}
            project={project}
            onUpdate={(patch, propsPatch) => onUpdateGate(selectedGate.id, patch, propsPatch)}
            onReplace={(newType) => onReplaceGate(selectedGate.id, newType)}
            onOpenCircuit={onOpenCircuit}
            onOpenLivePopup={() => onOpenLiveSubcircuitPopup(selectedGate.id)}
            onOpenHdlSource={onOpenHdlSource}
            onOpenMemoryEditor={() => onOpenMemoryEditor(selectedGate.id)}
          />
        ) : selectedWire ? (
          <WireInspector
            wire={selectedWire}
            snapshot={snapshot}
            simActive={simActive}
            watched={isWireWatched(selectedWire.id)}
            onToggleWatch={() => onToggleWatchWire(selectedWire)}
            onUpdate={(patch) => onUpdateWire(selectedWire.id, patch)}
            onReroute={() => onRerouteWire(selectedWire.id)}
          />
        ) : totalSelected > 1 ? (
          <div className="inspector-section">
            <div className="section-title">複数選択中</div>
            <p className="muted-text">
              ゲート {selectedGateIds.size} 個、ワイヤー {selectedWireIds.size} 本を選択しています。
            </p>
            <p className="muted-text">
              ドラッグで一括移動、<code>R</code> で回転、<code>Ctrl+C/V</code> でコピー、
              <code>Ctrl+D</code> で複製できます。
            </p>
          </div>
        ) : (
          <CircuitInspector
            circuit={circuit}
            snapshot={snapshot}
            simActive={simActive}
            onRename={(name) => onRenameCircuit(circuit.id, name)}
            onOpenSymbolEditor={onOpenSymbolEditor}
            onOpenHdlSource={() => onOpenHdlSource(circuit.id)}
          />
        )}

        {activeWatchTargets.length > 0 && (
          <div className="inspector-section inspector-watch-section">
            <div className="inspector-watch-head">
              <div className="section-title" style={{ marginBottom: 0 }}>
                <Activity size={12} style={{ marginRight: 5, verticalAlign: -1 }} />
                ウォッチ中の信号 ({activeWatchTargets.length})
              </div>
              <button
                className="inspector-watch-wave-btn"
                onClick={onToggleWatchPanel}
                title="下部の波形タイムチャートを表示 / 非表示"
              >
                波形
              </button>
            </div>
            <div className="inspector-watch-cards">
              {activeWatchTargets.map((t, idx) => {
                const entry = sampledWatch[t.id];
                const val = entry?.value;
                const bit = dominantState(val);
                const xCause = bit === BIT_X ? entry?.xCause : undefined;
                const dotColor = xCause ? X_CAUSE_COLORS[xCause] : SIGNAL_COLORS[bit];
                const stateLabel = xCause ? X_CAUSE_LABELS[xCause] : SIGNAL_LABELS[bit];

                return (
                  <div key={t.id} className="live-signal-card inspector-watch-card">
                    <div className="signal-card-header inspector-watch-card-head">
                      <span className="inspector-watch-label" title={t.label}>
                        {t.label}
                      </span>
                      <div className="watch-row-acts">
                        <button
                          className="palette-act-btn"
                          disabled={idx === 0}
                          onClick={() => onReorderWatchTarget(t.id, -1)}
                          title="上へ移動"
                        >
                          <ChevronUp size={11} />
                        </button>
                        <button
                          className="palette-act-btn"
                          disabled={idx === activeWatchTargets.length - 1}
                          onClick={() => onReorderWatchTarget(t.id, 1)}
                          title="下へ移動"
                        >
                          <ChevronDown size={11} />
                        </button>
                        <button
                          className="palette-act-btn danger"
                          onClick={() => onRemoveWatchTarget(t.id)}
                          title="ウォッチから解除"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    </div>
                    {simActive && val ? (
                      <div className="signal-readout">
                        <span className="signal-dot" style={{ backgroundColor: dotColor }} />
                        <span
                          className="signal-val inspector-watch-val"
                          title="クリックで表示基数を切替 (自動/HEX/BIN/DEC/SIGNED)"
                          onClick={() => {
                            const order: WatchRadix[] = ['auto', 'hex', 'bin', 'dec', 'signed'];
                            const next = order[(order.indexOf(t.radix) + 1) % order.length];
                            onUpdateWatchTarget(t.id, { radix: next });
                          }}
                        >
                          {formatWatchValue(val, t.radix)}
                        </span>
                        <span className="signal-meta">
                          ({val.width} bit · 状態: {stateLabel})
                        </span>
                      </div>
                    ) : (
                      <div className="muted-text">シミュレーション停止中</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

const GateInspector: React.FC<{
  gate: GateInstance;
  project: ProjectDocument;
  onUpdate: (patch: Partial<GateInstance>, propsPatch?: Partial<GateProps>) => void;
  onReplace: (newType: GateType) => void;
  onOpenCircuit: (circuitId: string) => void;
  onOpenLivePopup: () => void;
  onOpenHdlSource: (circuitId: string) => void;
  onOpenMemoryEditor: () => void;
}> = ({
  gate,
  project,
  onUpdate,
  onReplace,
  onOpenCircuit,
  onOpenLivePopup,
  onOpenHdlSource,
  onOpenMemoryEditor,
}) => {
  const entry = GATE_CATALOG[gate.type];
  const p = gate.props;

  const supportsBitWidth = [
    'MODULE_IN',
    'MODULE_OUT',
    'TOGGLE',
    'CONST',
    'NUM_DISPLAY',
    'TUNNEL',
    'AND',
    'OR',
    'NOT',
    'NAND',
    'NOR',
    'XOR',
    'XNOR',
    'BUF',
    'TRIBUF',
    'MUX',
    'DEMUX',
    'ADDER',
    'COMPARATOR',
    'D_LATCH',
    'D_FF',
    'REGISTER',
    'COUNTER',
  ].includes(gate.type);

  const supportsInputCount = ['AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR'].includes(gate.type);
  const supportsMuxChannels = gate.type === 'MUX' || gate.type === 'DEMUX';
  const supportsSelectBits = gate.type === 'DECODER';

  return (
    <>
      <div className="inspector-section">
        <div className="section-title">{entry.name}</div>
        {gate.type !== 'SUBCIRCUIT' && (
          <div className="field-row">
            <label>パーツ差し替え (配線維持)</label>
            <select
              value={gate.type}
              onChange={(e) => {
                const nextType = e.target.value as GateType;
                if (nextType !== gate.type) onReplace(nextType);
              }}
            >
              <option value={gate.type}>{entry.name}（現在）</option>
              {(() => {
                const compat = getCompatibleReplacementTypes(gate.type);
                const compatSet = new Set<GateType>([gate.type, ...compat]);
                const others = (Object.keys(GATE_CATALOG) as GateType[]).filter(
                  (t) => t !== 'SUBCIRCUIT' && !compatSet.has(t),
                );
                return (
                  <>
                    {compat.length > 0 && (
                      <optgroup label="互換パーツ（おすすめ）">
                        {compat.map((t) => (
                          <option key={t} value={t}>
                            {GATE_CATALOG[t].name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="その他の基本パーツ">
                      {others.map((t) => (
                        <option key={t} value={t}>
                          {GATE_CATALOG[t].name}
                        </option>
                      ))}
                    </optgroup>
                  </>
                );
              })()}
            </select>
          </div>
        )}
        <div className="field-row">
          <label>ラベル名</label>
          <input
            value={gate.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            placeholder="例: U1, A0, CLK"
          />
        </div>
        <div className="field-row">
          <label>向き (回転)</label>
          <button
            className="prop-btn"
            onClick={() =>
              onUpdate({ rotation: ((gate.rotation + 90) % 360) as GateInstance['rotation'] })
            }
          >
            <RotateCw size={13} /> {gate.rotation}° → {(gate.rotation + 90) % 360}°
          </button>
        </div>

        {supportsBitWidth && (
          <div className="field-row">
            <label>ビット幅</label>
            <input
              type="number"
              min={1}
              max={32}
              value={p.bitWidth ?? 1}
              onChange={(e) =>
                onUpdate({}, { bitWidth: Math.max(1, Math.min(32, Number(e.target.value) || 1)) })
              }
            />
          </div>
        )}

        {supportsInputCount && (
          <div className="field-row">
            <label>入力数</label>
            <input
              type="number"
              min={2}
              max={8}
              value={p.inputCount ?? 2}
              onChange={(e) =>
                onUpdate({}, { inputCount: Math.max(2, Math.min(8, Number(e.target.value) || 2)) })
              }
            />
          </div>
        )}

        {supportsMuxChannels && (
          <div className="field-row">
            <label>
              {gate.type === 'MUX' ? '入力チャネル数 (2〜16)' : '出力チャネル数 (2〜16)'}
            </label>
            <input
              type="number"
              min={2}
              max={16}
              value={p.inputCount ?? 1 << (p.selectBits ?? 1)}
              onChange={(e) => {
                const count = Math.max(2, Math.min(16, Number(e.target.value) || 2));
                const selBits = Math.max(1, Math.ceil(Math.log2(count)));
                onUpdate({}, { inputCount: count, selectBits: selBits });
              }}
            />
          </div>
        )}

        {supportsSelectBits && (
          <div className="field-row">
            <label>選択ビット数</label>
            <select
              value={p.selectBits ?? 1}
              onChange={(e) => onUpdate({}, { selectBits: Number(e.target.value) })}
            >
              <option value={1}>1 bit (2 ch)</option>
              <option value={2}>2 bit (4 ch)</option>
              <option value={3}>3 bit (8 ch)</option>
            </select>
          </div>
        )}

        {(gate.type === 'TOGGLE' || gate.type === 'CONST' || gate.type === 'MODULE_IN') && (
          <div className="field-row">
            <label>出力値 (0/1/X/Z/0x..)</label>
            <input
              value={p.value ?? '0'}
              onChange={(e) => onUpdate({}, { value: e.target.value })}
              placeholder="0, 1, X, Z, 0xF"
            />
          </div>
        )}

        {(gate.type === 'MODULE_IN' || gate.type === 'MODULE_OUT') && (
          <div className="field-row">
            <label>モジュール端子方向</label>
            <select
              value={p.portSide ?? (gate.type === 'MODULE_IN' ? 'left' : 'right')}
              onChange={(e) => onUpdate({}, { portSide: e.target.value as PinSide })}
            >
              <option value="left">左 (Left)</option>
              <option value="right">右 (Right)</option>
              <option value="top">上 (Top)</option>
              <option value="bottom">下 (Bottom)</option>
            </select>
          </div>
        )}

        {gate.type === 'ADDER' && (
          <div className="field-row">
            <label>キャリー入力 (Cin)</label>
            <select
              value={p.hasCarryIn === false ? 'off' : 'on'}
              onChange={(e) => onUpdate({}, { hasCarryIn: e.target.value === 'on' })}
            >
              <option value="on">あり (A + B + Cin)</option>
              <option value="off">なし (A + B)</option>
            </select>
          </div>
        )}

        {(gate.type === 'D_FF' || gate.type === 'REGISTER') && (
          <div className="field-row">
            <label>イネーブル入力 (EN)</label>
            <select
              value={p.hasEnable === false ? 'off' : 'on'}
              onChange={(e) => onUpdate({}, { hasEnable: e.target.value === 'on' })}
            >
              <option value="on">あり (EN 有効時のみ更新)</option>
              <option value="off">なし (常にクロックで更新)</option>
            </select>
          </div>
        )}

        {gate.type === 'NUM_DISPLAY' && (
          <div className="field-row">
            <label>表示基数</label>
            <select
              value={p.radix ?? 'hex'}
              onChange={(e) => onUpdate({}, { radix: e.target.value as GateProps['radix'] })}
            >
              <option value="hex">16進数 (HEX)</option>
              <option value="dec">10進数 (DEC)</option>
              <option value="signed">符号付き10進 (SIGNED)</option>
              <option value="bin">2進数 (BIN)</option>
            </select>
          </div>
        )}

        {gate.type === 'SEVEN_SEG' && (
          <div className="field-row">
            <label>入力モード</label>
            <select
              value={p.segMode ?? 'hex'}
              onChange={(e) =>
                onUpdate(
                  {},
                  {
                    segMode: e.target.value as 'hex' | 'direct',
                    bitWidth: e.target.value === 'direct' ? 7 : 4,
                  },
                )
              }
            >
              <option value="hex">4bit HEX デコーダ</option>
              <option value="direct">7bit セグメント直接</option>
            </select>
          </div>
        )}

        {gate.type === 'TUNNEL' && (
          <div className="field-row">
            <label>ネット名 (トンネル)</label>
            <input
              value={p.netName ?? ''}
              onChange={(e) => onUpdate({}, { netName: e.target.value })}
              placeholder="同じ名前同士を接続"
            />
          </div>
        )}

        {gate.type === 'SPLITTER' && (
          <>
            <div className="field-row">
              <label>動作モード</label>
              <select
                value={p.splitMode ?? 'split'}
                onChange={(e) => onUpdate({}, { splitMode: e.target.value as 'split' | 'merge' })}
              >
                <option value="split">分割 (1本 → 複数)</option>
                <option value="merge">結合 (複数 → 1本)</option>
              </select>
            </div>
            <div className="field-row">
              <label>ビット割当 (カンマ区切り)</label>
              <input
                value={(p.splitWidths ?? [1, 1, 1, 1]).join(',')}
                onChange={(e) => {
                  const arr = e.target.value
                    .split(',')
                    .map((s) => Math.max(1, Math.min(16, parseInt(s.trim(), 10) || 1)))
                    .slice(0, 8);
                  if (arr.length > 0)
                    onUpdate({}, { splitWidths: arr, bitWidth: arr.reduce((a, b) => a + b, 0) });
                }}
                placeholder="例: 1,1,1,1 または 4,4"
              />
            </div>
          </>
        )}

        {gate.type === 'IFACE_BUNDLE' && (
          <>
            <div className="field-row">
              <label>Interface名</label>
              <input
                value={p.interfaceName ?? 'bus_if'}
                onChange={(e) => onUpdate({}, { interfaceName: e.target.value })}
              />
            </div>
            <div className="field-row">
              <label>モード</label>
              <select
                value={p.bundleMode ?? 'pack'}
                onChange={(e) => onUpdate({}, { bundleMode: e.target.value as 'pack' | 'unpack' })}
              >
                <option value="pack">Pack (束ねる)</option>
                <option value="unpack">Unpack (展開する)</option>
              </select>
            </div>
            <div className="field-stack">
              <label>信号メンバー定義 (SV interface風)</label>
              {(p.interfaceFields ?? []).map((f, idx) => (
                <div key={idx} className="iface-field-row">
                  <input
                    value={f.name}
                    onChange={(e) => {
                      const next = (p.interfaceFields ?? []).map((item, i) =>
                        i === idx ? { ...item, name: e.target.value } : item,
                      );
                      onUpdate({}, { interfaceFields: next });
                    }}
                    placeholder="信号名"
                  />
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={f.bitWidth}
                    style={{ width: 52 }}
                    onChange={(e) => {
                      const next = (p.interfaceFields ?? []).map((item, i) =>
                        i === idx
                          ? { ...item, bitWidth: Math.max(1, Number(e.target.value) || 1) }
                          : item,
                      );
                      onUpdate({}, { interfaceFields: next });
                    }}
                  />
                  <button
                    className="icon-btn"
                    onClick={() => {
                      const next = (p.interfaceFields ?? []).filter((_, i) => i !== idx);
                      if (next.length > 0) onUpdate({}, { interfaceFields: next });
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                className="prop-btn"
                onClick={() => {
                  const list = p.interfaceFields ?? [];
                  onUpdate(
                    {},
                    { interfaceFields: [...list, { name: `sig_${list.length}`, bitWidth: 1 }] },
                  );
                }}
              >
                <Plus size={12} /> 信号メンバー追加
              </button>
            </div>
          </>
        )}

        {(gate.type === 'RAM' || gate.type === 'ROM') && (
          <>
            <div className="field-row">
              <label>アドレス幅 (bit)</label>
              <input
                type="number"
                min={1}
                max={8}
                value={p.addrBits ?? 4}
                onChange={(e) =>
                  onUpdate({}, { addrBits: Math.max(1, Math.min(8, Number(e.target.value) || 4)) })
                }
              />
            </div>
            <div className="field-row">
              <label>データ幅 (bit)</label>
              <input
                type="number"
                min={1}
                max={16}
                value={p.dataBits ?? 4}
                onChange={(e) =>
                  onUpdate({}, { dataBits: Math.max(1, Math.min(16, Number(e.target.value) || 4)) })
                }
              />
            </div>
            <button className="prop-btn accent" onClick={onOpenMemoryEditor}>
              <Database size={13} /> メモリ内容 (HEXエディタ) を編集
            </button>
          </>
        )}

        {gate.type === 'SUBCIRCUIT' && (
          <>
            <div className="field-row">
              <label>内部表示モード (Digital風)</label>
              <select
                value={p.displayMode ?? 'live'}
                onChange={(e) =>
                  onUpdate({}, { displayMode: e.target.value as SubcircuitDisplayMode })
                }
              >
                <option value="live">中身表示 + リアルタイム信号色</option>
                <option value="preview">中身表示のみ (信号色なし)</option>
                <option value="box">シンプル箱表示 (最軽量)</option>
              </select>
            </div>
            {p.subcircuitId && project.circuits[p.subcircuitId] && (
              <>
                {!project.circuits[p.subcircuitId].isStub && (
                  <button className="prop-btn accent" onClick={onOpenLivePopup}>
                    <ZoomIn size={13} /> ライブ内部を拡大表示（親の信号反映）
                  </button>
                )}
                <button className="prop-btn" onClick={() => onOpenCircuit(p.subcircuitId!)}>
                  <ExternalLink size={13} /> 内部回路 "{project.circuits[p.subcircuitId].name}"
                  を別タブで開く
                </button>
                {(project.circuits[p.subcircuitId].hdlSource ||
                  project.circuits[p.subcircuitId].hdlFileSource) && (
                  <>
                    <button className="prop-btn" onClick={() => onOpenHdlSource(p.subcircuitId!)}>
                      <FileCode2 size={13} /> 元の HDL ソースを表示
                    </button>
                    {project.circuits[p.subcircuitId].hdlDiverged && (
                      <div className="hdl-diverged-note">※ 回路図側が編集済み（元HDLと分離）</div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
};

const WireInspector: React.FC<{
  wire: Wire;
  snapshot: SimulationSnapshot | null;
  simActive: boolean;
  watched: boolean;
  onToggleWatch: () => void;
  onUpdate: (patch: Partial<Wire>) => void;
  onReroute: () => void;
}> = ({ wire, snapshot, simActive, watched, onToggleWatch, onUpdate, onReroute }) => {
  const val = snapshot?.wireValues[wire.id];
  const bit = dominantState(val);
  const xCause = bit === BIT_X ? snapshot?.wireXCauses?.[wire.id] : undefined;
  const dotColor = xCause ? X_CAUSE_COLORS[xCause] : SIGNAL_COLORS[bit];
  const stateLabel = xCause ? X_CAUSE_LABELS[xCause] : SIGNAL_LABELS[bit];

  return (
    <div className="inspector-section">
      <div className="section-title">ワイヤー / ネット</div>
      <div className="field-row">
        <label>ネットラベル</label>
        <input
          value={wire.netLabel ?? ''}
          onChange={(e) => onUpdate({ netLabel: e.target.value || undefined })}
          placeholder="同名ネットと自動接続"
        />
      </div>
      <div className="field-row">
        <label>配線スタイル</label>
        <select
          value={wire.routeMode}
          onChange={(e) => onUpdate({ routeMode: e.target.value as RouteMode })}
        >
          <option value="grid">グリッドフィット (重なり回避)</option>
          <option value="free">自由配線</option>
        </select>
      </div>
      <button className="prop-btn" onClick={onReroute}>
        <RefreshCw size={13} /> この配線を自動再レイアウト
      </button>
      <button className={`prop-btn ${watched ? 'accent' : ''}`} onClick={onToggleWatch}>
        <Activity size={13} /> {watched ? '信号ウォッチから解除' : '信号ウォッチ・波形に追加'}
      </button>
      <p className="muted-text" style={{ marginTop: 8 }}>
        線分や角ハンドルをドラッグして配線経路を手動調整できます。接続先パーツを動かすと自動で再レイアウトされます。
      </p>

      <div className="live-signal-card">
        <div className="signal-card-header">リアルタイム信号状態</div>
        {simActive && val ? (
          <div className="signal-readout">
            <span className="signal-dot" style={{ backgroundColor: dotColor }} />
            <span className="signal-val">{formatValue(val, val.width > 1 ? 'hex' : 'bin')}</span>
            <span className="signal-meta">
              ({val.width} bit · 状態: {stateLabel})
            </span>
          </div>
        ) : (
          <div className="muted-text">シミュレーション停止中</div>
        )}
      </div>
    </div>
  );
};

const CircuitInspector: React.FC<{
  circuit: CircuitDocument;
  snapshot: SimulationSnapshot | null;
  simActive: boolean;
  onRename: (name: string) => void;
  onOpenSymbolEditor: () => void;
  onOpenHdlSource: () => void;
}> = ({ circuit, snapshot, simActive, onRename, onOpenSymbolEditor, onOpenHdlSource }) => {
  const hasHdl = Boolean(circuit.hdlSource || circuit.hdlFileSource);
  return (
    <>
      <div className="inspector-section">
        <div className="section-title">現在の回路 / モジュール</div>
        <div className="field-row">
          <label>回路名</label>
          <input value={circuit.name} onChange={(e) => onRename(e.target.value)} />
        </div>
        <div className="stats-grid">
          <div className="stat-box">
            <span className="stat-num">{circuit.gates.length}</span>
            <span className="stat-lbl">パーツ</span>
          </div>
          <div className="stat-box">
            <span className="stat-num">{circuit.wires.length}</span>
            <span className="stat-lbl">ワイヤー</span>
          </div>
        </div>
        <button className="prop-btn accent" onClick={onOpenSymbolEditor}>
          モジュールシンボル（端子方向・名前）を編集
        </button>
        {hasHdl && (
          <>
            <button className="prop-btn" onClick={onOpenHdlSource}>
              <FileCode2 size={13} /> 元の HDL ソースを表示
            </button>
            {circuit.hdlDiverged && (
              <div className="hdl-diverged-note">
                ※ 回路図側が手動編集され、元のHDLソースとは分離しています
              </div>
            )}
          </>
        )}
      </div>

      <div className="inspector-section">
        <div className="section-title">4値信号カラーガイド</div>
        <ul className="legend-list">
          <li>
            <span className="dot" style={{ background: '#64748b' }} /> <strong>0 (LOW)</strong> —
            灰色
          </li>
          <li>
            <span className="dot" style={{ background: '#22c55e' }} /> <strong>1 (HIGH)</strong> —
            緑色
          </li>
          <li>
            <span className="dot" style={{ background: '#3b82f6' }} />{' '}
            <strong>Z (ハイインピーダンス)</strong> — 青色
          </li>
          <li>
            <span className="dot" style={{ background: X_CAUSE_COLORS.conflict }} />{' '}
            <strong>X (0/1 衝突)</strong> — 赤色
          </li>
          <li>
            <span className="dot" style={{ background: X_CAUSE_COLORS.oscillation }} />{' '}
            <strong>X (発振ループ)</strong> — マゼンタ
          </li>
          <li>
            <span className="dot" style={{ background: X_CAUSE_COLORS.stub }} />{' '}
            <strong>X (未実装Stub)</strong> — 琥珀色
          </li>
          <li>
            <span className="dot" style={{ background: X_CAUSE_COLORS.unknown }} />{' '}
            <strong>X (不定 / 伝播)</strong> — オレンジ
          </li>
        </ul>
        {simActive && snapshot?.oscillating && (
          <div className="warn-banner">
            発振ループを検出したため一部信号を X (マゼンタ) に安定化しました
          </div>
        )}
      </div>

      <div className="inspector-section">
        <div className="section-title">クイック操作ヒント</div>
        <ul className="tips-list">
          <li>
            <strong>端子を左クリック</strong> → 別の端子をクリックで簡単配線
          </li>
          <li>
            <strong>スイッチ/ボタン/クロック</strong>をクリックでリアルタイム操作
          </li>
          <li>
            <strong>右クリック</strong> → ネットラベル・回転・複製などのメニュー
          </li>
          <li>
            <strong>トラックパッド</strong>: 二本指で上下左右移動 / ピンチでキャンバス拡大縮小
          </li>
          <li>
            <strong>マウス</strong>: ホイールでズーム / 中ドラッグ or
            Space+ドラッグで移動（下部バーで「自動 / トラックパッド / マウス」切替可）
          </li>
        </ul>
      </div>
    </>
  );
};
