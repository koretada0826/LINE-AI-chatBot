-- ============================================================
-- マイグレーション②：オンボーディング＋テナント分離＋レポート
-- 既存Supabaseの SQL Editor に貼って実行する（create/alter if not exists で安全）
-- ============================================================

-- 会社マスタ：企業ごとの配信設定を追加（裏側で企業ごとに分岐）
alter table companies add column if not exists push_config jsonb not null default '{}'::jsonb;

-- 社員：登録項目とオンボーディング進捗を追加
alter table employees add column if not exists phone text;
alter table employees add column if not exists email text;
alter table employees add column if not exists concern_category text;
alter table employees add column if not exists onboarding_step text not null default 'company';
-- （既存: line_user_id, company_id, name, role_title, status, registered, created_at）

-- 相談・会話・エスカレーションに company_id を付与（会社ごとに集計・分離）
alter table consultation_logs add column if not exists company_id bigint references companies(id);
alter table conversations   add column if not exists company_id bigint references companies(id);
alter table escalations     add column if not exists company_id bigint references companies(id);
create index if not exists idx_logs_company on consultation_logs (company_id, created_at);

-- レポート用ビュー：会社 × カテゴリ × テーマ の相談件数（匿名集計）
create or replace view report_company_topics as
select
  l.company_id,
  co.name as company_name,
  l.category,
  l.topic,
  count(*)                 as consultations,
  count(*) filter (where l.escalated) as escalations,
  min(l.created_at)        as first_at,
  max(l.created_at)        as latest_at
from consultation_logs l
left join companies co on co.id = l.company_id
group by l.company_id, co.name, l.category, l.topic;

-- 会社×月×カテゴリ の月次トレンド
create or replace view report_company_monthly as
select
  l.company_id,
  co.name as company_name,
  date_trunc('month', l.created_at) as month,
  l.category,
  count(*) as consultations
from consultation_logs l
left join companies co on co.id = l.company_id
group by l.company_id, co.name, date_trunc('month', l.created_at), l.category;

-- 運営が会社を事前登録する例（実際はここを編集して実行）
-- insert into companies (name, invite_code, push_config) values
--   ('株式会社Uniboost', 'UNIBOOST2026',
--    '{"frequency":"weekly","message":"今週、大丈夫ですか？","options":["問題ない","少し不安","相談したい"]}'::jsonb);
