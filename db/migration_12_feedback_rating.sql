-- ============================================================
-- migration_12_feedback_rating : 会話後アンケートを「1〜5評価＋理由」に拡張
-- ============================================================
alter table feedback add column if not exists rating integer;   -- 1〜5
alter table feedback add column if not exists reason text;       -- 評価の理由（自由記述）
-- 「理由の入力待ち」状態を保持（次のテキストを理由として拾うため）
alter table user_profiles add column if not exists pending_feedback jsonb;
