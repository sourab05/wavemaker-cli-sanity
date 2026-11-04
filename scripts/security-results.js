'use strict';

const severities = ['critical', 'high', 'moderate', 'low'];
const severity = value => value === 'medium' ? 'moderate' : value;
const validCount = value => Number.isInteger(value) && value >= 0;

function normalizeResult(tool, raw, exitCode) {
  const failed = reason => ({ status: 'failed', reason, findings: [], counts: null });
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return failed('Scanner output is not valid JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object' || data.error) {
    return failed('Scanner returned an error or unsupported output');
  }
  if (exitCode !== 0 && exitCode !== 1) return failed(`Scanner exited with code ${exitCode}`);
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, total: 0 };
  const findings = [];
  if (tool === 'audit') {
    const totals = data.metadata?.vulnerabilities;
    if (data.auditReportVersion !== 2 || !totals || !validCount(totals.total) ||
        !severities.every(s => validCount(totals[s])) ||
        !data.vulnerabilities || typeof data.vulnerabilities !== 'object') {
      return failed('Unsupported or incomplete npm audit schema');
    }
    for (const [name, entry] of Object.entries(data.vulnerabilities)) {
      if (!entry || !severities.includes(severity(entry.severity)) || !Array.isArray(entry.via)) {
        return failed('Invalid npm audit vulnerability entry');
      }
      const before = findings.length;
      for (const advisory of entry.via) {
        if (typeof advisory === 'string') continue; // Transitive reference, not a new advisory.
        if (!advisory || typeof advisory.title !== 'string' || !severities.includes(severity(advisory.severity))) {
          return failed('Invalid npm audit advisory');
        }
        findings.push({
          name, version: entry.range || 'unknown', title: advisory.title,
          severity: severity(advisory.severity), url: advisory.url || '',
          fix: entry.fixAvailable,
        });
      }
      if (findings.length === before) {
        findings.push({
          name, version: entry.range || 'unknown', severity: severity(entry.severity),
          title: 'Vulnerable dependency (transitive reference)', url: '', fix: entry.fixAvailable,
        });
      }
    }
    Object.assign(counts, totals);
    if (severities.reduce((n, s) => n + counts[s], 0) !== counts.total ||
        Object.keys(data.vulnerabilities).length !== counts.total) {
      return failed('Inconsistent npm audit totals');
    }
  } else if (tool === 'snyk') {
    if (typeof data.ok !== 'boolean' || !Array.isArray(data.vulnerabilities) ||
        !validCount(data.dependencyCount) || data.dependencyCount === 0) {
      return failed('Unsupported or incomplete Snyk dependency scan schema');
    }
    const seen = new Set();
    for (const entry of data.vulnerabilities) {
      const sev = severity(entry?.severity);
      if (!entry || !entry.id || !entry.packageName || !entry.title || !severities.includes(sev)) {
        return failed('Invalid Snyk vulnerability entry');
      }
      const key = `${entry.id}:${entry.packageName}:${entry.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[sev]++;
      findings.push({
        name: entry.packageName, version: entry.version || 'unknown',
        title: entry.title, severity: sev,
        url: `https://security.snyk.io/vuln/${encodeURIComponent(entry.id)}`,
        fixedIn: Array.isArray(entry.fixedIn) ? entry.fixedIn.join(', ') : undefined,
      });
    }
    counts.total = findings.length;
    if (data.ok !== (counts.total === 0)) return failed('Inconsistent Snyk status');
  } else {
    return failed('Unknown scanner');
  }
  if (exitCode !== (counts.total > 0 ? 1 : 0)) return failed('Scanner exit code contradicts results');
  return { status: counts.total ? 'findings' : 'clean', findings, counts };
}

function readResult(tool, text) {
  try {
    const envelope = JSON.parse(text);
    if (envelope.format !== 'wm-security-v1' || envelope.tool !== tool ||
        envelope.status === 'failed') {
      return { status: 'failed', reason: 'Missing or failed scan envelope', findings: [], counts: null };
    }
    return normalizeResult(tool, envelope.result, envelope.exitCode);
  } catch {
    return { status: 'failed', reason: 'Missing or malformed structured scan report', findings: [], counts: null };
  }
}

module.exports = { normalizeResult, readResult };
