/**
 * Pre-install skill scan (W31 b). Runs in a worker thread with a hard timeout, never on the main thread: the skill
 * text is untrusted and may be huge or crafted. The patterns are ours (fixed, linear), never the skill's or an
 * agent's. The output is advisory text for the owner, never a gate an agent can satisfy by rewording.
 */

export type FindingKind =
  | 'download-and-run'
  | 'credential-path'
  | 'hidden-text'
  | 'exfiltration'
  | 'model-instruction';
export interface Finding {
  kind: FindingKind;
  /** the file the finding is in */
  file: string;
  line: number;
  /** a short, already-escaped excerpt (hidden characters shown as \u{...}) */
  excerpt: string;
}
export type ScanResult =
  | { status: 'ok'; findings: Finding[] }
  | { status: 'timeout'; findings: [] }
  | { status: 'error'; findings: []; error: string };

export const SCAN_TIMEOUT_MS = 2_000;
/** bytes per file handed to the worker (the rest is not scanned and the summary says so) */
export const SCAN_FILE_LIMIT = 4 * 1024 * 1024;

// Plain JS for the eval worker. Every pattern is fixed and has no nested quantifiers.
const SCAN_WORKER = `const { parentPort, workerData } = require('node:worker_threads');
const RULES = [
  ['download-and-run', /\\b(curl|wget|iwr|invoke-webrequest)\\b[^\\n|]{0,400}\\|\\s{0,4}(sudo\\s{1,4})?(ba|z|da)?sh\\b/i],
  ['download-and-run', /\\b(curl|wget)\\b[^\\n;]{0,400}(;|&&)\\s{0,4}(sh|bash|chmod\\s{1,4}\\+x)\\b/i],
  ['download-and-run', /\\b(iex|invoke-expression)\\b[^\\n]{0,200}(downloadstring|iwr|invoke-webrequest)/i],
  ['download-and-run', /\\bbase64\\s{1,4}(-d|--decode)\\b[^\\n]{0,200}\\|\\s{0,4}(ba|z)?sh\\b/i],
  ['credential-path', /~\\/\\.ssh\\b|\\.ssh\\/id_[a-z0-9]+|\\bid_(rsa|ed25519|ecdsa)\\b/i],
  ['credential-path', /\\.aws\\/credentials|\\.netrc\\b|\\.git-credentials\\b|\\.docker\\/config\\.json/i],
  ['credential-path', /\\bkeychain\\b|\\bsecurity\\s{1,4}find-(generic|internet)-password\\b|login\\.keychain/i],
  ['credential-path', /(chrome|chromium|firefox|brave|edge)[^\\n]{0,80}(profile|cookies|login data)|\\bcookies\\.sqlite\\b/i],
  ['credential-path', /(^|[\\s"'\\/=])\\.env(\\.[a-z]{1,12})?\\b/i],
  ['exfiltration', /\\b(curl|wget)\\b[^\\n]{0,300}(-d|--data|--data-binary|-F|--upload-file|-T)\\s{1,4}[^\\n]{0,200}(@|\\$\\(|\\$\\{?[A-Z_]{2,})/],
  ['exfiltration', /\\b(webhook\\.site|requestbin|pipedream\\.net|ngrok\\.io|ngrok-free\\.app|burpcollaborator|interact\\.sh|pastebin\\.com)\\b/i],
  ['exfiltration', /\\bnc\\s{1,4}(-[a-z]{1,4}\\s{1,4})?[a-z0-9.-]{3,}\\s{1,4}\\d{2,5}\\b[^\\n]{0,40}</i],
  ['model-instruction', /\\bignore\\s{1,4}(all\\s{1,4})?(the\\s{1,4})?(previous|prior|above|earlier)\\s{1,4}(instructions|rules|prompts?)\\b/i],
  ['model-instruction', /\\b(do\\s{1,4}not|don't|never)\\s{1,4}(tell|inform|show|mention\\s{1,4}(this\\s{1,4})?to)\\s{1,4}the\\s{1,4}(user|owner|human)\\b/i],
  ['model-instruction', /\\byou\\s{1,4}are\\s{1,4}now\\s{1,4}(in\\s{1,4})?(developer|dan|jailbreak|god)\\s{0,4}mode\\b/i],
];
// zero-width, bidi controls and tag characters hide text from a human reader
const HIDDEN = /[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]|[\\uDB40][\\uDC00-\\uDC7F]/;
const show = (s) => s.replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]/g, (c) => '\\\\u{' + c.charCodeAt(0).toString(16) + '}').slice(0, 160);
const out = [];
for (const f of workerData.files) {
  const lines = f.text.split('\\n');
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    const l = lines[i];
    if (HIDDEN.test(l)) out.push({ kind: 'hidden-text', file: f.name, line: i + 1, excerpt: show(l) });
    for (const [kind, re] of RULES) if (re.test(l)) out.push({ kind, file: f.name, line: i + 1, excerpt: show(l) });
  }
  // an HTML comment that talks to the model is hidden from a rendered view
  const c = /<!--([\\s\\S]{0,2000}?)-->/g;
  let m;
  while ((m = c.exec(f.text)) && out.length < 200) {
    if (/\\b(assistant|model|claude|ai|agent|you must|instructions?)\\b/i.test(m[1])) {
      const line = f.text.slice(0, m.index).split('\\n').length;
      out.push({ kind: 'hidden-text', file: f.name, line, excerpt: show(m[0]) });
    }
  }
}
parentPort.postMessage(out);`;

/** Scan skill files in a worker; a timeout or crash ends the worker and says so (the main thread never waits on it). */
export async function scanSkill(
  files: { name: string; text: string }[],
  timeoutMs = SCAN_TIMEOUT_MS,
): Promise<ScanResult> {
  const { Worker } = await import('node:worker_threads');
  const capped = files.map((f) => ({ name: f.name.slice(0, 200), text: f.text.slice(0, SCAN_FILE_LIMIT) }));
  return new Promise<ScanResult>((resolve) => {
    let settled = false;
    const w = new Worker(SCAN_WORKER, {
      eval: true,
      workerData: { files: capped },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    const done = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ status: 'timeout', findings: [] }), timeoutMs);
    w.once('message', (m) => done({ status: 'ok', findings: m as Finding[] }));
    w.once('error', (e) => done({ status: 'error', findings: [], error: e.message }));
    w.once('exit', () => done({ status: 'error', findings: [], error: 'the scan stopped' }));
  });
}
