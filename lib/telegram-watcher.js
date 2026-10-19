import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextMoscowReset } from './alerts.js';

const root = join(import.meta.dirname, '..');
const sessionPath = join(root, '.data', 'telegram.session');
const channelNames = ['radar_moscoww', 'radarrussiia'];

function postFromMessage(message, source) {
  const updated = message.editDate ?? message.date;
  const seconds = updated instanceof Date ? updated.getTime() / 1000 : Number(updated);
  return { source, id: message.id, text: message.message || message.text || '', date: seconds * 1000 };
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
  const since = nextMoscowReset(Date.now()) - 86_400_000;
  const recent = [];
  let connectedChannels = 0;
  for (const channelName of channelNames) {
    try {
      const channel = await client.getEntity(channelName);
      const handle = event => {
        try { applyPost(postFromMessage(event.message, channelName)); }
        catch (error) { console.error(`Telegram @${channelName}: не удалось обработать сообщение: ${error.message}`); }
      };
      client.addEventHandler(handle, new NewMessage({ chats: [channelName] }));
      client.addEventHandler(handle, new EditedMessage({ chats: [channelName] }));
      let count = 0;
      for await (const message of client.iterMessages(channel)) {
        const post = postFromMessage(message, channelName);
        if (post.date < since) break;
        recent.push(post);
        count++;
      }
      connectedChannels++;
      console.log(`Telegram: канал @${channelName} подключён, проверено ${count} сообщений за текущий цикл.`);
    } catch (error) { console.error(`Telegram @${channelName}: ${error.message}`); }
  }
  recent.sort((a, b) => a.date - b.date || a.id - b.id);
  for (const post of recent) applyPost(post);
  setFeedStatus(connectedChannels === channelNames.length ? 'connected' : 'error');
  const connectionTimer = setInterval(() => setFeedStatus(client.connected ? connectedChannels === channelNames.length ? 'connected' : 'error' : 'connecting'), 10_000);
  connectionTimer.unref();
  if (!connectedChannels) throw new Error('Не удалось подключить ни один канал.');
  return client;
}
