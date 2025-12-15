#!/bin/bash

# Скрипт для быстрого развертывания на сервере
# Использование: ./deploy.sh

set -e

echo "🚀 Начинаю развертывание qodeq_finder бота..."

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не установлен!"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Требуется Node.js 18+ (установлена версия: $(node -v))"
    exit 1
fi

echo "✅ Node.js версия: $(node -v)"

# Проверка .env файла
if [ ! -f .env ]; then
    echo "⚠️  Файл .env не найден!"
    echo "📝 Создаю .env из env.example..."
    cp env.example .env
    echo "⚠️  Пожалуйста, заполните .env файл перед запуском!"
    echo "   nano .env"
    exit 1
fi

# Проверка BOT_TOKEN
if ! grep -q "BOT_TOKEN=" .env || grep -q "BOT_TOKEN=your_bot_token_here" .env; then
    echo "❌ BOT_TOKEN не настроен в .env файле!"
    exit 1
fi

echo "✅ .env файл настроен"

# Установка зависимостей
echo "📦 Устанавливаю зависимости..."
npm install --production

# Создание директории для логов
echo "📁 Создаю директорию для логов..."
mkdir -p logs

# Проверка PM2
if command -v pm2 &> /dev/null; then
    echo "✅ PM2 установлен"
    
    # Проверка, запущен ли уже бот
    if pm2 list | grep -q "qodeq-finder"; then
        echo "🔄 Бот уже запущен, перезапускаю..."
        pm2 restart qodeq-finder
    else
        echo "🚀 Запускаю бота через PM2..."
        pm2 start ecosystem.config.js
        pm2 save
    fi
    
    echo ""
    echo "✅ Бот запущен!"
    echo ""
    echo "📊 Полезные команды:"
    echo "   pm2 status              - статус бота"
    echo "   pm2 logs qodeq-finder   - просмотр логов"
    echo "   pm2 restart qodeq-finder - перезапуск"
    echo "   pm2 stop qodeq-finder    - остановка"
else
    echo "⚠️  PM2 не установлен"
    echo "📦 Установите PM2: npm install -g pm2"
    echo "🚀 Запускаю бота напрямую..."
    node bot.js
fi

echo ""
echo "✅ Развертывание завершено!"

