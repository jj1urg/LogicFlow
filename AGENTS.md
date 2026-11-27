# AGENTS.md — LogicFlow 開発ガイドライン

このファイルは、LogicFlow リポジトリで作業する AI エージェントおよび開発者向けの共通ルールを定義します。

---

## 1. ナレッジ参照（Open Knowledge Format）

- 本リポジトリのドキュメントは `docs/` ディレクトリを **Open Knowledge Format (OKF)** の Knowledge Bundle として構造化しています。
- 仕様や設計を確認する際は、まず [`docs/index.md`](./docs/index.md) を読み込み、必要なコンセプトドキュメント（[`docs/scope.md`](./docs/scope.md), [`docs/architecture.md`](./docs/architecture.md), [`docs/features.md`](./docs/features.md), [`docs/versioning.md`](./docs/versioning.md) 等）へ辿ってください。
- 機能追加や提案を行う際は、[`docs/scope.md`](./docs/scope.md) に定義された **非ゴール（やらないこと）** を尊重し、過剰な複雑化を避けてください。
- `docs/` 配下に新しいドキュメントを追加する場合は、OKF に従い YAML フロントマター（最低限 `type`、推奨として `title`, `description`, `tags`, `generated`）を付与し、`docs/index.md` へ登録してください。

---

## 2. 人間専用ファイルの保護（厳守）

以下の 2 ファイルは **人間（プロジェクトオーナー）が直接記述・管理する専用ファイル** です：

- `docs/main.md`（初期要件定義書）
- `docs/memo.md`（人間の改善メモ・タスクメモ）

**ルール:**

- AI エージェントは上記 2 ファイルを **読み取ることは自由** ですが、**ユーザーから明示的な編集指示がない限り、内容の変更・追記・削除・自動フォーマットを一切行ってはいけません**。
- これらのファイルは `vite.config.ts` の `fmt.ignorePatterns` にも登録されています。除外設定を削除しないでください。

---

## 3. バージョン管理 & VCS 運用

詳細なルールは [`docs/versioning.md`](./docs/versioning.md) を参照してください。

- 本プロジェクトでは独自バージョニング形式 **`vx.y-rz.w`** を採用しています。
  - `x`: 破壊的変更 (`1` 以上で適用、`0` は初期開発フェーズ)
  - `y`: 機能追加 (Feature)
  - `z`: 内部ロジック刷新・バグ修正・最適化・テスト拡充
  - `w`: 非ロジック更新（ドキュメント・設定・フォーマット・開発管理のみ）
  - 上位の桁が上がったら下位の桁は `0` にリセットします。
- `package.json` の `version` は SemVer 互換の **`x.y.0-rz.w`** 形式で同期します。
- バージョン番号とルート [`CHANGELOG.md`](./CHANGELOG.md) の更新は、**1 つのタスク／修正・機能追加のまとまりが完了したタイミング** で行います。
- コミットメッセージ／`jj describe` は `:絵文字: プレフィックス: 要約` 形式（`wip`, `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `style`, `release`）に従います（一覧は [`docs/versioning.md`](./docs/versioning.md) を参照）。
- VCS は Git と **Jujutsu (`jj`)** の共存（colocated）リポジトリとして運用しています。ブランチ／ブックマークは `develop` を通常の開発ライン、`main` をリリースラインとします。`jj` では bookmark が自動追従しないため、節目・push 時に明示的に更新します。

---

## 4. 開発・検証コマンド

本プロジェクトはツールチェーンとして **Vite+ (`vp`)** を使用しています。コード変更後は以下で検証してください：

```bash
npm test        # vp test run（ユニット・結合テスト）
npm run check   # vp check（型チェック付きリント・フォーマット確認）
npm run build   # vp build（プロダクションビルド確認）
```

---

## 5. 設計上の重要原則

- `src/core/` は **DOM 非依存の純粋な TypeScript** に保ちます（将来の Rust + WASM 置換を想定）。ブラウザ API や React への依存を持ち込まないでください。
- 仕様変更やコンポーネント・UI 挙動の変更を行った場合は、実装とあわせて `docs/features.md` / `docs/architecture.md` / `CHANGELOG.md` を最新状態に保ってください。
