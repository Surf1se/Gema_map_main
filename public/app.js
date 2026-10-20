/* global L */
const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: false }).setView([55.75, 37.62], 8);
map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('<a href="https://www.geonames.org/">GeoNames</a>');
map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors');
L.control.zoom({ position: 'bottomright' }).addTo(map);
for (const [type, order] of [['region', 410], ['district', 420], ['settlement', 430], ['direction', 440]]) {
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

let events = null;
let alertFit = false;
let hasReceivedAlerts = false;
let activeAlertIds = new Set();
let currentAlerts = [];
let currentClearances = [];
let freshnessTimer;
const alertLayers = new Map();
const pulseLayers = new Map();
const directionLayers = new Map();
const toastTimers = new Map();
const initials = name => [...name.trim()].slice(0, 2).join('').toUpperCase();
const publicationTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  if (alert.areaType === 'settlement') return { color: '#ffffff', weight: 2.5, opacity: 1, fillColor: '#ed3030', fillOpacity: 1 };
  const stale = now - alert.observedAt >= 30 * 60_000;
  return { color: '#59636b', weight: 2.5, opacity: 0.95, fillColor: stale ? '#9299a0' : '#df3b3b', fillOpacity: 0.44 };
}

function adminIcon(alert, now) {
  const status = alert.cleared ? 'clear' : now - alert.observedAt >= 30 * 60_000 ? 'stale' : 'active';
  return L.divIcon({ className: `admin-point admin-point--${status}`, html: '<span class="admin-diamond"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
}

function directionIcon(direction) {
  const from = map.latLngToLayerPoint([direction.from.latitude, direction.from.longitude]);
  const to = map.latLngToLayerPoint([direction.to.latitude, direction.to.longitude]);
  const angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
  return L.divIcon({ className: 'direction-marker', iconSize: [48, 34], iconAnchor: [24, 17],
    html: `<span class="direction-glyph" style="--direction-angle:${angle}deg"><svg viewBox="0 0 48 34" aria-hidden="true"><path class="direction-head" d="M8 17h30m-7-7 9 7-9 7"/><g class="direction-drone"><path d="M2 17 13 13 20 5 22 6 19 14 34 16 39 17 34 18 19 20 22 28 20 29 13 21Z"/></g></svg></span>` });
}
function pulseIcon() {
  return L.divIcon({ className: 'alert-pulse', iconSize: [24, 24], iconAnchor: [12, 12], html: '<span class="alert-pulse-ring"></span><span class="alert-pulse-core"></span>' });
}

function renderDirections(alerts, now) {
  const directed = new Map();
  for (const alert of alerts) if (alert.direction?.from?.id === alert.placeId && alert.observedAt + 45 * 60_000 > now && !directed.has(alert.placeId)) directed.set(alert.placeId, alert);
  for (const [id, entry] of directionLayers) if (!directed.has(id)) { entry.line.remove(); entry.marker.remove(); directionLayers.delete(id); }
  for (const [id, alert] of directed) {
    const direction = alert.direction;
    const coordinates = [[direction.from.latitude, direction.from.longitude], [direction.to.latitude, direction.to.longitude]];
    let entry = directionLayers.get(id);
    if (!entry) {
      const line = L.polyline(coordinates, { pane: 'alert-direction', className: 'direction-route', color: '#075e79', weight: 2.5, opacity: .8, dashArray: '5 5' }).addTo(map);
      const marker = L.marker([(direction.from.latitude + direction.to.latitude) / 2, (direction.from.longitude + direction.to.longitude) / 2], { pane: 'alert-direction', icon: directionIcon(direction), keyboard: true }).addTo(map);
      entry = { line, marker }; directionLayers.set(id, entry);
    } else { entry.line.setLatLngs(coordinates); entry.marker.setLatLng([(direction.from.latitude + direction.to.latitude) / 2, (direction.from.longitude + direction.to.longitude) / 2]).setIcon(directionIcon(direction)); }
    const tip = document.createElement('span');
    tip.textContent = `${direction.from.name} → ${direction.to.name}. Направление из сообщения, не положение БПЛА.`;
    entry.marker.bindTooltip(tip, { direction: 'top', offset: [0, -12] });
    const popup = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${direction.from.name} → ${direction.to.name}`;
    const note = document.createElement('p'); note.textContent = 'Направление указано в сообщении. Значок не показывает текущее положение БПЛА.';
    const source = document.createElement('a'); source.href = `https://t.me/${alert.source}/${alert.messageId}`; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Открыть сообщение';
    popup.append(title, note, source); entry.marker.bindPopup(popup);
  }
}

function renderAlerts(alerts, clearances = []) {
  currentAlerts = alerts;
  currentClearances = clearances;
  clearTimeout(freshnessTimer);
  const now = Date.now();
  const active = new Map();
  for (const alert of alerts) if (alert.observedAt + 60 * 60_000 > now && !active.has(alert.placeId)) active.set(alert.placeId, alert);
  const latest = new Map();
  for (const clearance of clearances) if (clearance.expiresAt > now && !latest.has(clearance.placeId)) latest.set(clearance.placeId, { ...clearance, cleared: true });
  for (const [id, alert] of active) latest.set(id, alert);
  if (hasReceivedAlerts) for (const [id, alert] of active) if (!activeAlertIds.has(id)) showAlertToast(alert);
  activeAlertIds = new Set(active.keys());
  hasReceivedAlerts = true;
  for (const [id, entry] of alertLayers) if (!latest.has(id)) { entry.layer.remove(); alertLayers.delete(id); }
  for (const [id, layer] of pulseLayers) if (!active.has(id) || active.get(id).areaType !== 'settlement') { layer.remove(); pulseLayers.delete(id); }
  let nextColorChange = Infinity;
  for (const [id, alert] of latest) {
    const expiry = alert.cleared ? alert.expiresAt : alert.observedAt + 60 * 60_000;
    const colorChange = !alert.cleared && alert.areaType !== 'settlement' ? alert.observedAt + 30 * 60_000 : Infinity;
    if (expiry > now) nextColorChange = Math.min(nextColorChange, expiry);
    if (colorChange > now) nextColorChange = Math.min(nextColorChange, colorChange);
    const kind = alert.areaType === 'settlement' ? 'marker' : alert.boundary ? 'boundary' : 'admin';
    let entry = alertLayers.get(id);
    if (entry?.kind !== kind) {
      entry?.layer.remove();
      const pane = `alert-${alert.areaType || 'settlement'}`;
      const style = alertStyle(alert, now);
      const layer = kind === 'marker' ? L.circleMarker([alert.latitude, alert.longitude], { pane, radius: 9, ...style })
        : kind === 'boundary' ? L.geoJSON(alert.boundary, { pane, style }) : L.marker([alert.latitude, alert.longitude], { pane, icon: adminIcon(alert, now) });
      layer.addTo(map);
      entry = { kind, layer };
      alertLayers.set(id, entry);
    }
    if (kind === 'admin') entry.layer.setLatLng([alert.latitude, alert.longitude]).setIcon(adminIcon(alert, now));
    else entry.layer.setStyle(alertStyle(alert, now));
    if (kind === 'marker') {
      entry.layer.setLatLng([alert.latitude, alert.longitude]);
      let pulse = pulseLayers.get(id);
      if (!pulse) { pulse = L.marker([alert.latitude, alert.longitude], { pane: 'alert-direction', icon: pulseIcon(), interactive: false }).addTo(map); pulseLayers.set(id, pulse); }
      else pulse.setLatLng([alert.latitude, alert.longitude]);
      const tooltip = document.createElement('span');
      tooltip.textContent = `${alert.place} · ${alert.cleared ? 'Отбой опубликован' : 'Опубликовано'}: ${publicationTime.format(new Date(alert.publishedAt ?? alert.observedAt))} МСК`;
      entry.layer.bindTooltip(tooltip, { direction: 'top', offset: [0, -8] });
    }
    const popup = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${alert.cleared ? 'Отбой' : 'Опасность'}: ${alert.place}`;
    const territory = alert.areaType === 'region' ? 'региона' : alert.areaType === 'district' ? 'района' : 'населённого пункта';
    const note = document.createElement('p');
    note.textContent = alert.cleared ? 'Отбой подтверждён. Зелёная отметка исчезнет через 5 минут.'
      : (kind === 'marker' ? 'Место отмечено маркером.' : kind === 'boundary' ? `Контур ${territory} по данным OpenStreetMap. Это не зона опасности.` : `Центральная отметка ${territory}: точный контур не найден. Это не зона опасности.`)
        + (now >= colorChange ? ' Предупреждение не обновлялось более 30 минут.' : '');
    popup.append(title, note);
    if (!alert.cleared) {
      const source = document.createElement('a'); source.href = `https://t.me/${alert.source}/${alert.messageId}`; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Открыть сообщение';
      popup.append(source);
    }
    entry.layer.bindPopup(popup);
  }
  renderDirections([...active.values()], now);
  for (const alert of active.values()) if (alert.direction && alert.observedAt + 45 * 60_000 > now)
    nextColorChange = Math.min(nextColorChange, alert.observedAt + 45 * 60_000);
  if (Number.isFinite(nextColorChange)) freshnessTimer = setTimeout(() => renderAlerts(currentAlerts, currentClearances), Math.max(1, nextColorChange - Date.now() + 10));
  $('alerts-count').textContent = `Территорий с опасностью: ${active.size}`;
  $('active-circles-count').textContent = active.size;
  if (!latest.size) alertFit = false;
  else if (!alertFit && active.size) {
    map.fitBounds(L.featureGroup([...alertLayers.values()].map(entry => entry.layer)).getBounds(), { maxZoom: 9, padding: [40, 40] });
    alertFit = true;
  }
}
map.on('zoomend moveend', () => renderDirections(currentAlerts, Date.now()));

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
  events.onerror = () => { $('connection').textContent = 'Переподключение…'; };
};
window.addEventListener('pagehide', () => { events?.close(); events = null; });
window.addEventListener('pageshow', event => { if (event.persisted) connect(); });
connect();
