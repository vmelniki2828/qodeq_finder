import { Bot, InlineKeyboard } from "grammy";
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
          const found = searchTerms.some(term => 
            lowerText.includes(term.toLowerCase())
          );
          
          if (found) {
            const messageDate = msg.date ? (msg.date instanceof Date ? Math.floor(msg.date.getTime() / 1000) : msg.date) : Math.floor(Date.now() / 1000);
            const cleanChatId = String(chatId).replace(/^-100/, '');
            
            results.push({
              chatId: String(chatId),
              chatName: chatName,
              messageId: msg.id,
              text: text,
              author: "Канал",
              date: messageDate,
              link: `https://t.me/c/${cleanChatId}/${msg.id}`
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

function createMainMenu() {
  CONFIG = loadConfig();
  const searchStatus = CONFIG.searchEnabled ? "⏸️ Остановить поиск" : "▶️ Начать поиск";
  const resultsCount = CONFIG.searchResults ? CONFIG.searchResults.length : 0;
  
  const keyboard = new InlineKeyboard()
    .text("➕ Добавить канал/группу", "add_chat")
    .row()
    .text("🔍 Добавить слово", "add_word")
    .row()
    .text(searchStatus, "toggle_search");
  
  if (resultsCount > 0) {
    keyboard.row().text(`📋 Показать результаты (${resultsCount})`, "show_results");
  }
  
  keyboard
    .row()
    .text("📋 Список каналов", "list_chats")
    .text("📝 Список слов", "list_words")
    .row()
    .text("⚙️ Настройки", "settings")
    .text("📊 Статус", "status");
  
  return keyboard;
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

bot.callbackQuery("add_chat", async (ctx) => {
  userStates.set(ctx.from.id, { action: "add_chat" });
  await ctx.editMessageText(
    "📱 **Добавить канал/группу/чат**\n\nОтправьте ID или @username:\n• ID: `-1001234567890`\n• Username: `@channelname`\n\nИспользуйте /chatid в чате для получения ID.\n\n⚠️ Для каналов бот должен быть администратором!",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Назад", "menu_main")
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("add_word", async (ctx) => {
  userStates.set(ctx.from.id, { action: "add_word" });
  await ctx.editMessageText(
    "🔍 **Добавить слово**\n\nОтправьте слово или фразу для поиска.\n\nПример: `javascript`",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Назад", "menu_main")
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("list_chats", async (ctx) => {
  CONFIG = loadConfig();
  if (CONFIG.monitoredChats.length === 0) {
    await ctx.editMessageText("📋 Список пуст.", {
      reply_markup: new InlineKeyboard().text("➕ Добавить", "add_chat").row().text("🔙 Назад", "menu_main")
    });
  } else {
    let msg = "📋 **Каналы/группы/чаты:**\n\n";
    for (const chatId of CONFIG.monitoredChats) {
      try {
        const chat = await ctx.api.getChat(chatId);
        msg += `• ${chat.title || chat.first_name || 'Chat'}\n  ID: \`${chatId}\`\n\n`;
      } catch (error) {
        msg += `• Недоступен (ID: \`${chatId}\`)\n\n`;
      }
    }
    await ctx.editMessageText(msg, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Назад", "menu_main")
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("list_words", async (ctx) => {
  CONFIG = loadConfig();
  if (CONFIG.searchTerms.length === 0) {
    await ctx.editMessageText("📝 Список пуст.", {
      reply_markup: new InlineKeyboard().text("➕ Добавить", "add_word").row().text("🔙 Назад", "menu_main")
    });
  } else {
    let msg = "📝 **Слова:**\n\n";
    CONFIG.searchTerms.forEach((term, i) => {
      msg += `${i + 1}. ${term}\n`;
    });
    await ctx.editMessageText(msg, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Назад", "menu_main")
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("settings", async (ctx) => {
  CONFIG = loadConfig();
  await ctx.editMessageText(
    `⚙️ **Настройки**\n\n📬 Уведомления: ${CONFIG.notificationChatId ? "✅" : "❌"}\n📊 Каналов: ${CONFIG.monitoredChats.length}\n🔍 Слов: ${CONFIG.searchTerms.length}\n🔎 Поиск: ${CONFIG.searchEnabled ? "✅ Включен" : "⏸️ Остановлен"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("📬 Настроить уведомления", "set_notification")
        .row()
        .text("🔙 Назад", "menu_main")
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("set_notification", async (ctx) => {
  CONFIG = loadConfig();
  CONFIG.notificationChatId = String(ctx.chat.id);
  if (saveConfig(CONFIG)) {
    await ctx.editMessageText(`✅ Уведомления настроены!\n\nID: \`${ctx.chat.id}\``, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Назад", "settings")
    });
    await ctx.answerCallbackQuery("✅ Готово!");
  }
});

bot.callbackQuery("status", async (ctx) => {
  CONFIG = loadConfig();
  await ctx.editMessageText(
    `📊 **Статус**\n\n📱 Каналов: ${CONFIG.monitoredChats.length}\n🔍 Слов: ${CONFIG.searchTerms.length}\n📬 Уведомления: ${CONFIG.notificationChatId ? "✅" : "❌"}\n🔎 Поиск: ${CONFIG.searchEnabled ? "✅ Включен" : "⏸️ Остановлен"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Назад", "menu_main")
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("toggle_search", async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchEnabled) {
    // Начинаем поиск в истории
    await ctx.answerCallbackQuery("🔍 Начинаю поиск в истории...");
    
    if (CONFIG.monitoredChats.length === 0) {
      await ctx.editMessageText(
        "❌ **Нет каналов для поиска!**\n\nСначала добавьте канал/группу/чат.",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("➕ Добавить канал", "add_chat").row().text("🔙 Назад", "menu_main")
        }
      );
      return;
    }
    
    if (CONFIG.searchTerms.length === 0) {
      await ctx.editMessageText(
        "❌ **Нет слов для поиска!**\n\nСначала добавьте слово для поиска.",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("🔍 Добавить слово", "add_word").row().text("🔙 Назад", "menu_main")
        }
      );
      return;
    }
    
    // Очищаем предыдущие результаты
    CONFIG.searchResults = [];
    CONFIG.searchEnabled = true;
    saveConfig(CONFIG);
    
    await ctx.editMessageText(
      "🔍 **Поиск в истории начат!**\n\nИщу слова в истории каналов...\n\nЭто может занять некоторое время.",
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⏸️ Остановить", "toggle_search")
      }
    );
    
    // Запускаем поиск в истории асинхронно
    (async () => {
      try {
        // Инициализируем клиент если нужно
        if (!telegramClient) {
          telegramClient = await initTelegramClient();
          if (!telegramClient) {
            await ctx.editMessageText(
              "❌ **Ошибка подключения!**\n\nНужны API_ID и API_HASH от https://my.telegram.org/apps\n\nДобавьте их в .env файл.",
              {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
              }
            );
            return;
          }
          
          if (!telegramClient.connected) {
            console.log("🔐 Подключаюсь к Telegram...");
            await telegramClient.connect();
            
            if (!await telegramClient.checkAuthorization()) {
              await ctx.editMessageText(
                "❌ **Требуется авторизация!**\n\nЗапустите бота из консоли для первой авторизации.\n\nИли используйте отдельный скрипт для авторизации.",
                {
                  parse_mode: "Markdown",
                  reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
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
        
        await ctx.editMessageText(
          `✅ **Поиск завершен!**\n\nНайдено сообщений: **${totalFound}**\n\nИспользуйте кнопку "📋 Показать результаты" для просмотра.`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard()
              .text("📋 Показать результаты", "show_results")
              .row()
              .text("🔙 Главное меню", "menu_main")
          }
        );
        
      } catch (error) {
        console.error("Ошибка поиска:", error);
        await ctx.editMessageText(
          `❌ **Ошибка поиска:**\n\n${error.message}\n\nПроверьте настройки API_ID и API_HASH.`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
          }
        );
      }
    })();
    
  } else {
    // Останавливаем поиск
    CONFIG.searchEnabled = false;
    saveConfig(CONFIG);
    
    await ctx.answerCallbackQuery("⏸️ Поиск остановлен!");
    await ctx.editMessageText(
      "⏸️ **Поиск остановлен!**\n\nНайдено сообщений: " + CONFIG.searchResults.length,
      {
        parse_mode: "Markdown",
        reply_markup: createMainMenu()
      }
    );
  }
});

bot.callbackQuery("show_results", async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchResults || CONFIG.searchResults.length === 0) {
    await ctx.editMessageText(
      "📋 **Результаты поиска**\n\nПока ничего не найдено.\n\nНачните поиск, чтобы найти сообщения.",
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("▶️ Начать поиск", "toggle_search").row().text("🔙 Назад", "menu_main")
      }
    );
    await ctx.answerCallbackQuery();
    return;
  }
  
  // Показываем список результатов с номерами
  let message = `📋 **Результаты поиска**\n\nНайдено сообщений: **${CONFIG.searchResults.length}**\n\n`;
  message += "Выберите номер для просмотра полного сообщения:\n\n";
  
  CONFIG.searchResults.forEach((result, index) => {
    const date = new Date(result.date * 1000).toLocaleString('ru-RU');
    const preview = result.text.length > 80 ? result.text.substring(0, 80) + '...' : result.text;
    message += `${index + 1}. **${result.chatName}**\n`;
    message += `   📅 ${date}\n`;
    message += `   💬 ${preview}\n\n`;
  });
  
  await ctx.editMessageText(message, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("📄 Показать все", "show_all_results")
      .row()
      .text("🗑️ Очистить", "clear_results")
      .row()
      .text("🔙 Главное меню", "menu_main")
  });
  await ctx.answerCallbackQuery();
});

// Показать все результаты по одному
bot.callbackQuery("show_all_results", async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchResults || CONFIG.searchResults.length === 0) {
    await ctx.answerCallbackQuery("Нет результатов");
    return;
  }
  
  // Отправляем каждое сообщение отдельно
  for (let i = 0; i < CONFIG.searchResults.length; i++) {
    const result = CONFIG.searchResults[i];
    const date = new Date(result.date * 1000).toLocaleString('ru-RU');
    
    const fullMessage = `🔍 **Найдено совпадение #${i + 1}**

📱 **Источник:** ${result.chatName}
👤 **Автор:** ${result.author}
📅 **Время:** ${date}

💬 **Полное сообщение:**

${result.text}`;
    
    try {
      if (i === 0) {
        // Первое сообщение редактируем
        await ctx.editMessageText(fullMessage, {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("➡️ Следующее", `next_result_${i + 1}`)
            .row()
            .text("🔙 К списку", "show_results")
        });
      } else {
        // Остальные отправляем новыми сообщениями
        await ctx.reply(fullMessage, {
          parse_mode: "Markdown"
        });
      }
    } catch (error) {
      console.error("Ошибка отправки результата:", error.message);
    }
  }
  
  await ctx.answerCallbackQuery("✅ Все результаты отправлены!");
});

// Навигация по результатам
bot.callbackQuery(/^next_result_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]) - 1;
  CONFIG = loadConfig();
  
  if (index >= CONFIG.searchResults.length) {
    await ctx.answerCallbackQuery("Это последнее сообщение");
    return;
  }
  
  const result = CONFIG.searchResults[index];
  const date = new Date(result.date * 1000).toLocaleString('ru-RU');
  
  const fullMessage = `🔍 **Найдено совпадение #${index + 1}**

📱 **Источник:** ${result.chatName}
👤 **Автор:** ${result.author}
📅 **Время:** ${date}

💬 **Полное сообщение:**

${result.text}`;
  
  const keyboard = new InlineKeyboard();
  if (index > 0) {
    keyboard.text("⬅️ Предыдущее", `prev_result_${index - 1}`);
  }
  if (index < CONFIG.searchResults.length - 1) {
    keyboard.text("➡️ Следующее", `next_result_${index + 1}`);
  }
  keyboard.row().text("🔙 К списку", "show_results");
  
  await ctx.editMessageText(fullMessage, {
    parse_mode: "Markdown",
    reply_markup: keyboard
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^prev_result_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  CONFIG = loadConfig();
  
  if (index < 0 || index >= CONFIG.searchResults.length) {
    await ctx.answerCallbackQuery("Ошибка");
    return;
  }
  
  const result = CONFIG.searchResults[index];
  const date = new Date(result.date * 1000).toLocaleString('ru-RU');
  
  const fullMessage = `🔍 **Найдено совпадение #${index + 1}**

📱 **Источник:** ${result.chatName}
👤 **Автор:** ${result.author}
📅 **Время:** ${date}

💬 **Полное сообщение:**

${result.text}`;
  
  const keyboard = new InlineKeyboard();
  if (index > 0) {
    keyboard.text("⬅️ Предыдущее", `prev_result_${index - 1}`);
  }
  if (index < CONFIG.searchResults.length - 1) {
    keyboard.text("➡️ Следующее", `next_result_${index + 1}`);
  }
  keyboard.row().text("🔙 К списку", "show_results");
  
  await ctx.editMessageText(fullMessage, {
    parse_mode: "Markdown",
    reply_markup: keyboard
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("clear_results", async (ctx) => {
  CONFIG = loadConfig();
  CONFIG.searchResults = [];
  saveConfig(CONFIG);
  
  await ctx.editMessageText(
    "🗑️ **Результаты очищены!**",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
    }
  );
  await ctx.answerCallbackQuery("✅ Очищено!");
});

bot.callbackQuery("menu_main", async (ctx) => {
  await ctx.editMessageText("📱 **Главное меню:**", {
    parse_mode: "Markdown",
    reply_markup: createMainMenu()
  });
  await ctx.answerCallbackQuery();
});

bot.on("message", async (ctx) => {
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    return;
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
            reply_markup: new InlineKeyboard().text("🔙 Назад", "menu_main")
          });
          userStates.delete(userId);
          return;
        }
      }
      
      if (CONFIG.monitoredChats.includes(chatId)) {
        await ctx.reply(`❌ Уже в списке!`, {
          reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
        });
        userStates.delete(userId);
        return;
      }
      
      CONFIG.monitoredChats.push(chatId);
      if (saveConfig(CONFIG)) {
        await ctx.reply(`✅ "${chatName}" добавлен!\n\nID: \`${chatId}\``, {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
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
          reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
        });
        userStates.delete(userId);
        return;
      }
      
      CONFIG.searchTerms.push(word);
      if (saveConfig(CONFIG)) {
        await ctx.reply(`✅ Слово "${text.trim()}" добавлено!`, {
          reply_markup: new InlineKeyboard().text("🔙 Главное меню", "menu_main")
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
  
  if (containsSearchTerms(messageText)) {
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
      link: `https://t.me/c/${String(ctx.chat.id).slice(4)}/${ctx.message.message_id}`
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
    
    if (containsSearchTerms(messageText)) {
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
        link: `https://t.me/c/${String(ctx.chat.id).slice(4)}/${ctx.channelPost.message_id}`
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

