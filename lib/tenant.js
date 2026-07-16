// ============================================================
// テナント（会社）と社員（オンボーディング）のデータ層
// 会社は運営が事前登録。社員は登録するまで相談機能を使えない。
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const memEmployees = new Map(); // 開発用フォールバック

// 社員レコードを取得（未登録なら null 相当）
export async function getEmployee(userId) {
  if (!supabase) return memEmployees.get(userId) ?? null;
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .eq("line_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("getEmployee error:", error.message);
    return null;
  }
  return data ?? null;
}

// 社員レコードを作成/更新（オンボーディング進捗の保存に使う）
export async function upsertEmployee(userId, fields) {
  if (!supabase) {
    const cur = memEmployees.get(userId) ?? { line_user_id: userId };
    const next = { ...cur, ...fields };
    memEmployees.set(userId, next);
    return next;
  }
  const { data, error } = await supabase
    .from("employees")
    .upsert({ line_user_id: userId, ...fields }, { onConflict: "line_user_id" })
    .select()
    .maybeSingle();
  if (error) console.error("upsertEmployee error:", error.message);
  return data;
}

// 会社を検索（名前の部分一致 or 企業コードの完全一致）。運営が事前登録した会社から選ばせる。
export async function searchCompanies(query) {
  if (!supabase) return [];
  const q = (query || "").trim();
  if (!q) return [];
  // 企業コード完全一致を優先
  const byCode = await supabase
    .from("companies")
    .select("id, name, invite_code")
    .eq("invite_code", q)
    .limit(5);
  if (byCode.data && byCode.data.length) return byCode.data;
  // 名前の部分一致
  const byName = await supabase
    .from("companies")
    .select("id, name, invite_code")
    .ilike("name", `%${q}%`)
    .limit(8);
  if (byName.error) {
    console.error("searchCompanies error:", byName.error.message);
    return [];
  }
  return byName.data ?? [];
}

// 会社一覧（登録フォームのドロップダウン用）
export async function listCompanies() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, invite_code")
    .order("name");
  if (error) {
    console.error("listCompanies error:", error.message);
    return [];
  }
  return data ?? [];
}

export async function getCompany(companyId) {
  if (!supabase || !companyId) return null;
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("id", companyId)
    .maybeSingle();
  if (error) {
    console.error("getCompany error:", error.message);
    return null;
  }
  return data ?? null;
}
