# Changelog

本プロジェクトのバージョン管理ルール（`vx.y-rz.w`）および Jujutsu (`jj`) 運用方針の詳細は [`docs/versioning.md`](./docs/versioning.md) を参照してください。

> 概要: **`v` = version (`x.y`: 破壊的変更 / 機能追加)**、**`r` = revision (`z.w`: ロジック刷新・修正 / 非ロジック更新)**。上位桁が上がると下位桁は `0` にリセットし、`package.json` には SemVer 互換の `x.y.0-rz.w` を同期します。

---

## 2026-11-28 — v0.18-r1.0 HDLエディタの編集中ハイライト・VS Codeショートカット・構文エラー診断＆Discord OGP改善

### 実施内容

1. **HDL エディタの編集中リアルタイム構文ハイライト＆VS Code 風ショートカット** (`src/core/hdlEditor.ts`, `src/components/HdlDockPanel.tsx`, `src/styles.css`):
   - 編集モードでも透過 `<textarea>`＋同期ハイライト `<pre>` オーバーレイによりリアルタイムのシンタックスハイライト表示に対応しました。
   - VS Code 準拠の基本ショートカットとエディタ内 Undo/Redo (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` / `Ctrl+Y`) を実装しました：`Ctrl/Cmd+X`（未選択時の行丸ごと切り取り）、`Ctrl/Cmd+C`（未選択時の行コピー）、`Alt+↑/↓`（行／選択ブロックの上下入れ替え）、`Shift+Alt+↑/↓`（行複製）、`Ctrl/Cmd+Shift+K`（行削除）、`Ctrl/Cmd+/`（`//` コメント切替）、`Tab` / `Shift+Tab`（複数行インデント／アウトデント）、`Enter`（自動インデント）。
2. **HDL 構文チェック＆エラー診断（誤構文のサイレント論理合成を防止）** (`src/core/hdlDiagnostics.ts`, `src/components/HdlDockPanel.tsx`, `src/styles.css`):
   - 括弧・ブロック (`module/endmodule`, `begin/end`, `case/endcase`) 不一致、セミコロン欠落、`assign` 不正、モジュール直下の `assign` 書き忘れ、未宣言信号タイポ警告などを行番号付きでリアルタイム診断し、ガタードット・行ハイライト・クリックジャンプ付き診断バーで可視化しました。
   - 構文エラーが残っている場合は「論理合成して反映」を安全にブロックし、該当行と理由を赤バナーで通知します。
3. **Discord 等向け OGP 画像の 24-bit RGB PNG 最適化・メタタグ・配信ヘッダ整備** (`public/og-image.png`, `public/_headers`, `index.html`, `public/sw.js`):
   - `og-image.png` を不要な透過チャネル無しの標準 24-bit RGB sRGB PNG へ最適化し、`index.html` に `og:image:secure_url` / `og:image:type="image/png"` / キャッシュバストクエリ (`?v=18`) を追加、Cloudflare Workers Assets 用 `public/_headers` を配置しました。
4. **ユニットテスト追加** (`tests/hdl_editor_diagnostics.test.ts`):
   - VS Code ショートカット全種、構文エラー／未宣言信号警告、および実世界 SystemVerilog (`docs/test_hdl/td4/*.sv`, `cic_decimator.sv`) での誤検出ゼロを検証するテストを追加しました。

## 2026-11-28 — v0.18-r0.0 タブドラッグ並び替え機能＆OGP画像の実回路刷新

### 実施内容

1. **回路タブのドラッグ＆ドロップ並び替え機能** (`src/core/tabs.ts`, `src/store/useProjectStore.ts`, `src/components/TopBar.tsx`, `src/App.tsx`, `src/styles.css`):
   - 上部タブバーの回路タブをドラッグ＆ドロップで任意の順番に入れ替えられるようにしました（ドラッグ中の挿入位置を示すシアン色のドロップインジケータ付き、順序は `localStorage` へ自動保存）。
   - DOM 非依存の純粋関数 `reorderOpenTabIds` を `src/core/tabs.ts` に実装し、回帰ユニットテストを `tests/debug_watch_popup.test.ts` に追加しました。
2. **OGP プレビュー画像 (`public/og-image.png`) を論理的に正確な実回路へ刷新** (`public/og-image.png`, `public/sw.js`):
   - AI 生成の非実在回路から、トグル入力 (`A=1`, `B=1`) の **半加算回路 (`XOR` → `S=0`, `AND` → `C=1`)**＋2bit バス結合 (`{C, S} = 2'b10`) → **7 セグメントディスプレイ (`2` 表示)**＋**トライステートバッファ (`EN=0` → `Z`)** → **LED (`Hi-Z` 青色発光)**＋同期 4 値波形ストリップを備えた、電気的・論理的に完全に正しい回路プレビューへ刷新しました。

## 2026-11-28 — v0.17-r2.0 全タブ閉じ対応（純粋なタブ閉鎖・0タブスタート画面）

### 実施内容

1. **タブの `×` ボタンを「純粋にタブを閉じるだけ」の挙動へ統一し、最後のタブも含め全タブを閉じられるように対応** (`src/core/tabs.ts`, `src/store/useProjectStore.ts`, `src/components/TopBar.tsx`, `src/components/ComponentPalette.tsx`):
   - `resolveOpenTabIds` / `closeCircuitTabState` を新設し、`openTabIds: []`（全タブ閉鎖）と `undefined`（旧データ互換）を明確に区別しました。
   - タブの `×` をクリックしてもモジュール定義は削除されずプロジェクト＆左パレットにそのまま保持されるようになり、最後の 1 タブも閉じられるようになりました（モジュール本体の削除は左パレットのゴミ箱ボタンから実施）。
   - 0 タブ状態で左パレットのカスタムモジュール／HDL モジュールをクリックすると、そのまま新しいタブとして即オープンします。
2. **0 タブ時のエンプティステート（スタート画面）＆ Null 安全化** (`src/App.tsx`, `src/components/InspectorPanel.tsx`, `src/styles.css`):
   - 全タブを閉じた際、キャンバス領域に「新規モジュール」「新規HDL」「HDL読込」およびプロジェクト内モジュールのクイック起動チップを備えたスタート画面を表示し、インスペクタ・ツールバーも 0 タブ状態を安全にハンドリングするようにしました（0 タブ中はシミュレーションも自動休止）。
3. **ユニットテスト追加** (`tests/debug_watch_popup.test.ts`):
   - `resolveOpenTabIds`・純粋タブ閉鎖・MRU 復帰・0 タブ遷移の回帰テストを追加しました。

## 2026-11-28 — v0.17-r1.0 高コントラスト透過ファビコン刷新・サイドバー開閉時のCanvas引き伸ばし解消・フローティング開閉ボタン化

### 実施内容

1. **高コントラスト透過ファビコン＆アプリアイコン刷新** (`public/favicon.svg`, `public/favicon-32.png`, `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`, `index.html`, `public/sw.js`):
   - `<link rel="icon">` 用の `favicon.svg` および新設の `favicon-32.png` を背景透過・太線シルエット＋暗色エッジ＋鮮明なシアン／発光グリーン・ホワイト波形の超高コントラスト設計へ刷新し、ライト／ダークどちらのブラウザタブでも 16×16px でくっきり視認できるようにしました。
   - PWA / ホーム画面アイコン (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) も同じく高コントラストなシャープ造形へ更新し、Service Worker のキャッシュ名を `logicflow-static-v0.17-r1` へ更新しました。
2. **インスペクタ等サイドバー開閉アニメーション時の Canvas 引き伸ばし解消** (`src/components/CircuitCanvas.tsx`, `src/styles.css`):
   - `.circuit-canvas` の `width: 100%; height: 100%` による CSS スケーリングと `ResizeObserver` 経由の非同期 React 再描画による 1 フレーム遅延が原因で、インスペクタ開閉アニメーション中に回路描画が横方向へ引き伸ばされて見えていた不具合を修正しました。
   - `.circuit-canvas` を絶対配置＋JS による実ピクセル CSS サイズ同期（`canvas.width / dpr === style.width` を常に保証）とし、`ResizeObserver` 内でペイント前に同期再描画 (`drawCanvasNow`) する方式へ変更。あわせてデスクトップ版 `.sidebar-slot` の開閉時の隙間 (`transform` 重複) も解消しました。
3. **サイドバー開閉ボタンを各パネルヘッダ＆キャンバス上フローティング配置へ移動** (`src/components/TopBar.tsx`, `src/components/ComponentPalette.tsx`, `src/components/InspectorPanel.tsx`, `src/App.tsx`, `src/styles.css`):
   - 上部ツールバー左右のサイドバー切替ボタンを撤去し、左コンポーネントパレット／右インスペクタのヘッダ内（従来の `×` ボタン位置）へ移設しました。
   - サイドバーが非表示のときは、キャンバス左上／右上に半透明ガラス調のフローティング表示ボタンが滑らかに現れるようにしました。

## 2026-11-28 — v0.17-r0.0 Web メタ・アイコン/OGP・PWA 対応・左上バージョン表記・新規 HDL モジュール作成・スマホ対応＆サイドバー/ポップアップアニメーション

### 実施内容

1. **Web ページアイコン・OGP プレビュー画像・メタタグ・PWA 有効化** (`public/`, `index.html`, `src/main.tsx`):
   - LogicFlow 専用の SVG ファビコン (`public/favicon.svg`)・PWA/ホーム画面アイコン (`public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`)・1200×630 の OGP プレビュー画像 (`public/og-image.png`) を生成・設定しました。
   - `index.html` に `description` / Open Graph (`og:title`, `og:description`, `og:image`, `og:url`) / Twitter Card / `theme-color` / `manifest.webmanifest` を設定しました。
   - `public/manifest.webmanifest` と軽量 Service Worker (`public/sw.js`、HTML は Network-first・静的アセットは Stale-while-revalidate) を追加し、プロダクションビルドでオフライン起動・独立ウィンドウインストール（PWA）に対応しました。
2. **ヘッダ左上のバージョン表記 (`vx.y`)** (`src/core/version.ts`, `src/components/TopBar.tsx`, `src/styles.css`):
   - `package.json` のバージョンから `vx.y`（ホバー時はフル表記 `vx.y-rz.w`）を自動生成する `formatAppVersion` を追加し、左上 `LogicFlow` ロゴの直後に表示しました。
3. **新規モジュールを最初から HDL で制作できる機能** (`src/store/useProjectStore.ts`, `src/components/TopBar.tsx`, `src/components/HdlDockPanel.tsx`, `src/App.tsx`):
   - タブバーの「新規モジュール」の隣に **「新規HDL」** ボタンを追加しました。モジュール名を指定すると最小の SystemVerilog テンプレートを生成・論理合成してタブを作成し、ドッキング HDL パネルをそのまま編集モードで開きます。
4. **スマートフォン対応 & 左右サイドバー開閉・ライブポップアップ拡大アニメーション** (`src/App.tsx`, `src/components/TopBar.tsx`, `src/components/ComponentPalette.tsx`, `src/components/InspectorPanel.tsx`, `src/components/LiveSubcircuitPopup.tsx`, `src/styles.css`):
   - 左右サイドバー（パーツパレット／インスペクタ）の開閉トグルと左右スライドアニメーションを実装しました。
   - スマートフォン等の狭幅画面 (`<= 900px`) では左右サイドバーが初期状態で閉じたドロワー表示になり、左カタログからパーツを **ドラッグ＆ドロップ（タッチの右方向ドラッグ／長押しドラッグ含む）で取り出した場合は自動で左サイドバーが閉じてキャンバスへ配置**、**タップで取り出した場合はサイドバーを閉じずに連続配置でき、ユーザーが手動で閉じてキャンバスへ戻る** 操作を実現しました。
   - ライブ内部拡大ポップアップの表示・閉鎖時にスムーズな拡大縮小（スケール＋フェード）アニメーションを付与しました。

## 2026-11-28 — v0.16-r6.0 ダブルクリックでのライブ内部拡大・タブ閉鎖時の直前タブ復帰・ウォッチリスト永続化

### 実施内容

1. **サブモジュールのダブルクリック挙動をライブ内部拡大ポップアップ優先に変更** (`src/components/CircuitCanvas.tsx`):
   - キャンバス上のサブモジュールインスタンスをダブルクリックすると、別タブではなく **ライブ内部拡大ポップアップ（親の信号反映）** が開くように変更しました（`Shift + ダブルクリック`、右クリックメニュー、インスペクタ、ポップアップ内「別タブで編集」から従来の独立タブ表示が可能）。
2. **タブ閉鎖時に直前に開いていたタブ (MRU 履歴) へ戻るよう改善** (`src/store/useProjectStore.ts`):
   - 訪問タブ履歴（MRU スタック）をセッション内で追跡し、現在開いているタブを閉じた際に先頭タブではなく **直前に閲覧していたタブ** へ自動復帰するよう改善しました。
3. **ウォッチリストのブラウザリロード永続化** (`src/core/debug.ts`, `src/App.tsx`):
   - `parseStoredWatchTargets` / `pruneWatchTargets` を追加し、登録済みウォッチ信号（並び順・表示基数を含む）を `localStorage` (`logicflow_watch_v1`) へ自動保存・復元するよう対応しました（削除された回路／配線／ゲートを参照する古い項目は自動整理）。
4. **テスト・仕様更新** (`tests/debug_watch_popup.test.ts`, `docs/features.md`):
   - ウォッチリストのシリアライズ復元・破損データ耐性・無効参照プルーニングの回帰テストを追加しました。

## 2026-11-28 — v0.16-r5.0 インスペクタ内ウォッチ信号の上下並び替え対応

### 実施内容

- **インスペクタ内のウォッチ信号カードに上下並び替えボタンを追加** (`src/components/InspectorPanel.tsx`, `src/App.tsx`):
  - 下部の波形タイムチャートパネルと共通の並び替えハンドラ (`handleReorderWatchTarget`) を接続し、右インスペクタ側の「ウォッチ中の信号」からも `↑` / `↓` ボタンで順番を入れ替えられるようにしました（並び順は波形パネルとも即時同期）。

## 2026-11-28 — v0.16-r4.0 ライブ内部拡大ポップアップの入力モード（自動/トラックパッド/マウス）連動修正

### 実施内容

- **ライブ内部拡大ポップアップのホイール／トラックパッド／ピンチ操作を `inputMode` に完全連動** (`src/components/LiveSubcircuitPopup.tsx`):
  - 従来の `Math.abs(e.deltaX) < 1` 判定によりトラックパッド二本指の上下スクロールでパンとズームが交互に同時発火していた不具合を修正しました。
  - メインキャンバス (`CircuitCanvas`) と同じ `project.settings.inputMode`（`自動` / `トラックパッド` / `マウス`）判定・ピンチズーム (`Ctrl+Wheel` / Safari `gesturechange` / 2 本指タッチ) 処理を適用し、ポップアップ内でも完全に一貫した操作感を実現しました。

## 2026-11-28 — v0.16-r3.0 右ドッキング HDL ソースパネルの横スクロール／パン不可不具合を修正

### 実施内容

- **右ドッキング HDL ソースパネルの横スクロール・パン対応** (`src/styles.css`, `src/components/HdlDockPanel.tsx`):
  - `.hdl-dock-main-split` 内の `.hdl-dock-body` に `min-width: 0; overflow: hidden;`、`.hdl-code-viewer.docked` に `min-width: 0; width: 100%; overflow: auto; overscroll-behavior: contain;` を設定し、右ドッキング時に長い HDL 行が親の `overflow: hidden` で見切れて横スクロール不能になっていた Flexbox 制約バグを修正しました。
  - 二本指横スクロール・横スクロールバー・`Shift + ホイール` に加え、コードビューア上での中ドラッグ（または `Alt + 左ドラッグ`）によるパン移動にも対応しました（`overscroll-behavior: contain` により横スワイプ時のブラウザ戻る誤爆も防止）。

## 2026-11-28 — v0.16-r2.0 衝突不定時の OUT 端子自己駆動色維持・ライブポップアップのズーム維持・タブ別ビューポート記憶

### 実施内容

1. **衝突不定 (`conflict`) ワイヤー接続時の `OUT` 端子自己駆動色維持** (`src/core/types.ts`, `src/core/simulator.ts`, `src/canvas/renderer.ts`):
   - `SimulationSnapshot` に `pinDrivenValues`（各出力端子がバス解決前に自身でドライブしている値）を追加しました。
   - 0/1 衝突が発生している共有ワイヤーに接続された各 `OUT` 端子は、ワイヤーの衝突赤 (`X`) へ塗り潰さず自身の駆動値（`0` 灰 / `1` 緑 / `Z` 青）のまま描画するよう改善し、どのドライバ同士が衝突しているか一目で判別できるようにしました（ホバーツールチップでも `1 (配線: X [0/1 衝突])` のように明示）。未駆動 `TRIBUF` の `Z` 端子表示も同じ仕組みへ統合しています。
2. **ライブ内部拡大ポップアップの信号変化時ズームリセット不具合を修正** (`src/components/LiveSubcircuitPopup.tsx`):
   - `fitCircuitToPopup` が `rootSnapshot` 更新のたびに再生成されて自動フィット `useEffect` を再発火させていた問題を修正し、初回表示時およびパンくず／サブモジュール潜入時のみ自動フィットするよう改善しました。
3. **回路タブごとの拡大縮小・パン状態のセッション内保持** (`src/components/CircuitCanvas.tsx`):
   - タブ ID ごとにビューポート (`x`, `y`, `zoom`) をセッション内メモリへ記憶し、別タブへ切り替えて戻った際に元の表示位置・ズーム倍率をそのまま復元するようにしました（初回訪問タブおよび明示的な全体表示 `F` のみ自動フィット。また `fitTrigger > 0` 後に無関係な回路更新で再フィットしてしまう問題も併せて修正）。
4. **テスト・仕様更新** (`tests/debug_watch_popup.test.ts`, `docs/features.md`):
   - 0/1 バス衝突時の `pinDrivenValues`（各ドライバの `0`/`1` 保持）と `pinXCauses === 'conflict'` を検証する回帰テストを追加しました。

## 2026-11-28 — v0.16-r1.0 インスペクタ内ウォッチ表示・未駆動 TRIBUF の Z 端子描画修正・ゲートウォッチ対象整理

### 実施内容

1. **インスペクタ内のウォッチ信号リアルタイム表示** (`src/components/InspectorPanel.tsx`, `src/App.tsx`, `src/styles.css`):
   - 画面下部の波形タイムチャートパネルとは別に、右インスペクタ下部の既存セクション罫線下に、ウォッチ登録済みの全信号をワイヤー選択時の「リアルタイム信号状態」と同一カード形式で一覧表示するようにしました（基数クリック切替・解除・波形パネル起動・実行ロック中でも操作可能）。
2. **ハイインピーダンス状態のトライステートバッファ (`TRIBUF`) の `OUT` 端子 Z 表示維持** (`src/core/simulator.ts`, `src/canvas/renderer.ts`):
   - `TRIBUF` 評価時に自身の駆動出力を `gateInternalValues` へ記録し、`EN=0` 等で 0/1 をドライブしていない（`Z` 出力中の）`TRIBUF` の `OUT` 端子は、共有バス配線の色（0/1/X）へ同化させず `Z`（青色）表示のまま維持するように修正しました（ホバーツールチップでも `Z (バス: ...)` と明示）。
3. **ゲート単体ウォッチ対象の明確化** (`src/core/debug.ts`, `src/components/ContextMenu.tsx`):
   - 複数出力を持つ構造ブロック（`SUBCIRCUIT`, `DEMUX`, `DECODER`, `COMPARATOR`, 分割モード `SPLITTER`, Unpack `IFACE_BUNDLE`）では曖昧な単一ピン登録を抑止し、接続ワイヤー側から明示的にウォッチ追加する挙動へ整理するとともに、右クリックメニューへ監視対象端子名を表示するよう改善しました。
4. **テスト・仕様更新** (`tests/debug_watch_popup.test.ts`, `docs/features.md`):
   - 共有トライステートバス上の未駆動 `TRIBUF` の `Z` 内部出力記録と、複数出力ブロックの `getDefaultWatchPin` 除外を検証するテストを追加しました。

## 2026-11-28 — v0.16-r0.0 ライブ内部拡大ポップアップ・信号ウォッチ＆波形タイムチャート・非ゴール定義 (`docs/scope.md`)

### 実施内容

1. **プロジェクトスコープ & 非ゴール（やらないこと）の明文化** (`docs/scope.md`, `docs/index.md`, `AGENTS.md`):
   - OKF コンセプトドキュメントとして [`docs/scope.md`](./docs/scope.md) を新設し、LogicFlow が注力するコア価値（気軽な GUI リアルタイム 4 値シミュレーション＋視覚デバッグ）と、意図的に実施しない領域（`#delay` 物理時間軸テストベンチ実行・SPICE/タイミング遅延解析・商用合成代替・ベンダ IP 内部再現等）を規定しました。
2. **外部モジュール（インスタンス）のライブ内部拡大ポップアップ** (`src/core/debug.ts`, `src/components/LiveSubcircuitPopup.tsx`, `src/components/ContextMenu.tsx`, `src/components/InspectorPanel.tsx`, `src/components/CircuitCanvas.tsx`, `src/App.tsx`):
   - 既存の「別タブで開く（独立した定義編集・単体テスト）」を維持したまま、親回路からの入力がリアルタイム反映されたインスタンス内部を拡大閲覧できる **ドラッグ移動・リサイズ可能な非ブロッキング・フローティングポップアップ** を追加しました。
   - 右クリックメニュー／インスペクタの「ライブ内部を拡大表示（親の信号反映）」または `Shift + ダブルクリック` で起動でき、親回路のスイッチ操作やクロックステップと連動して内部信号がリアルタイム更新されます。
   - ポップアップ内の拡大・縮小・パン・全体フィット・端子ツールチップ・入出力ポート現在値バーに加え、入れ子サブモジュールをダブルクリックで潜入できる **階層パンくずリスト** に対応しています。
3. **信号ウォッチ一覧 & シンプルなステップ基準の波形タイムチャート** (`src/core/debug.ts`, `src/components/WatchWaveformPanel.tsx`, `src/components/TopBar.tsx`, `src/components/ContextMenu.tsx`, `src/components/InspectorPanel.tsx`, `src/App.tsx`):
   - ワイヤーやパーツの右クリックメニュー、ワイヤーインスペクタ、および上部タブバーの「ウォッチ / 波形」ボタン（＋「主要I/O一括登録」・信号選択ドロップダウン）から複数信号をまとめて登録・監視できるドッキングパネルを追加しました。
   - 各信号の 4 値カラー現在値（`自動 / HEX / BIN / DEC / SIGNED` 基数切替・並び替え対応）と、信号変化時／手動サンプル記録時に最大 128 ステップを軽量記録・描画するデジタル波形タイムチャート（1bit 矩形波＋多ビット六角バス波形＋ホバーカーソル値参照）を備えています。
4. **テスト拡充・仕様更新** (`tests/debug_watch_popup.test.ts`, `docs/features.md`):
   - 入れ子インスタンスの親連動スナップショット解決、信号ウォッチのサンプリング・変化検知・リングバッファ上限・4 値基数フォーマットのユニットテストを追加しました。

## 2026-11-28 — v0.15-r1.0 大規模 HDL インポートのフリーズ解消・非 HDL ファイル自動リジェクト強化・Stub 端子方向推論と右寄せ配置改善

### 実施内容

1. **大規模 HDL インポート時のフリーズ解消（配線ルータ・交差/分岐検出の抜本高速化）** (`src/core/routing.ts`, `src/core/hdl.ts`):
   - `createBatchWireRouter` を新設し、一括自動配線時に全ゲートの障害物グリッドを 1 回だけ事前構築・既設配線をインクリメンタル登録（数値パックキー採用で文字列アロケーションを排除）することで、数百ゲート・1,000 本超の配線を持つパイプライン回路（16 段 CORDIC 等）でも 2 分超のフリーズから数百ミリ秒へ劇的に高速化しました。
   - `hasInterveningGate` の障害物判定を X/Y 範囲事前絞り込みで高速化し、描画用の `findOrthogonalCrossings`（ソート＋二分探索）および `findWireJunctions`（空間グリッドバケット）も O(W^2) から O(W log W) へ最適化しました。
2. **非 HDL ファイルのリジェクト強化 & 未対応構文の安全ハンドリング** (`src/core/hdl.ts`, `src/components/Modals.tsx`):
   - `inspectHdlSourceFile` を追加し、Vivado IP 設定ファイル（`.xci` / `.xci.txt` の XML）・JSON・バイナリ・サイズ超過・`module ... endmodule` を含まないファイルをインポート前段で安全に検出・除外し、明確な通知メッセージを表示するよう強化しました（除外ファイルは `hdlProject.files` へ保存しません）。
   - `buildExprGate` に再帰深度・式長・モジュール当たりゲート数の安全上限を追加し、定数シフト (`<<`, `>>`, `<<<`, `>>>`)・単項マイナス・`localparam signed` リテラル評価に対応するとともに、未対応の乗除算 (`*`, `/`, `%`) やユーザー関数呼び出しは警告付きで安全に定数 `X` へフォールバックするよう改善しました。
3. **外部仮モジュール (Stub) の端子方向推論改善 & 多 `MODULE_OUT` 接続モジュールの右寄せ配置修正** (`src/core/hdl.ts`):
   - `classifyStubPortByName` で `aclk` / `SysClk*` / `ADC_SamplingClk` 等のクロック入力・`clk_out*` 出力・AXI-Stream (`m_axis_*` / `s_axis_*`) 規約を識別するよう改善し、複数 Stub が共有するクロックネット（`clk_out1` 等）で消費側 Stub のクロック入力が誤って `out` 扱いされる不具合を修正しました。
   - `autoLayoutGates` の右寄せ（ALAP）判定でグローバルクロック／リセットネットのファンアウトを除外し、クロック生成元（`clk_wiz_0` 等）を左側に維持したまま、多数の `MODULE_OUT` に接続する外部モジュール（`ZmodScopeController_0` 等）を確実に `MODULE_OUT` のすぐ左隣へ配置するよう修正しました。
4. **開発管理・テスト整備** (`.gitignore`, `tests/hdl_advanced.test.ts`, `docs/features.md`):
   - `docs/test_hdl/fm_hdl/` を `.gitignore` へ追加し、`docs/test_hdl/fm_ip/` へのリネームにテストパスを追従させるとともに、Stub 方向推論＋右寄せ配置・非 HDL リジェクト・大規模 16 段パイプライン高速インポート＆シミュレーションの回帰テストを追加しました。

## 2026-11-27 — v0.15-r0.0 配線維持のコンポーネント差し替え機能・`instruction_decoder` 修正＆定数共有・複雑 `always_ff` (CICフィルタ等) 合成対応

### 実施内容

1. **配線を維持したままパーツを差し替えられる機能 & 配線を残して削除** (`src/core/catalog.ts`, `src/store/useProjectStore.ts`, `src/canvas/renderer.ts`, `src/components/CircuitCanvas.tsx`, `src/components/ContextMenu.tsx`, `src/components/InspectorPanel.tsx`, `src/App.tsx`, `src/styles.css`):
   - `applyGateReplacement` / `mapReplacementPins` / `getCompatibleReplacementTypes` を新設し、位置・回転・互換プロパティ・接続配線を保ったままパーツを差し替え可能にしました（同一ピン ID → 意味エイリアス `rst↔clr`, `c↔cout` 等 → 同方向ピン順で自動張り替え、対応ピンが無い余剰配線も削除せずフローティング終端として保持）。
   - **3 つの導線**: ① 左パレットから既存パーツ上へのドラッグ＆ドロップ差し替え（`effectAllowed = 'copyMove'` 対応、アンバー枠＋`差し替え → ...` バッジ表示）、② 右クリックメニューの互換パーツ 1 クリック差し替えチップ、③ インスペクタの差し替えドロップダウン。
   - 右クリックメニューに「配線を残して削除」を追加し、パーツだけ消して既存配線をフローティング終端として残せるようにしました。
2. **`instruction_decoder.sv` の生成不具合修正・定数重複削減・ゲート背後貫通配線の解消・出力側右寄せレイアウト** (`src/core/hdl.ts`, `src/core/routing.ts`):
   - `parseProceduralAssignments` の `case` 分岐解析に外側デフォルトマップを引き継ぐよう修正し、`2'b01: if (carry_f == 1'b1) PC_we = 1'b1;` 等の条件付き分岐で `if` 条件と `carry_f` 接続が消失する不具合を修正。
   - モジュール単位の定数 `CONST` キャッシュ (`constCache`)・共通部分式キャッシュ (`exprCache`)・1bit 定数ブール簡約を導入し、`1'b0` / `1'b1` や重複 `CMP` の大量生成を大幅に削減。
   - `routeWire` の A* 探索ボックスと `buildDetourRoute` のチャネル探索にピン外向き制約を追加し、右向き出力ピン（`CONST` 等）から出た配線がゲート本体の左側へ回り込み・貫通する不具合を解消。
   - `autoLayoutGates` に出力駆動コンポーネントの右寄せ（ALAP）パスを追加し、`MODULE_OUT` に直接または多く接続されているコンポーネントを `MODULE_OUT` のすぐ左隣（キャンバス右寄り）へ優先配置するよう改善。
3. **複雑な `always_ff` / SystemVerilog 構文の論理合成対応 (`cic_decimator.sv` 等)** (`src/core/hdl.ts`):
   - `$clog2(...)` パラメータ評価、インデクス付きパートセレクト (`[base -: width]` / `[base +: width]`)、1 次元/2 次元アンパック配列 (`logic signed [W-1:0] reg [0:N-1][0:M-1]`) のスカラー展開、コンパイル時 `for` ループの静的展開 (`unrollForLoops`)、符号拡張 (`extendNet`)、および複数レジスタ・条件付き保持 (`extractRegisterEnable`) を含む複雑な `always_ff` 合成に対応。
   - `stripNonSynthesizable` が式中の `$clog2` 等のシステム関数を誤除去する不具合を修正。
4. **テスト拡充・パス追従** (`tests/hdl_advanced.test.ts`, `tests/catalog_routing_hittest.test.ts`):
   - `docs/test_hdl/td4/` への整理に合わせてテストパスを更新し、`instruction_decoder.sv` の全 32 通り真理値表＋定数重複排除＋反対側配線ゼロ検証、`cic_decimator.sv` の 16 レジスタ合成＆DC ゲイン検証、およびコンポーネント差し替えの自動テストを追加。

## 2026-11-27 — v0.14-r2.1 Cloudflare Workers プレビュービルド対応 (`wrangler.jsonc`)

### 実施内容

- **Cloudflare Workers Preview 設定の追加** (`wrangler.jsonc`):
  - 非 `main` ブランチ（`develop` 等）の Workers Builds プレビューデプロイ（`npx wrangler preview`）で要求される `"previews": {}` ブロックを `wrangler.jsonc` へ追加しました。

## 2026-11-27 — v0.14-r2.0 D_FF/REGISTER の EN ピン有効/無効切替対応 & 公開 URL 明記

### 実施内容

1. **`D_FF` / `REGISTER` のイネーブル入力 (`EN`) 有効・無効設定の追加** (`src/core/types.ts`, `src/core/catalog.ts`, `src/core/simulator.ts`, `src/core/hdl.ts`, `src/components/InspectorPanel.tsx`):
   - `GateProps` に `hasEnable?: boolean` を追加し、`D_FF` および `REGISTER` で `EN` ピンの有無をインスペクタから切り替え可能にしました（`hasEnable: false` の場合は `EN` ピン自体を非表示にし、常にクロック立ち上がりで更新）。
   - HDL の `always_ff` 合成時に、イネーブル条件 (`if (en)`) が存在しない場合は `hasEnable: false` で生成するよう修正し、未接続ハイインピーダンス (`Z`) の `EN` ピンが発生しないようにしました。
2. **ライブ公開 URL のドキュメント明記** (`README.md`, `docs/architecture.md`, `docs/features.md`):
   - Cloudflare Workers により `main` ブランチの内容が `https://logicflow.arrow-xt.com` へデプロイ・公開されている旨を `README.md` と `docs/architecture.md` に追記。
3. **テスト拡充** (`tests/hdl_advanced.test.ts`):
   - 実 `docs/test_hdl/alu.sv` / `pc_4bit.sv`（`EN` なし）および `register_4bit.sv`（`if (we)` 付き `EN` あり）を用いた `hasEnable` ピン生成・クロック更新の回帰テストを追加（全 9 ファイル 75 テスト）。

## 2026-11-27 — v0.14-r1.0 トグルスイッチ不定時ON表示・HDL加算器Ci/幅拡張修正・HDLタブ追従・Canvasリサイズ再描画・CLK/RST迂回最適化

### 実施内容

1. **トグルスイッチ（およびボタン／クロック）の物理 ON 状態と不定値 (`X`) 表示の両立** (`src/canvas/renderer.ts`):
   - `drawToggleGate` の物理ノブ位置判定をネット解決後の値ではなくスイッチ自身の駆動値から算出するよう修正し、ON にした結果配線が伝搬不定 (`X`)・衝突 (`X`) になってもスイッチ本体が伝搬不定カラーのまま ON 位置に表示されるようにしました。
   - `TOGGLE` / `BUTTON` / `CLOCK` 描画へ `XCause` を伝達し、伝搬不定（オレンジ）・衝突（赤）などの原因別カラーを正確に反映するよう改善。
2. **HDL インポート時の加算器 `Cin` (`Z`) および幅不一致による伝搬不定値バグの修正** (`src/core/types.ts`, `src/core/catalog.ts`, `src/core/simulator.ts`, `src/core/hdl.ts`, `src/components/InspectorPanel.tsx`):
   - `ADDER` に `hasCarryIn?: boolean` を追加し、インスペクタからキャリー入力 (`Cin`) の有無を切り替え可能にしました（1bit `FULL_ADDER` は従来どおり常に `Cin` 付き）。
   - HDL インポートのキャリーなし加算 (`a + b` / `{cout, sum} = a + b`) では `hasCarryIn: false`（`Cin` ピンなし）の `ADDER`（1bit 時は `HALF_ADDER`）を合成し、未接続 `Z` の `Cin` が生えないよう修正。
   - `logic [4:0] sum_temp = mux_out + Im;`（`docs/test_hdl/alu.sv` 等のキャリー取得 5bit 加算）では 4bit `ADDER` の `{cout, s}` を `SPLITTER (merge)` で 5bit 結合し、また幅の異なる加算・減算・比較オペランドには自動でゼロ拡張 (`zeroExtendNet`) を挿入することで、上位ビット `Z` パディングによる伝搬不定 `X` を解消。
3. **別タブ切替時のドッキング HDL ソースパネル自動追従** (`src/App.tsx`):
   - HDL ソースパネルを開いた状態で別の HDL ソース付き回路タブへ切り替えた際、パネルを一度閉じなくても新しいタブの HDL ソースへ自動で切り替わるよう修正。
4. **Canvas リサイズ時の即時再描画対応** (`src/components/CircuitCanvas.tsx`):
   - `ResizeObserver` の更新カウンタ (`resizeTick`) を描画 `useEffect` の依存配列へ追加し、あわせて `window` の `resize` イベントも監視することで、ウィンドウやドックパネルのリサイズ時にキャンバスが確実に再描画されるよう修正。
5. **`CLK` / `RST` 信号の過剰な上部迂回配線の解消** (`src/core/hdl.ts`):
   - `hasInterveningGate` を障害物なし直交 Z 経路の探索判定へ精密化し、さらにグローバル `CLK` / `RST` ネットでも送信元・送信先の間に中間モジュールが存在しない接続では上部レールへの強制迂回を行わず直接最短経路で配線するよう改善。
6. **回帰テスト拡充** (`tests/hdl_advanced.test.ts`):
   - 実 `docs/test_hdl/alu.sv` の 4bit+4bit→5bit キャリー加算＆`Cin` 非生成テスト、幅違い加算・明示 `Cin` 加算テスト、および間にモジュールがない `CLK`/`RST` の直接配線テストを追加（全 9 ファイル 74 テスト）。

## 2026-11-27 — v0.14-r0.1 公開準備・OKF 導入・開発管理ドキュメント整備

### 実施内容

1. **GitHub Public 公開向けルートファイルの整備** (`README.md`, `LICENSE`, `CHANGELOG.md`, `AGENTS.md`):
   - 操作方法・主要機能・アーキテクチャ・クイックスタートをまとめた `README.md` を新設。
   - `LICENSE`（MIT License / Copyright (c) 2026 JJ1URG）を追加。
   - `docs/changelog.md` をルート `CHANGELOG.md` へ移行し、重複していた履歴エントリ（`v0.12-r1.0`, `v0.8-r0.0`）を整理。
   - AI エージェント向け共通ルール `AGENTS.md` を新設し、OKF ナレッジ参照手順・人間専用ファイル（`docs/main.md`, `docs/memo.md`）の保護ルール・バージョン管理方針を明示。
2. **`docs/` の Open Knowledge Format (OKF) 化** (`docs/index.md`, `docs/versioning.md`, `docs/architecture.md`, `docs/features.md`, `docs/assets/.gitkeep`):
   - `docs/index.md` をナレッジ全体の目次として新設。
   - `docs/versioning.md` を新設し、独自バージョニング `vx.y-rz.w` と `package.json` (SemVer 互換)、コミットメッセージ規約（`:絵文字: prefix: abstract`）、および `jj` (Jujutsu) 運用方針を整理。
   - `docs/architecture.md`・`docs/features.md` へ OKF 準拠の YAML フロントマターを付与し、構成図を最新化。
3. **リポジトリ設定の整理** (`.gitignore`, `vite.config.ts`, `package.json`):
   - `vite.config.ts` の `fmt.ignorePatterns` で人間専用ファイル（`docs/main.md`, `docs/memo.md`）および `docs/test_hdl` をフォーマッタ除外対象として確認・維持。
   - `tsconfig.tsbuildinfo` を `.gitignore` に追加し、バージョン管理対象から除外。

## 2026-11-26 — v0.14-r0.0 基本ゲート帰還ループの不定値解消・状態保持 & フローティング配線の再延長対応

### 実施内容

1. **基本ゲート帰還ループの状態保持＆伝搬不定値リセット機構** (`src/core/types.ts`, `src/core/simulator.ts`, `src/store/useProjectStore.ts`):
   - `SequentialState.prevNetValues`（出力ピン署名キーで保持）を導入し、基本ゲートで組んだ NOR/NAND SR ラッチ等がホールド遷移時に毎ティック `Z/X` へ巻き戻らず状態を保持するようにしました。
   - 厳密な 4 値評価で伝搬不定値 (`X (unknown)`) がループ内に閉じ込められた場合、自動で 0/1 シードによる Gauss-Seidel 緩和プローブを実行：
     - **論理が一意に決定するループ**（`XOR(y, y)` / `AND(y, ~y)` / `OR(y, ~y)` / 同値データ入力の `MUX` ループ等）は自動で確定値 `0`/`1` へ解消。
     - **発振ループ**（単体/奇数段 `NOT` リング発振器等）は `X (発振)` (`oscillation`) として正しく分類。
     - **未初期化の双安定ループ**（`S=0, R=0` の SR ラッチ等）は不定のまま正直に表示しつつ、上部の状態リセット操作時に `resetUnknownLoops` により伝搬不定ループの対称性を崩して安定状態へ初期化できるようにしました。
   - `MUX` のセレクト信号が `X`/`Z` を含む場合も、既知ビットに整合する全候補チャネルのビットが一致していれば確定値を出力するよう精密化しました。
2. **フローティング配線の終端表示・再延長＆不要な中点ドットの解消** (`src/core/routing.ts`, `src/canvas/hitTest.ts`, `src/canvas/renderer.ts`, `src/store/useProjectStore.ts`, `src/components/CircuitCanvas.tsx`, `src/App.tsx`):
   - 既存配線を消去した際などに残ったフローティング配線終端を中抜きリングで可視化し、**フローティング終端をクリックして直接配線を延長**できるようにしました（既存の 1 本のワイヤーに統合され、余分なワイヤーや中点ドットは生成されません）。
   - 端子からフローティング終端へ接続した場合や、フローティング終端同士を接続した場合も自動で 1 本の連続ワイヤーへマージします。
   - `findWireJunctions` を分岐次数判定（次数 `>= 3` のみ接続点ドットを描画）へ刷新し、2 本の配線が 1 対 1 で突き合わさった箇所に不要な中点ドットが出ないよう修正しました。また T 字接続時のクリック座標を相手線分上へ正確に射影スナップするようにしました。
3. **テスト拡充** (`tests/logic_correctness.test.ts`, `tests/catalog_routing_hittest.test.ts`):
   - 基本 NOR ゲート構成 SR ラッチの状態保持＆手動リセット、一意確定ループの自動解消、3 段 NOT リング発振器検出、未接続浮遊 `X` の保全テストを追加。
   - 1 対 1 接続でのドット非生成、3 方向ジャンクション検出、ホスト配線削除後のフローティング終端検出・ヒットテストを追加。

## 2026-11-26 — v0.13-r0.0 不定値 X の原因別カラー表示 & ハイインピーダンス Z の実線表示化

### 実施内容

1. **不定値 `X` の原因別カラー＆ラベル表示** (`src/core/logic4.ts`, `src/core/types.ts`, `src/core/simulator.ts`, `src/canvas/renderer.ts`, `src/components/InspectorPanel.tsx`):
   - シミュレーション時に `X` が発生したネットごとに原因 (`XCause`) を自動分類し、色分け・ツールチップ・インスペクタで即座に判別できるようにしました：
     - **0/1 衝突 (`conflict`)**: 鮮赤 (`#ef4444`)
     - **発振ループ (`oscillation`)**: マゼンタ (`#ec4899`)
     - **未実装 Stub 出力 (`stub`)**: 琥珀色 (`#f59e0b`)
     - **不定 / 伝播 (`unknown`)**: オレンジ (`#f97316`)
2. **ハイインピーダンス (`Z`) の実線化** (`src/canvas/renderer.ts`, `docs/features.md`):
   - `Z`（青色 `#3b82f6`）のワイヤー描画を破線から他の信号状態と同じ実線へ変更し、配線全体の視認性を統一しました。
3. **テスト追加** (`tests/hdl_advanced.test.ts`): `conflict` / `oscillation` / `stub` / `unknown` 全 4 原因の分類テストを追加（合計 9 ファイル 70 テスト）。

## 2026-11-26 — v0.12-r1.0 自動配線・リアルタイム拡大縮小の大幅高速化 & トップモジュール自動推論の改善

### 実施内容

1. _*A* 自動配線の大幅高速化（Binary Min-Heap + TypedArray 化）_* (`src/core/routing.ts`):
   - A* 探索のオープンリストを線形走査＋`Array.splice` (`O(N^2)`) から **Binary Min-Heap** (`O(N log N)`) へ刷新し、内側ループの文字列キー生成・`Map`/`Set` ルックアップを **フラットな `Uint8Array` / `Float64Array` / `Int32Array`** へ置換（配線ロジック・経路品質はそのまま維持）。
2. **リアルタイム実行時の拡大縮小・パン・ドラッグ描画の高速化** (`src/canvas/renderer.ts`, `src/components/CircuitCanvas.tsx`, `src/store/useProjectStore.ts`):
   - 毎フレーム再計算していた `findOrthogonalCrossings` / `findWireJunctions` / サブ回路バウンディングボックスを `WeakMap` キャッシュ化（ネスト内部回路では T 字ドット探索を省略）。
   - 全 HIGH/X ワイヤーに対して毎フレーム走っていたソフトウェアガウスぼかし (`ctx.shadowBlur`) を軽量な半透明ハローパスへ置換。
   - 背景グリッドドットを最大数万回の個別 `fillRect` ループから **単一 `CanvasPattern` 描画** へ最適化。
   - ビューポート外パーツのカリング、ネスト小サイズ時の直線ワイヤー＆LOD 簡易表示、`requestAnimationFrame` によるズーム/パン統合、ドラッグ時のスナップ座標変化なしスキップ、および `localStorage` 保存の 400ms デバウンスを導入。
3. **トップモジュール自動推論の改善** (`src/core/hdl.ts`, `src/components/Modals.tsx`):
   - 未インスタンス化モジュールが複数存在する場合（例: `td4_cpu` と未使用リーフ `rom_16x8`）、単純な先頭／ファイル名順ではなく **再帰的な配下インスタンス数（階層規模）スコア** で最も上位のモジュールを自動選出するよう改善（インポート画面のドロップダウンにも `自動判定（推定: td4_cpu）` を事前表示）。
4. **実測ベンチマークテスト追加** (`tests/hdl_advanced.test.ts`): `docs/test_hdl` の実 TD4 CPU（7 ファイル）を用いたトップ推論・自動配線・再配線速度テストを追加（合計 9 ファイル 69 テスト）。

## 2026-11-26 — v0.12-r0.0 HDL モジュール階層ツリー表示・CPU 循環レイアウト刷新・クロック/回り込み迂回配線＆中間点 Y 調整

### 実施内容

1. **HDL プロジェクトのモジュール階層ツリー表示** (`src/core/hdl.ts`, `src/components/ComponentPalette.tsx`, `src/components/HdlDockPanel.tsx`, `src/App.tsx`, `src/styles.css`):
   - `buildHdlModuleTree` を実装し、トップモジュールをルートに `SUBCIRCUIT` インスタンス階層を再帰展開（トップから未参照のモジュールも「トップ外のモジュール」として分離表示）。
   - 左パレットの HDL プロジェクトに **ツリー／一覧切替**（デフォルトはツリー表示）を追加し、インスタンス名・モジュール名・`TOP` バッジ付きで開閉・回路タブオープン・HDL 表示・トップ指定・削除が可能に。
   - ドッキング型 HDL パネルにも開閉式の **「ツリー」サイドバー** を追加し、ソース閲覧中に階層ツリーから任意モジュールのソースや回路タブへ即移動可能に。
2. **CPU 等・循環回路向け初期レイアウト刷新 & グローバル CLK / 右→左回り込み迂回配線** (`src/core/hdl.ts`, `src/core/routing.ts`):
   - `autoLayoutGates` に DFS バックエッジ検出による循環サイクル分離を導入し、CPU（PC→DEC→ALU→WB→PC 等）のようにサブモジュール間で循環する回路が過剰に横長化せず整理されたステージ列に配置されるよう改善。
   - 複数モジュールへ分配されるグローバル `CLK` / `RST` 信号は回路上部の専用トップレールへ、右から左へ回り込むフィードバック信号や中間モジュールを跨ぐ長距離配線は回路下部／上部の専用迂回コリドーへ自動退避し、モジュール本体を横切らない配線を実現。
   - 入力ポート列 (`MODULE_IN`) の 2 パス整列により、クロック/リセットを上端、データ入力を接続先モジュール高さに合わせて配置。
3. **配線の中間点 Y 調整バイアス** (`src/core/routing.ts`):
   - A* 経路探索の縦移動コストに中間 X 優先バイアスを導入し、モジュール入力ピンの直前で急に Y を曲げるのではなく、モジュール間チャネルの中央付近で自然に Y を調整して真っ直ぐ入力ピンへ接続されるよう改善。
4. **テスト拡充** (`tests/hdl_advanced.test.ts`, `tests/catalog_routing_hittest.test.ts`): CPU 階層ツリー＋循環レイアウト＋上部 CLK 迂回＋下部フィードバック迂回テスト、および中間点 Y 調整テストを追加（合計 9 ファイル 68 テスト）。

## 2026-11-26 — v0.11-r0.0 HDL プロジェクト（統合ソース管理＋トップ指定）・パレットからのモジュール開閉/削除・Stub 非表示化

### 実施内容

1. **HDL プロジェクト機能（複数ファイルの一体管理）& トップモジュール指定** (`src/core/types.ts`, `src/core/hdl.ts`, `src/store/useProjectStore.ts`, `src/components/Modals.tsx`, `src/components/HdlDockPanel.tsx`):
   - `HdlProjectBundle` を新設し、まとめてインポートした複数 `.v`/`.sv` ファイル群を「ひとつの HDL ソースプロジェクト」として束ねて保持。
   - HDL インポート画面に **プロジェクト名** と **トップモジュール指定ドロップダウン**（全ファイルからモジュール名を自動検出）を追加し、テストベンチ等が含まれていても任意のモジュールをトップとしてインポート可能に。
   - ドッキング型 HDL パネルに **「プロジェクト (NF)」タブ** を追加し、プロジェクト内の全ファイル切替・ファイル追加・トップモジュール変更・**「プロジェクト再合成」** を一括操作可能に。
2. **カスタムモジュール一覧からのモジュール開閉・トップ切替・削除に対応** (`src/components/ComponentPalette.tsx`, `src/store/useProjectStore.ts`, `src/App.tsx`):
   - 左パレットに **HDL プロジェクトフォルダ**（`TOP` バッジ付き）および **カスタムモジュール一覧** を表示し、タブに開いていないモジュールでも右側のアクションボタンから **「回路タブを開く」／「HDLソースを表示」／「トップに指定」／「削除」**、さらに **HDL プロジェクトごとの一括削除** ができるように改善。
3. **外部仮モジュール (Stub) をカスタムコンポーネント一覧から除外** (`src/components/ComponentPalette.tsx`):
   - `isStub` な外部仮モジュールが左パレットのカスタムモジュール一覧に出現しないようフィルタリング。
4. **テスト拡充** (`tests/hdl_advanced.test.ts`): モジュール名検出・明示的トップモジュール指定・`HdlProjectBundle` 生成・プロジェクト全体再論理合成テストを追加（合計 9 ファイル 66 テスト）。

## 2026-11-26 — v0.10-r0.0 ドッキング型 HDL ソースエディタ＆再論理合成・Stub 間配線修復・複数 HDL ファイル一括インポート

### 実施内容

1. **ドッキング型 HDL ソースパネル（下部／右側切替）& 編集→再論理合成機能** (`src/components/HdlDockPanel.tsx`, `src/App.tsx`, `src/store/useProjectStore.ts`, `src/core/hdl.ts`, `src/styles.css`):
   - HDL ソース表示をポップアップモーダルから **非モーダルのドッキングパネル** に刷新。キャンバス下部・右側のワンクリック切替およびドラッグによるサイズ調整に対応し、HDL を見ながら回路の操作・シミュレーションが可能に。
   - 「閲覧（シンタックスハイライト）」と「編集（行番号付きコードエディタ）」を切り替えられ、編集後に **「論理合成して反映」**（または `Ctrl+Enter`）を押すと同一モジュール ID を維持したままインプレースで回路を再生成し、親モジュールからの参照も維持したまま即反映（`Ctrl+Z` での Undo にも対応）。
   - 回路図側を手動編集した場合（スイッチ操作等のランタイム操作は除く）、元ソースは書き換えずに `hdlDiverged` フラグを立て、上部タブバー・インスペクタ・HDL パネルに **「回路側で編集済み（元HDLと分離）」** バッジを表示（再論理合成で自動解除）。
2. **外部仮モジュール (Stub) 同士のみの配線・複数ドライバ配線の接続修復** (`src/core/hdl.ts`):
   - 親モジュール内のデータフロー解析＋Stub 間専用ネットの方向推論パスを追加し、ポート名から入出力が判別できない Stub 同士の接続でも適切に方向を推論。
   - さらに方向が曖昧・同一名ポート（例: `.bus` 同士）や複数ドライバが同一ネットに存在するケースでもスキップせず確実に配線するようルーティング＆自動レイアウトを拡張（シミュレーション時は 4 値調停により `1` と `0` の衝突を `X` として処理）。
3. **複数 `.v` / `.sv` ファイルの一括インポート＆ファイル間モジュール相互参照** (`src/core/hdl.ts`, `src/components/Modals.tsx`, `src/store/useProjectStore.ts`):
   - `importVerilogFilesToCircuits` を実装し、複数の `.v` / `.sv` ファイルをまとめて選択・追加・ドラッグ＆ドロップでインポート可能に。
   - 読込順にかかわらず別ファイルに定義されたモジュール同士を自動で相互解決し、各モジュールに元のファイル名 (`hdlFileName`) とソースを保持。
4. **テスト拡充** (`tests/hdl_advanced.test.ts`): Stub 間配線（不明ポート名・同一ポート名・複数ドライバ・Stub→出力）および複数ファイル一括インポート＋インプレース再論理合成テストを追加（合計 9 ファイル 65 テスト）。

## 2026-11-26 — v0.9-r0.0 HDL インポート元ソースコード表示機能の追加

### 実施内容

1. **モジュール別・元ファイル全体の HDL ソース保持** (`src/core/types.ts`, `src/core/hdl.ts`):
   - `CircuitDocument` に `hdlSource`（該当モジュールの `module ... endmodule` 原文）および `hdlFileSource`（複数モジュール・ディレクティブを含む元ファイル全体）を追加。プロジェクト保存 (`.lcirc.json` / `localStorage`) でもそのまま保持されます。
   - コメント・文字列リテラルを正しくスキップするスキャナ `extractOriginalModuleSources` により、コメントや `assert` / `initial` 等も含めインポート時の原文をそのまま抽出。
2. **シンタックスハイライト・行番号付き HDL ソースビューア** (`src/components/Modals.tsx`, `src/styles.css`):
   - `HdlSourceModal` を新設。行番号表示、Verilog / SystemVerilog シンタックスハイライト、モジュール単体 / 元ファイル全体の切替タブ、クリップボードコピー、`.sv` ダウンロードに対応。
3. **複数箇所からのワンクリック表示** (`src/components/TopBar.tsx`, `src/components/InspectorPanel.tsx`, `src/components/ContextMenu.tsx`, `src/App.tsx`):
   - 上部タブバーの **「HDLソース」** ボタン、インスペクタ（回路未選択時・`SUBCIRCUIT` 選択時）、右クリックメニュー（モジュール上・キャンバス背景上）からいつでも元の HDL ソースを表示可能（実行モード・編集ロック中でも閲覧可能）。
4. **テスト追加** (`tests/hdl_advanced.test.ts`): コメント・非合成文・複数モジュール・単一モジュールそれぞれの原文保持テストを追加（全 9 ファイル 63 テスト）。

## 2026-11-26 — v0.8-r0.0 配線ブリッジ重複バグ修正・HDL assign 接続修復・マルチ入力 MUX 対応・MODULE_OUT 形状刷新

### 実施内容

1. **交差ブリッジと直線の二重描画バグ修正 & 縦方向ワイヤー重なりの抑制** (`src/core/routing.ts`, `src/canvas/renderer.ts`, `src/core/hdl.ts`):
   - `findOrthogonalCrossings` で同一または近接 X 座標（12px 未満）の縦ワイヤー交差を重複排除し、`traceRoundedWirePath` にも `lastDrawnEnd` ガードを追加することで、複数ワイヤーが横ワイヤーを横切ってもブリッジ弧と直線が二重描画されないよう修正。
   - A* 経路探索の既存セグメント重複ペナルティを大幅強化（`+85` / 展開上限 `4500`）し、フォールバック経路でも空き縦トラックを探索する `findFreeChannelX` を導入。さらに HDL 自動レイアウトの列間チャネル幅を交差本数に応じて動的拡張。
2. **HDL `assign` 接続切れバグの包括修正** (`src/core/hdl.ts`):
   - `netPinMap` を複数ドライバ対応 (`drivers: PinRef[]`) に刷新し、複数トライステートバス駆動 (`assign bus = en ? d : 1'bz;`) で先のドライバが上書き消失する不具合を修正。
   - 右辺ビット選択/スライス (`a[0]`, `a[3:2]`)・左辺ビット/スライス代入 (`assign y[0] = ...`)・右辺/左辺連結＆複製 (`{a, b}`, `{4{a}}`, `assign {hi, lo} = bus`) を `SPLITTER`（分割/結合）へ自動合成。
   - カンマ区切り複数代入 (`assign #5 a = x, b = y;`)・ディレイ/ドライブ強度・宣言順に依存しないネット間エイリアス解決・減算 (`-`)・`<=` / `>=` / `===` / `!==`・単項リダクション (`&a`, `|a`, `^a`)・`localparam` 定数参照に対応。
3. **可変マルチ入力 `MUX` / `DEMUX`（2〜16 チャネル）& HDL マルチ入力 MUX 合成** (`src/core/catalog.ts`, `src/core/simulator.ts`, `src/components/InspectorPanel.tsx`, `src/core/hdl.ts`):
   - `MUX` / `DEMUX` に「入力（出力）チャネル数 (2〜16)」設定を追加し、選択ビット幅 `ceil(log2(channels))` を自動連動（範囲外選択時は `X` を出力）。
   - HDL の `case (sel)` / `if-else if` / 連鎖三項演算子 `(sel == k) ? ...` を 2:1 MUX＋比較器チェーンではなく **単一のマルチ入力 `MUX` コンポーネント** へ直接論理合成（Verilog エクスポート＆再インポートのラウンドトリップ対応）。
4. **`MODULE_OUT` シンボル形状を `MODULE_IN` と同一向きに変更** (`src/canvas/renderer.ts`):
   - `MODULE_OUT` の線対称反転を廃止し、`MODULE_IN` と同じ右向き五角形タグ形状で描画した上で、頂点側ではなく反対の左辺中点にピンが接続される表現へ変更。
5. **テスト拡充** (`tests/catalog_routing_hittest.test.ts`, `tests/hdl_advanced.test.ts`): 重複交差デデュープ・4 本並列配線重なりゼロ・可変マルチ入力 MUX・`assign` 各種接続・マルチ入力 MUX 合成＆往復テストを追加（合計 9 ファイル 62 テスト）。

## 2026-11-26 — v0.7-r0.0 HDL インポート大幅強化（テストベンチ・非合成文無視・always/always_ff 合成・タブ制御・重なりゼロ自動レイアウト）

### 実施内容

1. **ポートなしモジュール対応** (`src/core/hdl.ts`):
   - `module tb; ... endmodule` のようにポートリスト `(...)` が省略されたテストベンチ等のモジュール定義を正しく解析可能に。
2. **`assert` 誤解釈バグ修正 & 非合成文の自動無視** (`src/core/hdl.ts`):
   - インスタンス化正規表現でモジュール名とインスタンス名の間に必須空白（または `#(...)`）を要求するよう修正し、`assert(...)` が `asser` モジュールとして誤認識される不具合を根絶。
   - `assert` / `assume` / `cover` / `initial` / `final` / `task` / `function` / `property` / `sequence` / `$display` / `$finish` 等のシステムタスク / `` `timescale `` 等プリプロセッサ指令 / `typedef` / `import` を論理合成対象から安全に除外。
3. **`always` / `always_ff` / `always_comb` の論理合成対応** (`src/core/hdl.ts`):
   - `always_ff @(posedge clk [or posedge/negedge rst_n])` のリセット（Active-High / Active-Low 自動判定＋反転ゲート挿入）・イネーブル (`if (en)`)・自己フィードバック加算 (`count <= count + 1`) を `D_FF` / `REGISTER` へ論理合成。
   - `always_comb` / `always @(*)` の `if / else` および `case ... endcase` を `MUX` ツリーへ論理合成。
4. **サブモジュール・仮モジュールのタブ自動オープン抑止** (`src/core/types.ts`, `src/store/useProjectStore.ts`, `src/components/TopBar.tsx`, `src/core/samples.ts`):
   - `ProjectDocument.openTabIds` を導入し、HDL インポート時はトップモジュールのみタブを開くように変更。サブモジュールはダブルクリックや「内部回路を開く」でユーザーが明示的に開いたときのみタブ表示（仮モジュール Stub は中身がないためタブを開かず通知）。
5. **重なりゼロの階層トポロジカル自動レイアウト** (`src/core/hdl.ts`):
   - 依存グラフに基づく列割り当て（Sugiyama 風レイヤリング＋順序回路フィードバック辺の分離）、重心法（Barycenter）による交差最小化ソート、各コンポーネントの実バウンディングボックスに基づく配置計算により、パーツの重なりゼロ・見やすい配線チャネルで初期配置。
6. **テスト拡充** (`tests/hdl_advanced.test.ts`): 全 6 項目の自動テスト（合計 9 ファイル 57 テスト）を追加。

## 2026-11-26 — v0.6-r1.0 カタログ・配線・ヒット判定・複合回路・HDL エッジケースのテスト大幅拡充

### 実施内容

- テストスイートを **5 ファイル 35 テスト → 8 ファイル 52 テスト** へ拡充:
  - `tests/catalog_routing_hittest.test.ts` (8 テスト): 全コンポーネントのピン/サイズ/回転不変条件、4 辺カスタム `ModuleSymbolConfig` 配置、平行ワイヤーの重なりゼロ検証、非接続交差と T 字接続の判別、自由配線ドラッグ・長距離フォールバック、回転ピン・Z 順・ハンドル・逆方向マーキーのヒットテストを追加。
  - `tests/complex_circuits.test.ts` (6 テスト): 符号付き/16進/2進/32bit フォーマット、SPLITTER + 4×FULL_ADDER 構成の 4bit リップルキャリー加算器（256 通り完全網羅）、4 段シフトレジスタ＋非同期リセット、T 字接続の電気的伝搬、3 階層ネストサブ回路＆自己再帰モジュール保護、122 ゲート事前コンパイル回路の 50 クロック連続負荷テストを追加。
  - `tests/hdl_edge_cases.test.ts` (3 テスト): インラインコメント・アンダースコア付きリテラル (`8'b1010_0101`)・パラメータ除算 (`HALF = N / 2`)・深い括弧ネスト、同一外部未定義モジュールの複数インスタンス化時の Stub 共有、日本語/記号入りモジュール名のサニタイズ＆`TUNNEL` 配線を含む Verilog ラウンドトリップテストを追加。

## 2026-11-26 — v0.6-r0.1 バージョン管理方式を `vx.y-rz.w` へ移行

### 実施内容

- バージョン管理ルールを従来の SemVer から 4 ステータス形式 `vx.y-rz.w` へ移行し、過去の作業履歴を整理・再採番。

## 2026-11-26 — v0.6-r0.0 パレットからのドラッグ時リアルタイムシンボルプレビュー対応

### 実施内容

- **ドラッグ中のシンボル表示** (`src/canvas/renderer.ts`, `src/components/ComponentPalette.tsx`, `src/components/CircuitCanvas.tsx`, `src/App.tsx`):
  - パレットからゲート・カスタムモジュールをドラッグする際、ブラウザ標準の一覧行ゴーストを非表示にし、実際の論理ゲート／モジュールシンボル（ピン配置・モジュール内部プレビュー含む）がカーソルに追従するように改善。
  - キャンバス領域に入ると、現在のズーム倍率・グリッドスナップ位置に合わせた配置ゴーストと位置合わせクロスヘアがキャンバス上に直接描画され、ドロップ前にサイズ・端子位置を正確に確認できるようにしました。

## 2026-11-26 — v0.5-r1.0 `useProjectStore` 重複宣言修正 & StrictMode 安全化

### 実施内容

- `src/store/useProjectStore.ts` の `flushRuntimeInputsToProject` / `setManualSimRunning` 重複定義を解消。
- `setManualSimRunning` 内の `setProject` 呼び出しを状態アップデータ外へ移動し、React StrictMode 環境でも安全に動作するよう整理。

## 2026-11-26 — v0.5-r0.0 編集モード中のスイッチ状態表示・ボタン押下アニメーション対応

### 実施内容

- **編集モードでも ON スイッチを視認・操作可能に** (`src/canvas/renderer.ts`, `src/store/useProjectStore.ts`, `src/components/CircuitCanvas.tsx`):
  - 編集モード（シミュレーション停止中）でも、`TOGGLE` / `MODULE_IN` / `CLOCK` の現在状態を反映し、ON のスイッチはノブが右にスライド＋淡い緑色で表示（ライブ実行中の鮮やかな発光緑と視覚的に区別）。
  - 実行モード中に操作したスイッチ/クロック状態は、編集モードへ戻った際にも自動引き継ぎされるように改善。
  - 編集中にスイッチをクリックするとシミュレーションを走らせずに ON/OFF のみ切り替わり、ボタン押下時もシミュレーションを動かさず押し込みアニメーションのみ反応するよう対応。

## 2026-11-26 — v0.4-r0.0 編集/実行分離モードの厳密ロック化 & ネットリスト事前コンパイル高速化

### 実施内容

- **事前コンパイル (`compileCircuit` / `simulateCompiledCircuit`)** (`src/core/simulator.ts`):
  - ネットリストグラフ（Union-Find・ピンテーブル・ネストされたサブ回路）を 1 回だけ事前コンパイルして再利用する構造へ刷新。
  - `runtimeInputs` オーバーライド機構を導入し、クロック発振・ボタン押下・実行モード中のスイッチ切替で `ProjectDocument` 全体のディープコピー (`JSON.stringify/parse`) や `localStorage` 書込・ネットリスト再構築を完全に排除。
- **編集/実行分離モードの厳密な編集ロック** (`src/store/useProjectStore.ts`, `src/components/*`):
  - 編集/実行分離モードで「実行開始」すると回路構造の編集をロック（パレット・キャンバス上の配線/ドラッグ・削除・Undo/Redo をロックし、スイッチ/ボタン/クロック操作と信号観測のみ有効）。
  - 実行中バナー（緑）および `RUN (COMPILED)` ステータス表示を追加し、「実行中（編集に戻る）」で即座に編集モードへ復帰可能に。
- **テスト追加** (`tests/logic_correctness.test.ts`): 事前コンパイル実行＋`runtimeInputs` による非破壊クロック進行テストを追加。

## 2026-11-26 — v0.3-r0.0 トラックパッド二本指移動・キャンバス内ピンチズーム & 操作デバイス切替対応

### 実施内容

- **キャンバス限定ピンチズーム & 二本指パン** (`src/components/CircuitCanvas.tsx`, `src/styles.css`):
  - `<canvas>` にネイティブ `{ passive: false }` の `wheel` / `gesturestart` / `gesturechange` / 2本指 `touch` リスナーを登録し、キャンバス内でのピンチ操作 (`ctrlKey` 付き `wheel`) 時にブラウザ全体の拡大縮小を抑止してキャンバスのみ拡大縮小するよう改善（キャンバス外ではブラウザ標準の拡大縮小がそのまま機能）。
  - トラックパッド二本指の上下左右スクロールで直接キャンバスを移動できるように対応。
- **操作モード切替 UI (`自動 / トラックパッド / マウス`)** (`src/core/types.ts`, `src/components/CircuitCanvas.tsx`):
  - キャンバス下部ステータスバーに 1 クリックで切り替えられる 3 モードトグルを追加（プロジェクト設定へ自動保存）。

## 2026-11-26 — v0.2-r2.0 Vite+ (`vite-plus`) 導入・統合ツールチェーン移行

### 実施内容

- **Vite+ (`vite-plus@1.8.0`) 導入**:
  - `vp migrate` により `vite` を `@voidzero-dev/vite-plus-core` (Vite 8 + Rolldown 1.2) へ統合し、`@vitejs/plugin-react` を v6.3.0 へアップグレード（依存脆弱性 0 件）。
  - `vite.config.ts` を `vite-plus` からの `defineConfig` に一本化し、`test` (Vitest 5)・`lint` (Oxlint type-aware)・`fmt` (Oxfmt、`docs/main.md` 除外) の設定を統合。
  - `package.json` の各スクリプトを `vp dev` / `vp build` / `vp preview` / `vp check` / `vp lint` / `vp fmt` / `vp test run` に統一。
- **Oxlint 指摘のコード品質改善**:
  - `src/core/hdl.ts`: パラメータ定数評価 (`evalParamExpr`) から `Function` コンストラクタを排除し、安全な再帰下降式パーサに置換。
  - `src/App.tsx`, `src/components/Modals.tsx`: Floating Promise 警告を解消。
  - `src/canvas/renderer.ts`: 未使用変数・インポートを除去。

## 2026-11-26 — v0.2-r1.0 Vitest テスト拡充 & HDL 合成/シミュレータのバグ修正

### テストスイート拡充（全 5 ファイル / 34 テストケース）

- `tests/logic_correctness.test.ts`: 全基本ゲート 4値真理値表（4×4完全網羅）、多入力ゲート（16通り）、MUX/DEMUX/DECODER/ADDER/COMPARATOR、D-FF/JK-FF/T-FF/SRラッチ/Dラッチ/RAM(OE=0→Z)、トンネル接続、発振ループ検出、同一サブ回路複数インスタンスの状態分離テストを追加。
- `tests/hdl_verilog.test.ts`: Verilog-1995 非ANSI / Verilog-2001 ANSI、全8プリミティブ、演算子優先順位・括弧・単項否定・XNOR・入れ子三項MUX、逆順宣言・パススルー・ファンアウト・4値定数、マルチビット比較・連結加算 `{cout, sum} = a + b + cin`、階層モジュール（top先頭/末尾両方・定数ポート結合）の構文解析・合成・シミュレーション検証を追加。
- `tests/hdl_systemverilog.test.ts`: パラメータ化 SV モジュール (`#(parameter WIDTH = 4)` / `localparam`)、`logic` 宣言時初期化、暗黙 `.name` 接続、`always_comb` 展開、`always_ff` 警告耐性、トライステート構文 (`en ? d : 1'bz`)、外部未定義モジュールの仮 Stub 自動生成テストを追加。
- `tests/hdl_roundtrip.test.ts`: 回路 → Verilog エクスポート → 再インポート → 全入力ベクトル真理値表一致検証（FullAdder / 4:1 MUX + パススルー + ファンアウト / Tri-state + 4bit Adder / 階層2bit加算器）、JSON Netlist / DOT Graph / `.lcirc.json` 永続化検証を追加。

### テストによって発見・修正した不具合

1. **配線通過時の意図しないピン短絡バグ修正** (`src/core/simulator.ts`, `src/core/routing.ts`):
   - `buildNetGraph()` で他ゲート付近を通過する明示接続ワイヤーが近傍の無関係ピンを短絡して `X` を発生させる問題を修正（自由端点のみ T 字接続判定し、ルータのゲート障害物マージンも拡大）。
2. **クロック駆動サブ回路の 1 ティック遅延 & 発振ネット `X` 確定バグ修正** (`src/core/simulator.ts`):
   - 親回路の `commitSequential` 内でサブ回路の順序状態が更新された際、親回路の出力ネットを再評価していなかった不具合を修正。
   - 発振検出時に `netValues` 上書き後の差分比較になっており発振ネットが `X` に確定されなかった不具合を修正。
3. **HDL パーサ・合成・エクスポータ強化** (`src/core/hdl.ts`):
   - `always_ff ... begin ... end` の除去正規表現が最初の `;` で止まり後続の `assign` を巻き込んでいた不具合を修正。
   - `#(parameter ...)` / `localparam` 幅計算、`{cout, sum} = a + b + cin` 連結加算、`==`/`!=`/`<`/`>` 比較、`~^`/`^~`/`&&`/`||`、トライステート構文、`always_comb` 簡易展開、出力ポートエイリアス `assign` 出力、4:1/8:1 MUX エクスポートに対応。

## 2026-11-26 — v0.2-r0.1 クロック周波数入力欄の表示幅修正

### 実施内容

- ツールバーのクロック周波数入力欄 (`.hz-control input`) の幅を `38px` → `64px` へ拡張し、3 桁以上（例: `100`, `1000`, `12.5`）の入力時も見切れないように修正。
- 周波数入力の許容範囲も `0.1〜1000 Hz` に拡張。

## 2026-11-26 — v0.2-r0.0 配線の角丸化と手動経路調整機能の追加

### 実施内容

1. **配線の角丸（フィレット）描画** (`src/canvas/renderer.ts`):
   - `traceRoundedWirePath()` を実装し、すべてのワイヤー（通常配線・選択ハイライト・配線プレビュー・モジュール内部のライブ配線）の折れ曲がり角を滑らかな角丸で描画。
   - 非接続交差のブリッジ円弧と角丸が干渉しないようセグメント端のトリム半径を自動クランプ。
2. **配線のドラッグ手動調整 & 自動再レイアウト連携** (`src/core/routing.ts`, `src/canvas/hitTest.ts`, `src/components/CircuitCanvas.tsx`):
   - ワイヤーの水平/垂直線分をそのままドラッグして上下・左右にスライド調整可能に（端点ピンに接続する線分をドラッグした場合も自動で直交スタブを挿入してピン接続を維持）。
   - 選択中ワイヤーに角ハンドルと線分中点ハンドルを表示し、カーソル形状も `ns-resize` / `ew-resize` / `move` に動的に切替。
   - 手動調整後に接続先コンポーネントを移動した場合は、従来どおり `rerouteWiresForGates()` により自動で綺麗に再レイアウト。右クリックメニュー・インスペクタから単一ワイヤーの手動再レイアウト実行も可能に。
3. **テスト・ドキュメント更新**:
   - `tests/engine.test.ts` に手動線分ドラッグ・角ドラッグ・パーツ移動後自動再レイアウトのテストを追加。
   - `docs/features.md`, `docs/architecture.md`, `docs/changelog.md` を更新。

## 2026-11-26 — v0.1-r0.0 初期実装

### 実施内容

1. **プロジェクト基盤構築**:
   - Vite + React 19 + TypeScript + HTML5 Canvas 2D + Vitest の構成をセットアップ。
   - Cloudflare Workers Static Assets デプロイ設定 (`wrangler.jsonc`) を追加。
2. **4値論理シミュレーションエンジン (`src/core/`)**:
   - `logic4.ts`: IEEE 1364 準拠の 4 値信号 (`0`, `1`, `X`, `Z`)、マルチビット演算、マルチドライバ衝突解決 (`0`+`1`→`X`, 浮遊→`Z`) を実装。
   - `catalog.ts`: I/O、基本ゲート、組み合わせ回路 (MUX/DEMUX/DEC/HA/FA/ADD/CMP)、順序回路 (SR/Dラッチ、D/JK/T-FF、レジスタ、カウンタ)、RAM/ROM、トンネル、スプリッタ、SV 風 `IFACE_BUNDLE`、カスタムモジュールを定義。
   - `simulator.ts`: デルタサイクル収束・発振保護・階層サブ回路の独立状態管理・ライブスナップショット取得を実装。
3. **配線ルータ & HDL 連携 (`src/core/routing.ts`, `src/core/hdl.ts`)**:
   - グリッドフィット用の障害物・重なり回避 A* 直交ルータおよび自由配線モードを実装。
   - 非接続交差のブリッジ円弧描画、T 字接続のハンダ点検出を実装。
   - Verilog / SystemVerilog インポータ（未定義外部モジュールの仮 Stub 自動生成付き）および Verilog / JSON / DOT ネットリストエクスポータを実装。
4. **モダン GUI エディタ (`src/canvas/`, `src/components/`, `src/store/`)**:
   - リアルタイム 4 値発光キャンバス描画、Digital 風モジュール内部表示（箱 / 中身のみ / 中身＋リアルタイム色）を実装。
   - 編集/実行分離モード、Undo/Redo、コピー/ペースト/複製、右クリックコンテキストメニュー、シンボル定義エディタ、RAM/ROM HEX エディタ、`.lcirc.json` 保存/読込および外部モジュール読込を実装。
   - 初期体験用の 3 タブ構成サンプルプロジェクト（`2bit_Adder_Live`, `FullAdder`, `4State_Bus_RAM`）を同梱。
5. **ドキュメント・テスト整備**:
   - `docs/architecture.md`, `docs/features.md`, `docs/changelog.md` を作成。
   - `tests/engine.test.ts` に 4 値論理・階層シミュレーション・Tri-state バス・カウンタ/ROM・SV Interface・A* ルーティング・Verilog Import/Export の自動テストを追加。
