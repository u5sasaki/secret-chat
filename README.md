# URLを知っている人だけのグループチャット

- 参加用URL: `https://<サーバーのURL>/r/<ROOM_TOKEN>`（それ以外のURLは全て404）
- 画像送信対応（送信前に自動で縮小）
- メッセージ・画像は24時間で自動削除（10分ごとに掃除）
- データベース不要（ファイル保存）。依存パッケージは `ws` のみ

## ローカルで試す
    npm install
    ROOM_TOKEN=好きな英数字16文字以上 npm start
    → http://localhost:3000/r/<ROOM_TOKEN>

## Renderに置く手順（無料プランで可）
1. このフォルダをGitHubのリポジトリにアップロード
2. render.com で New → Web Service → そのリポジトリを選択
3. Build Command: `npm install` / Start Command: `npm start`
4. Environment に `ROOM_TOKEN` を追加（英数字・-・_ の16文字以上。例: `openssl rand -base64 18 | tr '+/' '-_'`）
5. デプロイ後、`https://xxxx.onrender.com/r/<ROOM_TOKEN>` をグループに共有

## 注意
- URLが漏れると誰でも入れます。漏れたら ROOM_TOKEN を変えて再デプロイすると、古いURLは無効になります。
- Renderの無料プランは、しばらくアクセスがないと休止し、再起動時に履歴が消えます（24時間で消す仕様なので実害は小さいです）。
- 常にHTTPS（wss）で使ってください。

## 管理者へのメール通知（任意）
Renderの無料プランはSMTPが使えないため、Resend（HTTP API）で送ります。
1. resend.com に登録し、API Keys で「Sending access」のキーを作成
2. Renderの Environment に次を追加
   - `RESEND_API_KEY` = 作成したキー（re_ で始まる）
   - `NOTIFY_EMAIL` = Resendに登録したメールアドレス（無料・ドメイン未認証では、この宛先にしか送れません）
   - （任意）`NOTIFY_INTERVAL_MIN` = 通知の最短間隔（分、既定10）。間隔内の投稿は1通にまとめます
3. 保存すると自動で再デプロイされます
通知には投稿者名・時刻・本文（先頭300文字）が入ります。画像は「(画像あり)」と表示します。1日90通までです。

## Telegramへの通知（任意・おすすめ）
1. Telegramで @BotFather を検索し、`/newbot` で名前を決めてBotを作成 → 表示される「token」（123456:ABC... の形）をコピー
2. 作ったBotを検索して開き、「開始（Start）」を押し、何か1通メッセージを送る
3. ブラウザで `https://api.telegram.org/bot<token>/getUpdates` を開き、`"chat":{"id":数字` の数字をコピー（これがチャットID）
4. Renderの Environment に追加
   - `TELEGRAM_BOT_TOKEN` = 手順1のtoken
   - `TELEGRAM_CHAT_ID` = 手順3の数字
   - `PUBLIC_URL` = `https://xxxx.onrender.com`（任意。通知にチャットへのリンクが付きます）
連続した投稿は5秒ごとにまとめて1通で届きます。

## Google Drive への自動保存（任意）
利用者の画面には何も表示されません。1時間ごとに、新しいメッセージと画像をGoogle Driveへ保存します。
1. https://script.google.com で新しいプロジェクトを作り、`gdrive/Code.gs` の中身を貼り付ける。
2. `SECRET` を自分で決めた長い合言葉に書き換える。
3. 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」→実行ユーザー「自分」、アクセスできるユーザー「全員」→デプロイ（初回は権限の承認が必要）。
4. 表示された「ウェブアプリのURL」を Render の環境変数 `GDRIVE_WEBHOOK_URL` に、合言葉を `GDRIVE_SECRET` に設定。
   （保存間隔を変えるときは `GDRIVE_INTERVAL_MIN`。初期値60分、最小5分）
5. Drive の「静岡用宗Ｂ邸ホワイトボード保存」フォルダに、日ごとの `chat-日付.txt` と `images` フォルダができる。
6. 
