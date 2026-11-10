/**
 * Conversão entre horário de parede (data + hora num fuso IANA) e instantes UTC.
 * Usa só `Intl`, então respeita horário de verão e mudanças de regra do fuso.
 */

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

function wallParts(utcMs: number, timeZone: string): { date: string; time: string; asUtcMs: number } {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) parts[part.type] = part.value;
  const [y, mo, d, h, mi, s] = [parts["year"], parts["month"], parts["day"], parts["hour"], parts["minute"], parts["second"]].map(Number) as [
    number, number, number, number, number, number,
  ];
  return {
    date: `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
    asUtcMs: Date.UTC(y, mo - 1, d, h, mi, s),
  };
}

/** Deslocamento do fuso (ms) no instante dado: horário de parede − UTC. */
function offsetMs(utcMs: number, timeZone: string): number {
  return wallParts(utcMs, timeZone).asUtcMs - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Instante UTC (ms) do horário de parede `date` `time` (HH:MM) em `timeZone`.
 * Horário que não existe (salto do horário de verão) avança para depois da lacuna; horário
 * repetido (fim do horário de verão) usa a primeira ocorrência.
 */
export function zonedToUtcMs(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const first = naive - offsetMs(naive, timeZone);
  const second = naive - offsetMs(first, timeZone);
  if (second === first) return first;
  // Perto de uma transição: confere qual dos dois candidatos volta ao mesmo horário de parede.
  const wanted = naive;
  const candidates = [first, second].filter((candidate) => wallParts(candidate, timeZone).asUtcMs === wanted);
  if (candidates.length > 0) return Math.min(...candidates);
  return Math.max(first, second);
}

export function utcMsToZoned(utcMs: number, timeZone: string): { date: string; time: string } {
  const { date, time } = wallParts(utcMs, timeZone);
  return { date, time };
}
