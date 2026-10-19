import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

const root = join(import.meta.dirname, '..');
const envPath = join(root, '.env');
const sessionPath = join(root, '.data', 'telegram.session');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error('Добавьте TELEGRAM_API_ID и TELEGRAM_API_HASH в локальный файл .env.');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(existsSync(sessionPath) ? readFileSync(sessionPath, 'utf8').trim() : ''), apiId, apiHash, { connectionRetries: 5 });
try {
  await client.start({
    phoneNumber: () => rl.question('Номер Telegram с кодом страны: '),
    phoneCode: () => rl.question('Код входа Telegram: '),
    password: () => rl.question('Пароль двухэтапной проверки, если запрошен: '),
    emailAddress: () => rl.question('Email для входа, если запрошен: '),
    emailVerification: async () => ({ type: 'code', code: await rl.question('Код из email: ') }),
    onError: error => console.error(`Ошибка входа: ${error.message}`)
  });
  mkdirSync(join(root, '.data'), { recursive: true });
  writeFileSync(sessionPath, client.session.save(), { mode: 0o600 });
  console.log('Сессия Telegram сохранена локально. Теперь запустите npm start.');
} finally {
  rl.close();
  await client.disconnect();
}
