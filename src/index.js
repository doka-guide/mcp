#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildIndex, search } from './search.js'

const SITE = 'https://doka.guide'
const RAW = 'https://raw.githubusercontent.com/doka-guide/content/main'
const UA = 'doka-mcp/0.1 (+https://github.com/doka-guide/mcp)'
const SECTIONS = {
  css: 'CSS',
  html: 'HTML',
  js: 'JavaScript',
  a11y: 'Доступность',
  tools: 'Веб-платформа',
  recipes: 'Рецепты',
}
const INDEX_TTL = 60 * 60 * 1000

let cache = { at: 0, index: null, failed: [] }

async function get(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA } })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} — ${url}`)
  }
  return response.text()
}

// Индексы разделов иногда приходят с сырыми переводами строк внутри строк —
// такой JSON не разбирается. Экранированные последовательности это два
// символа, замена их не трогает: убираем только настоящие управляющие.
async function getJson(url) {
  const text = await get(url)
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(text.replace(/[\u0000-\u001F]/g, ' '))
  }
}

// Индекс раздела отдаётся в виде { "заголовок": { path, related, summary } }
async function loadSection(section) {
  const data = await getJson(`${SITE}/${section}/index.json`)
  return Object.entries(data).map(([title, item]) => ({
    title,
    section,
    sectionName: SECTIONS[section],
    path: item.path,
    summary: (item.summary || []).join(' ').replace(/\s+/g, ' ').trim(),
  }))
}

// Полный список материалов с описаниями из шапки. Появился вместе с
// markdown-версиями, поэтому может не отвечать на старой сборке сайта.
async function loadDescriptions() {
  const text = await get(`${SITE}/llms-full.txt`)
  const descriptions = new Map()
  const line = /^-\s\[(.+?)\]\((https?:\/\/[^)]+)\)(?::\s*(.*))?$/

  for (const row of text.split('\n')) {
    const match = line.exec(row.trim())
    if (!match) {
      continue
    }
    const path = match[2]
      .replace(SITE, '')
      .replace(/index\.md$/, '')
    descriptions.set(path, match[3] || '')
  }
  return descriptions
}

async function loadIndex() {
  if (cache.index && Date.now() - cache.at < INDEX_TTL) {
    return cache
  }

  const names = Object.keys(SECTIONS)
  // один упавший раздел не должен гасить поиск по остальным
  const [sections, described] = await Promise.all([
    Promise.allSettled(names.map(loadSection)),
    loadDescriptions().catch(() => new Map()),
  ])
  const items = sections
    .filter((row) => row.status === 'fulfilled')
    .flatMap((row) => row.value)
    .map((item) => ({ ...item, description: described.get(item.path) || '' }))
  const failed = names.filter((_, i) => sections[i].status === 'rejected')

  if (!items.length) {
    throw new Error(`Не удалось загрузить индексы Доки: ${sections[0].reason?.message ?? 'причина неизвестна'}`)
  }

  cache = { at: Date.now(), index: buildIndex(items), failed }
  return cache
}

function pathToFile(input) {
  const clean = input
    .trim()
    .replace(/^https?:\/\/doka\.guide/, '')
    .replace(/^\/+|\/+$/g, '')
  const parts = clean.split('/').filter(Boolean)
  if (parts.length < 2 || !SECTIONS[parts[0]]) {
    return null
  }
  return `${parts[0]}/${parts[1]}`
}

const server = new McpServer({ name: 'doka', version: '0.1.0' })

server.registerTool(
  'search_doka',
  {
    title: 'Поиск по Доке',
    description:
      'Найти материалы Доки (doka.guide) — открытой энциклопедии по веб-разработке на русском языке. ' +
      'Разделы: CSS, HTML, JavaScript, доступность, инструменты веб-платформы, рецепты. ' +
      'Отдаёт заголовки, пути и краткие описания. Полный текст читайте инструментом read_doka.',
    inputSchema: {
      query: z.string().min(2).describe('Что искать: название свойства, метода, тега или тема по-русски'),
      section: z.enum(['css', 'html', 'js', 'a11y', 'tools', 'recipes']).optional().describe('Ограничить раздел'),
      limit: z.number().int().min(1).max(20).optional().describe('Сколько материалов вернуть, по умолчанию 8'),
    },
  },
  async ({ query, section, limit = 8 }) => {
    const { index, failed } = await loadIndex()
    const found = search(index, query, { section, limit })

    if (!found.length) {
      return { content: [{ type: 'text', text: `В Доке ничего не нашлось по запросу «${query}».` }] }
    }

    const lines = found.map(({ item }) => {
      const head = `- ${item.title} — ${item.sectionName}`
      const where = `  путь: ${item.path.replace(/^\/|\/$/g, '')}\n  адрес: ${SITE}${item.path}`
      const about = item.summary ? `\n  ${item.summary.slice(0, 300)}` : ''
      return `${head}\n${where}${about}`
    })

    return {
      content: [
        {
          type: 'text',
          text:
            `Нашлось в Доке (${found.length}):\n\n${lines.join('\n')}\n\n` +
            'Чтобы прочитать материал целиком, вызовите read_doka с полем path.' +
            (failed.length ? `\n\nРазделы не ответили: ${failed.join(', ')}.` : ''),
        },
      ],
    }
  },
)

server.registerTool(
  'read_doka',
  {
    title: 'Прочитать материал Доки',
    description:
      'Отдаёт материал Доки целиком в markdown вместе с шапкой: дата обновления, поддержка браузерами ' +
      '(поле baseline), авторы, лицензия. Поле baseline — источник правды о поддержке, предпочитайте его ' +
      'собственным предположениям. Ссылайтесь на адрес из поля url.',
    inputSchema: {
      path: z
        .string()
        .describe('Путь к материалу: «css/overflow-wrap», «/js/array-map/» или полный адрес страницы на doka.guide'),
    },
  },
  async ({ path }) => {
    const file = pathToFile(path)
    if (!file) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Не разобрал путь «${path}». Ожидаю «раздел/материал», например «css/overflow-wrap». Разделы: ${Object.keys(SECTIONS).join(', ')}.`,
          },
        ],
      }
    }

    // Сначала markdown с сайта, потом исходник в репозитории: так инструмент
    // работает и до того, как платформа начнёт отдавать .md
    const sources = [`${SITE}/${file}/index.md`, `${RAW}/${file}/index.md`]
    const problems = []

    for (const url of sources) {
      try {
        const text = await get(url)
        if (text.trimStart().startsWith('<')) {
          problems.push(`${url}: пришёл HTML вместо markdown`)
          continue
        }
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        problems.push(error.message)
      }
    }

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Не удалось прочитать «${file}». Возможно, материала нет — проверьте через search_doka.\n${problems.join('\n')}`,
        },
      ],
    }
  },
)

await server.connect(new StdioServerTransport())
