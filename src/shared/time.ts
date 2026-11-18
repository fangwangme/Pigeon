/** architecture.md §4.6: local ISO 8601 timestamp with millisecond precision and explicit UTC offset. */
export function formatLocalTimestamp(input: Date | number = new Date()): string {
  const d = typeof input === "number" ? new Date(input) : input;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = pad2(Math.floor(absMin / 60));
  const offM = pad2(absMin % 60);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}` +
    `${sign}${offH}:${offM}`
  );
}
