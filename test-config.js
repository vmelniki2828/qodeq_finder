import fs from "fs";
import path from "path";

const CONFIG_FILE = path.join(process.cwd(), "config.json");

const testConfig = {
  monitoredChats: ["123456789"],
  searchTerms: ["test"],
  notificationChatId: null,
  enableNotifications: true
};

try {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(testConfig, null, 2), "utf-8");
  console.log("✅ Тестовая конфигурация создана успешно!");
  
  const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  console.log("✅ Конфигурация загружена:", loaded);
} catch (error) {
  console.error("❌ Ошибка:", error.message);
}

