// ============================================================
// 請求API（トークン保護）
// 例: /api/billing?token=XXX&month=2026-07
//   token    : 運営のREPORT_ACCESS_TOKEN（全社一覧＋company_idで各社明細）
//              / 会社のreport_token（自社の請求明細のみ）
//   month    : 対象月 YYYY-MM（未指定＝当月）
//   company_id : 運営トークン時のみ有効（各社明細）
// ============================================================
import {
  computeBilling,
  computeAllBilling,
  billingToHtml,
  billingAdminHtml,
} from "../lib/billing.js";
import {
  getCompanyByReportToken,
  getCompany,
  listCompanies,
} from "../lib/tenant.js";

const REPORT_TOKEN = process.env.REPORT_ACCESS_TOKEN; // 運営マスタ（全社閲覧）

export default async function handler(req, res) {
  const token =
    req.query?.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).send("Unauthorized");

  const isMaster = REPORT_TOKEN && token === REPORT_TOKEN;
  const month = req.query?.month || null;
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!isMaster) {
    // 会社トークン → その会社の請求のみ（他社は見えない）
    const company = await getCompanyByReportToken(token);
    if (!company) return res.status(401).send("Unauthorized");
    const full = await getCompany(company.id); // billing_config を含む全カラム
    const b = await computeBilling(full || company, month);
    return res.status(200).send(billingToHtml(b));
  }

  // 運営：company_id指定なら各社明細、なければ全社一覧
  const companyId = req.query?.company_id ? Number(req.query.company_id) : null;
  if (companyId) {
    const c = await getCompany(companyId);
    if (!c) return res.status(404).send("company not found");
    const b = await computeBilling(c, month);
    const back = `/api/billing?token=${encodeURIComponent(token)}${
      month ? `&month=${encodeURIComponent(month)}` : ""
    }`;
    return res.status(200).send(billingToHtml(b, back));
  }
  const companies = await listCompanies();
  const rows = await computeAllBilling(companies, month);
  return res.status(200).send(billingAdminHtml(rows, month, token));
}
