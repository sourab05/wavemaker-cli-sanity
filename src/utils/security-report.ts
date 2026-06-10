import * as fs from 'fs';
import * as path from 'path';

export interface SecurityReportInput {
  auditReportPath?: string;
  snykReportPath?: string;
  cliVersion?: string;
  cliBinary?: string;
  projectPath?: string;
  rnZipPath?: string;
  rnZipSource?: string;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readReportFile(reportPath?: string): string {
  if (!reportPath || !fs.existsSync(reportPath)) {
    return 'Report not generated.';
  }
  return fs.readFileSync(reportPath, 'utf-8');
}

function buildReportMetaHeader(input: SecurityReportInput): string {
  const generatedAt = new Date().toISOString();
  return [
    'Security Vulnerabilities Report',
    `Generated: ${generatedAt}`,
    `CLI: ${input.cliBinary || 'unknown'} ${input.cliVersion || ''}`.trim(),
    `Project: ${input.projectPath || 'n/a'}`,
    `RN ZIP: ${input.rnZipPath || 'n/a'}`,
    `RN ZIP source: ${input.rnZipSource || 'Studio download'}`,
    '',
  ].join('\n');
}

/** Parse npm audit text for severity summary. */
export function parseAuditSummary(text: string): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, moderate: 0, low: 0, total: 0 };
  if (!text || text === 'Report not generated.') {
    return counts;
  }

  const summaryMatch = text.match(
    /(\d+)\s+vulnerabilities?\s*\((\d+)\s+moderate,\s*(\d+)\s+high,\s*(\d+)\s+critical\)/i
  );
  if (summaryMatch) {
    counts.total = Number(summaryMatch[1]);
    counts.moderate = Number(summaryMatch[2]);
    counts.high = Number(summaryMatch[3]);
    counts.critical = Number(summaryMatch[4]);
    counts.summaryLine = summaryMatch[0];
    return counts;
  }

  const altMatch = text.match(/(\d+)\s+vulnerabilities?\s*\(([^)]+)\)/i);
  if (altMatch) {
    counts.total = Number(altMatch[1]);
    counts.summaryLine = altMatch[0];
    const detail = altMatch[2];
    counts.critical = Number((detail.match(/(\d+)\s+critical/i) || [])[1] || 0);
    counts.high = Number((detail.match(/(\d+)\s+high/i) || [])[1] || 0);
    counts.moderate = Number((detail.match(/(\d+)\s+moderate/i) || [])[1] || 0);
    counts.low = Number((detail.match(/(\d+)\s+low/i) || [])[1] || 0);
    return counts;
  }

  if (text.includes('No vulnerabilities found')) {
    return counts;
  }

  counts.critical = (text.match(/Severity:\s*critical/gi) || []).length;
  counts.high = (text.match(/Severity:\s*high/gi) || []).length;
  counts.moderate = (text.match(/Severity:\s*moderate/gi) || []).length;
  counts.low = (text.match(/Severity:\s*low/gi) || []).length;
  counts.total = counts.critical + counts.high + counts.moderate + counts.low;
  return counts;
}

/** Parse Snyk CLI text output for severity summary. */
export function parseSnykSummary(text: string): SeverityCounts {
  const counts: SeverityCounts = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    total: 0,
  };
  if (!text || text === 'Report not generated.') {
    return counts;
  }

  const header = text.match(/found\s+(\d+)\s+issues?,?\s+(\d+)\s+vulnerable\s+paths/i);
  if (header) {
    counts.issues = Number(header[1]);
    counts.paths = Number(header[2]);
  }

  counts.critical = (text.match(/\[Critical Severity\]/gi) || []).length;
  counts.high = (text.match(/\[High Severity\]/gi) || []).length;
  counts.moderate = (text.match(/\[Medium Severity\]/gi) || []).length;
  counts.low = (text.match(/\[Low Severity\]/gi) || []).length;
  counts.total = counts.critical + counts.high + counts.moderate + counts.low;
  if (!counts.total && counts.issues) {
    counts.total = counts.issues;
  }
  return counts;
}

function severityCard(label: string, value: number, className: string): string {
  return `
    <div class="stat-card ${className}">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
    </div>`;
}

function buildSummaryStrip(title: string, counts: SeverityCounts, extra?: string): string {
  return `
    <div class="summary-strip">
      <h3>${escapeHtml(title)}</h3>
      ${extra ? `<p class="summary-extra">${escapeHtml(extra)}</p>` : ''}
      <div class="stat-grid">
        ${severityCard('Total', counts.total, 'stat-total')}
        ${severityCard('Critical', counts.critical, 'stat-critical')}
        ${severityCard('High', counts.high, 'stat-high')}
        ${severityCard('Moderate', counts.moderate, 'stat-moderate')}
        ${severityCard('Low', counts.low, 'stat-low')}
      </div>
    </div>`;
}

/** Build a combined plain-text report from npm audit and Snyk outputs. */
export function buildSecurityReportText(input: SecurityReportInput): string {
  const auditBody = readReportFile(input.auditReportPath);
  const snykBody = readReportFile(input.snykReportPath);

  return [
    buildReportMetaHeader(input),
    '=== npm audit ===',
    auditBody,
    '',
    '=== Snyk ===',
    snykBody,
    '',
  ].join('\n');
}

/** Build a single-file HTML report (Allure-style dashboard). */
export function buildSecurityReportHtml(input: SecurityReportInput): string {
  const auditBody = readReportFile(input.auditReportPath);
  const snykBody = readReportFile(input.snykReportPath);
  const generatedAt = new Date().toISOString();
  const auditSummary = parseAuditSummary(auditBody);
  const snykSummary = parseSnykSummary(snykBody);

  const combinedTotal = auditSummary.total + (snykSummary.issues ?? snykSummary.total);
  const statusClass = combinedTotal > 0 ? 'status-fail' : 'status-pass';
  const statusLabel = combinedTotal > 0 ? 'Vulnerabilities detected' : 'No issues reported';

  const snykExtra =
    snykSummary.issues != null && snykSummary.paths != null
      ? `${snykSummary.issues} issues across ${snykSummary.paths} vulnerable paths`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Security Vulnerabilities Report</title>
  <style>
    :root {
      --bg: #0f1419;
      --surface: #1b222c;
      --surface-2: #242b36;
      --border: #2d3642;
      --text: #e8edf3;
      --muted: #8b98a8;
      --accent: #4dabf7;
      --pass: #3dd68c;
      --fail: #ff6b6b;
      --critical: #ff4757;
      --high: #ff7f50;
      --moderate: #ffa502;
      --low: #70a1ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .topbar {
      background: linear-gradient(135deg, #1a2332 0%, #0d3d56 100%);
      padding: 20px 32px;
      border-bottom: 1px solid var(--border);
    }
    .topbar h1 { margin: 0 0 4px; font-size: 1.5rem; font-weight: 600; }
    .topbar .subtitle { color: var(--muted); font-size: 0.9rem; }
    .status-badge {
      display: inline-block;
      margin-top: 12px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-pass { background: rgba(61, 214, 140, 0.15); color: var(--pass); }
    .status-fail { background: rgba(255, 107, 107, 0.15); color: var(--fail); }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px 32px 48px; }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 28px;
    }
    .meta-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .meta-item .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .meta-item .value { font-size: 0.9rem; margin-top: 4px; word-break: break-word; }
    .summary-strip {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .summary-strip h3 { margin: 0 0 8px; font-size: 1.1rem; }
    .summary-extra { color: var(--muted); font-size: 0.85rem; margin: 0 0 16px; }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 12px;
    }
    .stat-card {
      background: var(--surface-2);
      border-radius: 8px;
      padding: 14px;
      text-align: center;
      border: 1px solid var(--border);
    }
    .stat-value { font-size: 1.75rem; font-weight: 700; line-height: 1.2; }
    .stat-label { font-size: 0.75rem; color: var(--muted); margin-top: 4px; }
    .stat-critical .stat-value { color: var(--critical); }
    .stat-high .stat-value { color: var(--high); }
    .stat-moderate .stat-value { color: var(--moderate); }
    .stat-low .stat-value { color: var(--low); }
    .stat-total .stat-value { color: var(--accent); }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 0;
      border-bottom: 1px solid var(--border);
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 12px 20px;
      cursor: pointer;
      font-size: 0.95rem;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tab-panel { display: none; padding-top: 16px; }
    .tab-panel.active { display: block; }
    pre.report-body {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.8rem;
      line-height: 1.45;
      max-height: 70vh;
    }
    footer {
      margin-top: 32px;
      text-align: center;
      color: var(--muted);
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <h1>Security Vulnerabilities Report</h1>
    <div class="subtitle">WaveMaker React Native CLI — npm audit &amp; Snyk</div>
    <span class="status-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
  </header>
  <main class="container">
    <div class="meta-grid">
      <div class="meta-item"><div class="label">Generated</div><div class="value">${escapeHtml(generatedAt)}</div></div>
      <div class="meta-item"><div class="label">CLI</div><div class="value">${escapeHtml(input.cliBinary || 'unknown')} ${escapeHtml(input.cliVersion || '')}</div></div>
      <div class="meta-item"><div class="label">Project</div><div class="value">${escapeHtml(input.projectPath || 'n/a')}</div></div>
      <div class="meta-item"><div class="label">RN ZIP</div><div class="value">${escapeHtml(input.rnZipPath || 'n/a')}</div></div>
      <div class="meta-item"><div class="label">RN ZIP source</div><div class="value">${escapeHtml(input.rnZipSource || 'Studio download')}</div></div>
    </div>

    ${buildSummaryStrip('npm audit', auditSummary, auditSummary.summaryLine || undefined)}
    ${buildSummaryStrip('Snyk', snykSummary, snykExtra || undefined)}

    <div class="tabs" role="tablist">
      <button class="tab-btn active" type="button" data-tab="audit" role="tab">npm audit</button>
      <button class="tab-btn" type="button" data-tab="snyk" role="tab">Snyk</button>
    </div>
    <div id="tab-audit" class="tab-panel active" role="tabpanel">
      <pre class="report-body">${escapeHtml(auditBody)}</pre>
    </div>
    <div id="tab-snyk" class="tab-panel" role="tabpanel">
      <pre class="report-body">${escapeHtml(snykBody)}</pre>
    </div>

    <footer>Generated by wavemaker-cli-sanity security pipeline</footer>
  </main>
  <script>
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });
  </script>
</body>
</html>`;
}

export function writeSecurityReportTxt(
  outputDir: string,
  input: SecurityReportInput,
  filename = 'security-vulnerabilities.txt'
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, filename);
  fs.writeFileSync(reportPath, buildSecurityReportText(input), 'utf-8');
  return reportPath;
}

export function writeSecurityReport(
  outputDir: string,
  input: SecurityReportInput,
  filename = 'index.html'
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const indexPath = path.join(outputDir, filename);
  fs.writeFileSync(indexPath, buildSecurityReportHtml(input), 'utf-8');
  return indexPath;
}
