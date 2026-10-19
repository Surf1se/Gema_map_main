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
  events.onmessage = event => { $('online-count').textContent = JSON.parse(event.data).online; };
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
