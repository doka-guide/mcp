// Поиск по индексам разделов Доки. Корпус маленький: заголовок, слаг и текст
// «Кратко». Поэтому считаем вес слова по редкости (idf): частые слова вроде
// «блок» или «элемент» есть почти везде и ранжировать не помогают.

const STOP_WORDS = new Set([
  'как', 'что', 'чем', 'для', 'при', 'это', 'или', 'все', 'его', 'если', 'там',
  'надо', 'нужно', 'сделать', 'работает', 'можно', 'есть', 'бывает', 'такое',
  'the', 'how', 'why', 'and', 'for',
])

export function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Грубая нормализация под русскую морфологию: сравниваем по началу слова,
// чтобы «переносы» находили «переносом», а «свойства» — «свойство»
function stem(word) {
  return word.length > 5 ? word.slice(0, word.length - 2) : word
}

export function tokenize(text) {
  return normalize(text)
    .split(' ')
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map(stem)
}

export function buildIndex(items) {
  const documents = items.map((item) => {
    const slug = item.path.split('/').filter(Boolean).pop() || ''
    const strong = new Set([...tokenize(item.title), ...tokenize(slug.replace(/-/g, ' '))])
    // описание из шапки материала написано автором специально как объяснение
    // «про что это», поэтому весит больше текста «Кратко»
    const medium = new Set(tokenize(item.description))
    const weak = new Set(tokenize(item.summary))
    for (const token of strong) {
      medium.delete(token)
      weak.delete(token)
    }
    for (const token of medium) {
      weak.delete(token)
    }
    return {
      item,
      slug: normalize(slug),
      title: normalize(item.title),
      strong,
      medium,
      weak,
    }
  })

  const frequency = new Map()
  for (const document of documents) {
    for (const token of new Set([...document.strong, ...document.medium, ...document.weak])) {
      frequency.set(token, (frequency.get(token) || 0) + 1)
    }
  }

  return { documents, frequency, total: documents.length }
}

export function search(index, rawQuery, { section, limit = 8 } = {}) {
  const query = normalize(rawQuery)
  const queryTokens = tokenize(rawQuery)
  const { frequency, total } = index

  // слово, которое встречается в большинстве материалов, почти ничего не весит
  const weight = (token) => Math.log(1 + total / (1 + (frequency.get(token) || 0)))

  const scored = []
  for (const document of index.documents) {
    if (section && document.item.section !== section) {
      continue
    }

    let points = 0
    let matched = 0

    for (const token of queryTokens) {
      if (document.strong.has(token)) {
        points += weight(token) * 3
        matched += 1
      } else if (document.medium.has(token)) {
        points += weight(token) * 2
        matched += 1
      } else if (document.weak.has(token)) {
        points += weight(token)
        matched += 1
      }
    }

    // материал, который отвечает на весь запрос, важнее совпавшего одним словом
    if (queryTokens.length > 1 && matched === queryTokens.length) {
      points *= 1.5
    }

    // точное попадание в название перебивает любое накопленное совпадение
    if (document.slug === query || document.title === query) {
      points += 1000
    } else if (document.slug.replace(/\s+/g, '') === query.replace(/\s+/g, '')) {
      points += 500
    } else if (query.length > 3 && document.title.includes(query)) {
      points += 100
    }

    if (points > 0) {
      scored.push({ item: document.item, points })
    }
  }

  if (scored.length) {
    return scored.sort((a, b) => b.points - a.points).slice(0, limit)
  }

  // Ничего не нашлось по целым словам: пробуем по началу слова. Так «флексбокс»
  // находит «флекс-контейнер», а «центрировать» — «центрирование». Выдача
  // получается шумной, но пустой ответ хуже: вызывающая модель сама выберет
  // нужное из списка с описаниями.
  const prefixes = queryTokens.map((token) => token.slice(0, 4)).filter((token) => token.length === 4)
  if (!prefixes.length) {
    return []
  }

  const loose = []
  for (const document of index.documents) {
    if (section && document.item.section !== section) {
      continue
    }

    let points = 0
    for (const prefix of prefixes) {
      for (const token of document.strong) {
        if (token.startsWith(prefix)) {
          points += weight(token) * 3
          break
        }
      }
      for (const token of document.medium) {
        if (token.startsWith(prefix)) {
          points += weight(token) * 2
          break
        }
      }
      for (const token of document.weak) {
        if (token.startsWith(prefix)) {
          points += weight(token)
          break
        }
      }
    }

    if (points > 0) {
      loose.push({ item: document.item, points })
    }
  }

  return loose.sort((a, b) => b.points - a.points).slice(0, limit)
}
