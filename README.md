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
