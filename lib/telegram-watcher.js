import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextMoscowReset } from './alerts.js';

const root = join(import.meta.dirname, '..');
const sessionPath = join(root, '.data', 'telegram.session');
const channelName = 'radar_moscoww';

function postFromMessage(message) {
  const seconds = message.date instanceof Date ? message.date.getTime() / 1000 : Number(message.date);
  return { id: message.id, text: message.message || message.text || '', date: seconds * 1000 };
}

export async function startTelegramWatcher(applyPost, setFeedStatus = () => {}) {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash || !existsSync(sessionPath)) {
    console.log('Telegram: настройте .env и запустите npm run telegram:login, чтобы включить сообщения канала.');
    return null;
  }
  setFeedStatus('connecting');
  const { TelegramClient, WebSocketTransport } = await import('teleproto');
  const { StringSession } = await import('teleproto/sessions');
  const { NewMessage, EditedMessage } = await import('teleproto/events');
  const client = new TelegramClient(new StringSession(readFileSync(sessionPath, 'utf8').trim()), apiId, apiHash, { connectionRetries: 5, transport: new WebSocketTransport() });
  await client.connect();
  if (!await client.checkAuthorization()) throw new Error('Сессия недействительна. Повторите npm run telegram:login.');
  const channel = await client.getEntity(channelName);
  const handle = event => {
    try { applyPost(postFromMessage(event.message)); }
    catch (error) { console.error(`Telegram: не удалось обработать сообщение: ${error.message}`); }
  };
  client.addEventHandler(handle, new NewMessage({ chats: [channelName] }));
  client.addEventHandler(handle, new EditedMessage({ chats: [channelName] }));
  const since = nextMoscowReset(Date.now()) - 86_400_000;
  const recent = [];
  for await (const message of client.iterMessages(channel)) {
    const post = postFromMessage(message);
    if (post.date < since) break;
    recent.push(post);
  }
  for (const post of recent.reverse()) applyPost(post);
  setFeedStatus('connected');
  const connectionTimer = setInterval(() => setFeedStatus(client.connected ? 'connected' : 'connecting'), 10_000);
  connectionTimer.unref();
  console.log(`Telegram: канал @${channelName} подключён, проверено ${recent.length} сообщений за текущий цикл.`);
  return client;
}
