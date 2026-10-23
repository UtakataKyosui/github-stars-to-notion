# GitHub Stars to Notion

GitHubでStarをつけたリポジトリを、GitHub Actionsから定期的にNotionデータベースへ同期するプロジェクトです。

## 現在の状態

MVPの同期スクリプト、定期・手動実行のGitHub Actions、自動テストを実装しています。
利用には、NotionのデータベースとGitHub Actionsの設定が必要です。
タグ・ラベル分類、Cloudflare Workers AIによる概要生成は後続対応です。

## MVP

- 対象ユーザーの公開Star一覧をページネーション込みで取得する。
- 毎日1回の定期実行と、`workflow_dispatch`による手動実行に対応する。
- Notionへリポジトリ名、URL、説明、GitHubリポジトリID、Star登録日時を保存する。
- GitHubリポジトリIDを照合して作成・更新し、再実行やリポジトリの改名でも重複させない。
- 実行を直列化し、途中失敗後の再実行にも対応する。
- Notionの手入力メモ・分類は保持する。Star解除による削除はMVPでは行わない。
- 作成・更新・スキップ・失敗の件数をActionsの実行サマリーに表示する。

同期方式はGitHubからNotionへの一方向とし、MVPでは公開リポジトリを対象にします。
Node.js 24の標準機能のみを使用します。追加のnpmパッケージやインストール処理は不要です。

## セットアップ

### 1. Notionを準備する

1. Notionの[Integrations](https://www.notion.so/profile/integrations)でinternal integrationを作成し、Read / Insert / Update contentを許可します。
2. 同期専用のデータベースを作成し、下表のプロパティを正確な名前・型で用意します。既存のタイトル列は`Name`に変更します。
3. データベースの接続メニューからintegrationを接続し、アクセスを許可します。
4. 同期先の**データソースID**を取得します。データベースIDやビューIDとは異なります。IDを確認するには[Retrieve a database](https://developers.notion.com/reference/retrieve-a-database)の`data_sources`から対象の`id`を選択できます。APIの`Notion-Version`には`2025-09-03`を指定します。複数データソースがある場合は同期先を1つ選びます。

| プロパティ名 | Notionの型 | 用途 |
| --- | --- | --- |
| `Name` | タイトル | `owner/repository` |
| `Repository ID` | テキスト | GitHubの数値リポジトリIDを文字列で保存する照合キー |
| `URL` | URL | GitHubのリポジトリURL |
| `Description` | テキスト | GitHubの説明。説明なしの場合は空欄 |
| `Starred At` | 日付 | Starをつけた日時 |

`Repository ID`にNotionの「ID」型や数値型を使用しないでください。
メモ・タグ・分類用の列やページ本文は自由に追加できます。上記5列のみが同期対象です。
手動で作成した行は`Repository ID`を空欄にすれば同期対象になりません。

### 2. GitHub Actionsを設定する

このコードを利用するリポジトリの **Settings → Secrets and variables → Actions** に設定します。

| 種類 | 名前 | 用途 |
| --- | --- | --- |
| Actions Variable | `STAR_USER` | Star一覧を取得するユーザー。例：`UtakataKyosui` |
| Actions Variable | `NOTION_DATA_SOURCE_ID` | 同期先データソースのID |
| Actions Secret | `NOTION_TOKEN` | 同期先へのアクセスを許可したNotion integrationのトークン |

GitHubのConfiguration Variableでは`GITHUB_`で始まる名前が予約されているため、設定名は`STAR_USER`とします。Workflow内でスクリプトの環境変数`GITHUB_STAR_USER`に渡します。

GitHub APIにはActions標準の`GITHUB_TOKEN`を渡すため、個人用PATの登録は不要です。
`/users/{username}/starred`から指定ユーザーの公開Star一覧を取得し、個人の認証済みStar一覧APIは使用しません。GitHub APIバージョンは`2026-03-10`、Notion APIバージョンは`2025-09-03`に固定しています。
秘密情報をVariable、コミット、実行ログに記載しないでください。

### 3. 実行する

1. Workflowファイルをデフォルトブランチに配置し、リポジトリのActionsを有効にします。
2. **Actions → Sync GitHub Stars to Notion → Run workflow** からデフォルトブランチを選んで実行します。
3. 実行サマリーとNotionの行を確認します。同じ内容で再実行すると`skipped`になります。

定期実行は毎日 **09:17 JST（00:17 UTC）** です。push/PRではテスト用CIのみが実行され、Notionへの書き込みは起動しません。
同じリポジトリの定期・手動実行は固定の`concurrency`グループで直列化し、実行中の同期はキャンセルしません。GitHubのconcurrencyでは待機中の実行が新しい実行に置き換わる場合があります。各回で全件照合するため、後続回で取り込みます。

## 同期と重複防止

- 同期前に設定、Notionの列の型、GitHub全ページ、Notion全ページ、既存IDの重複を検証します。不備がある場合は書き込み前に停止します。
- 一意キーはリポジトリ名・URLではなくGitHubリポジトリIDです。改名・移管後も同じNotionページを更新します。同期する5列はGitHubの値を正とします。
- Star解除済み・取得不能・Notionでアーカイブ済みの行は削除しません。アーカイブ済みの行は照合対象外のため、現在もStarしている場合は新しいアクティブな行が作成されます。
- 読み取りと同じ値を設定する更新は、一時障害時に最大4回まで試行します。429やGitHubのレート制限では`Retry-After`またはリセット時刻を尊重し、必要な待機が120秒を超える場合は停止します。Notionリクエストは350ms以上の間隔を空けます。
- 新規作成のPOSTは自動再送しません。応答が途切れたり5xxになった場合はIDで最大3回再照合し、作成済みなら成功として扱います。見つからなければ成否不明として停止します。作成時の429など明確なエラーもその実行を失敗にし、後で再実行します。
- 実行サマリーの`created` / `updated` / `skipped`は処理が確認できた件数です。`failed`は実行を停止させたエラー件数（0または1）で、未処理リポジトリ数ではありません。失敗時は非ゼロで終了します。

Notionの照合と作成は原子的な処理ではありません。同じデータソースを別のリポジトリ、ローカル実行、他のツールから同時に同期しないでください。作成直後の参照反映遅延やrunnerの強制終了を含む、外部APIをまたいだ厳密なexactly-once保証はありません。

## 障害時の復旧

- **設定・スキーマのエラー**：Variable/Secret、integrationの接続、プロパティ名と型を確認します。HTTP 401/403は認証・権限、404は対象IDやアクセス許可を確認します。
- **既存IDの重複**：サマリーに表示された`Repository ID`をNotionで検索し、必要なメモ等を1行に集約します。余分な行をアーカイブするかIDを空欄にしてから再実行します。自動削除・統合はしません。
- **通常の途中失敗**：原因を解消して手動で再実行します。作成済みのIDは再照合され、同じ行は増えません。
- **`create outcome is unknown`、runnerのタイムアウト・キャンセル**：まずActionsのWorkflowを一時的にDisableし、次の定期実行を止めます。処理が終了したことを確認し、Notionの反映を待って対象IDの行がないか調べます。成否不明エラーでは対象IDをサマリーに表示します。強制終了時は既存の行とStar一覧を照合します。作成された行が見つかったら、その行のIDを保持します。未作成と判断できるまで再実行しないでください。確認後にWorkflowをEnableし、手動で再実行します。
- **レート制限・一時障害**：必要な待機を終えてから再実行します。30分のジョブ上限に届く件数の場合は、運用に合わせてtimeoutを調整してください。
- **定期実行の停止**：GitHubの定期実行は混雑時に遅延する可能性があります。公開リポジトリで60日間活動がないと自動停止するため、Actions画面のEnable workflow、または認証済みCLIの`gh workflow enable sync.yml`で再有効化し、手動実行で確認します。

## ローカル開発

Node.js 24を用意し、依存インストールなしで実行できます。

```sh
npm run check
npm test
```

テストはAPIを模擬し、実際のGitHub/Notionへ接続しません。初回・再実行、ページネーション、改名、手入力保持、部分失敗、作成応答欠落、レート制限、設定不備、Workflowの直列化設定を検証します。

実同期は次の環境変数を安全な方法でシェルへ設定してから`npm run sync`を実行します。
`GITHUB_STAR_USER`、`GITHUB_TOKEN`、`NOTION_DATA_SOURCE_ID`、`NOTION_TOKEN`。
`.env`は自動読み込みしません。トークンをコマンド履歴に残さないでください。
ローカル実行時は、同じ同期先へのActionsや他プロセスの同期を停止してください。

## ロードマップ

1. [**MVP (#1)**](https://github.com/UtakataKyosui/github-stars-to-notion/issues/1) — 定期同期・重複防止・再実行・セットアップ手順。
2. [**タグ・ラベル分類 (#2)**](https://github.com/UtakataKyosui/github-stars-to-notion/issues/2) — GitHub Topicsと利用者が管理する分類を分けて保存。
3. [**AI概要生成 (#3)**](https://github.com/UtakataKyosui/github-stars-to-notion/issues/3) — Cloudflare Workers AIで日本語の概要を作成し、Notionへ保存。

AI機能は任意設定とし、未設定でもMVPの同期を利用できる構成にします。

## 公式資料

- [GitHub: Star一覧API](https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-a-user)
- [GitHub: scheduleイベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Notion: データソースのクエリ](https://developers.notion.com/reference/query-a-data-source)
- [Notion: APIリクエストの制限](https://developers.notion.com/reference/request-limits)
- [Cloudflare Workers AI: REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
