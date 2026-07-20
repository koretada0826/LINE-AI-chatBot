// ============================================================
// 相談ログ（運営専用・個人特定）API
// ★運営マスタートークン(REPORT_ACCESS_TOKEN)でのみ閲覧可。企業トークンでは絶対に見せない。
// 例: /api/people?token=MASTER&company_id=1&since=30
// ============================================================
import { generatePeopleLogs, peopleLogsHtml } from "../lib/report.js";
import { getCompany } from "../lib/tenant.js";

const REPORT_TOKEN = process.env.REPORT_ACCESS_TOKEN;

export default async function handler(req, res) {
  const token =
    req.query?.token || (req.headers.authorization || "").replace("Bearer ", "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  // ★運営マスタのみ。企業のreport_tokenでは個人特定ログを一切返さない。
  if (!REPORT_TOKEN || token !== REPORT_TOKEN) {
    return res.status(401).send("Unauthorized（この画面は運営専用です）");
  }

  const companyId = req.query?.company_id ? Number(req.query.company_id) : null;
  if (!companyId) return res.status(400).send("company_id が必要です");

  const sinceDays = req.query?.since ? Number(req.query.since) : null;
  const periodLabel = sinceDays ? `直近${sinceDays}日` : "全期間";
  const c = await getCompany(companyId);
  const rep = await generatePeopleLogs(companyId, sinceDays);
  if (!rep) return res.status(500).send("ログ取得に失敗しました（Supabase未接続の可能性）");
  return res.status(200).send(peopleLogsHtml(rep, c?.name || "", periodLabel, token));
}
