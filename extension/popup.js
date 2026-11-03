const $ = (id) => document.getElementById(id);
async function refresh() {
  const { serverUrl = 'http://localhost:3000' } = await chrome.storage.local.get('serverUrl');
  $('server').value = serverUrl;
  $('open').href = serverUrl;
  const st = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  $('dot').classList.toggle('on', !!st?.online);
  $('state').textContent = st?.online ? 'connected' : 'not reachable';
  $('job').textContent = st?.job ? `${st.job.id} (${st.job.count} posts)` : 'none';
}
$('save').onclick = async () => {
  await chrome.storage.local.set({ serverUrl: $('server').value.trim().replace(/\/$/, '') || 'http://localhost:3000' });
  refresh();
};
refresh();
setInterval(refresh, 2000);
