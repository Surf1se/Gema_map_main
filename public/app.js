/* global L */
const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: false }).setView([55.75, 37.62], 8);
map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('<a href="https://www.geonames.org/">GeoNames</a>');
map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors');
L.control.zoom({ position: 'bottomright' }).addTo(map);
for (const [type, order] of [['region', 410], ['district', 420], ['settlement', 430]]) {
  map.createPane(`alert-${type}`).style.zIndex = order;
}
function addOpenStreetMapTiles() {
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
}
async function loadMapTiles() {
  let config;
  try { config = await api('/map-config'); }
  catch { addOpenStreetMapTiles(); return; }
  if (config.provider !== 'yandex' || !config.key) { addOpenStreetMapTiles(); return; }
  const url = `https://tiles.api-maps.yandex.ru/v1/tiles/?apikey=${encodeURIComponent(config.key)}&lang=ru_RU&x={x}&y={y}&z={z}&l=map&maptype=map&projection=web_mercator`;
  const tiles = L.tileLayer(url, { maxZoom: 20 });
  tiles.once('tileerror', () => {
    tiles.remove();
    $('yandex-logo').hidden = true;
    addOpenStreetMapTiles();
    notice('Не удалось загрузить карту Яндекса. Показана карта OpenStreetMap. Проверьте ключ Tiles API.');
  });
  $('yandex-logo').hidden = false;
  tiles.addTo(map);
}
loadMapTiles();

let user = null;
let mode = 'register';
let events = null;
let alertFit = false;
let hasReceivedAlerts = false;
let activeAlertIds = new Set();
let currentAlerts = [];
let currentClearances = [];
let freshnessTimer;
const alertLayers = new Map();
const toastTimers = new Map();
const initials = name => [...name.trim()].slice(0, 2).join('').toUpperCase();
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }

function dismissToast(toast) {
  clearTimeout(toastTimers.get(toast));
  toastTimers.delete(toast);
  toast.remove();
}
function showAlertToast(alert) {
  const toast = document.createElement('div'); toast.className = 'alert-toast';
  const title = document.createElement('strong'); title.textContent = `Новая опасность: ${alert.place}`;
  const detail = document.createElement('small'); detail.textContent = alert.areaType === 'region' ? 'Регион на карте' : alert.areaType === 'district' ? 'Район на карте' : 'Населённый пункт на карте';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `Закрыть уведомление: ${alert.place}`);
  close.onclick = () => dismissToast(toast);
  toast.append(title, detail, close);
  $('alert-toasts').prepend(toast);
  toastTimers.set(toast, setTimeout(() => dismissToast(toast), 120_000));
}

function alertStyle(alert, now) {
  if (alert.cleared) return alert.areaType === 'settlement'
    ? { color: '#ffffff', weight: 2.5, opacity: 1, fillColor: '#2baa62', fillOpacity: 1 }
    : { color: '#59636b', weight: 2.5, opacity: 0.95, fillColor: '#38b66d', fillOpacity: 0.44 };
  const stale = now - alert.observedAt >= (alert.areaType === 'settlement' ? 4 * 60 : 60) * 60_000;
  return alert.areaType === 'settlement'
    ? { color: '#ffffff', weight: 2.5, opacity: 1, fillColor: stale ? '#f18b25' : '#ed3030', fillOpacity: 1 }
    : { color: '#59636b', weight: 2.5, opacity: 0.95, fillColor: stale ? '#9299a0' : '#df3b3b', fillOpacity: 0.44 };
}

function renderAlerts(alerts, clearances = []) {
  currentAlerts = alerts;
  currentClearances = clearances;
  clearTimeout(freshnessTimer);
  const now = Date.now();
  const active = new Map();
  for (const alert of alerts) if (!active.has(alert.placeId)) active.set(alert.placeId, alert);
  const latest = new Map();
  for (const clearance of clearances) if (clearance.expiresAt > now && !latest.has(clearance.placeId)) latest.set(clearance.placeId, { ...clearance, cleared: true });
  for (const [id, alert] of active) latest.set(id, alert);
  if (hasReceivedAlerts) for (const [id, alert] of active) if (!activeAlertIds.has(id)) showAlertToast(alert);
  activeAlertIds = new Set(active.keys());
  hasReceivedAlerts = true;
  for (const [id, entry] of alertLayers) if (!latest.has(id)) { entry.layer.remove(); alertLayers.delete(id); }
  let nextColorChange = Infinity;
  for (const [id, alert] of latest) {
    const colorChange = alert.cleared ? alert.expiresAt : alert.observedAt + (alert.areaType === 'settlement' ? 4 * 60 : 60) * 60_000;
    if (colorChange > now) nextColorChange = Math.min(nextColorChange, colorChange);
    const kind = alert.areaType === 'settlement' ? 'marker' : alert.boundary ? 'boundary' : 'circle';
    let entry = alertLayers.get(id);
    if (entry?.kind !== kind) {
      entry?.layer.remove();
      const pane = `alert-${alert.areaType || 'settlement'}`;
      const style = alertStyle(alert, now);
      const layer = kind === 'marker' ? L.circleMarker([alert.latitude, alert.longitude], { pane, radius: 9, ...style })
        : kind === 'boundary' ? L.geoJSON(alert.boundary, { pane, style }) : L.circle([alert.latitude, alert.longitude], { pane, radius: alert.radius, ...style });
      layer.addTo(map);
      entry = { kind, layer };
      alertLayers.set(id, entry);
    }
    entry.layer.setStyle(alertStyle(alert, now));
    if (kind === 'circle') entry.layer.setLatLng([alert.latitude, alert.longitude]).setRadius(alert.radius);
    if (kind === 'marker') entry.layer.setLatLng([alert.latitude, alert.longitude]);
    const popup = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${alert.cleared ? 'Отбой' : 'Опасность'}: ${alert.place}`;
    const territory = alert.areaType === 'region' ? 'региона' : alert.areaType === 'district' ? 'района' : 'населённого пункта';
    const note = document.createElement('p');
    note.textContent = alert.cleared ? 'Отбой подтверждён. Зелёная отметка исчезнет через 5 минут.'
      : (kind === 'marker' ? 'Место отмечено маркером.' : kind === 'boundary' ? `Контур ${territory} по данным OpenStreetMap. Это не зона опасности.` : `Примерный круг ${territory}: точный контур не найден. Это не зона опасности.`)
        + (now >= colorChange ? ` Предупреждение не обновлялось более ${alert.areaType === 'settlement' ? '4 часов' : '60 минут'}.` : '');
    popup.append(title, note);
    if (!alert.cleared) {
      const source = document.createElement('a'); source.href = `https://t.me/${alert.source}/${alert.messageId}`; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Открыть сообщение';
      popup.append(source);
    }
    entry.layer.bindPopup(popup);
  }
  if (Number.isFinite(nextColorChange)) freshnessTimer = setTimeout(() => renderAlerts(currentAlerts, currentClearances), Math.max(1, nextColorChange - Date.now() + 10));
  $('alerts-count').textContent = `Территорий с опасностью: ${active.size}`;
  $('active-circles-count').textContent = active.size;
  if (!latest.size) alertFit = false;
  else if (!alertFit && active.size) {
    map.fitBounds(L.featureGroup([...alertLayers.values()].map(entry => entry.layer)).getBounds(), { maxZoom: 9, padding: [40, 40] });
    alertFit = true;
  }
}

async function api(path, data) {
  let response;
  try {
    response = await fetch(`/api${path}`, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  } catch { throw new Error('Нет связи с сервером. Проверьте подключение.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || 'Не удалось выполнить запрос.');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function changeMode(next) {
  mode = next;
  const registering = mode === 'register';
  $('register-tab').classList.toggle('active', registering);
  $('login-tab').classList.toggle('active', !registering);
  $('name-label').hidden = !registering;
  $('name').required = registering;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('auth-submit').textContent = registering ? 'Создать аккаунт ↗' : 'Войти ↗';
  $('auth-error').textContent = '';
}
$('register-tab').onclick = () => changeMode('register');
$('login-tab').onclick = () => changeMode('login');
$('auth-dialog').addEventListener('cancel', event => event.preventDefault());
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const result = await api(`/${mode}`, { name: $('name').value, email: $('email').value, password: $('password').value });
    $('password').value = '';
    $('auth-dialog').close();
    signedIn(result.user);
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
});

function signedIn(value) {
  user = value;
  $('profile-name').textContent = user.name;
  $('profile-avatar').textContent = initials(user.name);
  $('profile-status').textContent = 'Вы на платформе';
  $('logout').hidden = false;
  notice('');
  connect();
}
function connect() {
  events?.close();
  $('connection').textContent = 'Подключение…';
  events = new EventSource('/api/events');
  events.onopen = () => { $('connection').textContent = 'В реальном времени'; notice(''); };
  events.onmessage = event => {
    const data = JSON.parse(event.data);
    $('online-count').textContent = data.online;
    renderAlerts(data.alerts || [], data.clearances || []);
    $('feed-status').textContent = ({ off: 'Каналы не подключены', connecting: 'Соединяемся с каналами…', connected: 'Каналы подключены', error: 'Ошибка подключения канала' })[data.feedStatus] || 'Каналы не подключены';
  };
  events.onerror = async () => {
    $('connection').textContent = 'Переподключение…';
    try { await api('/me'); }
    catch (error) {
      if (error.status === 401) { signedOut(); notice('Сессия завершилась. Войдите снова.'); }
    }
  };
}
function signedOut() {
  events?.close(); events = null; user = null;
  $('online-count').textContent = '0';
  renderAlerts([]);
  hasReceivedAlerts = false;
  activeAlertIds = new Set();
  for (const toast of toastTimers.keys()) dismissToast(toast);
  $('feed-status').textContent = 'Войдите в аккаунт';
  $('profile-name').textContent = 'Гость';
  $('profile-avatar').textContent = '?';
  $('profile-status').textContent = 'Войдите, чтобы присоединиться';
  $('logout').hidden = true;
  $('connection').textContent = 'Войдите в аккаунт';
  if (!$('auth-dialog').open) $('auth-dialog').showModal();
}
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await api('/logout', {}); signedOut(); }
  catch (error) { notice(error.message); }
  finally { $('logout').disabled = false; }
};
window.addEventListener('pagehide', () => { events?.close(); events = null; });
window.addEventListener('pageshow', event => { if (event.persisted && user) connect(); });
try { const data = await api('/me'); signedIn(data.user); }
catch (error) { signedOut(); if (error.status !== 401) $('auth-error').textContent = error.message; }
