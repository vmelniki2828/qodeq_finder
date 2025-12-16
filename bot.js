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
const userPagination = new Map(); // Хранит состояние пагинации для каждого пользователя

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

// Функция для извлечения всего текста из сообщения, включая текст из ссылок
function extractFullText(message) {
  if (!message) return "";
  
  let text = message.message || message.text || message.caption || "";
  const fullText = text; // Сохраняем оригинальный текст для извлечения
  
  // Если есть entities (форматирование, ссылки и т.д.), извлекаем текст из них
  const entities = message.entities || message.raw?.entities || message.caption_entities || [];
  
  if (entities && entities.length > 0) {
    // Проходим по всем entities и добавляем текст ссылок
    for (const entity of entities) {
      if (entity && typeof entity === 'object') {
        // Для grammy: entity.type может быть "text_link", "url", "mention", "hashtag" и т.д.
        // Для Telethon: entity может быть объектом с className или _ (тип)
        const entityType = entity.type || entity._ || entity.className || entity.constructor?.name || '';
        
        // Проверяем, является ли это ссылкой
        const isLink = entityType === 'text_link' || 
                      entityType === 'url' || 
                      entityType === 'messageEntityUrl' || 
                      entityType === 'messageEntityTextUrl' ||
                      entityType.includes('Url') || 
                      entityType.includes('TextUrl') ||
                      entity.url;
        
        if (isLink) {
          // Извлекаем текст ссылки из сообщения
          const offset = entity.offset || 0;
          const length = entity.length || 0;
          
          if (offset >= 0 && offset + length <= fullText.length) {
            const linkText = fullText.substring(offset, offset + length);
            // Добавляем текст ссылки к основному тексту для поиска (если его еще нет)
            if (linkText && linkText.trim() && !text.includes(linkText)) {
              text += ' ' + linkText;
              console.log(`🔗 Найден текст ссылки: "${linkText}"`);
            }
          }
          
          // Если есть URL (для text_link), добавляем его тоже
          if (entity.url) {
            const url = entity.url;
            // Добавляем URL только если его еще нет в тексте
            if (url && !text.includes(url)) {
              text += ' ' + url;
              console.log(`🔗 Найден URL ссылки: "${url}"`);
            }
          }
        }
      }
    }
  }
  
  return text.trim();
}

// Функция для получения публичного канала по ID без подписки
async function getPublicChannelById(telegramClient, chatId) {
  const cleanId = chatId.replace(/^-100/, '');
  const channelIdNum = BigInt(cleanId);
  const { Api } = await import('telegram/tl/index.js');
  
  // Метод 1: Пробуем через getEntity (может работать для некоторых публичных каналов)
  try {
    const entity = await telegramClient.getEntity(chatId);
    return { entity, method: 'getEntity (string)' };
  } catch (e1) {
    try {
      const entity = await telegramClient.getEntity(parseInt(cleanId));
      return { entity, method: 'getEntity (numeric)' };
    } catch (e2) {
      // Метод 2: Пробуем через getChannels (требует accessHash, но попробуем)
      try {
        // Для публичных каналов иногда можно получить через getChannels
        // Но это требует accessHash, который мы не знаем
        // Попробуем с нулевым accessHash для публичных каналов
        const result = await telegramClient.invoke(
          new Api.channels.GetChannels({
            id: [
              new Api.InputChannel({
                channelId: channelIdNum,
                accessHash: BigInt(0)
              })
            ]
          })
        );
        
        if (result && result.chats && result.chats.length > 0) {
          return { entity: result.chats[0], method: 'getChannels' };
        }
        throw new Error('Канал не найден в результате');
      } catch (e3) {
        // Метод 3: Пробуем найти через поиск (если канал публичный)
        // Но для этого нужен @username
        throw new Error(`Все методы не сработали. Ошибки: getEntity(string)=${e1.message}, getEntity(numeric)=${e2.message}, getChannels=${e3.message}`);
      }
    }
  }
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
      // Пытаемся получить доступ БЕЗ подписки и БЕЗ прав администратора
      if (typeof chatId === 'string' && chatId.startsWith('-100')) {
        // Для супергрупп и каналов: ID -100XXXXXXXXXX означает channel ID = XXXXXXXXXX
        const cleanId = chatId.replace(/^-100/, '');
        const channelIdNum = BigInt(cleanId);
        
        console.log(`🔍 Пытаюсь получить доступ к публичному каналу по ID: ${chatId}...`);
        
        try {
          // Используем специальную функцию для получения публичного канала
          const result = await getPublicChannelById(telegramClient, chatId);
          entity = result.entity;
          chatName = entity.title || entity.firstName || chatName;
          console.log(`✅ Публичный канал получен (метод: ${result.method}): ${chatName}`);
        } catch (error) {
          // Если не получилось через специальные методы, пробуем поиск в диалогах
          console.log(`⚠️ Прямые методы не сработали: ${error.message}`);
          console.log(`🔍 Пробую найти канал в диалогах...`);
          
          try {
            const dialogs = await telegramClient.getDialogs({ limit: 500 });
            const found = dialogs.find(d => {
              const dialogId = String(d.id);
              return dialogId === chatId || dialogId === cleanId || dialogId === `-100${cleanId}`;
            });
            
            if (found && found.entity) {
              entity = found.entity;
              chatName = found.name || found.title || found.entity.title || chatName;
              console.log(`✅ Канал найден в диалогах: ${chatName}`);
            } else {
              throw new Error(`Не удалось получить доступ к каналу ${chatId}.\n\nПопробовано:\n1. Прямые методы получения публичного канала\n2. Поиск в диалогах (500 чатов)\n\n💡 **Важно:**\n- Для работы БЕЗ подписки канал должен быть публичным\n- Публичные каналы лучше добавлять через @username вместо ID\n- Для приватных каналов требуется подписка или права администратора\n\nПопробуйте:\n1. Использовать @username канала вместо ID (например: @channelname)\n2. Убедиться, что канал публичный и существует\n3. Проверить правильность ID канала`);
            }
          } catch (e2) {
            throw new Error(`Не удалось получить доступ к каналу ${chatId}.\n\nОшибки:\n1. Прямые методы: ${error.message}\n2. Поиск в диалогах: ${e2.message}\n\n💡 **Решения:**\n- Используйте @username канала вместо ID (например: @channelname)\n- Убедитесь, что канал публичный\n- Для приватных каналов требуется подписка или права администратора`);
          }
        }
      } else if (typeof chatId === 'string' && chatId.startsWith('@')) {
        // Username - это самый надежный способ для публичных каналов
        console.log(`🔍 Получаю публичный канал по @username: ${chatId}...`);
        entity = await telegramClient.getEntity(chatId);
        chatName = entity.title || entity.firstName || chatName;
        console.log(`✅ Публичный канал получен: ${chatName}`);
      } else {
        // Пробуем как есть (может быть числовой ID)
        entity = await telegramClient.getEntity(chatId);
        chatName = entity.title || entity.firstName || chatName;
      }
    } catch (error) {
      console.error(`Ошибка получения entity для ${chatId}:`, error.message);
      return { error: `Не удалось получить доступ к каналу: ${error.message}\n\n💡 **Решения:**\n- Убедитесь, что канал публичный\n- Для публичных каналов используйте @username вместо ID\n- Для приватных каналов требуется подписка или права администратора` };
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
          
          // Извлекаем весь текст для поиска, включая текст из ссылок
          const searchText = extractFullText(msg);
          const lowerText = searchText.toLowerCase();
          
          // Оригинальный текст сообщения (для сохранения)
          const originalText = msg.message || msg.text || "";
          
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
              text: originalText,
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
  userPagination.delete(ctx.from.id); // Очищаем пагинацию
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

// Функция для отправки результатов с пагинацией
async function sendPaginatedResults(ctx, page = 0) {
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
  
  const RESULTS_PER_PAGE = 10; // Количество результатов на странице
  const totalResults = CONFIG.searchResults.length;
  const totalPages = Math.ceil(totalResults / RESULTS_PER_PAGE);
  const currentPage = Math.min(page, totalPages - 1);
  const startIndex = currentPage * RESULTS_PER_PAGE;
  const endIndex = Math.min(startIndex + RESULTS_PER_PAGE, totalResults);
  
  // Сохраняем состояние пагинации
  userPagination.set(ctx.from.id, { currentPage, totalPages });
  
  // Формируем сообщение для текущей страницы
  let message = `📋 **Результаты поиска**\n\n`;
  message += `Найдено сообщений: **${totalResults}**\n`;
  message += `Страница ${currentPage + 1} из ${totalPages}\n\n`;
  
  // Добавляем результаты текущей страницы
  for (let i = startIndex; i < endIndex; i++) {
    const result = CONFIG.searchResults[i];
    message += `${i + 1}. **${result.chatName}**\n`;
    message += `   🔍 Найдено по слову: **${result.foundTerm || 'неизвестно'}**\n`;
    message += `   🔗 [Ссылка на пост](${result.link})\n\n`;
  }
  
  // Создаем клавиатуру с навигацией
  const keyboard = new Keyboard();
  
  // Кнопки навигации
  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Назад");
    }
    if (currentPage < totalPages - 1) {
      keyboard.text("▶️ Вперед");
    }
    if (currentPage > 0 || currentPage < totalPages - 1) {
      keyboard.row();
    }
  }
  
  // Дополнительные кнопки
  keyboard
    .text("📄 Показать все")
    .row()
    .text("🗑️ Очистить")
    .row()
    .text("🔙 Главное меню");
  
  try {
    await ctx.reply(message, {
      parse_mode: "Markdown",
      reply_markup: keyboard.resized().persistent()
    });
  } catch (error) {
    // Если сообщение все еще слишком длинное, уменьшаем количество результатов на странице
    if (error.description && error.description.includes('too long')) {
      console.log(`⚠️ Сообщение слишком длинное, уменьшаю количество результатов на странице`);
      // Пробуем с меньшим количеством результатов
      const SMALLER_PAGE = 5;
      const newEndIndex = Math.min(startIndex + SMALLER_PAGE, totalResults);
      message = `📋 **Результаты поиска**\n\n`;
      message += `Найдено сообщений: **${totalResults}**\n`;
      message += `Страница ${currentPage + 1} из ${Math.ceil(totalResults / SMALLER_PAGE)}\n\n`;
      
      for (let i = startIndex; i < newEndIndex; i++) {
        const result = CONFIG.searchResults[i];
        message += `${i + 1}. **${result.chatName}**\n`;
        message += `   🔍 **${result.foundTerm || 'неизвестно'}**\n`;
        message += `   🔗 [Ссылка](${result.link})\n\n`;
      }
      
      await ctx.reply(message, {
        parse_mode: "Markdown",
        reply_markup: keyboard.resized().persistent()
      });
    } else {
      throw error;
    }
  }
}

bot.hears(/^📋 Показать результаты/, async (ctx) => {
  await sendPaginatedResults(ctx, 0);
});

// Обработчики навигации по страницам
bot.hears("◀️ Назад", async (ctx) => {
  const pagination = userPagination.get(ctx.from.id);
  if (pagination && pagination.currentPage > 0) {
    await sendPaginatedResults(ctx, pagination.currentPage - 1);
  }
});

bot.hears("▶️ Вперед", async (ctx) => {
  const pagination = userPagination.get(ctx.from.id);
  if (pagination && pagination.currentPage < pagination.totalPages - 1) {
    await sendPaginatedResults(ctx, pagination.currentPage + 1);
  }
});

// Показать все результаты по одному (с пагинацией)
bot.hears("📄 Показать все", async (ctx) => {
  CONFIG = loadConfig();
  
  if (!CONFIG.searchResults || CONFIG.searchResults.length === 0) {
    await ctx.reply("Нет результатов", {
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    });
    return;
  }
  
  const totalResults = CONFIG.searchResults.length;
  const BATCH_SIZE = 5; // Отправляем по 5 сообщений за раз, чтобы не перегружать API
  
  await ctx.reply(
    `📄 **Отправка всех результатов**\n\nВсего найдено: **${totalResults}** сообщений\n\nОтправляю по ${BATCH_SIZE} сообщений...`,
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    }
  );
  
  // Отправляем результаты батчами с задержкой
  for (let i = 0; i < totalResults; i += BATCH_SIZE) {
    const batch = CONFIG.searchResults.slice(i, i + BATCH_SIZE);
    
    for (const result of batch) {
      const index = CONFIG.searchResults.indexOf(result) + 1;
      const fullMessage = `🔍 **Найдено совпадение #${index}**

📱 **Канал:** ${result.chatName}
🔍 **Найдено по слову:** ${result.foundTerm || 'неизвестно'}
🔗 [Ссылка на пост](${result.link})`;
      
      try {
        await ctx.reply(fullMessage, {
          parse_mode: "Markdown"
        });
        // Небольшая задержка между сообщениями
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`Ошибка отправки результата #${index}:`, error.message);
        // Продолжаем отправку остальных
      }
    }
    
    // Задержка между батчами
    if (i + BATCH_SIZE < totalResults) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  await ctx.reply(
    `✅ **Все результаты отправлены!**\n\nОтправлено: **${totalResults}** сообщений`,
    {
      parse_mode: "Markdown",
      reply_markup: new Keyboard().text("🔙 Главное меню").resized().persistent()
    }
  );
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
  
  // Извлекаем весь текст для поиска, включая текст из ссылок
  const searchText = extractFullText(ctx.message);
  console.log(`🔍 Проверяю сообщение на слова: ${CONFIG.searchTerms.join(', ')}`);
  console.log(`📝 Текст: ${searchText.substring(0, 100)}...`);
  
  // Оригинальный текст сообщения (для сохранения)
  const originalText = ctx.message.text || ctx.message.caption || '';
  
  const foundTerm = findSearchTerm(searchText);
  if (foundTerm) {
    const chatName = ctx.chat.title || ctx.chat.first_name || `Chat ${ctx.chat.id}`;
    console.log(`✅ ✅ ✅ НАЙДЕНО СОВПАДЕНИЕ в "${chatName}"`);
    
    // Сохраняем результат поиска (оригинальный текст сообщения)
    const result = {
      chatId: String(ctx.chat.id),
      chatName: chatName,
      messageId: ctx.message.message_id,
      text: originalText,
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
${originalText}`;
    
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
    
    // Извлекаем весь текст для поиска, включая текст из ссылок
    const searchText = extractFullText(ctx.channelPost);
    console.log(`🔍 Проверяю сообщение на слова: ${CONFIG.searchTerms.join(', ')}`);
    console.log(`📝 Текст сообщения: ${searchText.substring(0, 100)}...`);
    
    // Оригинальный текст сообщения (для сохранения)
    const originalText = ctx.channelPost.text || ctx.channelPost.caption || '';
    
    const foundTerm = findSearchTerm(searchText);
    if (foundTerm) {
      const chatName = ctx.chat.title || `Channel ${ctx.chat.id}`;
      console.log(`✅ ✅ ✅ НАЙДЕНО СОВПАДЕНИЕ в канале "${chatName}"`);
      
      // Сохраняем результат поиска (оригинальный текст сообщения)
      const result = {
        chatId: String(ctx.chat.id),
        chatName: chatName,
        messageId: ctx.channelPost.message_id,
        text: originalText,
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
${originalText}`;
      
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

