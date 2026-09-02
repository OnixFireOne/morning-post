# Версия образа обязана совпадать с версией пакета playwright в package.json
# (сейчас 1.62.1) — расхождение даёт «browser not found» или тихо другой
# рендер скриншота, чем локально. Обновлять оба места одним коммитом.
# Браузер и системные библиотеки уже внутри — ничего руками не ставим.
# Образ несёт Node 24, совпадает с "engines" в package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Сначала только манифесты — слой с зависимостями кешируется отдельно от кода.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# 02.09: config/providers.json — src/ai/providers.ts reads it at startup
# (AI_PROVIDERS_FILE unset) whenever the process runs at all, dry or not.
# Missing here means every container run, including a plain --dry smoke
# test, dies immediately on "providers catalog: cannot read
# /app/config/providers.json" — this file is not optional cargo.
COPY config ./config

# Одноразовый скрипт: запустился → сделал пост (или упал с алертом) →
# завершился. Никакого демона внутри — расписание снаружи, через cron.
#
# ENTRYPOINT, not CMD: `docker compose run --rm morning-post` still runs the
# same command as before (ENTRYPOINT + empty CMD), but
# `docker compose run --rm morning-post --dry` now actually reaches
# src/cliArgs.ts instead of being silently dropped — a bare CMD is *replaced*
# wholesale by any trailing `run` arguments, an ENTRYPOINT's arguments are
# appended to it. The cron line on the VPS passes no arguments at all, so
# this changes nothing for it — see README's own note on `--entrypoint sh`
# for the one real consequence (shell debugging needs that flag now).
ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD []
