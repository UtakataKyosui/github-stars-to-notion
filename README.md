# GitHub Stars to Notion

GitHubでStarをつけたリポジトリを、GitHub Actionsから定期的にNotionデータベースへ同期するプロジェクトです。

## 現在の状態

MVPの同期スクリプト、定期・手動実行のGitHub Actions、GitHub Topics・手入力タグによる分類、Cloudflare Workers AIによる日本語概要生成、Crustによる対話セットアップ・配布用ビルド、自動テストを実装しています。
利用には、NotionのデータベースとGitHub Actionsの設定が必要です。
AI概要生成は任意です。Cloudflare設定がなければ基本同期のみ実行します。

## MVP

- デフォルトでは、このリポジトリの所有者の公開Star一覧をページネーション込みで取得する。`STAR_USER`で別ユーザーを指定できる。
- 毎日1回の定期実行と、`workflow_dispatch`による手動実行に対応する。
- Notionへリポジトリ名、URL、説明、GitHubリポジトリID、Star登録日時を保存する。
- GitHub Topicsを自動同期し、手入力の`Tags`・`Category`と分けて管理する。
- GitHubリポジトリIDを照合して作成・更新し、再実行やリポジトリの改名でも重複させない。
- 実行を直列化し、途中失敗後の再実行にも対応する。
- Notionの手入力メモ・分類は保持する。Star解除による削除はMVPでは行わない。
- 作成・更新・スキップ・失敗の件数をActionsの実行サマリーに表示する。

同期方式はGitHubからNotionへの一方向とし、MVPでは公開リポジトリを対象にします。
Node.js 24で実行します。CLIにはCrust、実行制御には公式アダプター経由でEffect.tsを使用します。GitHub Actionsはnpmキャッシュを利用し、同期前に`npm ci --ignore-scripts --include=dev`で依存をインストールして型チェックを行います。CIではテストとCLIのヘルプ表示も検証します。

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
| `GitHub Topics` | マルチセレクト | GitHub Topicsを自動同期。追加・削除を反映 |
| `Tags` | マルチセレクト | 利用者が管理する用途・独自タグ。自動更新しない |
| `Category` | セレクト | 利用者が管理する主カテゴリ。自動更新しない |

`Repository ID`にNotionの「ID」型や数値型を使用しないでください。
8列すべての名前・型を起動時に検証します。自動更新するのは`Tags`・`Category`以外の6列です。
メモ用の列やページ本文は自由に追加できます。`GitHub Topics`の手修正は次回同期でGitHubの値へ戻るため、独自の分類は`Tags`・`Category`へ記入してください。
手動で作成した行は`Repository ID`を空欄にすれば同期対象になりません。

### 2. GitHub Actionsを設定する

このコードを利用するリポジトリの **Settings → Secrets and variables → Actions** に設定します。

| 種類 | 名前 | 用途 |
| --- | --- | --- |
| Actions Variable（任意） | `STAR_USER` | Star一覧を取得するユーザー。未設定・空欄ならリポジトリ所有者 |
| Actions Variable | `NOTION_DATA_SOURCE_ID` | 同期先データソースのID |
| Actions Secret | `NOTION_TOKEN` | 同期先へのアクセスを許可したNotion integrationのトークン |

GitHubのConfiguration Variableでは`GITHUB_`で始まる名前が予約されているため、設定名は`STAR_USER`とします。Workflow内でスクリプトの環境変数`GITHUB_STAR_USER`に渡します。

未設定の場合は、Actionsが自動で設定する`GITHUB_REPOSITORY_OWNER`を使用します。このリポジトリでは`UtakataKyosui`、個人アカウントへforkした場合はfork先の所有者です。手動実行した人やコミットした人には切り替わりません。組織所有のリポジトリで利用する場合は、`STAR_USER`に同期したい個人ユーザーを指定してください。
同期先は常に`NOTION_DATA_SOURCE_ID`で指定したデータソースであり、Notion上の自分のDBを自動で探す動作はありません。必須設定は`NOTION_DATA_SOURCE_ID`と`NOTION_TOKEN`です。

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

Starした公開リポジトリ1件につきNotionに1行を作成します。基本同期で反映するのは上記の`Name`・`URL`・`Description`・`Repository ID`・`Starred At`・`GitHub Topics`の6列です。`Description`はGitHubの説明文をそのまま保存します。任意のAI概要は後述の専用列へ保存し、README本文はNotionへ保存しません。AIによる自動分類は実装していません。

- 同期前に設定、Notionの列の型、GitHub全ページ、Notion全ページ、既存IDの重複を検証します。不備がある場合は書き込み前に停止します。
- 一意キーはリポジトリ名・URLではなくGitHubリポジトリIDです。改名・移管後も同じNotionページを更新します。同期する6列はGitHubの値を正とします。
- Star解除済み・取得不能・Notionでアーカイブ済みの行は削除しません。アーカイブ済みの行は照合対象外のため、現在もStarしている場合は新しいアクティブな行が作成されます。
- 読み取りと同じ値を設定する更新は、一時障害時に最大4回まで試行します。429やGitHubのレート制限では`Retry-After`またはリセット時刻を尊重し、必要な待機が120秒を超える場合は停止します。Notionリクエストは350ms以上の間隔を空けます。
- 新規作成のPOSTは自動再送しません。応答が途切れたり5xxになった場合はIDで最大3回再照合し、作成済みなら成功として扱います。見つからなければ成否不明として停止します。作成時の429など明確なエラーもその実行を失敗にし、後で再実行します。
- 実行サマリーの`created` / `updated` / `skipped`は処理が確認できた件数です。`failed`は実行を停止させたエラー件数（0または1）で、未処理リポジトリ数ではありません。失敗時は非ゼロで終了します。

Notionの照合と作成は原子的な処理ではありません。同じデータソースを別のリポジトリ、ローカル実行、他のツールから同時に同期しないでください。作成直後の参照反映遅延やrunnerの強制終了を含む、外部APIをまたいだ厳密なexactly-once保証はありません。

## Topics・タグ・カテゴリで分類する

### 同期と正規化のルール

- GitHub Star一覧APIの`topics`を取得し、Unicode NFKC正規化、前後の空白除去、小文字化、空文字の除去、重複除去を行います。たとえば` JavaScript `と`javascript`は`javascript`にまとまります。手入力の`Tags`・`Category`は正規化も更新もしません。
- `GitHub Topics`に同じ正規化名の選択肢があれば既存の表記を再利用します。未登録の名前はページへの保存時にNotionが選択肢として追加します。選択順やNotionの選択肢ID・色が変わっても、名前の集合が同じなら更新をスキップします。正規化すると同名になる選択肢が複数ある場合は、書き込み前に停止するためNotion上で統一してください。
- GitHubで削除されたTopicはページの選択から外します。Topicsが空配列・未指定なら空の選択を保存します。データソース内の未使用の選択肢は削除しません。他のページやビューの設定への影響を避けるため、必要ならNotionで整理してください。
- [Notion APIの制限](https://developers.notion.com/reference/request-limits)に合わせ、1ページのmulti-selectは正規化・重複除去後100件までとします。選択肢名は本ツールの保守的な上限として100 UTF-16単位までに制限します。[Notionで使用できないカンマ](https://developers.notion.com/reference/page-property-values#multi-select)と制御文字も拒否します。上限超過や不正な型は、値を切り詰めたり欠落させたりせず、全ページへの書き込み前にエラーにします。100件は1回のページ書き込みの上限であり、データソース全体の選択肢数に100件の上限を設けるものではありません。
- 新規ページの`Tags`・`Category`は未入力です。更新リクエストにも両プロパティを含めないため、Topicsだけが変更された場合や作成応答欠落からの再照合でも手入力を保持します。

### 既存MVPデータベースの移行

1. Actionsの同期Workflowを一時的にDisableし、進行中の同期が終了したことを確認します。必要に応じてNotionのデータベースをエクスポートして控えを残します。
2. 同じデータソースに`GitHub Topics`（マルチセレクト）、`Tags`（マルチセレクト）、`Category`（セレクト）を追加します。すでに同名・同型の列があればそのまま使用します。選択肢の事前登録は不要です。スクリプトは列を自動作成・型変換しません。
3. 同名でも型が異なる列は、既存の内容を残して別名に変更し、正しい型の列を追加します。旧列の独自タグ・カテゴリはNotion上で`Tags`・`Category`へコピーして確認します。別名の分類列をすでに使用している場合は、その列を正確な名前へ変更しても構いません。`GitHub Topics`には手入力分類を移さないでください。
4. 既存行の`Repository ID`と他の5列を保持し、このバージョンを配置します。WorkflowをEnableして手動実行すると、現在もStarしている既存行にTopicsを補完します。ページを作り直す必要はありません。Star解除済みの行やIDが空欄の行はそのまま残ります。
5. 手入力の`Tags`・`Category`が保持されていることと実行サマリーを確認し、再実行して`skipped`になることを確かめます。列不足・型違いの場合は書き込み前に停止するので、スキーマエラーの列を修正して再実行します。

### ビューの設定例

- **用途タグで絞るテーブル**：Notionでテーブルビューを追加し、フィルターを`Tags` →「次を含む」→ `仕事で使う`に設定します。技術で絞るなら`GitHub Topics` →「次を含む」→ `typescript`を追加します。両方の条件をANDにすると、仕事で使うTypeScript関連リポジトリを表示できます。
- **カテゴリ別のボード**：ボードビューを追加し、「グループ」→`Category`を選びます。`開発ツール`、`学習`、`運用`などのカテゴリをNotionで作成し、各行に指定します。未分類のグループも表示すると仕分け漏れを確認できます。`Tags`のフィルターとの併用も可能です。

### 将来の自動分類

自動分類を追加する場合は、`Suggested Tags`（マルチセレクト）・`Suggested Category`（セレクト）などの専用列を設けます。自動生成した提案列のみを再分類時に上書きし、GitHub由来の`GitHub Topics`と手入力の`Tags`・`Category`には書き込みません。提案を採用する場合は利用者が手入力列へコピーします。現在のAI機能は概要生成のみで、提案列は追加しません。

## AIによる日本語概要（任意）

### 設定と既存DBへの追加

基本同期の完了後、同じNotionページに日本語の概要を補完します。既存ページの作り直しは不要です。AIを利用しない場合は、追加の列・設定は不要です。

1. 同期Workflowを一時的にDisableし、実行中の同期が終了したことを確認します。
2. 同じデータソースに次の列を追加します。同名でも型が違う列は内容を保管して別名にし、正しい型で作成してください。列の自動作成・型変更は行いません。

| プロパティ名 | Notionの型 | 用途 |
| --- | --- | --- |
| `AI Summary` | テキスト | 生成した日本語概要 |
| `AI Generated At` | 日付 | 生成が成功した日時（UTC） |
| `AI Model` | テキスト | 生成に使用したモデルID |
| `AI Input Hash` | テキスト | 実際に送信した入力JSONのSHA-256 |
| `AI Prompt Version` | テキスト | プロンプトのバージョン（現在`ja-summary-v1`） |

3. Cloudflareの **Workers AI → Use REST API** でAccount IDを取得し、対象アカウントに限定したWorkers AI API Tokenを作成します。公式テンプレートを使うか、`Workers AI - Read`・`Workers AI - Edit`権限を設定します（[公式手順](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)）。Workerのデプロイは不要です。
4. GitHub ActionsのSecrets / Variablesに次を設定します。

| 種類 | 名前 | 用途・既定値 |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflareの32桁のAccount ID |
| Secret | `CLOUDFLARE_API_TOKEN` | Workers AI API Token。Variableへ登録しない |
| Variable（任意） | `CLOUDFLARE_AI_MODEL` | 既定値`@cf/qwen/qwen3-30b-a3b-fp8` |
| Variable（任意） | `AI_MAX_ITEMS` | 1実行の生成対象数。既定10、0〜50。0は生成を保留 |

5. WorkflowをEnableして通常の手動実行を行い、`ai_generated`とNotionの5列を確認します。未生成分が上限より多ければ、以降の定期・通常手動実行で補完されます。再実行で同じ入力の`ai_skipped`が増え、AI呼び出しが増えないことを確認します。

既定モデルは[Qwen3 30B A3B FP8](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)です。多言語対応と低いトークン単価を理由に選定しました。日本語の品質は対象リポジトリで確認してください。モデルを変更する場合は、Workers AIの`@cf/作者/モデル名`で、`messages`・`max_tokens`・`temperature`を受け取り、`result.response`または`result.choices[0].message.content`を返すテキスト生成モデルを選んでください。他の出力形式やAPIは未対応です。

### 送信情報・制限・費用

- Cloudflareへ送るのは、公開リポジトリ名、GitHubの説明、正規化したTopics、GitHub README APIから取得した先頭部分と固定プロンプトです。Notionのメモ・タグ・本文、Starした日時、環境変数、認証トークンは入力に含めません。GitHub / Notion / Cloudflareのトークンはそれぞれの認証ヘッダーにのみ使用し、ログには出しません。
- READMEは最大8,000 UTF-8バイトを読み、続きのダウンロードをキャンセルします。404はREADMEなしとして空文字を使います。その他の取得エラーはその項目のAI失敗です。名前512バイト、説明2,000バイト、TopicsのJSON合計2,000バイト、入力JSON全体24,000バイトを上限とし、超過部分を切り詰めます。既定モデルの32,768トークンのコンテキストに対し、入力をバイト数で保守的に制限します。
- README等はすべて信頼できない資料としてuserメッセージのJSONへ分離し、資料中の指示に従わず、不明事項を断定しないようsystemメッセージで指定します。ツール・任意URLアクセス・コード実行の機能は渡しません。README内のリンクは取得せず、APIのリダイレクトも拒否します。生成内容の正確性・指示への追従を完全には保証できないため、概要を確認して利用してください。
- 出力は`max_tokens: 512`、日本語2〜3文・400文字以内を指示します。空、1,200 UTF-16単位超、日本語文字なし、未完了の思考タグ、完了理由が`length`等の応答は保存しません。完結した`<think>…</think>`の先頭部分は取り除きます。モデルの出力制限が優先されます。
- 推論は30秒でタイムアウトし、429・5xx・ネットワーク障害・タイムアウト・不正JSONは最大3回（初回＋再試行2回）まで試みます。`Retry-After`は尊重し、30秒超の待機を要求された場合はその項目を失敗にします。401/403は同じリクエストを再試行しません。対象数10なら推論は最大30リクエストです。応答欠落後の再試行も課金される可能性があります。ジョブ全体は従来どおり30分です。
- 2026-10-23確認時の[料金表](https://developers.cloudflare.com/workers-ai/platform/pricing/)では、既定モデルは入力100万トークンあたり約$0.051、出力100万トークンあたり$0.335です。仮に1件が入力3,000・出力512トークンなら約$0.000325、10件で約$0.00325（再試行なし・無料枠適用前）です。実入力のトークン数により変動します。Workers AI全体で1日10,000 Neuronsの無料枠があり、超過利用にはWorkers Paidが必要です。他用途と無料枠を共有するため、Cloudflareダッシュボードで使用量と最新料金を確認してください。

### 再生成と障害復旧

`AI Summary`が空、生成日時がない、入力ハッシュ・モデルID・プロンプトバージョンのいずれかが違う項目だけ生成します。比較対象は上限を適用した送信入力です。上限以降だけの変更、Topicsの順序変更、Star日時変更は再生成の理由になりません。変化の確認のためREADMEは毎回取得しますが、同じ入力なら推論は呼びません。プロンプト変更時はコードの`PROMPT_VERSION`も更新します。

強制再生成は **Run workflow → force_regenerate** を明示的にチェックします。ローカルでは`AI_FORCE_REGENERATE=true`を設定します。通常の定期実行ではfalseです。強制実行にも`AI_MAX_ITEMS`が適用され、既定の古いStar順で先頭から処理します。上限を超える全件を強制再生成したい場合は、対象の`AI Input Hash`をNotionで空にしてから、forceなしの通常実行を繰り返してください。forceを繰り返すと同じ先頭項目が再生成されます。

AIは基本同期の全件完了後に処理し、概要と4つの生成情報を1回のPATCHで保存します。`Description`や手入力項目・ページ本文はAI更新に含めません。生成失敗時は前回の概要・生成情報を保持するため、通常の次回実行で再試行されます。保存応答が失われた場合は保存済みの可能性があり、次回のNotion照合で判定します。基本同期自体が停止した場合、AI処理は開始しません。

Actionsサマリーの`ai_generated`（保存成功）、`ai_skipped`（変更なし）、`ai_failed`（AI処理の失敗）、`ai_deferred`（件数上限で保留）を確認します。失敗があれば、基本同期の結果を保持したままジョブは非ゼロで終了します。設定・スキーマ不備の`ai_failed=1`は準備処理の失敗1件で、対象リポジトリ数ではありません。全Cloudflare設定が空ならAIを無効と表示し、基本同期のみ成功します。一部だけ設定された場合は設定エラーを表示します。

| サマリーの追加項目 | 復旧方法 |
| --- | --- |
| `ai_error_configuration` | Account ID・Secretの不足や書式、モデルID、件数0〜50、forceのtrue/falseを確認 |
| `ai_error_schema` | 上記5列の正確な名前と型を確認 |
| `ai_error_http_401` / `ai_error_http_403` | Cloudflareトークンの有効性・対象アカウント・Workers AI権限を確認 |
| `ai_error_http_429` / `ai_error_http_5xx`相当の番号 | レート制限・無料枠・Cloudflare側の状態を確認し、間隔を空けるか件数を減らして再実行 |
| `ai_error_network_or_json` | ネットワーク・タイムアウト・応答形式を確認して再実行 |
| `ai_error_response` | 日本語概要と互換性のあるモデルか確認。長さ上限や未完了出力も対象 |
| `ai_error_readme` | GitHubの権限・レート制限・README取得可否を確認 |
| `ai_error_save` | Notionの権限・列・レート制限を確認 |

エラー本文・入力本文・認証情報はサマリーへ出しません。原因解消後はforceをチェックせず通常実行し、未生成・変更分を再試行してください。AIを止めるには3つの`CLOUDFLARE_*`設定をすべて空にします。Notionの過去の概要は残ります。

## 障害時の復旧

- **設定・スキーマのエラー**：Variable/Secret、integrationの接続、プロパティ名と型を確認します。HTTP 401/403は認証・権限、404は対象IDやアクセス許可を確認します。
- **既存IDの重複**：サマリーに表示された`Repository ID`をNotionで検索し、必要なメモ等を1行に集約します。余分な行をアーカイブするかIDを空欄にしてから再実行します。自動削除・統合はしません。
- **通常の途中失敗**：原因を解消して手動で再実行します。作成済みのIDは再照合され、同じ行は増えません。
- **`create outcome is unknown`、runnerのタイムアウト・キャンセル**：まずActionsのWorkflowを一時的にDisableし、次の定期実行を止めます。処理が終了したことを確認し、Notionの反映を待って対象IDの行がないか調べます。成否不明エラーでは対象IDをサマリーに表示します。強制終了時は既存の行とStar一覧を照合します。作成された行が見つかったら、その行のIDを保持します。未作成と判断できるまで再実行しないでください。確認後にWorkflowをEnableし、手動で再実行します。
- **レート制限・一時障害**：必要な待機を終えてから再実行します。30分のジョブ上限に届く件数の場合は、運用に合わせてtimeoutを調整してください。
- **定期実行の停止**：GitHubの定期実行は混雑時に遅延する可能性があります。公開リポジトリで60日間活動がないと自動停止するため、Actions画面のEnable workflow、または認証済みCLIの`gh workflow enable sync.yml`で再有効化し、手動実行で確認します。

## ローカル開発

Node.js 24を用意し、lockfileに固定した依存をインストールします。

```sh
npm ci --ignore-scripts --include=dev
npm run check
npm test
npm run sync -- --help
npm run build
npm run test:build
```

`npm run check`はBiomeによる整形・lint・import順序、TypeScriptの型、fallowによる未使用コード・依存を検査します。CIでも同じコマンドを実行します。個別には`npm run lint`、`npm run check:types`、`npm run check:unused`を使えます。`npm run format`は整形・安全なlint修正・import整理を適用するため、変更差分を確認してください。

Biomeとfallowは開発依存としてバージョンを固定しています。`biome.json`はソース・テスト・設定JSONを対象とし、生成されたlockfileは除外します。`.fallowrc.json`はCLIとテストをエントリーポイントに指定します。fallowは全体の未使用コード検査を失敗条件としており、既存の指摘を隠すベースラインは使用しません。定期・手動同期のWorkflowは同期前に`npm run check:types`を実行します。

CLIは`@crustjs/core` / `@crustjs/extensions` 0.5.6、公式Effectアダプター`@crustjs/effect` 0.2.3、Effect 4.0.6を採用しています。各パッケージのNode.js 24対応と、アダプターのEffect v4 peer dependencyに合わせた構成です。

アプリケーションコード（`src/*.ts`）はTypeScriptです。Node.js 24の[type stripping](https://nodejs.org/docs/latest-v24.x/api/typescript.html)で直接実行でき、既存の同期・ヘルプ・単体テストにはビルドやBunは不要です。`npm run check`でTypeScript 7のstrictモードによる型検査を行います。`erasableSyntaxOnly`を有効にし、Node.jsで直接実行できる構文に制限しています。設定・統計・APIクライアント・外部APIのデータ構造・テスト用の依存注入にも型を定義しています。外部レスポンスの実行時検証は引き続き行い、回帰テスト（`test/*.mjs`）からTypeScriptモジュールを直接検証します。

Crustが引数解析とヘルプを担当し、`handler()`でEffectプログラムを実行します。Effectは設定読み込み・同期呼び出しの失敗を処理し、件数レポートとActionsサマリー追記を順に実行します。同期・AIモジュールは既存のPromise APIを維持します。`--help`は設定なしで利用でき、同期もサマリー追記も行いません。不明な引数・フラグは同期前に拒否します。

Ctrl+Cで中断すると終了コード130になり、実行中のHTTP通信と待機をキャンセルして、次のリクエスト・再試行・AI生成・書き込みを開始しません。中断時点ですでにサーバーへ送信した書き込みやAI生成は取り消せない場合があります。Notionの作成処理中に中断した場合は、既存の重複防止・障害復旧の手順に従って結果を確認してから再実行してください。

テストはAPIを模擬し、実際のGitHub/Notion/Cloudflareへ接続しません。基本同期に加え、AI概要の保存と再実行、入力・モデル・プロンプト変更、強制再生成、READMEなし・長大・不正指示、件数制限、AI無効・設定不備、401・429・タイムアウト・保存失敗からの復旧、手入力保持、Secretの非混入を検証します。

実同期は次の環境変数をシェルまたはプロジェクトルートの`.env`へ設定してから`npm run sync`を実行します。
`GITHUB_STAR_USER`、`GITHUB_TOKEN`、`NOTION_DATA_SOURCE_ID`、`NOTION_TOKEN`。
AIを利用する場合は上記の`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`と任意のモデル・件数・force設定も渡します。
同期時はカレントディレクトリの`.env`を自動読み込みします。既存のシェル環境変数を優先し、ファイルがなければ従来どおり環境変数だけを使います。別ファイルは`npm run sync -- --env-file PATH`で指定します。明示したファイルがない、または読み込めない場合は同期前に停止します。ヘルプ表示と`init`では読み込みません。Node.js標準の`util.parseEnv()`を使い、`process.env`の書き換えや値のコマンド実行は行いません。トークンをコマンド履歴に残さないでください。
ローカル実行時は、同じ同期先へのActionsや他プロセスの同期を停止してください。

### Crustの初期設定・ビルド・スキル

任意のローカル設定を作成するには、先にビルドしてテンプレートを配置します。対話実行ではGitHubユーザーとNotionデータソースIDを入力します。初期設定だけでは同期は開始しません。

```sh
npm run build
npm run start -- init
# 対話なしで作成する場合
npm run start -- init --non-interactive --user YOUR_USER --data-source-id YOUR_DATA_SOURCE_ID
```

カレントディレクトリの`.stars-to-notion/`へ、`config.json`、`.env.example`、説明を作成します。既存の非空ディレクトリには上書きしません。`config.json`へ保存する設定は`GITHUB_STAR_USER`と`NOTION_DATA_SOURCE_ID`の2つだけです。トークンはシェルまたは`.env`から渡します。初期設定後に`.stars-to-notion/.env.example`をプロジェクトルートの`.env`へコピーし、トークンを記入すれば`npm run sync`で利用できます。`.env.example`そのものは読み込みません。`.env`と`.stars-to-notion/`はgitの対象外です。

各環境変数はシェル → `.env`（または`--env-file`のファイル）の順で優先します。シェルに空文字を設定した場合もその値を優先します。`--env-file`指定時はそのファイルだけを読み、既定の`.env`とは重ねません。その後、ユーザー選択は`GITHUB_STAR_USER` → `GITHUB_REPOSITORY_OWNER` → ローカル設定の順、データソースIDは`NOTION_DATA_SOURCE_ID` → ローカル設定の順です。ユーザー・データソースIDの空白のみの値は未設定として扱います。ローカル設定ファイルが壊れている場合は同期前に停止します。設定ディレクトリを含むプロジェクトのルートから実行してください。

`@crustjs/env`のContextで環境変数を宣言し、ヘルプにも一覧を表示します。値の検証は既存の設定検証を維持し、秘密情報をエラーへ出しません。`@crustjs/store`で設定を保存し、`@crustjs/create`でテンプレートを展開、`@crustjs/prompts`で入力します。通常の端末では`@crustjs/progress`のスピナーをstderrへ表示します。パイプ・Actionsではスピナーを表示せず、従来の件数レポートを出力します。

`npm run build`は`@crustjs/crust`によりNode.js向けJavaScriptパッケージを`.crust/root/`へ生成します。ビルドにはBunのバンドラーを使います。PATHにBunがあればその実体を使い、なければCrust配布バイナリ内蔵のBunを使います。Bunを別途使う場合はCrustが要求するバージョンを用意してください。配布物の実行にはNode.js 24以降のみが必要です。ビルド時にテンプレートと`@crustjs/skills`で生成したCLI操作用スキルも同梱します。

```sh
npm run start -- --help
npm run test:build
# 同梱スキルをプロジェクトへ導入する場合（利用者が明示的に実行）
npm run start -- skills install --all --scope project
```

スキルの自動修復は無効です。通常の同期やヘルプ表示ではエージェントの設定を書き換えません。ソースからの`npm run sync -- init`もビルド済みテンプレートを使います。ビルド成果物はgitの対象外で、npmへの公開は行いません。

追加テストは`@crustjs/testing`の`captureExecute()`と`runInteractive()`、Coreの`run()`を使い、対話入力、設定の優先順位、上書き拒否、秘密情報の非混入、スピナー終了処理を検証します。`npm run test:build`は別の一時ディレクトリから配布物を起動し、テンプレートと生成スキルも検証します。CIでもビルドと配布物のチェックを実行します。

実装の基準はCrust公式の[Testing](https://crustjs.com/docs/guide/testing/)、[Build and distribution](https://crustjs.com/docs/guide/build-and-distribution/)、[Skills](https://crustjs.com/docs/modules/skills/)、[Env](https://crustjs.com/docs/modules/env/)、[Create](https://crustjs.com/docs/modules/create/)、[Progress](https://crustjs.com/docs/modules/progress/)、[Prompts](https://crustjs.com/docs/modules/prompts/)、[Store](https://crustjs.com/docs/modules/store/)です。

## ロードマップ

1. [**MVP (#1)**](https://github.com/UtakataKyosui/github-stars-to-notion/issues/1) — 定期同期・重複防止・再実行・セットアップ手順。
2. [**タグ・ラベル分類 (#2)**](https://github.com/UtakataKyosui/github-stars-to-notion/issues/2) — 実装済み。GitHub Topicsと利用者が管理する分類を分けて保存。
3. [**AI概要生成 (#3)**](https://github.com/UtakataKyosui/github-stars-to-notion/issues/3) — 実装済み。Cloudflare Workers AIで日本語の概要を作成し、Notionへ保存。

AI機能は任意設定とし、未設定でもMVPの同期を利用できる構成にします。

## 公式資料

- [GitHub: Star一覧API](https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-a-user)
- [GitHub: scheduleイベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Notion: データソースのクエリ](https://developers.notion.com/reference/query-a-data-source)
- [Notion: APIリクエストの制限](https://developers.notion.com/reference/request-limits)
- [Cloudflare Workers AI: REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
