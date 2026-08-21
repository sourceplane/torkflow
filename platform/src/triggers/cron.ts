/**
 * Cron parsing and next-occurrence calculation.
 *
 * Schedules are per-tenant and per-timezone, which a Worker cron trigger cannot
 * express — those are per-Worker and UTC only. So schedules are evaluated here
 * and fired by a Durable Object alarm, and the Worker's own cron trigger is only
 * a sweeper for alarms that were missed.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Standard cron ORs day-of-month with day-of-week when both are restricted. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

export function parseCron(expression: string): CronFields {
  const normalized = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  return {
    minutes: parseField(minute, 0, 59, "minute"),
    hours: parseField(hour, 0, 23, "hour"),
    daysOfMonth: parseField(dom, 1, 31, "day-of-month"),
    months: parseField(month, 1, 12, "month", MONTH_NAMES, 1),
    // Both 0 and 7 mean Sunday.
    daysOfWeek: normalizeDow(parseField(dow, 0, 7, "day-of-week", DAY_NAMES, 0)),
    domRestricted: dom !== "*" && dom !== "?",
    dowRestricted: dow !== "*" && dow !== "?",
  };
}

function normalizeDow(values: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const value of values) out.add(value === 7 ? 0 : value);
  return out;
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  names?: string[],
  nameOffset = 0,
): Set<number> {
  const out = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(`${label}: step ${JSON.stringify(stepText)} must be a positive integer`);
    }

    let start: number;
    let end: number;

    if (range === "*" || range === "?" || range === undefined) {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [from, to] = range.split("-");
      start = toNumber(from!, label, names, nameOffset);
      end = toNumber(to!, label, names, nameOffset);
    } else {
      start = toNumber(range, label, names, nameOffset);
      end = stepText === undefined ? start : max;
    }

    if (start < min || end > max || start > end) {
      throw new CronParseError(`${label}: ${JSON.stringify(part)} is out of range ${min}-${max}`);
    }
    for (let value = start; value <= end; value += step) out.add(value);
  }

  if (out.size === 0) throw new CronParseError(`${label}: ${JSON.stringify(field)} matches nothing`);
  return out;
}

function toNumber(text: string, label: string, names?: string[], nameOffset = 0): number {
  const trimmed = text.trim().toLowerCase();
  if (names) {
    const index = names.indexOf(trimmed.slice(0, 3));
    if (index !== -1) return index + nameOffset;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    throw new CronParseError(`${label}: ${JSON.stringify(text)} is not a valid value`);
  }
  return value;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** Splits an instant into calendar fields in the given IANA timezone. */
export function localParts(epochMs: number, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: DAY_NAMES.indexOf((parts.weekday ?? "Sun").slice(0, 3).toLowerCase()),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The next instant at or after `after` that matches the schedule.
 *
 * Rather than testing every minute of the next four years, this jumps by the
 * largest unit that cannot possibly match — a wrong month skips to the next
 * month, a wrong day skips to the next day — so it converges in tens of
 * iterations. Each jump is re-checked in local time, which is what keeps it
 * correct across a DST transition instead of drifting by an hour.
 */
export function nextOccurrence(
  fields: CronFields,
  after: number,
  timezone = "UTC",
): number | null {
  // Start at the next whole minute; a schedule never fires twice in one minute.
  let candidate = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  // Four years of headroom covers the worst legitimate case (29 February on a
  // specific weekday); beyond that the expression matches nothing real.
  const limit = candidate + 4 * 366 * DAY_MS;

  while (candidate < limit) {
    const parts = localParts(candidate, timezone);

    if (!fields.months.has(parts.month)) {
      candidate = startOfNextMonth(candidate, parts, timezone);
      continue;
    }

    if (!dayMatches(fields, parts)) {
      candidate = startOfNextDay(candidate, parts, timezone);
      continue;
    }

    if (!fields.hours.has(parts.hour)) {
      candidate += HOUR_MS - parts.minute * MINUTE_MS;
      candidate = Math.floor(candidate / MINUTE_MS) * MINUTE_MS;
      continue;
    }

    if (!fields.minutes.has(parts.minute)) {
      candidate += MINUTE_MS;
      continue;
    }

    return candidate;
  }

  return null;
}

function dayMatches(fields: CronFields, parts: LocalParts): boolean {
  const domHit = fields.daysOfMonth.has(parts.day);
  const dowHit = fields.daysOfWeek.has(parts.weekday);

  // Standard cron: when both fields are restricted, either one matching fires.
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

function startOfNextDay(epochMs: number, parts: LocalParts, timezone: string): number {
  // Advance past the rest of the local day, then re-align to local midnight.
  const elapsed = parts.hour * HOUR_MS + parts.minute * MINUTE_MS;
  let next = epochMs - elapsed + DAY_MS;
  const check = localParts(next, timezone);
  // A DST shift can leave us slightly before or after local midnight.
  next -= check.hour * HOUR_MS + check.minute * MINUTE_MS;
  if (next <= epochMs) next = epochMs + MINUTE_MS;
  return Math.floor(next / MINUTE_MS) * MINUTE_MS;
}

function startOfNextMonth(epochMs: number, parts: LocalParts, timezone: string): number {
  // Step day by day to the first of the next month. Months are short enough
  // that this is a handful of iterations, and it avoids month-length maths.
  let candidate = epochMs;
  let current = parts;
  const startMonth = parts.month;
  for (let i = 0; i < 32; i++) {
    candidate = startOfNextDay(candidate, current, timezone);
    current = localParts(candidate, timezone);
    if (current.month !== startMonth) break;
  }
  return candidate;
}

/** Convenience: parse and compute in one call. */
export function nextRunAt(expression: string, after: number, timezone = "UTC"): number | null {
  return nextOccurrence(parseCron(expression), after, timezone);
}
