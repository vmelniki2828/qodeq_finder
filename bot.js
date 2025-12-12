import { Bot, Keyboard } from "grammy";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не найден в .env!");
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);
const CONFIG_FILE = path.join(process.cwd(), "config.json");

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch (error) {
    console.error("Ошибка загрузки:", error.message);
  }
  return {
    monitoredChats: [],
    searchTerms: [],
    notificationChatId: null,
    searchEnabled: true,
    searchResults: []
  };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch (error) {
    console.error("Ошибка сохранения:", error.message);
    return false;
  }
}

let CONFIG = loadConfig();
const userStates = new Map();

// Инициализация Telegram клиента для поиска в истории
let telegramClient = null;
const SESSION_FILE = path.join(process.cwd(), "telegram_session.txt");

async function initTelegramClient() {
  if (!process.env.API_ID || !process.env.API_HASH) {
    console.log("⚠️ API_ID и API_HASH не настроены. Поиск в истории будет недоступен.");
    console.log("Получите их на https://my.telegram.org/apps");
    return null;
  }
  
  let stringSession = "";
  if (fs.existsSync(SESSION_FILE)) {
    stringSession = fs.readFileSync(SESSION_FILE, "utf-8").trim();
  }
  
  const client = new TelegramClient(
    new StringSession(stringSession),
    parseInt(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 5,
    }
  );
  
  return client;
}

// Функция для поиска в истории канала/группы
async function searchInChannelHistory(chatId, searchTerms, limit = 1000) {
  if (!telegramClient || !telegramClient.connected) {
    return { error: "Telegram клиент не подключен" };
  }
  
  try {
    const results = [];
    
    console.log(`🔍 Начинаю поиск в истории канала ${chatId}...`);
    
    // Получаем entity чата
    let entity;
    let chatName = `Channel ${chatId}`;
    
    try {
      // Для каналов/супергрупп с ID типа -100XXXXXXXXXX
      // Библиотека telegram может работать с разными форматами
      if (typeof chatId === 'string' && chatId.startsWith('-100')) {
        // Для супергрупп и каналов используем полный ID
        // Пробуем получить entity по полному ID
        try {
          entity = await telegramClient.getEntity(chatId);
        } catch (e) {
          // Если не получилось, пробуем без префикса
          const cleanId = chatId.replace(/^-100/, '');
          entity = await telegramClient.getEntity(parseInt(cleanId));
        }
      } else if (typeof chatId === 'string' && chatId.startsWith('@')) {
        // Username
        entity = await telegramClient.getEntity(chatId);
      } else {
        // Пробуем как есть (может быть числовой ID)
        entity = await telegramClient.getEntity(chatId);
      }
      
      chatName = entity.title || entity.firstName || chatName;
    } catch (error) {
      console.error(`Ошибка получения entity для ${chatId}:`, error.message);
      return { error: `Не удалось получить доступ к каналу: ${error.message}\n\nУбедитесь, что:\n- Канал существует\n- Вы подписаны на канал\n- Канал не является приватным` };
    }
    
    console.log(`📱 Подключен к каналу: ${chatName}`);
    
    // Получаем историю сообщений
    let offsetId = 0;
    let hasMore = true;
    let processed = 0;
    
    while (hasMore && processed < limit) {
      try {
        // Используем правильный метод для получения сообщений
        const messages = await telegramClient.getMessages(entity, {
          limit: 100,
          minId: 0,
          maxId: offsetId || undefined
        });
        
        if (!messages || messages.length === 0) {
          hasMore = false;
          break;
        }
        
        // Сортируем по ID (от старых к новым)
        messages.sort((a, b) => a.id - b.id);
        
        for (const msg of messages) {
          processed++;
          if (processed > limit) {
            hasMore = false;
            break;
          }
          
          const text = msg.message || msg.text || "";
          const lowerText = text.toLowerCase();
          
          // Проверяем наличие искомых слов
          let foundTerm = null;
          for (const term of searchTerms) {
            if (lowerText.includes(term.toLowerCase())) {
              foundTerm = term;
              break;
            }
          }
          
          if (foundTerm) {
            const messageDate = msg.date ? (msg.date instanceof Date ? Math.floor(msg.date.getTime() / 1000) : msg.date) : Math.floor(Date.now() / 1000);
            const cleanChatId = String(chatId).replace(/^-100/, '');
            
            results.push({
              chatId: String(chatId),
              chatName: chatName,
              messageId: msg.id,
              text: text,
              author: "Канал",
              date: messageDate,
              link: `https://t.me/c/${cleanChatId}/${msg.id}`,
              foundTerm: foundTerm
            });
            
            console.log(`✅ Найдено сообщение #${msg.id} в "${chatName}"`);
          }
          
          // Обновляем offsetId для следующей итерации
          if (!offsetId || msg.id < offsetId) {
            offsetId = msg.id;
          }
        }
        
        if (messages.length < 100) {
          hasMore = false;
        }
        
        // Небольшая задержка чтобы не перегружать API
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Ошибка при получении сообщений:`, error.message);
        hasMore = false;
      }
    }
    
    console.log(`✅ Поиск завершен. Найдено: ${results.length} сообщений из ${processed} проверенных`);
    return { results, processed };
    
  } catch (error) {
    console.error("Ошибка поиска в истории:", error);
    return { error: error.message };
  }
}

function containsSearchTerms(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return CONFIG.searchTerms.some(term => lowerText.includes(term.toLowerCase()));
}

function findSearchTerm(text) {
  if (!text) return null;
  const lowerText = text.toLowerCase();
  for (const term of CONFIG.searchTerms) {
    if (lowerText.includes(term.toLowerCase())) {
      return term;
    }
  }
  return null;
}

function createMainMenu() {
  CONFIG = loadConfig();
  const searchStatus = CONFIG.searchEnabled ? "⏸️ Остановить поиск" : "▶️ Начать поиск";
  const resultsCount = CONFIG.searchResults ? CONFIG.searchResults.length : 0;
  
  const keyboard = new Keyboard()
    .text("➕ Добавить канал/группу")
    .row()
    .text("🔍 Добавить слово")
    .row()
    .text(searchStatus);
  
  if (resultsCount > 0) {
    keyboard.row().text(`📋 Показать результаты (${resultsCount})`);
  }
  
  keyboard
    .row()
    .text("📋 Список каналов")
    .text("📝 Список слов")
    .row()
    .text("⚙️ Настройки")
    .text("📊 Статус")
    .row()
    .text("🔙 Главное меню");
  
  return keyboard.resized().persistent();
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 **Добро пожаловать!**\n\nБот ищет слова в каналах, группах и чатах.\n\nВыберите действие:",
    {
      parse_mode: "Markdown",
      reply_markup: createMainMenu()
    }
  );
});

// Обработчик главного меню
bot.hears("🔙 Главное меню", async (ctx) => {
  // Сбрасываем состояние пользователя при возврате в главное меню
  userStates.delete(ctx.from.id);
  await ctx.reply("📱 **Главное меню:**", {
    parse_mode: "Markdown",
    reply_markup: createMainMenu()
  });
});

bot.hears("➕ Добавить канал/группу", async (ctx) => {
  userStates.set(ctx.from.id, { action: "add_chat" });
  await ctx.reply(
    "📱 **Добавить канал/группу/чат**\n\nОтправьте ID или @username:\n• ID: `-1001234567890`\n• Username: `@channelname`\n\nИспользуйте /chatid в чате для получения ID.\n\n⚠️ Для каналов бот должен быть администратором!",
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    }
  );
});

bot.hears("🔍 Добавить слово", async (ctx) => {
  userStates.set(ctx.from.id, { action: "add_word" });
  await ctx.reply(
    "🔍 **Добавить слово**\n\nОтправьте слово или фразу для поиска.\n\nПример: `javascript`",
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    }
  );
});

bot.hears("📋 Список каналов", async (ctx) => {
  CONFIG = loadConfig();
  if (CONFIG.monitoredChats.length === 0) {
    await ctx.reply("📋 Список пуст.", {
      reply_markup: new Keyboard().text("➕ Добавить канал/группу").row().text("🔙 Главное меню").resized().persistent()
    });
  } else {
    let msg = "📋 **Каналы/группы/чаты:**\n\n";
    for (let i = 0; i < CONFIG.monitoredChats.length; i++) {
      const chatId = CONFIG.monitoredChats[i];
      try {
        const chat = await ctx.api.getChat(chatId);
        msg += `${i + 1}. ${chat.title || chat.first_name || 'Chat'}\n   ID: \`${chatId}\`\n\n`;
      } catch (error) {
        msg += `${i + 1}. Недоступен (ID: \`${chatId}\`)\n\n`;
      }
    }
    msg += "Для удаления нажмите кнопку ниже:";
    
    const keyboard = new Keyboard();
    keyboard.text("🗑️ Удалить канал/группу");
    keyboard.row().text("🔙 Главное меню");
    
    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: keyboard.resized().persistent()
    });
  }
});

bot.hears("📝 Список слов", async (ctx) => {
  CONFIG = loadConfig();
  if (CONFIG.searchTerms.length === 0) {
    await ctx.reply("📝 Список пуст.", {
      reply_markup: new Keyboard().text("🔍 Добавить слово").row().text("🔙 Главное меню").resized().persistent()
    });
  } else {
    let msg = "📝 **Слова:**\n\n";
    CONFIG.searchTerms.forEach((term, i) => {
      msg += `${i + 1}. ${term}\n`;
    });
    msg += "\nДля удаления нажмите кнопку ниже:";
    
    const keyboard = new Keyboard();
    keyboard.text("🗑️ Удалить слово");
    keyboard.row().text("🔙 Главное меню");
    
    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: keyboard.resized().persistent()
    });
  }
});

bot.hears("⚙️ Настройки", async (ctx) => {
  CONFIG = loadConfig();
  await ctx.reply(
    `⚙️ **Настройки**\n\n📬 Уведомления: ${CONFIG.notificationChatId ? "✅" : "❌"}\n📊 Каналов: ${CONFIG.monitoredChats.length}\n🔍 Слов: ${CONFIG.searchTerms.length}\n🔎 Поиск: ${CONFIG.searchEnabled ? "✅ Включен" : "⏸️ Остановлен"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard()
        .text("📬 Настроить уведомления")
        .row()
        .text("🔙 Главное меню")
        .resized()
        .persistent()
    }
  );
});

bot.hears("📬 Настроить уведомления", async (ctx) => {
  CONFIG = loadConfig();
  CONFIG.notificationChatId = String(ctx.chat.id);
  if (saveConfig(CONFIG)) {
    await ctx.reply(`✅ Уведомления настроены!\n\nID: \`${ctx.chat.id}\``, {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    });
  }
});

bot.hears("📊 Статус", async (ctx) => {
  CONFIG = loadConfig();
  await ctx.reply(
    `📊 **Статус**\n\n📱 Каналов: ${CONFIG.monitoredChats.length}\n🔍 Слов: ${CONFIG.searchTerms.length}\n📬 Уведомления: ${CONFIG.notificationChatId ? "✅" : "❌"}\n🔎 Поиск: ${CONFIG.searchEnabled ? "✅ Включен" : "⏸️ Остановлен"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    }
  );
});

// Обработчик для начала/остановки поиска
bot.hears(/^(▶️ Начать поиск|⏸️ Остановить поиск)$/, async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchEnabled) {
    // Начинаем поиск в истории
    
    if (CONFIG.monitoredChats.length === 0) {
      await ctx.reply(
        "❌ **Нет каналов для поиска!**\n\nСначала добавьте канал/группу/чат.",
        {
          parse_mode: "Markdown",
          reply_markup: new Keyboard().text("➕ Добавить канал/группу").row().text("🔙 Главное меню").resized().persistent()
        }
      );
      return;
    }
    
    if (CONFIG.searchTerms.length === 0) {
      await ctx.reply(
        "❌ **Нет слов для поиска!**\n\nСначала добавьте слово для поиска.",
        {
          parse_mode: "Markdown",
          reply_markup: new Keyboard().text("🔍 Добавить слово").row().text("🔙 Главное меню").resized().persistent()
        }
      );
      return;
    }
    
    // Очищаем предыдущие результаты
    CONFIG.searchResults = [];
    CONFIG.searchEnabled = true;
    saveConfig(CONFIG);
    
    await ctx.reply(
      "🔍 **Поиск в истории начат!**\n\nИщу слова в истории каналов...\n\nЭто может занять некоторое время.",
      {
        parse_mode: "Markdown",
        reply_markup: new Keyboard().text("⏸️ Остановить поиск").row().text("🔙 Главное меню").resized().persistent()
      }
    );
    
    // Запускаем поиск в истории асинхронно
    (async () => {
      try {
        // Инициализируем клиент если нужно
        if (!telegramClient) {
          telegramClient = await initTelegramClient();
          if (!telegramClient) {
            await ctx.reply(
              "❌ **Ошибка подключения!**\n\nНужны API_ID и API_HASH от https://my.telegram.org/apps\n\nДобавьте их в .env файл.",
              {
                parse_mode: "Markdown",
                reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
              }
            );
            return;
          }
          
          if (!telegramClient.connected) {
            console.log("🔐 Подключаюсь к Telegram...");
            await telegramClient.connect();
            
            if (!await telegramClient.checkAuthorization()) {
              await ctx.reply(
                "❌ **Требуется авторизация!**\n\nЗапустите бота из консоли для первой авторизации.\n\nИли используйте отдельный скрипт для авторизации.",
                {
                  parse_mode: "Markdown",
                  reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
                }
              );
              return;
            }
            
            // Сохраняем сессию
            const sessionString = telegramClient.session.save();
            fs.writeFileSync(SESSION_FILE, sessionString);
          }
        }
        
        // Ищем в каждом канале
        let totalFound = 0;
        for (const chatId of CONFIG.monitoredChats) {
          const searchResult = await searchInChannelHistory(chatId, CONFIG.searchTerms, 1000);
          
          if (searchResult.results) {
            CONFIG.searchResults.push(...searchResult.results);
            totalFound += searchResult.results.length;
            saveConfig(CONFIG);
          }
        }
        
        CONFIG.searchEnabled = false;
        saveConfig(CONFIG);
        
        await ctx.reply(
          `✅ **Поиск завершен!**\n\nНайдено сообщений: **${totalFound}**\n\nИспользуйте кнопку "📋 Показать результаты" для просмотра.`,
          {
            parse_mode: "Markdown",
            reply_markup: createMainMenu()
          }
        );
        
      } catch (error) {
        console.error("Ошибка поиска:", error);
        await ctx.reply(
          `❌ **Ошибка поиска:**\n\n${error.message}\n\nПроверьте настройки API_ID и API_HASH.`,
          {
            parse_mode: "Markdown",
            reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
          }
        );
      }
    })();
    
  } else {
    // Останавливаем поиск
    CONFIG.searchEnabled = false;
    saveConfig(CONFIG);
    
    await ctx.reply(
      "⏸️ **Поиск остановлен!**\n\nНайдено сообщений: " + CONFIG.searchResults.length,
      {
        parse_mode: "Markdown",
        reply_markup: createMainMenu()
      }
    );
  }
});

bot.hears(/^📋 Показать результаты/, async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchResults || CONFIG.searchResults.length === 0) {
    await ctx.reply(
      "📋 **Результаты поиска**\n\nПока ничего не найдено.\n\nНачните поиск, чтобы найти сообщения.",
      {
        parse_mode: "Markdown",
        reply_markup: new Keyboard().text("▶️ Начать поиск").row().text("🔙 Главное меню").resized().persistent()
      }
    );
    return;
  }
  
  // Показываем список результатов с номерами
  let message = `📋 **Результаты поиска**\n\nНайдено сообщений: **${CONFIG.searchResults.length}**\n\n`;
  message += "Список найденных сообщений:\n\n";
  
  CONFIG.searchResults.forEach((result, index) => {
    message += `${index + 1}. **${result.chatName}**\n`;
    message += `   🔍 Найдено по слову: **${result.foundTerm || 'неизвестно'}**\n`;
    message += `   🔗 [Ссылка на пост](${result.link})\n\n`;
  });
  
  await ctx.reply(message, {
    parse_mode: "Markdown",
    reply_markup: new Keyboard()
      .text("📄 Показать все")
      .row()
      .text("🗑️ Очистить")
      .row()
      .text("🔙 Главное меню")
      .resized()
      .persistent()
  });
});

// Показать все результаты по одному
bot.hears("📄 Показать все", async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchResults || CONFIG.searchResults.length === 0) {
    await ctx.reply("Нет результатов", {
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    });
    return;
  }
  
  // Отправляем каждое сообщение отдельно
  for (let i = 0; i < CONFIG.searchResults.length; i++) {
    const result = CONFIG.searchResults[i];
    
    const fullMessage = `🔍 **Найдено совпадение #${i + 1}**

📱 **Канал:** ${result.chatName}
🔍 **Найдено по слову:** ${result.foundTerm || 'неизвестно'}
🔗 [Ссылка на пост](${result.link})`;
    
    try {
      await ctx.reply(fullMessage, {
        parse_mode: "Markdown"
      });
    } catch (error) {
      console.error("Ошибка отправки результата:", error.message);
    }
  }
  
  await ctx.reply("✅ Все результаты отправлены!", {
    reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
  });
});

bot.hears("🗑️ Очистить", async (ctx) => {
  CONFIG = loadConfig();
  CONFIG.searchResults = [];
  saveConfig(CONFIG);
  
  await ctx.reply(
    "🗑️ **Результаты очищены!**",
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    }
  );
});

// Удаление канала/группы
bot.hears("🗑️ Удалить канал/группу", async (ctx) => {
  CONFIG = loadConfig();
  if (CONFIG.monitoredChats.length === 0) {
    await ctx.reply("📋 Список пуст. Нечего удалять.", {
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    });
    return;
  }
  
  let msg = "🗑️ **Удаление канала/группы**\n\nВыберите номер для удаления:\n\n";
  for (let i = 0; i < CONFIG.monitoredChats.length; i++) {
    const chatId = CONFIG.monitoredChats[i];
    try {
      const chat = await ctx.api.getChat(chatId);
      msg += `${i + 1}. ${chat.title || chat.first_name || 'Chat'}\n   ID: \`${chatId}\`\n\n`;
    } catch (error) {
      msg += `${i + 1}. Недоступен (ID: \`${chatId}\`)\n\n`;
    }
  }
  msg += "Отправьте номер канала/группы для удаления:";
  
  userStates.set(ctx.from.id, { action: "delete_chat" });
  
  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
  });
});

// Удаление слова
bot.hears("🗑️ Удалить слово", async (ctx) => {
  CONFIG = loadConfig();
  if (CONFIG.searchTerms.length === 0) {
    await ctx.reply("📝 Список пуст. Нечего удалять.", {
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    });
    return;
  }
  
  let msg = "🗑️ **Удаление слова**\n\nВыберите номер для удаления:\n\n";
  CONFIG.searchTerms.forEach((term, i) => {
    msg += `${i + 1}. ${term}\n`;
  });
  msg += "\nОтправьте номер слова для удаления:";
  
  userStates.set(ctx.from.id, { action: "delete_word" });
  
  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
  });
});

bot.on("message", async (ctx) => {
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    return;
  }
  
  // Игнорируем нажатия кнопок меню
  const menuButtons = [
    "➕ Добавить канал/группу",
    "🔍 Добавить слово",
    "▶️ Начать поиск",
    "⏸️ Остановить поиск",
    "📋 Показать результаты",
    "📋 Список каналов",
    "📝 Список слов",
    "⚙️ Настройки",
    "📊 Статус",
    "🔙 Главное меню",
    "📬 Настроить уведомления",
    "📄 Показать все",
    "🗑️ Очистить",
    "🗑️ Удалить канал/группу",
    "🗑️ Удалить слово"
  ];
  
  if (ctx.message.text && menuButtons.includes(ctx.message.text)) {
    return; // Обработчики hears() обработают это
  }
  
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (state) {
    const text = ctx.message.text || ctx.message.caption || '';
    
    if (state.action === "add_chat") {
      CONFIG = loadConfig();
      const input = text.trim();
      let chatId = null;
      let chatName = null;
      
      try {
        let identifier = input;
        if (!input.startsWith('@') && /^-?\d+$/.test(input)) {
          identifier = input;
        } else if (!input.startsWith('@')) {
          identifier = '@' + input;
        }
        
        const chat = await ctx.api.getChat(identifier);
        chatId = String(chat.id);
        chatName = chat.title || chat.first_name || `Chat ${chatId}`;
      } catch (error) {
        if (/^-?\d+$/.test(input)) {
          chatId = input;
          chatName = `Chat ${chatId}`;
        } else {
          await ctx.reply(`❌ Ошибка: ${error.description || error.message}`, {
            reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
          });
          userStates.delete(userId);
          return;
        }
      }
      
      if (CONFIG.monitoredChats.includes(chatId)) {
        await ctx.reply(`❌ Уже в списке!`, {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
        userStates.delete(userId);
        return;
      }
      
      CONFIG.monitoredChats.push(chatId);
      if (saveConfig(CONFIG)) {
        await ctx.reply(`✅ "${chatName}" добавлен!\n\nID: \`${chatId}\``, {
          parse_mode: "Markdown",
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
      }
      userStates.delete(userId);
    }
    
    if (state.action === "add_word") {
      CONFIG = loadConfig();
      const word = text.trim().toLowerCase();
      
      if (!word) {
        await ctx.reply("❌ Слово не может быть пустым!");
        return;
      }
      
      if (CONFIG.searchTerms.includes(word)) {
        await ctx.reply(`❌ Уже в списке!`, {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
        userStates.delete(userId);
        return;
      }
      
      CONFIG.searchTerms.push(word);
      if (saveConfig(CONFIG)) {
        await ctx.reply(`✅ Слово "${text.trim()}" добавлено!`, {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
      }
      userStates.delete(userId);
    }
    
    if (state.action === "delete_chat") {
      CONFIG = loadConfig();
      const input = text.trim();
      const index = parseInt(input) - 1;
      
      if (isNaN(index) || index < 0 || index >= CONFIG.monitoredChats.length) {
        await ctx.reply("❌ Неверный номер! Попробуйте еще раз или нажмите '🔙 Главное меню' для отмены.", {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
        return;
      }
      
      const chatId = CONFIG.monitoredChats[index];
      let chatName = `Chat ${chatId}`;
      
      try {
        const chat = await ctx.api.getChat(chatId);
        chatName = chat.title || chat.first_name || chatName;
      } catch (error) {
        // Используем chatName по умолчанию
      }
      
      CONFIG.monitoredChats.splice(index, 1);
      if (saveConfig(CONFIG)) {
        await ctx.reply(`✅ Канал/группа "${chatName}" удален из списка!`, {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
      } else {
        await ctx.reply("❌ Ошибка при сохранении.", {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
      }
      userStates.delete(userId);
    }
    
    if (state.action === "delete_word") {
      CONFIG = loadConfig();
      const input = text.trim();
      const index = parseInt(input) - 1;
      
      if (isNaN(index) || index < 0 || index >= CONFIG.searchTerms.length) {
        await ctx.reply("❌ Неверный номер! Попробуйте еще раз или нажмите '🔙 Главное меню' для отмены.", {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
        return;
      }
      
      const word = CONFIG.searchTerms[index];
      CONFIG.searchTerms.splice(index, 1);
      if (saveConfig(CONFIG)) {
        await ctx.reply(`✅ Слово "${word}" удалено из списка!`, {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
      } else {
        await ctx.reply("❌ Ошибка при сохранении.", {
          reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
        });
      }
      userStates.delete(userId);
    }
    return;
  }
  
  // Поиск в сообщениях
  CONFIG = loadConfig();
  
  // Проверяем, включен ли поиск
  if (!CONFIG.searchEnabled) {
    return;
  }
  
  const chatId = String(ctx.chat.id);
  console.log(`📨 Получено сообщение из чата: ${chatId}`);
  
  if (CONFIG.monitoredChats.length > 0 && !CONFIG.monitoredChats.includes(chatId)) {
    console.log(`❌ Чат ${chatId} не в списке мониторинга`);
    return;
  }
  
  if (CONFIG.searchTerms.length === 0) {
    console.log(`❌ Нет слов для поиска`);
    return;
  }
  
  const messageText = ctx.message.text || ctx.message.caption || '';
  console.log(`🔍 Проверяю сообщение на слова: ${CONFIG.searchTerms.join(', ')}`);
  console.log(`📝 Текст: ${messageText.substring(0, 100)}...`);
  
  const foundTerm = findSearchTerm(messageText);
  if (foundTerm) {
    const chatName = ctx.chat.title || ctx.chat.first_name || `Chat ${ctx.chat.id}`;
    console.log(`✅ ✅ ✅ НАЙДЕНО СОВПАДЕНИЕ в "${chatName}"`);
    
    // Сохраняем результат поиска (полное сообщение)
    const result = {
      chatId: String(ctx.chat.id),
      chatName: chatName,
      messageId: ctx.message.message_id,
      text: messageText, // Полный текст сообщения
      author: ctx.from ? (ctx.from.first_name || ctx.from.username || 'Неизвестно') : 'Неизвестно',
      date: ctx.message.date,
      link: `https://t.me/c/${String(ctx.chat.id).slice(4)}/${ctx.message.message_id}`,
      foundTerm: foundTerm
    };
    
    CONFIG.searchResults.push(result);
    saveConfig(CONFIG);
    
    console.log(`💾 Сохранено сообщение #${CONFIG.searchResults.length} из "${chatName}"`);
    
    const notification = `🔍 **Найдено совпадение!**

📱 **Источник:** ${chatName}
👤 **Автор:** ${ctx.from ? (ctx.from.first_name || ctx.from.username || 'Неизвестно') : 'Неизвестно'}
🕐 **Время:** ${new Date(ctx.message.date * 1000).toLocaleString('ru-RU')}

💬 **Сообщение:**
${messageText}`;
    
    if (CONFIG.notificationChatId) {
      try {
        await bot.api.sendMessage(CONFIG.notificationChatId, notification, {
          parse_mode: "Markdown"
        });
        console.log(`📬 Уведомление отправлено`);
      } catch (error) {
        console.error('❌ Ошибка уведомления:', error.message);
      }
    }
  } else {
    console.log(`❌ Совпадений не найдено`);
  }
});

// Обработка каналов
bot.on("channel_post", async (ctx) => {
  try {
    CONFIG = loadConfig();
    const chatId = String(ctx.chat.id);
    
    console.log(`📢 Получено сообщение из канала: ${chatId}`);
    
    // Проверяем, включен ли поиск
    if (!CONFIG.searchEnabled) {
      console.log(`⏸️ Поиск выключен, пропускаем`);
      return;
    }
    
    // Проверяем, мониторим ли этот канал
    if (CONFIG.monitoredChats.length > 0 && !CONFIG.monitoredChats.includes(chatId)) {
      console.log(`❌ Канал ${chatId} не в списке мониторинга`);
      return;
    }
    
    if (CONFIG.searchTerms.length === 0) {
      console.log(`❌ Нет слов для поиска`);
      return;
    }
    
    const messageText = ctx.channelPost.text || ctx.channelPost.caption || '';
    console.log(`🔍 Проверяю сообщение на слова: ${CONFIG.searchTerms.join(', ')}`);
    console.log(`📝 Текст сообщения: ${messageText.substring(0, 100)}...`);
    
    const foundTerm = findSearchTerm(messageText);
    if (foundTerm) {
      const chatName = ctx.chat.title || `Channel ${ctx.chat.id}`;
      console.log(`✅ ✅ ✅ НАЙДЕНО СОВПАДЕНИЕ в канале "${chatName}"`);
      
      // Сохраняем результат поиска (полное сообщение из канала)
      const result = {
        chatId: String(ctx.chat.id),
        chatName: chatName,
        messageId: ctx.channelPost.message_id,
        text: messageText, // Полный текст сообщения
        author: 'Канал',
        date: ctx.channelPost.date,
        link: `https://t.me/c/${String(ctx.chat.id).slice(4)}/${ctx.channelPost.message_id}`,
        foundTerm: foundTerm
      };
      
      CONFIG.searchResults.push(result);
      saveConfig(CONFIG);
      
      console.log(`💾 Сохранено сообщение #${CONFIG.searchResults.length} из канала "${chatName}"`);
      
      const notification = `🔍 **Найдено в канале!**

📢 **Канал:** ${chatName}
🕐 **Время:** ${new Date(ctx.channelPost.date * 1000).toLocaleString('ru-RU')}

💬 **Сообщение:**
${messageText}`;
      
      if (CONFIG.notificationChatId) {
        try {
          await bot.api.sendMessage(CONFIG.notificationChatId, notification, {
            parse_mode: "Markdown"
          });
          console.log(`📬 Уведомление отправлено в чат ${CONFIG.notificationChatId}`);
        } catch (error) {
          console.error('❌ Ошибка уведомления:', error.message);
        }
      }
    } else {
      console.log(`❌ Совпадений не найдено`);
    }
  } catch (error) {
    console.error('❌ Ошибка при обработке channel_post:', error.message);
  }
});

bot.catch((err) => {
  console.error("Ошибка:", err);
});

async function start() {
  try {
    const me = await bot.api.getMe();
    console.log(`✅ Бот запущен: @${me.username}`);
    console.log(`📊 Каналов: ${CONFIG.monitoredChats.length}`);
    console.log(`🔍 Слов: ${CONFIG.searchTerms.length}`);
    
    // Инициализируем Telegram клиент для поиска в истории
    if (process.env.API_ID && process.env.API_HASH) {
      telegramClient = await initTelegramClient();
      if (telegramClient) {
        console.log("📱 Telegram клиент инициализирован для поиска в истории");
        // Пытаемся подключиться если есть сохраненная сессия
        try {
          if (fs.existsSync(SESSION_FILE)) {
            await telegramClient.connect();
            if (await telegramClient.checkAuthorization()) {
              console.log("✅ Telegram клиент авторизован");
            } else {
              console.log("⚠️ Требуется авторизация Telegram клиента");
              console.log("Запустите скрипт авторизации или авторизуйтесь вручную");
            }
          }
        } catch (error) {
          console.log("⚠️ Ошибка подключения Telegram клиента:", error.message);
        }
      }
    } else {
      console.log("⚠️ API_ID и API_HASH не настроены. Поиск в истории недоступен.");
      console.log("Получите их на https://my.telegram.org/apps");
    }
    
    await bot.start();
  } catch (error) {
    console.error("❌ Ошибка:", error.message);
    process.exit(1);
  }
}

start();

