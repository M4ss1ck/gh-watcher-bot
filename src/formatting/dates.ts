// Formats dates for Telegram messages in a subscription's timezone.
const utcTimezone = "UTC";

const dateTimeParts = (
  date: Date,
  timezone: string
): Intl.DateTimeFormatPart[] => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
};

const getPart = (parts: Intl.DateTimeFormatPart[], type: string): string => {
  return parts.find((part) => part.type === type)?.value ?? "";
};

export const formatDateTimeInTimeZone = (
  date: Date,
  timezone: string
): string => {
  let safeTimezone = timezone;
  let parts: Intl.DateTimeFormatPart[];

  try {
    parts = dateTimeParts(date, safeTimezone);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }

    safeTimezone = utcTimezone;
    parts = dateTimeParts(date, safeTimezone);
  }

  return [
    `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}`,
    `${getPart(parts, "hour")}:${getPart(parts, "minute")}`,
    safeTimezone
  ].join(" ");
};
