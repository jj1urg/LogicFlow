import React, { useMemo, useState } from 'react';
import { Copy, Download, FileCode2, FilePlus2, Trash2, Upload, X } from 'lucide-react';
import {
  exportDotGraph,
  exportJsonNetlist,
  exportVerilog,
  HdlSourceFile,
  ImportOptions,
  inferTopModuleName,
  inspectHdlSourceFile,
  listModuleNamesInFiles,
} from '../core/hdl';
import { SAMPLE_VERILOG_SNIPPET } from '../core/samples';
import {
  CircuitDocument,
  GateInstance,
  ModuleSymbolConfig,
  ModuleSymbolPin,
  PinSide,
  ProjectDocument,
} from '../core/types';

// --- 1. Verilog / SystemVerilog Multi-File Import Modal ---

export const VerilogImportModal: React.FC<{
  onClose: () => void;
  onImportFiles: (
    files: HdlSourceFile[],
    options?: Pick<ImportOptions, 'topModuleName' | 'projectName'>,
  ) => string[];
}> = ({ onClose, onImportFiles }) => {
  const [files, setFiles] = useState<HdlSourceFile[]>([
    { name: 'sample.sv', content: SAMPLE_VERILOG_SNIPPET },
  ]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [projectName, setProjectName] = useState('');
  const [selectedTopModule, setSelectedTopModule] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const safeIdx = Math.min(activeIdx, Math.max(0, files.length - 1));
  const activeFile = files[safeIdx] ?? { name: 'untitled.sv', content: '' };
  const detectedModules = useMemo(() => listModuleNamesInFiles(files), [files]);
  const inferredTop = useMemo(() => inferTopModuleName(files), [files]);

  const loadFileList = (fileList: FileList | File[], append: boolean) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    void Promise.all(
      arr.map(async (f) => ({
        name: f.name,
        content: await f.text(),
      })),
    ).then((loaded) => {
      const accepted: HdlSourceFile[] = [];
      const skippedMsgs: string[] = [];
      for (const item of loaded) {
        const check = inspectHdlSourceFile(item);
        if (check.valid) {
          accepted.push(item);
        } else {
          skippedMsgs.push(`"${item.name}" を除外しました（${check.reason ?? '未対応形式'}）`);
        }
      }

      if (accepted.length === 0) {
        setError(
          skippedMsgs.length === 1
            ? skippedMsgs[0]
            : `選択された ${loaded.length} ファイルはいずれも有効な Verilog/SystemVerilog ではありませんでした（${skippedMsgs.slice(0, 3).join(' / ')}）。`,
        );
        return;
      }

      setFiles((prev) => {
        if (!append) {
          setActiveIdx(0);
          return accepted;
        }
        // Replace existing files with the same name, append new ones
        const next = [...prev];
        for (const item of accepted) {
          const dupIdx = next.findIndex((x) => x.name === item.name);
          if (dupIdx !== -1) next[dupIdx] = item;
          else next.push(item);
        }
        setActiveIdx(next.length - 1);
        return next;
      });
      setError(null);
      setWarnings(skippedMsgs);
    });
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>, append: boolean) => {
    if (e.target.files && e.target.files.length > 0) {
      loadFileList(e.target.files, append);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // If only untouched sample is present, replace it; otherwise append!
      const isDefaultSample =
        files.length === 1 &&
        files[0].name === 'sample.sv' &&
        files[0].content === SAMPLE_VERILOG_SNIPPET;
      loadFileList(e.dataTransfer.files, !isDefaultSample);
    }
  };

  const handleUpdateActiveContent = (content: string) => {
    setFiles((prev) => prev.map((f, idx) => (idx === safeIdx ? { ...f, content } : f)));
  };

  const handleRemoveFile = (idx: number) => {
    setFiles((prev) => {
      if (prev.length <= 1) return [{ name: 'untitled.sv', content: '' }];
      const next = prev.filter((_, i) => i !== idx);
      setActiveIdx((cur) => Math.min(cur, next.length - 1));
      return next;
    });
  };

  const handleAddEmptyTab = () => {
    setFiles((prev) => {
      const next = [...prev, { name: `module_${prev.length + 1}.sv`, content: '' }];
      setActiveIdx(next.length - 1);
      return next;
    });
  };

  const handleImport = () => {
    try {
      setError(null);
      const warns = onImportFiles(files, {
        topModuleName: selectedTopModule || undefined,
        projectName: projectName.trim() || undefined,
      });
      setWarnings(warns);
      if (warns.length === 0) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-card wide ${isDragOver ? 'modal-drop-active' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="modal-header">
          <div className="modal-title">
            <FileCode2 size={16} /> Verilog / SystemVerilog インポート（複数ファイル対応）
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="muted-text">
            1 つまたは複数の <code>.v</code> / <code>.sv</code>{' '}
            ファイルをまとめて読み込みます（ドラッグ＆ドロップ対応）。別ファイルに定義されたモジュール同士も自動で相互解決し、未定義の外部モジュールのみ仮モジュール
            (Stub) を生成します。
          </p>
          <div className="modal-actions-inline">
            <label className="pill-btn active-blue">
              <Upload size={13} /> <span>.v / .sv を選択（複数可）</span>
              <input
                type="file"
                accept=".v,.sv,.vh,.svh,.txt"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => handleFileInput(e, false)}
              />
            </label>
            <label className="pill-btn">
              <FilePlus2 size={13} /> <span>ファイルを追加</span>
              <input
                type="file"
                accept=".v,.sv,.vh,.svh,.txt"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => handleFileInput(e, true)}
              />
            </label>
            <button className="pill-btn" onClick={handleAddEmptyTab}>
              新規タブ追加
            </button>
            <button
              className="pill-btn"
              onClick={() => {
                setFiles([{ name: 'sample.sv', content: SAMPLE_VERILOG_SNIPPET }]);
                setActiveIdx(0);
              }}
            >
              サンプル貼付
            </button>
          </div>

          <div className="hdl-import-meta-row">
            <label className="hdl-meta-field">
              <span>HDL プロジェクト名</span>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={selectedTopModule || detectedModules[0]?.name || '自動（トップ名）'}
              />
            </label>
            <label className="hdl-meta-field">
              <span>トップモジュール指定</span>
              <select
                value={selectedTopModule}
                onChange={(e) => setSelectedTopModule(e.target.value)}
              >
                <option value="">
                  自動判定{inferredTop ? `（推定: ${inferredTop}）` : '（ルートモジュール）'}
                </option>
                {detectedModules.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({m.fileName})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="hdl-file-tabs" role="tablist">
            {files.map((f, idx) => (
              <div
                key={`${f.name}-${idx}`}
                className={`hdl-import-tab ${idx === safeIdx ? 'active' : ''}`}
                onClick={() => setActiveIdx(idx)}
              >
                <span className="hdl-import-tab-name">{f.name}</span>
                <span className="hdl-import-tab-lines">
                  {f.content ? f.content.split(/\r?\n/).length : 0}行
                </span>
                {files.length > 1 && (
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveFile(idx);
                    }}
                    title="このファイルをリストから除外"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <textarea
            className="code-textarea"
            value={activeFile.content}
            onChange={(e) => handleUpdateActiveContent(e.target.value)}
            spellCheck={false}
            placeholder="ここに Verilog / SystemVerilog コードを記述するか、複数の .v / .sv ファイルをドロップしてください..."
          />
          {error && <div className="error-banner">{error}</div>}
          {warnings.length > 0 && (
            <div className="warn-banner">
              <strong>インポート完了（通知）:</strong>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span className="muted-text" style={{ marginRight: 'auto' }}>
            読込対象: {files.length} ファイル
          </span>
          <button className="pill-btn" onClick={onClose}>
            閉じる
          </button>
          <button className="pill-btn active-green" onClick={handleImport}>
            {files.length > 1
              ? `${files.length} ファイルをまとめてインポート`
              : '回路としてインポート'}
          </button>
        </div>
      </div>
    </div>
  );
};

// --- 2. Netlist Export Modal ---

export const NetlistExportModal: React.FC<{
  project: ProjectDocument;
  circuitId: string;
  onClose: () => void;
  onCopied: () => void;
}> = ({ project, circuitId, onClose, onCopied }) => {
  const [format, setFormat] = useState<'verilog' | 'json' | 'dot'>('verilog');

  const content = useMemo(() => {
    if (format === 'verilog') return exportVerilog(project, circuitId);
    if (format === 'json') return exportJsonNetlist(project, circuitId);
    return exportDotGraph(project, circuitId);
  }, [format, project, circuitId]);

  const ext = format === 'verilog' ? 'v' : format === 'json' ? 'netlist.json' : 'dot';
  const circuitName = project.circuits[circuitId]?.name || 'circuit';

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${circuitName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    void navigator.clipboard.writeText(content).then(onCopied);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">ネットリスト エクスポート ({circuitName})</div>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="tab-pills">
            <button
              className={`pill-btn ${format === 'verilog' ? 'active-blue' : ''}`}
              onClick={() => setFormat('verilog')}
            >
              Verilog HDL (.v)
            </button>
            <button
              className={`pill-btn ${format === 'json' ? 'active-blue' : ''}`}
              onClick={() => setFormat('json')}
            >
              構造化 JSON Netlist
            </button>
            <button
              className={`pill-btn ${format === 'dot' ? 'active-blue' : ''}`}
              onClick={() => setFormat('dot')}
            >
              Graphviz DOT (.dot)
            </button>
          </div>
          <textarea className="code-textarea" value={content} readOnly spellCheck={false} />
        </div>
        <div className="modal-footer">
          <button className="pill-btn" onClick={handleCopy}>
            <Copy size={13} /> コピー
          </button>
          <button className="pill-btn active-blue" onClick={handleDownload}>
            <Download size={13} /> ダウンロード
          </button>
        </div>
      </div>
    </div>
  );
};

// --- 3. Module Symbol Editor Modal ---

export const SymbolEditorModal: React.FC<{
  circuit: CircuitDocument;
  onClose: () => void;
  onSave: (config: ModuleSymbolConfig) => void;
}> = ({ circuit, onClose, onSave }) => {
  const initialPins: ModuleSymbolPin[] = useMemo(() => {
    const portGates = circuit.gates.filter(
      (g) => g.type === 'MODULE_IN' || g.type === 'MODULE_OUT',
    );
    return portGates.map((g, idx) => {
      const existing = circuit.symbolConfig?.pins.find((p) => p.portGateId === g.id);
      const dir = g.type === 'MODULE_IN' ? 'in' : 'out';
      return {
        portGateId: g.id,
        name: existing?.name ?? g.label ?? (dir === 'in' ? `IN${idx}` : `OUT${idx}`),
        dir,
        side: existing?.side ?? g.props.portSide ?? (dir === 'in' ? 'left' : 'right'),
        order: existing?.order ?? g.props.portOrder ?? idx,
        bitWidth: g.props.bitWidth ?? 1,
      };
    });
  }, [circuit]);

  const [width, setWidth] = useState(circuit.symbolConfig?.width ?? 180);
  const [height, setHeight] = useState(circuit.symbolConfig?.height ?? 140);
  const [pins, setPins] = useState<ModuleSymbolPin[]>(initialPins);

  const updatePin = (portGateId: string, patch: Partial<ModuleSymbolPin>) => {
    setPins((prev) => prev.map((p) => (p.portGateId === portGateId ? { ...p, ...patch } : p)));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">モジュールシンボル定義 — {circuit.name}</div>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="muted-text">
            この回路を別回路からモジュールとして呼び出すときのサイズ、端子名、各端子の配置方向(左/右/上/下)と並び順を定義できます。
          </p>
          <div className="symbol-editor-grid">
            <div>
              <div className="field-row">
                <label>シンボル幅 (px)</label>
                <input
                  type="number"
                  step={20}
                  min={100}
                  max={480}
                  value={width}
                  onChange={(e) => setWidth(Math.max(100, Number(e.target.value) || 160))}
                />
              </div>
              <div className="field-row">
                <label>シンボル高さ (px)</label>
                <input
                  type="number"
                  step={20}
                  min={80}
                  max={400}
                  value={height}
                  onChange={(e) => setHeight(Math.max(80, Number(e.target.value) || 120))}
                />
              </div>

              {pins.length === 0 ? (
                <div className="warn-banner">
                  この回路にはまだ「モジュール入力 (IN)」または「モジュール出力
                  (OUT)」が配置されていません。
                </div>
              ) : (
                <table className="pin-table">
                  <thead>
                    <tr>
                      <th>種別</th>
                      <th>端子名</th>
                      <th>幅</th>
                      <th>配置辺</th>
                      <th>順序</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pins.map((p) => (
                      <tr key={p.portGateId}>
                        <td>
                          <span className={`dir-tag ${p.dir}`}>{p.dir.toUpperCase()}</span>
                        </td>
                        <td>
                          <input
                            value={p.name}
                            onChange={(e) => updatePin(p.portGateId, { name: e.target.value })}
                          />
                        </td>
                        <td>{p.bitWidth}b</td>
                        <td>
                          <select
                            value={p.side}
                            onChange={(e) =>
                              updatePin(p.portGateId, { side: e.target.value as PinSide })
                            }
                          >
                            <option value="left">左 (Left)</option>
                            <option value="right">右 (Right)</option>
                            <option value="top">上 (Top)</option>
                            <option value="bottom">下 (Bottom)</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            style={{ width: 52 }}
                            value={p.order}
                            onChange={(e) =>
                              updatePin(p.portGateId, { order: Number(e.target.value) || 0 })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Live Symbol Preview */}
            <div className="symbol-preview-box">
              <svg width="260" height="220" viewBox="-130 -110 260 220">
                <rect
                  x={-Math.min(100, width / 2)}
                  y={-Math.min(80, height / 2)}
                  width={Math.min(200, width)}
                  height={Math.min(160, height)}
                  rx={10}
                  fill="#162033"
                  stroke="#38bdf8"
                  strokeWidth={2}
                />
                <text
                  x="0"
                  y="4"
                  textAnchor="middle"
                  fill="#e2e8f0"
                  fontSize="12"
                  fontWeight="700"
                  fontFamily="monospace"
                >
                  {circuit.name}
                </text>
                {(['left', 'right', 'top', 'bottom'] as PinSide[]).map((side) => {
                  const list = pins
                    .filter((p) => p.side === side)
                    .sort((a, b) => a.order - b.order);
                  const bw = Math.min(100, width / 2);
                  const bh = Math.min(80, height / 2);
                  return list.map((p, i) => {
                    const offset = (i - (list.length - 1) / 2) * 24;
                    const cx = side === 'left' ? -bw : side === 'right' ? bw : offset;
                    const cy = side === 'top' ? -bh : side === 'bottom' ? bh : offset;
                    return (
                      <g key={p.portGateId}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={4.5}
                          fill={p.dir === 'in' ? '#22c55e' : '#38bdf8'}
                        />
                        <text
                          x={side === 'left' ? cx + 8 : side === 'right' ? cx - 8 : cx}
                          y={side === 'top' ? cy + 14 : side === 'bottom' ? cy - 10 : cy + 3}
                          textAnchor={
                            side === 'left' ? 'start' : side === 'right' ? 'end' : 'middle'
                          }
                          fill="#cbd5e1"
                          fontSize="9.5"
                          fontFamily="monospace"
                        >
                          {p.name}
                        </text>
                      </g>
                    );
                  });
                })}
              </svg>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="pill-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="pill-btn active-green"
            onClick={() => {
              onSave({ width, height, pins });
              onClose();
            }}
          >
            シンボル設定を保存
          </button>
        </div>
      </div>
    </div>
  );
};

// --- 4. RAM / ROM Hex Memory Editor Modal ---

export const MemoryEditorModal: React.FC<{
  gate: GateInstance;
  liveRam?: number[];
  onClose: () => void;
  onSave: (memoryData: number[]) => void;
}> = ({ gate, liveRam, onClose, onSave }) => {
  const addrBits = Math.max(1, Math.min(8, gate.props.addrBits ?? 4));
  const dataBits = Math.max(1, Math.min(16, gate.props.dataBits ?? 4));
  const size = 1 << addrBits;
  const maxVal = (1 << dataBits) - 1;
  const hexDigits = Math.ceil(dataBits / 4);

  const [cells, setCells] = useState<number[]>(() => {
    const base = liveRam ?? gate.props.memoryData ?? [];
    return Array.from({ length: size }, (_, i) => (base[i] ?? 0) & maxVal);
  });

  const updateCell = (idx: number, raw: string) => {
    const parsed = parseInt(raw, 16);
    setCells((prev) => {
      const next = prev.slice();
      next[idx] = Number.isNaN(parsed) ? 0 : parsed & maxVal;
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {gate.type} HEX エディタ — {gate.label || gate.id} ({size} × {dataBits} bit)
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-actions-inline">
            <button className="pill-btn" onClick={() => setCells(new Array(size).fill(0))}>
              全て 0 クリア
            </button>
            <button
              className="pill-btn"
              onClick={() => setCells(Array.from({ length: size }, (_, i) => i & maxVal))}
            >
              0, 1, 2... 連番
            </button>
          </div>
          <div className="hex-grid">
            {cells.map((val, idx) => (
              <div key={idx} className="hex-cell">
                <span className="hex-addr">
                  0x{idx.toString(16).toUpperCase().padStart(2, '0')}
                </span>
                <input
                  value={val.toString(16).toUpperCase().padStart(hexDigits, '0')}
                  onChange={(e) => updateCell(idx, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="pill-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="pill-btn active-green"
            onClick={() => {
              onSave(cells);
              onClose();
            }}
          >
            メモリ内容を適用
          </button>
        </div>
      </div>
    </div>
  );
};

// --- 5. Keyboard Shortcuts Modal ---

export const ShortcutsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const rows: [string, string][] = [
    ['左クリック (端子 → 端子)', 'ワイヤーを接続（自由配線モード中は途中クリックで経由点追加）'],
    ['左クリック (スイッチ/ボタン/CLK)', 'リアルタイムに信号値をトグル・パルス操作'],
    ['ダブルクリック (モジュール)', 'モジュールの内部回路タブを開く'],
    ['ダブルクリック (ワイヤー)', 'ネットラベルを素早く設定'],
    ['右クリック', 'ネットラベル・回転・複製・表示モードなどのコンテキストメニュー'],
    ['ドラッグ (パーツ / 空き領域)', 'パーツの移動 / 範囲選択マーキー'],
    [
      'トラックパッド (二本指 / ピンチ)',
      '上下左右キャンバス移動 / キャンバス拡大縮小（ブラウザズーム抑止）',
    ],
    [
      'マウス (ホイール / 中ドラッグ or Space+ドラッグ)',
      'カーソル位置ズーム / キャンバス移動（下部バーでモード切替可）',
    ],
    ['R', '選択中のパーツを 90° 回転'],
    ['L', '選択中ワイヤーにネットラベル設定'],
    ['G', 'グリッド配線 / 自由配線モード切替'],
    ['F', '回路全体が収まるようにズーム調整'],
    ['Space (単押し) / S', 'クロック自動発振 ON/OFF / クロック1ステップ進める'],
    ['Ctrl+C / Ctrl+V / Ctrl+D', 'コピー / ペースト / 複製'],
    ['Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z)', '元に戻す / やり直す'],
    ['Ctrl+A / Delete (Backspace)', '全選択 / 選択項目を削除'],
    ['Escape', '配線中キャンセル / 選択解除'],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">操作方法・キーボードショートカット</div>
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <table className="shortcut-table">
            <tbody>
              {rows.map(([k, desc]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
