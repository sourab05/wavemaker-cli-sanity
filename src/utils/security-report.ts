import * as fs from 'fs';
import * as path from 'path';
import { resolveSecurityReleaseVersion } from '../config/security-project';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SecurityReportInput {
  auditReportPath?: string;
  snykReportPath?: string;
  cliVersion?: string;
  cliBinary?: string;
  projectPath?: string;
  rnZipPath?: string;
  rnZipSource?: string;
  /** Release label for report section, e.g. 12.0.0 → "12.0.0 Release" */
  releaseVersion?: string;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
  total: number;
  summaryLine?: string;
  issues?: number;
  paths?: number;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface AuditPackage {
  name: string;
  versionRange: string;
  severity: string;
  advisories: Array<{ title: string; url: string }>;
  fix: 'none' | 'audit-fix' | 'audit-fix-force';
  fixNote?: string;
}

interface SnykIssue {
  title: string;
  severity: string;
  url: string;
  fixedIn?: string;
}

interface SnykPackage {
  name: string;
  version: string;
  issues: SnykIssue[];
  maxSeverity: string;
}

interface UnifiedIssue {
  title: string;
  severity: string;
  auditUrl?: string;
  snykUrl?: string;
  snykFixedIn?: string;
  sources: ('audit' | 'snyk')[];
}

interface CombinedPackage {
  name: string;
  version: string;
  inAudit: boolean;
  inSnyk: boolean;
  worstSeverity: string;
  audit?: AuditPackage;
  snyk?: SnykPackage;
  unifiedIssues: UnifiedIssue[];
  auditOnlyCount: number;
  snykOnlyCount: number;
  bothCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(v: string): string {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readReportFile(p?: string): string {
  if (!p || !fs.existsSync(p)) return 'Report not generated.';
  return fs.readFileSync(p, 'utf-8');
}

const SEV: Record<string, number> = { critical: 4, high: 3, moderate: 2, medium: 2, low: 1 };
function sevOrd(s: string): number { return SEV[s.toLowerCase()] ?? 0; }
function normSev(s: string): string { return s.toLowerCase() === 'medium' ? 'moderate' : s.toLowerCase(); }
function worstOf(a: string, b: string): string { return sevOrd(a) >= sevOrd(b) ? a : b; }

/**
 * Strip package name prefixes and noise so titles from npm audit and Snyk can
 * be compared. Takes the first 4 significant words as a match key.
 */
function normTitle(title: string): string {
  let t = title.toLowerCase();
  t = t.replace(/^(axios|handlebars\.js|handlebars|lodash-es|lodash|fast-xml-parser|postcss|uuid|inflight|angular\/compiler|@angular\/compiler)[:\s.]+/gi, '');
  t = t.replace(/^(has an?\s+|is\s+|are\s+|vulnerable to\s+|affected by\s+|contains?\s+)/gi, '');
  t = t.replace(/\s*\([a-z\-]{2,12}\)\s*/gi, ' ');
  t = t.replace(/\s+via\s+.+$/gi, '').replace(/\s+in\s+\S+$/, '');
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const stop = new Set(['a','an','the','in','of','to','and','or','for','with','by','through','that','this','its','from']);
  return t.split(' ').filter(w => w.length > 2 && !stop.has(w)).slice(0, 4).join(' ');
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseAuditPackages(text: string): AuditPackage[] {
  if (!text || text === 'Report not generated.') return [];
  const packages: AuditPackage[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const pkgM = lines[0].match(/^(\S.+?)\s{2,}(.+)$/);
    if (!pkgM) continue;
    const sevM = lines[1].match(/^Severity:\s*(\w+)/i);
    if (!sevM) continue;
    const name = pkgM[1].trim();
    const versionRange = pkgM[2].trim();
    const severity = normSev(sevM[1]);
    const advisories: AuditPackage['advisories'] = [];
    let fix: AuditPackage['fix'] = 'none';
    let fixNote: string | undefined;
    for (let i = 2; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('node_modules/') || /^\s{2,}/.test(l)) continue;
      if (l.includes('npm audit fix --force')) { fix = 'audit-fix-force'; continue; }
      if (l.includes('npm audit fix')) { fix = 'audit-fix'; continue; }
      if (l.startsWith('Will install')) { fixNote = l.replace('Will install ', '').trim(); continue; }
      const adv = l.match(/^(.+?)\s+-\s+(https?:\/\/\S+)$/);
      if (adv) advisories.push({ title: adv[1].trim(), url: adv[2] });
    }
    packages.push({ name, versionRange, severity, advisories, fix, fixNote });
  }
  return packages;
}

function parseSnykPackages(text: string): SnykPackage[] {
  if (!text || text === 'Report not generated.') return [];
  const map = new Map<string, SnykPackage>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/✗\s+(.+?)\s+\[(\w+)\s+Severity\]\[(https?:\/\/\S+)\]\s+in\s+(\S+?)@(\S+)/);
    if (!m) continue;
    const [, title, sevWord, url, pkgName, pkgVer] = m;
    const severity = normSev(sevWord);
    let fixedIn: string | undefined;
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
      const fm = lines[j].match(/This issue was fixed in versions:\s*(.+)/);
      if (fm) { fixedIn = fm[1].trim(); break; }
    }
    if (!map.has(pkgName)) map.set(pkgName, { name: pkgName, version: pkgVer, issues: [], maxSeverity: 'low' });
    const entry = map.get(pkgName)!;
    // Dedup: same CVE appears once per upgrade path — deduplicate by URL
    if (!entry.issues.some(e => e.url === url)) {
      entry.issues.push({ title, severity, url, fixedIn });
      if (sevOrd(severity) > sevOrd(entry.maxSeverity)) entry.maxSeverity = severity;
    }
  }
  return Array.from(map.values());
}

function mergeIssues(audit: AuditPackage | undefined, snyk: SnykPackage | undefined): UnifiedIssue[] {
  if (!audit && !snyk) return [];
  if (!audit) return snyk!.issues.map(i => ({ title: i.title, severity: i.severity, snykUrl: i.url, snykFixedIn: i.fixedIn, sources: ['snyk'] as ('audit'|'snyk')[] }));
  if (!snyk)  return audit.advisories.map(a => ({ title: a.title, severity: audit.severity, auditUrl: a.url, sources: ['audit'] as ('audit'|'snyk')[] }));

  const result: UnifiedIssue[] = [];
  const usedSnyk = new Set<number>();

  for (const adv of audit.advisories) {
    const normA = normTitle(adv.title);
    let matchIdx = -1;
    for (let j = 0; j < snyk.issues.length; j++) {
      if (usedSnyk.has(j)) continue;
      const normS = normTitle(snyk.issues[j].title);
      if (normA === normS || (normA.length > 8 && normS.startsWith(normA)) || (normS.length > 8 && normA.startsWith(normS))) {
        matchIdx = j; break;
      }
    }
    if (matchIdx >= 0) {
      usedSnyk.add(matchIdx);
      const si = snyk.issues[matchIdx];
      result.push({ title: adv.title, severity: worstOf(audit.severity, si.severity), auditUrl: adv.url, snykUrl: si.url, snykFixedIn: si.fixedIn, sources: ['audit', 'snyk'] });
    } else {
      result.push({ title: adv.title, severity: audit.severity, auditUrl: adv.url, sources: ['audit'] });
    }
  }
  for (let j = 0; j < snyk.issues.length; j++) {
    if (!usedSnyk.has(j)) {
      const si = snyk.issues[j];
      result.push({ title: si.title, severity: si.severity, snykUrl: si.url, snykFixedIn: si.fixedIn, sources: ['snyk'] });
    }
  }
  result.sort((a, b) => sevOrd(b.severity) - sevOrd(a.severity) || b.sources.length - a.sources.length);
  return result;
}

function combinePackages(auditPkgs: AuditPackage[], snykPkgs: SnykPackage[]): CombinedPackage[] {
  const map = new Map<string, CombinedPackage>();
  for (const ap of auditPkgs) map.set(ap.name, { name: ap.name, version: ap.versionRange, inAudit: true, inSnyk: false, worstSeverity: ap.severity, audit: ap, unifiedIssues: [], auditOnlyCount: 0, snykOnlyCount: 0, bothCount: 0 });
  for (const sp of snykPkgs) {
    if (map.has(sp.name)) {
      const e = map.get(sp.name)!;
      e.inSnyk = true; e.snyk = sp;
      e.worstSeverity = worstOf(e.worstSeverity, sp.maxSeverity);
    } else {
      map.set(sp.name, { name: sp.name, version: sp.version, inAudit: false, inSnyk: true, worstSeverity: sp.maxSeverity, snyk: sp, unifiedIssues: [], auditOnlyCount: 0, snykOnlyCount: 0, bothCount: 0 });
    }
  }
  for (const cp of map.values()) {
    cp.unifiedIssues = mergeIssues(cp.audit, cp.snyk);
    cp.bothCount      = cp.unifiedIssues.filter(i => i.sources.length === 2).length;
    cp.auditOnlyCount = cp.unifiedIssues.filter(i => i.sources.length === 1 && i.sources[0] === 'audit').length;
    cp.snykOnlyCount  = cp.unifiedIssues.filter(i => i.sources.length === 1 && i.sources[0] === 'snyk').length;
  }
  return Array.from(map.values()).sort((a, b) => sevOrd(b.worstSeverity) - sevOrd(a.worstSeverity) || a.name.localeCompare(b.name));
}

// ─── Table row builders (Vulnerability Report format) ─────────────────────────

interface ReportTableRow {
  title: string;
  severity: string;
  packageName: string;
  affectedVersion: string;
  fixHtml: string;
  src: 'both' | 'audit' | 'snyk';
}

function resolveReleaseVersion(input: SecurityReportInput): string {
  return resolveSecurityReleaseVersion(input.releaseVersion);
}

function formatFooterDate(): string {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function sevBadgeLight(sev: string): string {
  const s = normSev(sev);
  const label = s === 'moderate' ? 'Medium' : s.charAt(0).toUpperCase() + s.slice(1);
  const cls = s === 'high' || s === 'critical' ? 'high' : 'moderate';
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function formatFixCell(issue: UnifiedIssue, audit?: AuditPackage): { html: string; hasFix: boolean } {
  if (issue.snykFixedIn) {
    const v = issue.snykFixedIn.trim();
    const text = /^[\d<]/.test(v) ? v : `Fixed in ${v}`;
    return { html: escapeHtml(text), hasFix: true };
  }
  if (audit?.fix === 'audit-fix-force') {
    return { html: 'Fix available via <code>npm audit fix --force</code>', hasFix: true };
  }
  if (audit?.fix === 'audit-fix') {
    return { html: 'Fix available via <code>npm audit fix</code>', hasFix: true };
  }
  if (issue.sources.includes('snyk') && !issue.sources.includes('audit')) {
    return { html: 'No upgrade or patch available', hasFix: false };
  }
  return { html: 'No fix available', hasFix: false };
}

function flattenToTableRows(combined: CombinedPackage[]): ReportTableRow[] {
  const rows: ReportTableRow[] = [];
  for (const cp of combined) {
    for (const issue of cp.unifiedIssues) {
      const isBoth = issue.sources.length === 2;
      const src: ReportTableRow['src'] = isBoth ? 'both' : issue.sources[0] === 'audit' ? 'audit' : 'snyk';
      const fix = formatFixCell(issue, cp.audit);
      const fixClass = fix.hasFix ? 'fix-available' : 'no-fix';
      rows.push({
        title: issue.title,
        severity: issue.severity,
        packageName: cp.name,
        affectedVersion: cp.version,
        fixHtml: `<td class="${fixClass}">${fix.html}</td>`,
        src,
      });
    }
  }
  rows.sort((a, b) => sevOrd(b.severity) - sevOrd(a.severity) || a.packageName.localeCompare(b.packageName));
  return rows;
}

function buildTableRowsHtml(rows: ReportTableRow[]): string {
  if (rows.length === 0) {
    return '<tr><td colspan="5" style="text-align:center;color:#888;padding:24px">No vulnerabilities found.</td></tr>';
  }
  return rows.map(r => `
        <tr data-src="${r.src}">
          <td>${escapeHtml(r.title)}</td>
          <td>${sevBadgeLight(r.severity)}</td>
          <td><code>${escapeHtml(r.packageName)}</code></td>
          <td>${escapeHtml(r.affectedVersion)}</td>
          ${r.fixHtml}
        </tr>`).join('');
}

function buildSourceFilterBar(rows: ReportTableRow[]): string {
  const all = rows.length;
  const both = rows.filter(r => r.src === 'both').length;
  const audit = rows.filter(r => r.src === 'audit').length;
  const snyk = rows.filter(r => r.src === 'snyk').length;
  const parts = [`<button class="src-btn active" data-src="all">All (${all})</button>`];
  if (both > 0) parts.push(`<button class="src-btn" data-src="both">★ Both (${both})</button>`);
  if (audit > 0) parts.push(`<button class="src-btn" data-src="audit">npm audit (${audit})</button>`);
  if (snyk > 0) parts.push(`<button class="src-btn" data-src="snyk">Snyk (${snyk})</button>`);
  return parts.join('');
}

// ─── Public summary parsers (used by upload script) ──────────────────────────

export function parseAuditSummary(text: string): SeverityCounts {
  const c: SeverityCounts = { critical: 0, high: 0, moderate: 0, low: 0, total: 0 };
  if (!text || text === 'Report not generated.') return c;
  const m = text.match(/(\d+)\s+vulnerabilities?\s*\(([^)]+)\)/i);
  if (m) {
    c.total    = Number(m[1]); c.summaryLine = m[0];
    const d    = m[2];
    c.critical = Number((d.match(/(\d+)\s+critical/i)  || [])[1] || 0);
    c.high     = Number((d.match(/(\d+)\s+high/i)      || [])[1] || 0);
    c.moderate = Number((d.match(/(\d+)\s+moderate/i)  || [])[1] || 0);
    c.low      = Number((d.match(/(\d+)\s+low/i)       || [])[1] || 0);
    return c;
  }
  if (text.includes('No vulnerabilities found')) return c;
  c.critical = (text.match(/Severity:\s*critical/gi) || []).length;
  c.high     = (text.match(/Severity:\s*high/gi)     || []).length;
  c.moderate = (text.match(/Severity:\s*moderate/gi) || []).length;
  c.low      = (text.match(/Severity:\s*low/gi)      || []).length;
  c.total    = c.critical + c.high + c.moderate + c.low;
  return c;
}

export function parseSnykSummary(text: string): SeverityCounts {
  const c: SeverityCounts = { critical: 0, high: 0, moderate: 0, low: 0, total: 0 };
  if (!text || text === 'Report not generated.') return c;
  const h = text.match(/found\s+(\d+)\s+issues?,?\s+(\d+)\s+vulnerable\s+paths/i);
  if (h) { c.issues = Number(h[1]); c.paths = Number(h[2]); }
  c.critical = (text.match(/\[Critical Severity\]/gi) || []).length;
  c.high     = (text.match(/\[High Severity\]/gi)     || []).length;
  c.moderate = (text.match(/\[Medium Severity\]/gi)   || []).length;
  c.low      = (text.match(/\[Low Severity\]/gi)      || []).length;
  c.total    = c.critical + c.high + c.moderate + c.low;
  if (!c.total && c.issues) c.total = c.issues;
  return c;
}

// ─── Text report ──────────────────────────────────────────────────────────────

export function buildSecurityReportText(input: SecurityReportInput): string {
  const auditBody = readReportFile(input.auditReportPath);
  const snykBody  = readReportFile(input.snykReportPath);
  return ['Security Vulnerabilities Report', `Generated: ${new Date().toISOString()}`,
    `CLI: ${input.cliBinary || 'unknown'} ${input.cliVersion || ''}`.trim(),
    `Project: ${input.projectPath || 'n/a'}`,
    `RN ZIP source: ${input.rnZipSource || 'Studio download'}`,
    '', '=== npm audit ===', auditBody, '', '=== Snyk ===', snykBody, ''].join('\n');
}

// ─── HTML report ──────────────────────────────────────────────────────────────

export function buildSecurityReportHtml(input: SecurityReportInput): string {
  const auditBody = readReportFile(input.auditReportPath);
  const snykBody  = readReportFile(input.snykReportPath);

  const auditPkgs = parseAuditPackages(auditBody);
  const snykPkgs  = parseSnykPackages(snykBody);
  const combined  = combinePackages(auditPkgs, snykPkgs);
  const tableRows = flattenToTableRows(combined);

  const sevTotals = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const r of tableRows) {
    const s = normSev(r.severity);
    if (s === 'critical') sevTotals.critical++;
    else if (s === 'high') sevTotals.high++;
    else if (s === 'moderate') sevTotals.moderate++;
    else if (s === 'low') sevTotals.low++;
  }

  const totalVulns = tableRows.length;
  const highCount = sevTotals.high + sevTotals.critical;
  const medModerate = sevTotals.moderate + sevTotals.low;
  const releaseVersion = resolveReleaseVersion(input);
  const sectionTitle = escapeHtml(releaseVersion) + ' Release';
  const footerDate = formatFooterDate();
  const filterBar = buildSourceFilterBar(tableRows);
  const tableBody = buildTableRowsHtml(tableRows);

  const criticalCard = sevTotals.critical > 0
    ? '<div class="card crit-card"><div class="num">' + sevTotals.critical + '</div><div class="label">Critical</div></div>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vulnerability Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f0f2f5; color: #1a1a2e; padding: 2rem;
  }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 0.3rem; color: #1a1a2e; }
  .subtitle { color: #666; margin-bottom: 1.5rem; font-size: 0.95rem; }
  .section-title {
    font-size: 1.1rem; font-weight: 600; color: #1a1a2e;
    margin: 2rem 0 0.8rem; padding-bottom: 0.4rem;
    border-bottom: 2px solid #ddd;
  }
  .filter-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .src-btn {
    background: #fff; border: 1px solid #ddd; color: #555;
    border-radius: 20px; padding: 5px 14px; cursor: pointer; font-size: 0.82rem;
  }
  .src-btn:hover { border-color: #1a1a2e; color: #1a1a2e; }
  .src-btn.active { background: #1a1a2e; border-color: #1a1a2e; color: #fff; font-weight: 600; }
  .table-wrapper {
    background: #fff; border-radius: 12px; padding: 1.5rem;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow-x: auto;
    margin-bottom: 1.5rem;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  thead th {
    background: #1a1a2e; color: #fff; padding: 12px 16px;
    text-align: left; font-weight: 600;
  }
  thead th:first-child { border-radius: 8px 0 0 0; }
  thead th:last-child { border-radius: 0 8px 0 0; }
  tbody td { padding: 11px 16px; border-bottom: 1px solid #eee; }
  tbody tr:hover { background: #f7f8fc; }
  tbody tr:nth-child(even) { background: #fafbfd; }
  tbody tr:nth-child(even):hover { background: #f0f1f5; }
  tbody tr.hidden { display: none; }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 20px;
    font-size: 0.78rem; font-weight: 600; text-transform: uppercase;
  }
  .high { background: #fde8e8; color: #c0392b; }
  .moderate { background: #fef3e2; color: #d68910; }
  .fix-available { color: #27ae60; font-weight: 500; }
  .fix-available code { background: #eef9f2; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
  .no-fix { color: #c0392b; font-weight: 500; }
  .summary-cards { display: flex; gap: 1rem; margin-bottom: 1.8rem; flex-wrap: wrap; }
  .card {
    flex: 1; min-width: 140px; background: #fff; border-radius: 10px;
    padding: 1.2rem; text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .card .num { font-size: 2rem; font-weight: 700; }
  .card .label { font-size: 0.82rem; color: #888; margin-top: 0.2rem; }
  .card.high-card .num { color: #c0392b; }
  .card.med-card .num { color: #d68910; }
  .card.crit-card .num { color: #8b0000; }
  .card.total-card .num { color: #1a1a2e; }
  footer { text-align: center; margin-top: 2rem; color: #999; font-size: 0.8rem; }
  code { font-family: 'Fira Code', 'Courier New', monospace; }
</style>
</head>
<body>
<div class="container">
  <h1>Vulnerability Report</h1>
  <p class="subtitle">Security audit findings &mdash; npm audit &amp; Snyk &mdash; generated ${escapeHtml(footerDate)}</p>

  <div class="summary-cards">
    <div class="card total-card">
      <div class="num">${totalVulns}</div>
      <div class="label">Total Issues</div>
    </div>
    ${criticalCard}
    <div class="card high-card">
      <div class="num">${highCount}</div>
      <div class="label">High Severity</div>
    </div>
    <div class="card med-card">
      <div class="num">${medModerate}</div>
      <div class="label">Medium / Moderate</div>
    </div>
  </div>

  <div class="section-title">${sectionTitle}</div>
  <div class="filter-bar">${filterBar}</div>
  <div class="table-wrapper">
    <table id="vuln-table">
      <thead>
        <tr>
          <th>Issue Description</th>
          <th>Severity</th>
          <th>Package</th>
          <th>Affected Version</th>
          <th>Fixed Version / Status</th>
        </tr>
      </thead>
      <tbody>
        ${tableBody}
      </tbody>
    </table>
  </div>

  <footer>Generated from security audit data &mdash; ${escapeHtml(footerDate)}</footer>
</div>
<script>
  document.querySelectorAll('.src-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.src-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const src = btn.dataset.src;
      document.querySelectorAll('#vuln-table tbody tr').forEach(row => {
        const show = src === 'all' || row.dataset.src === src;
        row.classList.toggle('hidden', !show);
      });
    });
  });
</script>
</body>
</html>`;
}

// ─── File writers ─────────────────────────────────────────────────────────────

export function writeSecurityReportTxt(outputDir: string, input: SecurityReportInput, filename = 'security-vulnerabilities.txt'): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const p = path.join(outputDir, filename);
  fs.writeFileSync(p, buildSecurityReportText(input), 'utf-8');
  return p;
}

export function writeSecurityReport(outputDir: string, input: SecurityReportInput, filename = 'index.html'): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const p = path.join(outputDir, filename);
  fs.writeFileSync(p, buildSecurityReportHtml(input), 'utf-8');
  return p;
}
