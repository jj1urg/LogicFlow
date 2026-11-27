---
type: architecture
title: LogicFlow アーキテクチャ設計書
description: 技術選定、ディレクトリ構成、4 値論理シミュレーションエンジン、A* ルータ、Cloudflare Workers デプロイ構成
tags: [architecture, simulator, routing, canvas, hdl, cloudflare-workers]
generated:
  by: agent/antigravity
  at: 2026-11-27T15:08:00+09:00
---

# LogicFlow アーキテクチャ設計書

## 1. 技術選定と構成方針

ターゲット環境が **Linux および Web（Cloudflare Workers デプロイ想定）** であり、かつリアルタイムな 4 値信号シミュレーション・スムーズな拡大縮小・モジュール内部のライブ可視化を実現するため、以下のアーキテクチャを採用しました。

| レイヤー                 | 採用技術                                            | 採用理由                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ツールチェーン           | **Vite+ (`vite-plus` / `vp`)**                      | Vite 8 (Rolldown) + Vitest 5 + Oxlint + Oxfmt を単一 CLI (`vp`) と単一設定 (`vite.config.ts`) に統合し、高速ビルド・型チェック付きリント・フォーマット・テストを実現     |
| フロントエンド UI        | React 19 + TypeScript                               | モダンなダークテーマ IDE 体験、高速な HMR、静的バンドルとして Cloudflare Workers へ即デプロイ可能                                                                        |
| 回路描画エンジン         | HTML5 Canvas 2D (High-DPI 対応)                     | 数百〜数千ノードでも DOM オーバーヘッドなしで 60fps 描画、IEEE 論理ゲート記号、ワイヤー発光・ブリッジ円弧、モジュール内部のライブ縮小描画を柔軟に実装可能                |
| シミュレーションエンジン | Pure TypeScript (`src/core/`)                       | DOM 非依存でユニットテストが容易。将来的に超大規模回路向けに **Rust + WebAssembly (WASM)** カーネルへ差し替える際も `simulateCircuit()` の入出力契約を保ったまま置換可能 |
| デプロイ構成             | Cloudflare Workers Static Assets (`wrangler.jsonc`) | `npm run build` (`vp build`) の出力 `dist/` をそのままエッジ配信可能。Linux ローカルでは Vite+ サーバまたはビルド済み Web アプリとして動作                               |

## 2. ディレクトリ構成

```text
LogicFlow/
├── README.md                   # 公開用トップページ・操作概要
├── CHANGELOG.md                # 変更履歴（vx.y-rz.w）
├── LICENSE                     # MIT License
├── AGENTS.md                   # AI エージェント向け開発ガイドライン
├── docs/                       # Open Knowledge Format (OKF) ナレッジバンドル
│   ├── index.md                # OKF 目次（エントリポイント）
│   ├── architecture.md         # 本ドキュメント（アーキテクチャ設計）
│   ├── features.md             # 機能仕様・コンポーネント一覧・ショートカット
│   ├── versioning.md           # バージョン管理 (vx.y-rz.w) & jj 運用ルール
│   ├── main.md                 # [人間専用] 初期要件定義書
│   ├── memo.md                 # [人間専用] 人間のメモ・改善案
│   ├── assets/                 # スクリーンショット等の画像アセット
│   └── test_hdl/               # テスト用 SystemVerilog サンプル（TD4 CPU 等）
├── src/
│   ├── core/                   # DOM 非依存の純粋ロジック層（将来 WASM 置換対象）
│   │   ├── logic4.ts           # IEEE 1364 準拠の 4値論理演算 (0, 1, X, Z) & バス解決
│   │   ├── types.ts            # プロジェクト・回路・ゲート・ワイヤー・スナップショット型定義
│   │   ├── catalog.ts          # 全コンポーネント定義・動的ピン配置・バウンディング計算
│   │   ├── simulator.ts        # 階層対応 4値論理シミュレータ (順序回路状態分離・事前コンパイル)
│   │   ├── routing.ts          # 障害物・ワイヤー重なり回避 A* 直交ルータ & 自由配線
│   │   ├── hdl.ts              # Verilog/SystemVerilog インポータ (Stub 生成) & ネットリスト出力
│   │   └── samples.ts          # 初期サンプルプロジェクト（2bit加算器 / 4値バス / カウンタ）
│   ├── canvas/                 # Canvas 2D 描画・ヒットテスト層
│   │   ├── hitTest.ts          # ワールド座標変換、ピン/ゲート/ワイヤー/矩形ヒット判定
│   │   └── renderer.ts         # 4値発光ワイヤー、ゲート記号、Digital風モジュール内部ライブ描画
│   ├── store/
│   │   └── useProjectStore.ts  # Undo/Redo、LocalStorage自動保存、クリップボード、実行モード管理
│   ├── components/             # UI クローム層
│   │   ├── TopBar.tsx          # ツールバー・タブ・クロック制御・ファイル/HDL操作
│   │   ├── ComponentPalette.tsx # 検索付きカテゴリ別パーツパレット & HDL プロジェクトツリー
│   │   ├── CircuitCanvas.tsx   # ドラッグ・配線・ズームパン制御キャンバス
│   │   ├── HdlDockPanel.tsx    # ドッキング型 HDL ソースビューア・エディタ・再論理合成パネル
│   │   ├── InspectorPanel.tsx  # 選択要素のプロパティ・リアルタイム信号表示
│   │   ├── ContextMenu.tsx     # コンテキストに応じた右クリックメニュー
│   │   └── Modals.tsx          # HDL読込 / ネットリスト出力 / シンボル編集 / HEXエディタ
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── tests/                      # Vitest ユニット・結合テスト群
├── wrangler.jsonc              # Cloudflare Workers 静的アセット配信設定
├── vite.config.ts              # Vite+ 統合設定（ビルド / テスト / リント / フォーマット）
└── package.json
```

## 3. 4値論理シミュレーションエンジン (`src/core/simulator.ts`)

1. **ネット接続解決 (Union-Find)**:
   - ワイヤーの始点/終点ピン参照、同一座標上の端子・端点、他ワイヤーへの T 字接続（T-Junction）、同一名のネットラベル (`wire.netLabel`) および `TUNNEL` ゲートをすべて統合して等電位ネットを構築します。
2. **マルチドライバ バス解決 (`resolveValues`)**:
   - 複数ドライバが接続されたネットでは、`Z` は他ドライバに譲り、`0` と `1` が衝突した場合は自動的に `X`（赤色）になります。ドライバが存在しない浮遊ネットは `Z`（青色）になります。
3. **デルタサイクル収束と発振保護**:
   - 組み合わせ論理を最大 48 デルタサイクルまで反復評価して安定化します。リング発振などの非収束ループを検出した場合はハングせず該当ネットを `X` に確定し UI へ警告を出します。
4. **階層サブ回路と独立状態 (`SequentialState`)**:
   - 各 `SUBCIRCUIT` インスタンスごとに独立した `SequentialState`（FF/レジスタ/RAM の状態）と `SimulationSnapshot` を保持するため、同一モジュールを複数配置しても状態が干渉せず、かつ Digital 風の **中身ライブ表示** でインスタンスごとに異なる内部信号色を描画できます。

## 4. ワイヤー重なり回避ルータ (`src/core/routing.ts`)

- **グリッドフィットモード (`grid`)**: 20px グリッド上で探索コスト付きの A* ルーティングを実行します。
  - ゲート内部セルへの侵入に高コスト (+40)
  - 既存ワイヤーと平行に重なるセグメントに高コスト (+18)
  - 折れ曲がり（コーナー）に小コスト (+0.65)
  - これにより、ワイヤー同士が重ならずゲートを避けた見やすい直交配線が自動生成されます。
- **自由配線モード (`free`)**: 任意の角度・経由点（空き領域クリック）で自在に配線できます。
- **手動配線調整 & 再レイアウト連携**: ワイヤーの水平/垂直線分および中間角ハンドルを直接ドラッグして経路調整できます（端点ピンは固定のまま直交スタブを自動挿入）。調整後に接続先コンポーネントを移動すると `rerouteWiresForGates()` により自動的に再レイアウトされます。
- **角丸フィレット・交差ブリッジ円弧・T 字接続点**: すべてのワイヤー屈折部を半径クランプ付き 2 次ベジェ曲線 (`traceRoundedWirePath`) で角丸描画し、近接・重なり時の追従性を向上。非接続の直交交差にはブリッジ円弧（ホップ）を、電気的に接続された T 字合流点には信号色のハンダ点を描画します。

## 5. Cloudflare Workers デプロイ手順

```bash
npm run build
npx wrangler deploy
```

`wrangler.jsonc` に `assets.directory = "./dist"` と SPA フォールバックが設定済みのため、そのままデプロイできます。
