-- ============================================================
-- migration_10_department : 部署（部門）を登録＋相談ログに保持
-- 目的：経営レポートを「部署別」に出せるようにする（要件どおり）。
-- ・employees.department          … 登録フォームで任意入力
-- ・consultation_logs.department  … 相談時点の部署を非正規化保存（後から部署変更されても当時の集計が保てる）
-- 匿名性は維持（部署は組織単位の集計にのみ使用。個人特定はしない運用）。
-- ============================================================
alter table employees          add column if not exists department text;
alter table consultation_logs  add column if not exists department text;

create index if not exists idx_logs_company_dept
  on consultation_logs (company_id, department);
