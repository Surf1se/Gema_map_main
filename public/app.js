/* global L */
const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: false }).setView([30, 20], 3);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
tiles.on('tileerror', () => notice('Не удалось загрузить часть карты. Проверьте интернет-соединение и доступ к tile.openstreetmap.org.'));
let user = null;
let mode = 'register';
let events = null;
let watch = null;
let active = false;
let lastPosition = null;
let latestAccuracy = null;
const MAX_SHARED_ACCURACY = 100;
let sendTimer = null;
let pendingLocation = Promise.resolve();
let locationPending = false;
let sendingGeneration = 0;
let initialFit = false;
let positions = [];
const markers = new Map();
const initials = name => [...name.trim()].slice(0, 2).join('').toUpperCase();
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
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
  $('consent-label').hidden = !registering;
  $('consent').required = registering;
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
    const result = await api(`/${mode}`, { name: $('name').value, email: $('email').value, password: $('password').value, sharingConsent: $('consent').checked });
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
  $('profile-status').textContent = 'Передача выключена';
  $('share-button').disabled = false;
  $('logout').hidden = false;
  notice('Вы на общей карте. Нажмите «Включить геопозицию», чтобы участники увидели вашу точку.');
  connect();
}
function connect() {
  events?.close();
  $('connection').textContent = 'Подключение…';
  events = new EventSource('/api/events');
  events.onopen = () => { $('connection').textContent = 'В реальном времени'; };
  events.onmessage = event => {
    positions = JSON.parse(event.data).positions;
    renderPositions();
  };
  events.onerror = async () => {
    $('connection').textContent = 'Переподключение…';
    try { await api('/me'); }
    catch (error) { if (error.status === 401) { await stopSharing(false); signedOut(); notice('Сессия завершилась. Войдите снова.'); } }
  };
}
function renderPositions() {
  const visible = new Set(positions.map(p => p.id));
  for (const [id, marker] of markers) if (!visible.has(id)) { marker.remove(); markers.delete(id); }
  $('people-count').textContent = positions.length;
  $('people').replaceChildren();
  if (!positions.length) {
    const empty = document.createElement('li'); empty.className = 'empty';
    empty.textContent = 'Пока никто не делится геопозицией. Станьте первым!'; $('people').append(empty);
  }
  for (const p of positions) {
    const own = p.id === user?.id;
    let marker = markers.get(p.id);
    if (!marker) {
      const pin = document.createElement('div'); pin.className = `pin-avatar${own ? ' self' : ''}`; pin.textContent = initials(p.name);
      marker = L.marker([p.latitude, p.longitude], { icon: L.divIcon({ className: 'map-pin', html: pin, iconSize: [42, 48], iconAnchor: [21, 48] }), alt: own ? 'Ваша геопозиция' : p.name }).addTo(map);
      markers.set(p.id, marker);
    }
    marker.setLatLng([p.latitude, p.longitude]);
    const popup = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${p.name}${own ? ' · вы' : ''}`;
    const detail = document.createElement('div'); detail.textContent = `Точность: ±${Math.round(p.accuracy)} м · ${new Date(p.observedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
    popup.append(title, detail); marker.bindPopup(popup);
    const li = document.createElement('li');
    const button = document.createElement('button'); button.className = 'person';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = initials(p.name);
    const text = document.createElement('span');
    const name = document.createElement('span'); name.className = 'person-name'; name.textContent = `${p.name}${own ? ' · вы' : ''}`;
    const accuracy = document.createElement('small'); accuracy.textContent = `Геопозиция обновляется · ±${Math.round(p.accuracy)} м`;
    text.append(name, accuracy);
    const dot = document.createElement('span'); dot.className = 'live-dot';
    button.append(avatar, text, dot);
    button.onclick = () => { map.flyTo([p.latitude, p.longitude], 15); marker.openPopup(); };
    li.append(button); $('people').append(li);
  }
  if (!initialFit && positions.length) {
    const own = positions.find(p => p.id === user?.id);
    if (own) map.setView([own.latitude, own.longitude], 15);
    else map.fitBounds(positions.map(p => [p.latitude, p.longitude]), { maxZoom: 13, padding: [70, 70] });
    initialFit = true;
  }
}
function sharingUI() {
  $('share-button').textContent = active ? 'Остановить передачу ◼' : 'Включить геопозицию ↗';
  $('share-button').classList.toggle('sharing', active);
  $('sharing-title').textContent = active ? 'Вас видят участники карты' : 'Вы управляете видимостью';
  $('sharing-description').textContent = active ? 'Передача активна, пока страница открыта. Нажмите ниже, чтобы скрыть точку.' : 'Включите геопозицию, чтобы появиться на общей карте.';
  $('profile-status').textContent = active ? 'Геопозиция включена' : 'Передача выключена';
}
function sendPosition() {
  if (!active || !lastPosition || latestAccuracy > MAX_SHARED_ACCURACY || locationPending || Date.now() - lastPosition.observedAt > 60_000) return;
  const generation = sendingGeneration;
  locationPending = true;
  pendingLocation = api('/location', lastPosition).then(() => {
    if (active && generation === sendingGeneration) notice('');
  }).catch(async error => {
    if (active && generation === sendingGeneration) {
      notice(error.message);
      if (error.status === 401) { active = false; clearInterval(sendTimer); navigator.geolocation.clearWatch(watch); signedOut(); }
    }
  }).finally(() => { locationPending = false; });
}
async function stopSharing(send = true) {
  active = false;
  sendingGeneration++;
  if (watch !== null) navigator.geolocation.clearWatch(watch);
  watch = null; clearInterval(sendTimer); lastPosition = null; latestAccuracy = null;
  sharingUI();
  await pendingLocation;
  if (send && user) {
    try { await api('/location/stop', {}); }
    catch (error) { notice(`${error.message} Последняя точка исчезнет после 90 секунд без свежих координат.`); return false; }
  }
  return true;
}
function startSharing() {
  if (!window.isSecureContext) return notice('Геопозиция работает через HTTPS. Откройте защищённый адрес приложения. Для локальной разработки подходит localhost.');
  if (!navigator.geolocation) return notice('Этот браузер не поддерживает геопозицию.');
  active = true;
  lastPosition = null;
  latestAccuracy = null;
  sharingUI();
  notice('Разрешите доступ к геопозиции в браузере. Получаем координаты…');
  const generation = ++sendingGeneration;
  watch = navigator.geolocation.watchPosition(position => {
    if (!active || generation !== sendingGeneration) return;
    const { latitude, longitude, accuracy } = position.coords;
    if (Date.now() - position.timestamp > 60_000) return notice('Ожидаем свежие координаты от устройства…');
    latestAccuracy = accuracy;
    if (accuracy > MAX_SHARED_ACCURACY) {
      notice(`Сейчас точность ±${Math.round(accuracy)} м. Ждём точности до 100 м: включите точную геолокацию и GPS, выйдите на открытое место. На компьютере без GPS такая точность может быть недоступна.`);
      return;
    }
    lastPosition = { latitude, longitude, accuracy, observedAt: position.timestamp };
    sendPosition();
  }, async error => {
    if (!active || generation !== sendingGeneration) return;
    if (error.code === 1) { await stopSharing(); notice('Доступ к геопозиции запрещён. Разрешите его в настройках сайта и включите передачу снова.'); }
    else notice(error.code === 3 ? 'Устройство пока не определило координаты. Ожидаем следующий сигнал…' : 'Геопозиция недоступна. Проверьте службы геолокации устройства.');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
  sendTimer = setInterval(() => {
    sendPosition();
    if (latestAccuracy !== null && latestAccuracy > MAX_SHARED_ACCURACY) return;
    if (!lastPosition || Date.now() - lastPosition.observedAt > 60_000) notice('Нет свежих координат. Устаревшая точка автоматически исчезнет с карты.');
  }, 15_000);
}
$('share-button').onclick = async () => {
  $('share-button').disabled = true;
  try { if (active) { if (await stopSharing()) notice('Передача остановлена. Ваша точка скрыта с общей карты.'); } else startSharing(); }
  finally { $('share-button').disabled = !user; }
};
$('locate').onclick = () => {
  const own = positions.find(p => p.id === user?.id);
  if (own) { map.flyTo([own.latitude, own.longitude], 16); markers.get(own.id)?.openPopup(); }
  else notice('Включите передачу геопозиции и дождитесь координат, чтобы увидеть свою точку.');
};
function signedOut() {
  events?.close(); events = null; user = null; positions = []; initialFit = false; renderPositions();
  $('profile-name').textContent = 'Гость'; $('profile-avatar').textContent = '?'; $('profile-status').textContent = 'Войдите, чтобы присоединиться';
  $('share-button').disabled = true; $('logout').hidden = true; $('connection').textContent = 'Войдите в аккаунт';
  if (!$('auth-dialog').open) $('auth-dialog').showModal();
}
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await stopSharing(); await api('/logout', {}); signedOut(); }
  catch (error) { notice(error.message); }
  finally { $('logout').disabled = false; }
};
window.addEventListener('pagehide', () => {
  if (active) navigator.sendBeacon('/api/location/stop');
  if (watch !== null) navigator.geolocation.clearWatch(watch);
  active = false; clearInterval(sendTimer); events?.close();
});
window.addEventListener('pageshow', event => {
  if (event.persisted && user) { sharingUI(); connect(); notice('Страница восстановлена. Включите геопозицию снова, чтобы делиться координатами.'); }
});
try { const data = await api('/me'); signedIn(data.user); }
catch (error) { signedOut(); if (error.status !== 401) $('auth-error').textContent = error.message; }
