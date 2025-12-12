import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "readline";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

if (!process.env.API_ID || !process.env.API_HASH) {
  console.error("❌ API_ID и API_HASH не найдены в .env!");
  console.log("Получите их на https://my.telegram.org/apps");
  process.exit(1);
}

const SESSION_FILE = path.join(process.cwd(), "telegram_session.txt");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log("🔐 Авторизация Telegram клиента для поиска в истории...\n");
  
  let stringSession = "";
  if (fs.existsSync(SESSION_FILE)) {
    stringSession = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    console.log("📁 Найдена сохраненная сессия");
  }
  
  const client = new TelegramClient(
    new StringSession(stringSession),
    parseInt(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 5,
    }
  );
  
  console.log("📱 Подключаюсь к Telegram...");
  
  await client.start({
    phoneNumber: async () => {
      return await question("Введите номер телефона (с кодом страны, например +79991234567): ");
    },
    password: async () => {
      return await question("Введите пароль двухфакторной аутентификации: ");
    },
    phoneCode: async () => {
      return await question("Введите код из Telegram: ");
    },
    onError: (err) => {
      console.error("❌ Ошибка авторизации:", err);
    },
  });
  
  const sessionString = client.session.save();
  fs.writeFileSync(SESSION_FILE, sessionString);
  
  console.log("\n✅ Авторизация успешна!");
  console.log(`📁 Сессия сохранена в: ${SESSION_FILE}`);
  console.log("\nТеперь можно использовать поиск в истории сообщений.");
  
  await client.disconnect();
  rl.close();
}

main().catch((error) => {
  console.error("❌ Ошибка:", error);
  process.exit(1);
});

