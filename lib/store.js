// ============================================================
// 会話記憶・相談ログの保存（Supabase）
// 深掘りヒアリングには「過去の会話」が必要なため、ユーザーごとに履歴を持つ。
// Supabaseの環境変数が未設定でも動くよう、インメモリにフォールバックする
// （※インメモリはサーバー再起動で消える。動作確認用。本番はSupabase必須）
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HISTORY_LIMIT = 20; // 直近何ターンをAIに渡すか

const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Supabaseが接続されているか（トークン自動更新などの永続化機能の有効判定に使う）
export const persistenceEnabled = !!supabase;

// インメモリのフォールバック
const memHistory = new Map(); // userId -> [{role, content}]
const memUserProfile = new Map(); // userId -> {profile, updated_at}（長期プロフィール）

// 直近の会話履歴を取得（古い順）
export async function getHistory(userId) {
  if (!supabase) return memHistory.get(userId) ?? [];
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("line_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    console.error("getHistory error:", error.message);
    return [];
  }
  return (data ?? []).reverse().map((r) => ({ role: r.role, content: r.content }));
}

// 1発言を履歴に追記（company_id で会社ごとに分離）
export async function appendTurn(userId, role, content, companyId = null) {
  if (!supabase) {
    const arr = memHistory.get(userId) ?? [];
    arr.push({ role, content });
    memHistory.set(userId, arr.slice(-HISTORY_LIMIT));
    return;
  }
  const { error } = await supabase
    .from("conversations")
    .insert({ line_user_id: userId, role, content, company_id: companyId });
  if (error) console.error("appendTurn error:", error.message);
}

// 相談ログ（対応区分・リスク・要約）を保存（company_id で会社ごとに集計）
export async function logConsultation(userId, result, companyId = null, department = null) {
  if (!supabase) return; // フォールバック時はログ保存なし
  const { error } = await supabase.from("consultation_logs").insert({
    line_user_id: userId,
    company_id: companyId,
    department: department || null, // 部署別レポート用（相談時点の部署を非正規化）
    category: result.category,
    risk_level: result.risk_level,
    topic: result.topic,
    summary: result.summary,
    escalated: result.escalate,
  });
  if (error) console.error("logConsultation error:", error.message);
}

// --- 継続学習ループ ---

// 相手の蓄積プロフィールを取得（会話を重ねるほど賢くなる土台）
export async function getUserProfile(userId) {
  if (!supabase) return memUserProfile.get(userId) ?? { profile: null, updated_at: null, support_style: null };
  const { data, error } = await supabase
    .from("user_profiles")
    .select("profile, updated_at, support_style")
    .eq("line_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("getUserProfile error:", error.message);
    return { profile: null, updated_at: null, support_style: null };
  }
  return {
    profile: data?.profile ?? null,
    updated_at: data?.updated_at ?? null,
    support_style: data?.support_style ?? null,
  };
}

// 会話後アンケートを保存し、支援スタイルの好みを学習する（①③）
export async function saveFeedback(userId, label, companyId = null) {
  // 好みのマッピング（もっと寄り添って=共感重視 / もっと具体的に=解決重視）
  const styleMap = { empathy: "共感重視", solution: "解決重視" };
  if (!supabase) {
    if (styleMap[label]) {
      const cur = memUserProfile.get(userId) ?? { profile: null, updated_at: null };
      memUserProfile.set(userId, { ...cur, support_style: styleMap[label] });
    }
    return;
  }
  const { error: e1 } = await supabase
    .from("feedback")
    .insert({ line_user_id: userId, company_id: companyId, label });
  if (e1) console.error("saveFeedback error:", e1.message);
  if (styleMap[label]) {
    const { error: e2 } = await supabase
      .from("user_profiles")
      .upsert(
        { line_user_id: userId, support_style: styleMap[label] },
        { onConflict: "line_user_id" }
      );
    if (e2) console.error("saveFeedback style error:", e2.message);
  }
}

// 相手のプロフィールを更新（AIが積み上げた全体で上書き）
export async function saveUserProfile(userId, profile) {
  if (!profile || typeof profile !== "object") return;
  const now = new Date().toISOString();
  if (!supabase) {
    const cur = memUserProfile.get(userId) ?? {};
    memUserProfile.set(userId, { ...cur, profile, updated_at: now }); // support_style等を消さない
    return;
  }
  const { error } = await supabase
    .from("user_profiles")
    .upsert(
      { line_user_id: userId, profile, updated_at: now },
      { onConflict: "line_user_id" }
    );
  if (error) console.error("saveUserProfile error:", error.message);
}

// ナレッジで扱いきれなかった論点を記録（ナレッジ育成の材料）
export async function logCoverageGap(userId, result) {
  if (!supabase || !result.coverage_gap) return;
  const { error } = await supabase.from("learned_patterns").insert({
    line_user_id: userId,
    topic: result.topic,
    gap: result.coverage_gap,
    summary: result.summary,
  });
  if (error) console.error("logCoverageGap error:", error.message);
}

// --- 緊急ハンドオフ（人へつなぐ） ---

// エスカレーション記録を残す（対応漏れ防止・SLA管理）
export async function logEscalation(userId, result, companyId = null) {
  if (!supabase) return;
  const { error } = await supabase.from("escalations").insert({
    line_user_id: userId,
    company_id: companyId,
    risk_level: result.risk_level,
    topic: result.topic,
    summary: result.summary,
    status: "open",
  });
  if (error) console.error("logEscalation error:", error.message);
}

// 有人テイクオーバー：一定時間、Botの自動応答を止めて人が対応するモード
const HUMAN_MODE_HOURS = Number(process.env.HUMAN_MODE_HOURS || 12);
const memHumanUntil = new Map(); // userId -> epoch ms

export async function setHumanMode(userId) {
  const until = new Date(Date.now() + HUMAN_MODE_HOURS * 3600 * 1000);
  if (!supabase) {
    memHumanUntil.set(userId, until.getTime());
    return;
  }
  const { error } = await supabase
    .from("user_profiles")
    .upsert(
      { line_user_id: userId, human_mode_until: until.toISOString() },
      { onConflict: "line_user_id" }
    );
  if (error) console.error("setHumanMode error:", error.message);
}

export async function isHumanMode(userId) {
  if (!supabase) {
    const until = memHumanUntil.get(userId);
    return !!until && Date.now() < until;
  }
  const { data, error } = await supabase
    .from("user_profiles")
    .select("human_mode_until")
    .eq("line_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("isHumanMode error:", error.message);
    return false;
  }
  return !!data?.human_mode_until && Date.now() < Date.parse(data.human_mode_until);
}

// --- LINEアクセストークンの永続化（自動更新用） ---

export async function getLineToken() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("line_tokens")
    .select("token, expires_at")
    .eq("channel_id", process.env.LINE_CHANNEL_ID || "default")
    .maybeSingle();
  if (error) {
    console.error("getLineToken error:", error.message);
    return null;
  }
  return data ?? null;
}

export async function saveLineToken(token, expiresAtISO) {
  if (!supabase) return;
  const { error } = await supabase.from("line_tokens").upsert(
    {
      channel_id: process.env.LINE_CHANNEL_ID || "default",
      token,
      expires_at: expiresAtISO,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "channel_id" }
  );
  if (error) console.error("saveLineToken error:", error.message);
}
