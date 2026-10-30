'use strict';

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  const dot    = document.getElementById('dot');
  const badge  = document.getElementById('badge-monitoring');
  const stText = document.getElementById('status-text');

  if (status.active) {
    dot.className    = 'dot active';
    badge.className  = 'badge on';
    badge.textContent = 'ACTIVE';
    stText.textContent = 'Monitoring enabled';
    document.getElementById('session-id').textContent =
      (status.sessionId || '').slice(0, 12) + '…' || '—';
  } else {
    dot.className    = 'dot inactive';
    badge.className  = 'badge off';
    badge.textContent = 'OFF';
    stText.textContent = 'No active session';
    document.getElementById('session-id').textContent = '—';
  }

  document.getElementById('buffered').textContent = String(status.buffered || 0);
}

document.getElementById('port-btn').addEventListener('click', async () => {
  const val = parseInt(document.getElementById('port-input').value, 10);
  if (val > 1023 && val < 65536) {
    await chrome.runtime.sendMessage({ type: 'set-port', port: val });
  }
});

refresh();
setInterval(refresh, 3000);
