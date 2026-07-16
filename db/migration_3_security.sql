-- ============================================================
-- マイグレーション③：セキュリティ強化（ガチガチ）
-- 匿名/公開キー(sb_publishable)からのアクセスを完全遮断。
-- サーバー(sb_secret=service_role)だけがアクセスできる状態にする。
-- ※Botは service_role を使い RLS をバイパスするので、動作は継続する。
-- ★migration_2 を実行し、オンボーディングの動作確認をしてから実行推奨。
-- ============================================================

-- 先に付与した広い権限を撤回（anon/authenticated を締め出す）
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 全テーブルで RLS 有効化（ポリシー無し＝anon/authenticatedは全拒否／service_roleはバイパス）
alter table companies         enable row level security;
alter table employees         enable row level security;
alter table conversations     enable row level security;
alter table consultation_logs enable row level security;
alter table user_profiles     enable row level security;
alter table escalations       enable row level security;
alter table learned_patterns  enable row level security;
alter table line_tokens       enable row level security;

-- 確認：RLSが有効か
-- select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind='r';
