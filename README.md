# GitHub Stars to Notion

GitHubでStarをつけたリポジトリを、GitHub Actionsから定期的にNotionデータベースへ同期するプロジェクトです。

## 現在の状態

企画・Issue作成段階です。同期スクリプトとGitHub Actionsはまだ実装していません。
MVPを先に実装し、その後にタグ・ラベル分類、Cloudflare Workers AIによる概要生成を追加します。

## MVP

- 対象ユーザーの公開Star一覧をページネーション込みで取得する。
- 毎日1回の定期実行と、`workflow_dispatch`による手動実行に対応する。
- Notionへリポジトリ名、URL、説明、GitHubリポジトリID、Star登録日時を保存する。
- GitHubリポジトリIDを照合して作成・更新し、再実行やリポジトリの改名でも重複させない。
- 実行を直列化し、途中失敗後の再実行にも対応する。
- Notionの手入力メモ・分類は保持する。Star解除による削除はMVPでは行わない。
- 作成・更新・スキップ・失敗の件数をActionsの実行サマリーに表示する。

同期方式はGitHubからNotionへの一方向とし、MVPでは公開リポジトリを対象にします。
実装言語やライブラリは実装時に決定します。

## 設定案

実装時に以下の設定を用意します。現時点では設定しても同期は実行されません。

| 種類 | 名前 | 用途 |
| --- | --- | --- |
| Actions Variable | `GITHUB_STAR_USER` | Star一覧を取得するユーザー。初期利用者は`UtakataKyosui` |
| Actions Variable | `NOTION_DATA_SOURCE_ID` | 同期先データソースのID |
| Actions Secret | `NOTION_TOKEN` | 同期先へのアクセスを許可したNotion integrationのトークン |

GitHub APIにはActions標準の`GITHUB_TOKEN`を利用する方針です。個人アカウントの認証済みStar一覧を取得するトークンとは区別し、公開Star一覧を利用します。
Notion integrationの接続、必要なプロパティ、APIバージョン、実行方法はMVP実装で文書化します。
トークンや実データはコミットしません。

## ロードマップ

1. **MVP** — 定期同期・重複防止・再実行・セットアップ手順。
2. **タグ・ラベル分類** — GitHub Topicsと利用者が管理する分類を分けて保存。
3. **AI概要生成** — Cloudflare Workers AIで日本語の概要を作成し、Notionへ保存。

AI機能は任意設定とし、未設定でもMVPの同期を利用できる構成にします。

## 運用上の注意

定期実行はデフォルトブランチで行い、混雑時には遅延する可能性があります。
公開リポジトリでは60日間リポジトリの活動がないと定期実行が自動停止するため、再有効化の手順も実装時に案内します。

## 公式資料

- [GitHub: Star一覧API](https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-a-user)
- [GitHub: scheduleイベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Notion: データソースのクエリ](https://developers.notion.com/reference/query-a-data-source)
- [Cloudflare Workers AI: REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
