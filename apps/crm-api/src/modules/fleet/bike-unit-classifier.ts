const PLACEHOLDER_TOKENS = ["legacy bike placeholder", "placeholder"];

const COMPONENT_TOKENS = [
  "амортиз",
  "багажник",
  "блок света",
  "модуль света",
  "тумблер",
  "сигнализац",
  "брызговик",
  "датчик",
  "держател",
  "дисплей",
  "защита дисплея",
  "задний свет",
  "передний свет",
  "кабель",
  "камера",
  "контроллер",
  "короб",
  "коса провод",
  "ось",
  "поворотник",
  "рама для",
  "рулевой вал",
  "ручка газа",
  "суппорт",
  "тормозн",
  "сиденье",
  "колодк",
  "заряд",
  "зарядка",
  "ключ",
  "аккум",
  "аккумулятор",
  "крыл",
  "покрыш",
  "винт",
  "болт",
  "провод",
  "расходник",
  "мелоч",
  "моторколес",
  "подножк",
  "крепеж",
  "вилка",
  "маятник",
  "фара",
  "корзина"
];

const BIKE_HINT_TOKENS = [
  "электровел",
  "велосипед",
  "bike",
  "kugoo",
  "kirin",
  "monster",
  "wenbox",
  "winebox",
  "qronge"
];

function normalize(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasArticleLikeToken(value: string) {
  return /,\s*[\w/-]{5,}/i.test(value) || /\b\d{8,}\b/.test(value);
}

export function isAssignableBikeUnitName(title: string, modelName?: string | null) {
  const haystack = normalize(`${title} ${modelName ?? ""}`);
  if (!haystack) {
    return false;
  }

  if (PLACEHOLDER_TOKENS.some((token) => haystack.includes(token))) {
    return false;
  }

  if (COMPONENT_TOKENS.some((token) => haystack.includes(token))) {
    return false;
  }

  return BIKE_HINT_TOKENS.some((token) => haystack.includes(token)) || hasArticleLikeToken(haystack);
}
