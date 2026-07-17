-- ============================================================
-- マイグレーション⑥：会社ごとの「レポート閲覧トークン」
-- これにより、A社のトークンでB社のレポートを見ることは"構造上"不可能になる。
-- （company_id を差し替えても、自分の会社の集計しか返らない）
-- ============================================================
alter table companies
  add column if not exists report_token text not null default gen_random_uuid()::text;

-- 会社ごとの閲覧トークンを確認（各社に、この company_report_token を渡す）
-- select name, invite_code as 企業番号, report_token as レポート閲覧トークン from companies order by created_at;
