#!/usr/bin/env node
'use strict';

/**
 * Консольный замер скорости скачивания.
 * Делает N последовательных запросов к URL, ждёт полный ответ каждого,
 * считает среднее время, суммарный объём и скорость.
 *
 * Запуск: node speedtest.js <url> [количество_запросов]
 */

const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

const DEFAULT_REQUESTS = 10;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'etolegko-speedtest/1.0';

function printUsage() {
  console.error('Использование: node speedtest.js <url> [количество_запросов]');
  console.error('Пример:     node speedtest.js https://httpbin.org/image/jpeg');
  console.error(
    'По умолчанию выполняется 10 запросов. Число можно задать вторым аргументом или переменной окружения REQUESTS.',
  );
}

function parseArgs(argv) {
  const targetUrl = argv[2];
  if (!targetUrl || targetUrl === '-h' || targetUrl === '--help') {
    printUsage();
    process.exit(targetUrl ? 0 : 1);
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    console.error(`Некорректный URL: ${targetUrl}`);
    process.exit(1);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error('Поддерживаются только протоколы http и https.');
    process.exit(1);
  }

  const rawCount = argv[3] ?? process.env.REQUESTS;
  const count = rawCount === undefined ? DEFAULT_REQUESTS : Number(rawCount);
  if (!Number.isInteger(count) || count < 1) {
    console.error('Количество запросов должно быть целым числом ≥ 1.');
    process.exit(1);
  }

  return { targetUrl: parsed.href, count };
}

/**
 * Один полный запрос: скачиваем всё тело ответа и замеряем время.
 * Редиректы 301/302/303/307/308 следуем до MAX_REDIRECTS раз.
 */
function requestOnce(targetUrl, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch {
      reject(new Error(`Некорректный URL: ${targetUrl}`));
      return;
    }

    const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!client) {
      reject(new Error(`Неподдерживаемый протокол: ${url.protocol}`));
      return;
    }

    // Замер: от старта этого HTTP-запроса до полного получения тела ответа.
    const startedAt = performance.now();

    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          // Тело редиректа нам не нужно — сбрасываем поток, чтобы сокет закрылся.
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Слишком много редиректов (лимит ${MAX_REDIRECTS}).`));
            return;
          }
          let nextUrl;
          try {
            // location может быть относительным — резолвим относительно текущего URL.
            nextUrl = new URL(location, url).href;
          } catch {
            reject(new Error(`Некорректный Location в редиректе: ${location}`));
            return;
          }
          // Редирект не включаем в замер: считаем только финальный ответ.
          resolve(requestOnce(nextUrl, redirectsLeft - 1));
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          const phrase = res.statusMessage ? ` ${res.statusMessage}` : '';
          reject(new Error(`Сервер ответил ${status}${phrase} (${url.href})`));
          return;
        }

        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
        });
        res.on('end', () => {
          resolve({
            url: url.href,
            status,
            bytes,
            durationMs: performance.now() - startedAt,
          });
        });
        res.on('error', reject);
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Таймаут ${REQUEST_TIMEOUT_MS / 1000} с: ${url.href}`));
    });
    req.on('error', reject);
  });
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} МБ`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} КБ`;
  return `${bytes} Б`;
}

function formatDuration(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)} с`;
  return `${ms.toFixed(1)} мс`;
}

async function main() {
  const { targetUrl, count } = parseArgs(process.argv);

  console.log(`URL: ${targetUrl}`);
  console.log(`Запросов: ${count} (последовательно)`);
  console.log('');

  const results = [];
  for (let i = 1; i <= count; i += 1) {
    try {
      const result = await requestOnce(targetUrl);
      results.push(result);
      console.log(
        `#${String(i).padStart(2, '0')}  ${formatDuration(result.durationMs).padStart(10)}  ${formatBytes(result.bytes)}  HTTP ${result.status}`,
      );
    } catch (err) {
      console.error(`#${String(i).padStart(2, '0')}  ошибка: ${err.message}`);
      process.exit(1);
    }
  }

  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  const avgMs = totalMs / results.length;
  const totalSeconds = totalMs / 1000;
  // СИ-единицы: 1 МБ = 10^6 байт, 1 Мбит = 10^6 бит — так принято для сетевых скоростей.
  const mbPerSec = totalSeconds > 0 ? totalBytes / 1_000_000 / totalSeconds : 0;
  const mbitPerSec = mbPerSec * 8;

  console.log('');
  console.log('--- Итоги ---');
  console.log(`Среднее время запроса:  ${formatDuration(avgMs)}`);
  console.log(`Всего скачано:          ${formatBytes(totalBytes)} (${totalBytes} байт)`);
  console.log(`Суммарное время:        ${formatDuration(totalMs)}`);
  console.log(`Скорость скачивания:    ${mbitPerSec.toFixed(2)} Мбит/с  (${mbPerSec.toFixed(2)} МБ/с)`);
  console.log('');
  console.log('Единицы: 1 МБ = 1 000 000 байт, 1 Мбит/с = 1 000 000 бит в секунду.');
  console.log('Скорость = суммарный объём / сумма времён запросов (чистое время передачи, без пауз между запросами).');
}

main();
