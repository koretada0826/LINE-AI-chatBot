# 才職CARE LINE AI相談チャットボット

企業向け社外相談サービス「才職CARE」のLINE相談窓口。
Claude Opus 4.8 を頭脳に、傾聴的な深掘りヒアリング・5区分の自動振り分け・
希死念慮/ハラスメント/不正の即時エスカレーションを行う。

## 構成
```
api/webhook.js   … LINE Webhook本体（署名検証→AI→返信→ログ→通知）
lib/prompt.js    … メンター「リンカー」の傾聴ペルソナ＋5区分の判定基準（AIの頭脳）
lib/claude.js    … Claude Opus 4.8 呼び出し（構造化出力で返信＋区分を取得）
lib/safety.js    … 危険語の決定論的ガード（AI判定と二重チェック）
lib/line.js      … LINE返信/プッシュ＋署名検証
lib/store.js     … 会話記憶・相談ログ（Supabase、未設定時はインメモリ）
db/schema.sql    … Supabaseスキーマ
```

## デプロイ手順（Vercel）

### 0. 事前準備
```bash
npm i -g vercel
vercel login
```

### 1. 鍵を用意する
- **LINE**: LINE Developers → チャネル(2009710636) → Messaging API → 「チャネルアクセストークン（長期）」を発行
- **AI（Gemini）**: https://aistudio.google.com/api-keys でAPIキーを発行（無料枠あり）
- **Supabase**（推奨）: プロジェクト作成 → SQL Editorで `db/schema.sql` を実行 → Settings > API から `URL` と `service_role key` を取得

### 2. デプロイ
```bash
cd "/Users/koretada/Desktop/LINE＿AIチャットボット"
vercel --yes
```

### 3. 環境変数を登録（.env.example 参照）
```bash
vercel env add LINE_CHANNEL_ACCESS_TOKEN production
vercel env add LINE_CHANNEL_SECRET production
vercel env add GEMINI_API_KEY production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
# 任意: vercel env add OPERATOR_LINE_USER_ID production
```
登録後、本番反映：
```bash
vercel --prod --yes
```

### 4. LINE側にWebhook URLを登録
- 公式アカウントマネージャー → 設定 → Messaging API → Webhook URL に：
  ```
  https://xxxx.vercel.app/api/webhook
  ```
  → 保存 → 検証

### 5. 応答設定
- 設定 → 応答設定：応答メッセージ=オフ / Webhook=オン

### 6. 実機テスト
- 友だち追加して話しかける。傾聴的に返答し、深掘りしてくれれば成功。
- 「有給の残りはどこで確認？」→ 即答（ai_only）
- 「最近、上司と合わなくて…」→ 傾聴・深掘り（mentor_normal）
- ※安全確認テストは慎重に。危険語を入れるとエスカレーション扱いになります。

## この第一弾に含むもの / 次フェーズ
- ✅ 含む：AI一次対応・深掘り・5区分判定・安全ガード・会話記憶・相談ログ・緊急通知
- ⏭️ 次：企業コードによるオンボーディング/テナント分離、メンター予約・マッチング、
  定期プッシュ型コンディション確認、企業向けレポート、請求自動化
