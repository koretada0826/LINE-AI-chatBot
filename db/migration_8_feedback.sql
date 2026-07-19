-- ============================================================
-- migration_8_feedback.sql
-- ①会話後アンケート（フィードバック）＋ ②支援スタイルの好み学習
-- ============================================================

-- 会話後の評価ログ（ユースケース分析・AI改善の材料）
create table if not exists feedback (
  id           bigint generated always as identity primary key,
  line_user_id text not null,
  company_id   bigint references companies(id) on delete set null,
  label        text,              -- good / empathy / solution / skip 等
  created_at   timestamptz default now()
);
alter table feedback enable row level security;
grant all on table feedback to service_role;

-- 相手の「支援スタイルの好み」（共感重視 / 解決重視）をプロフィールに保持
alter table user_profiles add column if not exists support_style text;
