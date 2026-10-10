import type { ReceiptPublicKeys } from '@payment/shared';

function escapeForScript(value: string): string {
  return value.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * A single self-contained HTML file (no network requests) that verifies receipt QR codes with
 * the embedded public keys. Schools and parents can save it and keep verifying receipts even if
 * the platform is unreachable or shut down. The verification logic mirrors @payment/shared.
 */
export function buildOfflineVerifierHtml(publicKeys: ReceiptPublicKeys, generatedAt: Date): string {
  const keys = escapeForScript(JSON.stringify(publicKeys));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:">
<title>Offline receipt verifier</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f9fafb; color: #111827; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.lead { color: #4b5563; margin: 0 0 20px; }
  textarea { width: 100%; min-height: 110px; font: 13px ui-monospace, monospace; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box; }
  button, label.file { background: #047857; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 600; cursor: pointer; font-size: 14px; display: inline-block; }
  label.file { background: #374151; }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 18px; margin-top: 20px; }
  .ok { border-color: #10b981; background: #ecfdf5; }
  .bad { border-color: #ef4444; background: #fef2f2; }
  dl { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; margin: 12px 0 0; font-size: 14px; }
  dt { color: #6b7280; } dd { margin: 0; font-weight: 600; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
  td { padding: 6px 0; border-bottom: 1px solid #e5e7eb; } td:last-child { text-align: right; }
  small { color: #6b7280; }
</style>
</head>
<body>
<main>
  <h1>Offline receipt verifier</h1>
  <p class="lead">Paste the text of a receipt QR code (or the link it opens), or pick a photo of the QR code. Nothing leaves this device.</p>
  <textarea id="input" placeholder="https://.../verify#eyJwIjp7..."></textarea>
  <div class="row">
    <button id="verify" type="button">Verify receipt</button>
    <label class="file">Scan QR from image<input id="image" type="file" accept="image/*" hidden></label>
  </div>
  <div id="result"></div>
  <p><small>Trusted signing keys: <span id="kids"></span>. Generated ${generatedAt.toISOString()}.</small></p>
</main>
<script>
const PUBLIC_KEYS = ${keys};
document.getElementById('kids').textContent = Object.keys(PUBLIC_KEYS).join(', ');

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('bad number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  throw new Error('bad value');
}
function b64urlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function money(santim) {
  const [birr, cents] = (santim / 100).toFixed(2).split('.');
  return 'ETB ' + birr.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + cents;
}
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }

async function verify(content) {
  const out = document.getElementById('result');
  out.replaceChildren();
  let data;
  try {
    const fragment = content.includes('#') ? content.slice(content.indexOf('#') + 1) : content;
    const parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(fragment.trim())));
    if (!parsed.p || typeof parsed.s !== 'string') throw new Error('no receipt');
    data = parsed;
  } catch {
    const card = el('div', undefined, 'card bad');
    card.append(el('h2', 'Not a receipt QR code'), el('p', 'The text could not be read as a signed receipt.'));
    out.append(card);
    return;
  }
  const payload = data.p;
  const rawKey = PUBLIC_KEYS[payload.kid];
  let valid = false;
  let reason = 'Signed with an unknown key (' + payload.kid + ').';
  if (rawKey) {
    try {
      const key = await crypto.subtle.importKey('raw', b64urlToBytes(rawKey), { name: 'Ed25519' }, false, ['verify']);
      valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64urlToBytes(data.s), new TextEncoder().encode(canonicalJson(payload)));
      reason = valid ? '' : 'The signature does not match: this receipt was altered or forged.';
    } catch (error) {
      reason = 'This browser cannot verify Ed25519 signatures. Use a current Chrome, Edge, Firefox or Safari.';
    }
  }
  const card = el('div', undefined, 'card ' + (valid ? 'ok' : 'bad'));
  card.append(el('h2', valid ? 'Genuine receipt' : 'NOT a valid receipt'));
  if (!valid) card.append(el('p', reason));
  if (valid) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(payload))));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const dl = el('dl');
    const rows = [
      ['Verification code', hex.slice(0, 4) + '-' + hex.slice(4, 8)],
      ['Receipt number', payload.receiptNo],
      ['School', payload.school.name + ' (' + payload.school.code + ')'],
      ['Student', payload.student.name + ' (' + payload.student.code + '), grade ' + payload.student.grade],
      ['Paid by', payload.payer.name + ' ' + payload.payer.phone],
      ['Invoice', payload.invoiceNo],
      ['Total paid', money(payload.total)],
      ['Paid at', new Date(payload.paidAt).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa' }) + ' EAT'],
      ['Method', payload.method + ' via ' + payload.gateway],
      ['Gateway reference', payload.gatewayRef],
    ];
    for (const [label, value] of rows) { dl.append(el('dt', label), el('dd', value)); }
    const table = el('table');
    for (const item of payload.items) { const tr = el('tr'); tr.append(el('td', item.label), el('td', money(item.amount))); table.append(tr); }
    card.append(dl, table);
  }
  out.append(card);
}

document.getElementById('verify').addEventListener('click', () => verify(document.getElementById('input').value));
document.getElementById('image').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!('BarcodeDetector' in window)) { alert('This browser cannot read QR images. Scan the QR with your camera app and paste the link instead.'); return; }
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const codes = await detector.detect(await createImageBitmap(file));
  if (!codes.length) { alert('No QR code found in this image.'); return; }
  document.getElementById('input').value = codes[0].rawValue;
  verify(codes[0].rawValue);
});
if (location.hash.length > 1) { document.getElementById('input').value = location.href; verify(location.href); }
</script>
</body>
</html>`;
}
