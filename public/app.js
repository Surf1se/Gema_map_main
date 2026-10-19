/* global L */
const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: false }).setView([55.75, 37.62], 8);
map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('<a href="https://www.geonames.org/">GeoNames</a>');
L.control.zoom({ position: 'bottomright' }).addTo(map);
const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
tiles.on('tileerror', () => notice('Не удалось загрузить часть карты. Проверьте интернет-соединение и доступ к tile.openstreetmap.org.'));

let user = null;
let mode = 'register';
let events = null;
let alertFit = false;
const alertCircles = new Map();
const initials = name => [...name.trim()].slice(0, 2).join('').toUpperCase();
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }

function renderAlerts(alerts) {
  const latest = new Map();
  for (const alert of alerts) if (!latest.has(alert.placeId)) latest.set(alert.placeId, alert);
  for (const [id, circle] of alertCircles) if (!latest.has(id)) { circle.remove(); alertCircles.delete(id); }
  for (const [id, alert] of latest) {
    let circle = alertCircles.get(id);
    if (!circle) {
      circle = L.circle([alert.latitude, alert.longitude], { radius: alert.radius, color: '#ba2525', fillColor: '#e44444', fillOpacity: 0.35, weight: 2 }).addTo(map);
      alertCircles.set(id, circle);
    }
    circle.setLatLng([alert.latitude, alert.longitude]).setRadius(alert.radius);
    const popup = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `Опасность: ${alert.place}`;
    const note = document.createElement('p'); note.textContent = 'Условный круг по сообщению канала. Это не точная зона опасности.';
    const source = document.createElement('a'); source.href = `https://t.me/radar_moscoww/${alert.messageId}`; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Открыть сообщение';
    popup.append(title, note, source); circle.bindPopup(popup);
  }
  $('alerts-count').textContent = `Областей опасности: ${latest.size}`;
  $('active-circles-count').textContent = latest.size;
  if (!latest.size) alertFit = false;
  else if (!alertFit) {
    map.fitBounds(L.featureGroup([...alertCircles.values()]).getBounds(), { maxZoom: 9, padding: [40, 40] });
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
    renderAlerts(data.alerts || []);
    $('feed-status').textContent = ({ off: 'Канал не подключён', connecting: 'Соединяемся с каналом…', connected: 'Канал подключён', error: 'Ошибка канала' })[data.feedStatus] || 'Канал не подключён';
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
