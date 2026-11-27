---
type: index
title: LogicFlow Knowledge Index
description: LogicFlow プロジェクトの設計・機能仕様・運用ルールを束ねる OKF ナレッジインデックス
tags: [index, okf, logicflow]
generated:
  by: agent/antigravity
  at: 2026-11-27T15:08:00+09:00
---

# LogicFlow Knowledge Index

この `docs/` ディレクトリは、**Open Knowledge Format (OKF)** に準拠した LogicFlow の Knowledge Bundle です。人間と AI エージェントの双方が、必要なコンテキストへ段階的に辿れるように構成しています。

---

## コンセプトドキュメント一覧

| ファイル                             | `type`          | 概要                                                                                   |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md) | `architecture`  | 技術選定、ディレクトリ構成、4 値シミュレータ、A* ルータ、デプロイ構成                  |
| [features.md](./features.md)         | `specification` | 基本操作、4 値信号色定義、実行モード、搭載コンポーネント一覧、HDL 連携、ショートカット |
| [versioning.md](./versioning.md)     | `policy`        | 独自バージョニング `vx.y-rz.w`、SemVer/`package.json` 整合、Jujutsu (`jj`) 運用ルール  |

---

## 人間専用ドキュメント（AI 編集禁止）

以下のファイルはプロジェクトオーナーが直接記述・管理する一次メモです。AI エージェントは参照のみ行い、明示的な指示なしに編集・フォーマットしないでください。

- [main.md](./main.md) — 初期要件定義書
- [memo.md](./memo.md) — 改善案・不具合・開発管理メモ

---

## 関連リソース

- **ルートドキュメント**:
  - [README.md](../README.md) — プロジェクト紹介・操作方法・クイックスタート
  - [CHANGELOG.md](../CHANGELOG.md) — バージョン別の変更履歴
  - [AGENTS.md](../AGENTS.md) — AI エージェント向け共通ガイドライン
  - [LICENSE](../LICENSE) — MIT License (Copyright (c) 2026 JJ1URG)
- **アセット / サンプル**:
  - `assets/` — README やドキュメント用のスクリーンショット配置ディレクトリ
  - `test_hdl/` — テスト・検証用の SystemVerilog サンプル群（TD4 CPU 7 ファイル構成）

---

## OKF 記述規約（新規ドキュメント追加時）

`docs/` に新しいナレッジを追加する場合は、以下の最小ルールに従ってください：

1. **1 ファイル = 1 コンセプト** とし、先頭に YAML フロントマターを配置する。
2. 必須フィールドは `type`（例: `architecture`, `specification`, `policy`, `guide`, `decision`, `reference`）。
3. 推奨フィールドとして `title`, `description`, `tags`, `generated`（`by`, `at`）を付与する。
4. ファイル間の関連は通常の相対 Markdown リンクで結び、本 `index.md` にエントリを追加する。
