#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';

const suite = process.argv[2] || 'smoke';
if (!['smoke', 'regression'].includes(suite)) {
  console.error('Usage: node scripts/run-maestro-report.mjs smoke|regression');
  process.exit(2);
}

const root = process.cwd();
const reportDir = join(root, 'reports', suite);
const flowDir = join(root, '.maestro', suite);
const testDataDir = join(root, '.maestro', 'test-data');
const testData = {
  ...parse(readFileSync(join(testDataDir, 'users.yaml'), 'utf8')),
  ...parse(readFileSync(join(testDataDir, 'tasks.yaml'), 'utf8')),
  ...parse(readFileSync(join(testDataDir, 'invalid-data.yaml'), 'utf8')),
};
const variableNames = [
  'QA_EMAIL', 'QA_PASSWORD', 'INVALID_PASSWORD', 'TASK_TITLE',
  'TASK_DESCRIPTION', 'TASK_DUE_DATE', 'EXISTING_TASK_TITLE',
  'CHECKOUT_TASK_TITLE', 'OFFLINE_TASK_TITLE', 'PUSH_TASK_TITLE',
  'SEARCH_TERM', 'NO_RESULTS_TERM', 'EDITED_TASK_TITLE',
];
const env = Object.fromEntries(variableNames.map((key) => [key, process.env[key] || testData[key]]));
const missingVariables = variableNames.filter((key) => !env[key]);
if (missingVariables.length) {
  console.error(`Missing Maestro test data variables: ${missingVariables.join(', ')}`);
  console.error('Add them to .maestro/test-data/*.yaml or override them with environment variables.');
  process.exit(2);
}

mkdirSync(reportDir, { recursive: true });
const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
const appVersion = app.expo?.version || 'unknown';
const appBuild = app.expo?.android?.versionCode || app.expo?.ios?.buildNumber || 'debug';
const commit = git('rev-parse', '--short', 'HEAD');
const device = adb('shell', 'getprop', 'ro.product.model') || 'unknown emulator';
const osVersion = adb('shell', 'getprop', 'ro.build.version.release') || 'unknown';
const timestamp = new Date().toISOString();
const flows = execFileSync('find', [flowDir, '-type', 'f', '-name', '*.yaml', '-print'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
const results = [];

for (const flow of flows) {
  const name = basename(flow, '.yaml');
  const htmlPath = join(reportDir, `${name}.html`);
  const logPath = join(reportDir, `${name}.log`);
  const screenshotPath = join(reportDir, `${name}-failure.png`);
  const started = Date.now();
  const args = ['test', '--config', '.maestro/config.yaml', '--include-tags', suite, '--format', 'HTML-DETAILED', '--output', htmlPath];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(flow);
  const run = spawnSync('maestro', args, { cwd: root, encoding: 'utf8' });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  writeFileSync(logPath, output);
  const passed = run.status === 0;
  let screenshot = '';
  if (!passed) {
    const image = spawnSync('adb', ['exec-out', 'screencap', '-p']);
    if (image.status === 0 && image.stdout?.length) {
      writeFileSync(screenshotPath, image.stdout);
      screenshot = `${name}-failure.png`;
    }
  }
  const error = passed ? '' : (output.match(/(?:Element not found|Assertion is false|No visible element found|Parsing Failed|CommandError|Error:).*$/m)?.[0] || `Maestro exited with code ${run.status ?? 'unknown'}`).trim();
  results.push({ name, suite, status: passed ? 'PASS' : 'FAIL', durationMs: Date.now() - started, timestamp, error, screenshot, platform: 'Android', device, osVersion, appVersion, appBuild, commit, report: `${name}.html` });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
}

writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2));
const dashboard = buildDashboard(results, suite);
writeFileSync(join(reportDir, 'index.html'), dashboard);
const summary = buildSummary(results, suite);
writeFileSync(join(reportDir, 'github-summary.md'), summary);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(results.every((result) => result.status === 'PASS') ? 0 : 1);

function git(...args) { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } }
function adb(...args) { try { return execFileSync('adb', args, { encoding: 'utf8' }).trim(); } catch { return ''; } }
function seconds(ms) { return `${(ms / 1000).toFixed(1)}s`; }
function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function buildSummary(items, suiteName) {
  const passed = items.filter((item) => item.status === 'PASS').length;
  const rows = items.map((item) => `| ${item.name} | ${item.suite} | ${item.status} | ${seconds(item.durationMs)} | ${item.timestamp} | ${item.error || '-'} | ${item.screenshot ? `[screenshot](./${item.screenshot})` : '-'} | ${item.platform} / ${item.device} (Android ${item.osVersion}) | ${item.appVersion} (${item.appBuild}) | ${item.commit} |`).join('\n');
  return `## Maestro ${suiteName} report\n\n**Result:** ${passed}/${items.length} passed  \n**Generated:** ${items[0]?.timestamp || new Date().toISOString()}  \n**Platform:** ${items[0]?.platform || 'unknown'} / ${items[0]?.device || 'unknown'}\n\n| Test name | Suite | Pass/fail | Duration | Timestamp | Error message | Screenshot on failure | Device/platform | App version/build | Git commit |\n|---|---|---|---:|---|---|---|---|---|---|\n${rows}\n`;
}
function buildDashboard(items, suiteName) {
  const passed = items.filter((item) => item.status === 'PASS').length;
  const failed = items.length - passed;
  const totalMs = items.reduce((sum, item) => sum + item.durationMs, 0);
  const rows = items.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.suite)}</td><td class="${item.status.toLowerCase()}">${item.status}</td><td>${seconds(item.durationMs)}</td><td>${esc(item.timestamp)}</td><td>${esc(item.error || '-')}</td><td>${item.screenshot ? `<a href="${esc(item.screenshot)}">Screenshot</a>` : '-'}</td><td>${esc(item.platform)} / ${esc(item.device)}<br>Android ${esc(item.osVersion)}</td><td>${esc(item.appVersion)} / ${esc(item.appBuild)}</td><td>${esc(item.commit)}</td><td><a href="${esc(item.report)}">HTML report</a></td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Maestro ${esc(suiteName)} metrics</title><style>body{font:14px system-ui;margin:32px;color:#202a27;background:#f7f5ef}h1{margin-bottom:4px}.metrics{display:flex;gap:12px;margin:24px 0}.metric{background:white;border:1px solid #ddd7cc;border-radius:8px;padding:16px;min-width:130px}.value{font-size:28px;font-weight:800}.label{color:#6c756e}table{border-collapse:collapse;width:100%;background:white}th,td{border:1px solid #ddd7cc;padding:10px;text-align:left;vertical-align:top}th{background:#e7eee9}.pass{color:#28734f;font-weight:800}.fail{color:#b64339;font-weight:800}</style></head><body><h1>Maestro ${esc(suiteName)} dashboard</h1><div class="label">Generated ${esc(items[0]?.timestamp || '')}</div><div class="metrics"><div class="metric"><div class="value">${items.length}</div><div class="label">Total tests</div></div><div class="metric"><div class="value pass">${passed}</div><div class="label">Passed</div></div><div class="metric"><div class="value fail">${failed}</div><div class="label">Failed</div></div><div class="metric"><div class="value">${seconds(totalMs)}</div><div class="label">Total duration</div></div><div class="metric"><div class="value">${items.length ? seconds(totalMs / items.length) : '0.0s'}</div><div class="label">Average duration</div></div></div><table><thead><tr><th>Test name</th><th>Suite</th><th>Status</th><th>Duration</th><th>Timestamp</th><th>Error message</th><th>Screenshot on failure</th><th>Device/platform</th><th>App version/build</th><th>Git commit</th><th>Report</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
