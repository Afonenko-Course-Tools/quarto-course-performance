/** JSON остаётся неизвестным до проверки на конкретной границе. */
export function parseJson(source: string): unknown {
  return JSON.parse(source);
}
export function object(value: unknown, field = "JSON"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Необходим объект: ${field}`);
  }
  return value as Record<string, unknown>;
}
export function array(value: unknown, field = "JSON"): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Необходим массив: ${field}`);
  return value;
}
export function string(value: unknown, field = "JSON"): string {
  if (typeof value !== "string") throw new Error(`Необходима строка: ${field}`);
  return value;
}
export function strings(value: unknown, field = "JSON"): string[] {
  return array(value, field).map((item) => string(item, field));
}
export function number(value: unknown, field = "JSON"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Необходимо конечное число: ${field}`);
  }
  return value;
}
export function boolean(value: unknown, field = "JSON"): boolean {
  if (typeof value !== "boolean") throw new Error(`Необходим boolean: ${field}`);
  return value;
}
export function oneOf<const Choices extends readonly string[]>(
  value: unknown,
  choices: Choices,
  field = "JSON",
): Choices[number] {
  const choice = choices.find((choice) => choice === value);
  if (choice === undefined) throw new Error(`Недопустимое значение: ${field}`);
  return choice;
}
export function parseObject(source: string): Record<string, unknown> {
  return object(parseJson(source));
}
export function numbers(value: unknown, field = "JSON"): number[] {
  return array(value, field).map((item) => number(item, field));
}
export function numberMap(value: unknown, field = "JSON"): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(value, field)).map(([key, value]) => [key, number(value, key)]),
  );
}
