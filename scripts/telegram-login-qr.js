import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
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
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const client = new TelegramClient(new StringSession(existsSync(sessionPath) ? readFileSync(sessionPath, 'utf8').trim() : ''), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.connect();
  if (!await client.checkAuthorization()) {
    console.log('Откройте Telegram на телефоне → Настройки → Устройства → Подключить устройство и отсканируйте QR-код ниже. Не показывайте его другим людям.');
    await client.signInUserWithQrCode({ apiId, apiHash }, {
      abortSignal: controller.signal,
      qrCode: async ({ token }) => {
        console.log('\nQR-код для входа (при истечении срока появится новый):');
        qrcode.generate(`tg://login?token=${token.toString('base64url')}`, { small: true });
      },
      password: () => rl.question('Пароль двухэтапной проверки, если запрошен: '),
      onError: error => { console.error(`Ошибка входа: ${error.message}`); return true; }
    });
  }
  if (!await client.checkAuthorization()) throw new Error('Telegram не подтвердил вход.');
  mkdirSync(join(root, '.data'), { recursive: true });
  writeFileSync(sessionPath, client.session.save(), { mode: 0o600 });
  console.log('Сессия Telegram сохранена локально. Теперь запустите npm start.');
} catch (error) {
  if (error.name === 'AbortError') console.log('Вход по QR-коду отменён.');
  else { console.error(`Не удалось войти: ${error.message}`); process.exitCode = 1; }
} finally {
  rl.close();
  await client.disconnect();
}
