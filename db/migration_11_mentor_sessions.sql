-- ============================================================
-- migration_11_mentor_sessions : メンター稼働記録（誰が何時間対応したか）
-- 目的：運営（Uniboost社内）が「社員・メンター・対応時間」を記録し、
--       単価表を元に従量課金を自動算出→請求書に反映する。
-- 金額(amount)は登録時に単価表ルールで自動計算して保存（手入力で上書きも可）。
-- ============================================================
create table if not exists mentor_sessions (
  id            bigint generated always as identity primary key,
  company_id    bigint references companies (id) not null,
  mentor_id     bigint references mentors (id),      -- 紐付くメンター（任意）
  mentor_name   text,                                -- 表示用（mentor未登録でも記録可）
  session_type  text not null,                       -- 面談 / チャット / レポート / 研修 / その他
  minutes       integer not null default 0,          -- 対応時間（分）
  priority      text,                                -- 低 / 中 / 高（時間単価の根拠）
  occurred_on   date not null,                       -- 対応日
  billing_month date not null,                       -- 請求対象月（月初日）
  amount        numeric not null default 0,          -- 金額（単価表で自動計算 or 手入力）
  note          text,                                -- 備考（個人名は入れない運用）
  created_at    timestamptz not null default now()
);
create index if not exists idx_mentor_sessions_company_month
  on mentor_sessions (company_id, billing_month);
create index if not exists idx_mentor_sessions_mentor
  on mentor_sessions (mentor_id, billing_month);

alter table mentor_sessions enable row level security;
