import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { navigate, state } from "../state/store";
import { request } from "../state/ws";
import { cacheHitPercent, daysBetween, formatYMD, heatmapLayout, type UsagePreset } from "../../../shared/usage";
import type {
  UsageDayPayload,
  UsageDaySummary,
  UsageGetPayload,
  UsageModelPayload,
} from "../../../types/protocol";
import { Icon } from "./ui";
import { t, locale } from "../i18n";

const AGENT_KEYS = ["claude", "codex", "agy", "opencode", "pi"] as const;

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
};

const COMPANY_COLORS: Record<string, string> = {
  anthropic: "var(--co-anthropic)",
  openai: "var(--co-openai)",
  google: "var(--co-google)",
  other: "var(--co-other)",
};

function formatWeekdayShort(day: number): string {
  const isZh = locale() === "zh";
  const zh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return isZh ? zh[day] : en[day];
}

function getWeekdayTop(): string[] {
  const isZh = locale() === "zh";
  return isZh ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"];
}

function getWeekdaySide(): string[] {
  const isZh = locale() === "zh";
  return isZh ? ["一", "", "三", "", "五", "", "日"] : ["M", "", "W", "", "F", "", "S"];
}

function formatMonthName(monthIdx: number): string {
  const isZh = locale() === "zh";
  const zh = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
  const en = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return isZh ? zh[monthIdx] : en[monthIdx];
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + " K";
  return Math.round(n).toString();
}

export function fmtCost(c: number): string {
  return "$" + c.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function todayYMD(): string {
  return formatYMD(new Date());
}

export function UsagePage() {
  const [range, setRange] = createSignal<UsagePreset>(
    state.route.name === "usage" && state.route.initialPreset ? state.route.initialPreset : "today"
  );
  const [metric, setMetric] = createSignal<"tokens" | "cost">("tokens");
  const [group, setGroup] = createSignal<"date" | "model">("date");
  const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set(AGENT_KEYS));
  const [rowsLimit, setRowsLimit] = createSignal(10);

  const [customFrom, setCustomFrom] = createSignal("");
  const [customTo, setCustomTo] = createSignal("");
  const [draftFrom, setDraftFrom] = createSignal("");
  const [draftTo, setDraftTo] = createSignal("");

  const [usageReport, setUsageReport] = createSignal<UsageGetPayload | null>(null);
  const [loading, setLoading] = createSignal(false);

  // Sheets
  const [sheet, setSheet] = createSignal<"none" | "day" | "model" | "custom" | "filter">("none");
  const [selectedDay, setSelectedDay] = createSignal<string | null>(null);
  const [dayData, setDayData] = createSignal<UsageDayPayload | null>(null);
  const [selectedModel, setSelectedModel] = createSignal<string | null>(null);
  const [modelData, setModelData] = createSignal<UsageModelPayload | null>(null);

  // Zoom for week-columns heatmap
  const ZOOM_LEVELS = [16, 24, 32, 44];
  const [zoomIndex, setZoomIndex] = createSignal<number | null>(null); // null = fit
  const [selectedLegendBucket, setSelectedLegendBucket] = createSignal<number | null>(null);

  createEffect(() => {
    metric();
    range();
    setSelectedLegendBucket(null);
  });

  const backTarget = () => (state.route.name === "usage" ? (state.route.from ?? "home") : "home");

  const loadUsage = async (force = false) => {
    setLoading(true);
    try {
      const res: UsageGetPayload = await request({
        type: "usage_get",
        payload: {
          preset: range(),
          from: range() === "custom" ? customFrom() : undefined,
          to: range() === "custom" ? customTo() : undefined,
          agents: Array.from(activeAgents()),
          force,
        },
      });
      setUsageReport(res);
      if (!customFrom() && res.firstDay) {
        setCustomFrom(res.firstDay);
        setCustomTo(todayYMD());
        setDraftFrom(res.firstDay);
        setDraftTo(todayYMD());
      }
    } catch (err) {
      console.error("[Pigeon] usage_get error", err);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    if (!state.configReady) return;
    // Re-fetch when range or activeAgents change
    const p = range();
    activeAgents(); // tracked: a filter change reloads
    const cf = customFrom();
    const ct = customTo();
    if (p !== "custom" || (cf && ct)) {
      void loadUsage();
    }
  });

  const openDaySheet = async (date: string) => {
    setSelectedDay(date);
    setSheet("day");
    setDayData(null);
    try {
      const res: UsageDayPayload = await request({
        type: "usage_day",
        payload: { date, agents: Array.from(activeAgents()) },
      });
      setDayData(res);
    } catch (err) {
      console.error("[Pigeon] usage_day error", err);
    }
  };

  const rangeSpan = createMemo(() => {
    const rep = usageReport();
    if (!rep) return { from: todayYMD(), to: todayYMD(), len: 1 };
    const len = daysBetween(rep.range.from, rep.range.to) + 1;
    return { from: rep.range.from, to: rep.range.to, len };
  });

  const openModelSheet = async (model: string) => {
    setSelectedModel(model);
    setSheet("model");
    setModelData(null);
    try {
      const res: UsageModelPayload = await request({
        type: "usage_model",
        payload: {
          model,
          from: rangeSpan().from,
          to: rangeSpan().to,
          agents: Array.from(activeAgents()),
        },
      });
      setModelData(res);
    } catch (err) {
      console.error("[Pigeon] usage_model error", err);
    }
  };

  const isSingleDay = () => rangeSpan().len === 1;

  const rangeText = () => {
    const span = rangeSpan();
    if (span.len === 1) {
      const [y, m, d] = span.from.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      return `${span.from} ${formatWeekdayShort(dt.getDay())}`;
    }
    return `${span.from} → ${span.to} · ${t("usage.rangeDays", { count: span.len.toString() })}`;
  };

  // KPI comparison deltas
  const kpis = createMemo(() => {
    const rep = usageReport();
    const cur = rep?.totals ?? { cost: 0, tokens: 0, sessions: 0 };
    const prev = rep?.comparison?.totals;

    const calcDelta = (c: number, p?: number) => {
      if (p === undefined) return { text: "—", color: "var(--muted)" };
      if (p <= 0) {
        if (c > 0) return { text: "+100%", color: "var(--danger)" };
        return { text: "0.0%", color: "var(--muted)" };
      }
      const pct = ((c - p) / p) * 100;
      if (Math.abs(pct) < 0.1) return { text: "0.0%", color: "var(--muted)" };
      const sign = pct > 0 ? "+" : "";
      return {
        text: `${sign}${pct.toFixed(1)}%`,
        color: pct > 0 ? "var(--danger)" : "var(--addfg)",
      };
    };

    return [
      {
        label: t("usage.cost"),
        value: fmtCost(cur.cost),
        color: "var(--fig-cost)",
        delta: calcDelta(cur.cost, prev?.cost),
      },
      {
        label: t("usage.tokens"),
        value: fmtTokens(cur.tokens),
        color: "var(--fig-tokens)",
        delta: calcDelta(cur.tokens, prev?.tokens),
      },
      {
        label: t("usage.sessions"),
        value: fmtNumber(cur.sessions),
        color: "var(--fg)",
        delta: calcDelta(cur.sessions, prev?.sessions),
      },
    ];
  });

  const comparisonNote = () => {
    const rep = usageReport();
    if (!rep) return "";
    const p = range();
    if (p === "year" || p === "all") return t("usage.noComparison");
    if (!rep.comparison) return t("usage.noPrevData");

    const comp = rep.comparison;
    const [y, m, d] = comp.from.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const dayName = formatWeekdayShort(dt.getDay());
    const dateStr = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    if (rangeSpan().len === 1) {
      if (rangeSpan().from === todayYMD()) {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        return t("usage.compareSameTime", { day: dayName, date: dateStr, time: timeStr });
      }
      return t("usage.compareFullDay", { day: dayName, date: dateStr });
    }
    return t("usage.compareEqualLength", { days: rangeSpan().len.toString() });
  };

  // Heatmap generation
  const heatmapData = createMemo(() => {
    const rep = usageReport();
    if (!rep || isSingleDay()) return null;

    const span = rangeSpan();
    const layout = heatmapLayout({ from: span.from, to: span.to });

    // Map of date string to day summary
    const dayMap = new Map<string, UsageDaySummary>();
    for (const d of rep.days) dayMap.set(d.date, d);

    const m = metric();
    let vmax = 0;
    for (const d of rep.days) {
      const val = m === "tokens" ? d.tokens : d.cost;
      if (val > vmax) vmax = val;
    }

    // Active days & streaks
    let activeDays = 0;
    let longestStreak = 0;
    let currentStreak = 0;
    let curRun = 0;

    // Check all dates in span
    const [y1, m1, d1] = span.from.split("-").map(Number);
    const [y2, m2, d2] = span.to.split("-").map(Number);
    const startDt = new Date(y1, m1 - 1, d1);
    const endDt = new Date(y2, m2 - 1, d2);

    for (let cur = new Date(startDt); cur <= endDt; cur.setDate(cur.getDate() + 1)) {
      const ymd = formatYMD(cur);
      const sum = dayMap.get(ymd);
      const val = sum ? (m === "tokens" ? sum.tokens : sum.cost) : 0;
      if (val > 0) {
        activeDays++;
        curRun++;
        if (curRun > longestStreak) longestStreak = curRun;
      } else {
        curRun = 0;
      }
    }

    // Current streak from end backwards
    for (let cur = new Date(endDt); cur >= startDt; cur.setDate(cur.getDate() - 1)) {
      const ymd = formatYMD(cur);
      const sum = dayMap.get(ymd);
      const val = sum ? (m === "tokens" ? sum.tokens : sum.cost) : 0;
      if (val > 0) currentStreak++;
      else break;
    }

    // Heat color helper
    const getCellColor = (val: number) => {
      if (val <= 0) return "var(--heat-empty)";
      const f = vmax > 0 ? val / vmax : 0;
      const step = f <= 0.2 ? 1 : f <= 0.4 ? 2 : f <= 0.6 ? 3 : f <= 0.8 ? 4 : 5;
      return `var(--heat-${m}-${step})`;
    };

    const getCellTextColor = (val: number) => {
      if (val <= 0) return "var(--muted)";
      const f = vmax > 0 ? val / vmax : 0;
      return f <= 0.6 ? "#0B1A22" : "#FFFFFF";
    };

    // Strip layout (<= 7 days)
    if (layout === "strip") {
      const cells = [];
      for (let cur = new Date(startDt); cur <= endDt; cur.setDate(cur.getDate() + 1)) {
        const ymd = formatYMD(cur);
        const sum = dayMap.get(ymd);
        const val = sum ? (m === "tokens" ? sum.tokens : sum.cost) : 0;
        cells.push({
          date: ymd,
          dayNum: cur.getDate(),
          weekdayLabel: getWeekdayTop()[(cur.getDay() + 6) % 7],
          color: getCellColor(val),
          textColor: getCellTextColor(val),
          val,
        });
      }
      return { layout, cells, activeDays, currentStreak, longestStreak, vmax };
    }

    // Week rows (<= 42 days, Monday-to-Sunday rows)
    if (layout === "week-rows") {
      // Find Monday of the first week
      const dow1 = (startDt.getDay() + 6) % 7;
      const firstMonday = new Date(y1, m1 - 1, d1 - dow1);
      const dow2 = (endDt.getDay() + 6) % 7;
      const lastSunday = new Date(y2, m2 - 1, d2 + (6 - dow2));

      const weeks = [];
      let currentWeekCells = [];
      let currentWeekDays: Date[] = [];

      for (let cur = new Date(firstMonday); cur <= lastSunday; cur.setDate(cur.getDate() + 1)) {
        const ymd = formatYMD(cur);
        const inRange = cur >= startDt && cur <= endDt;
        const sum = inRange ? dayMap.get(ymd) : undefined;
        const val = sum ? (m === "tokens" ? sum.tokens : sum.cost) : 0;

        currentWeekCells.push({
          date: ymd,
          dayNum: cur.getDate(),
          inRange,
          color: inRange ? getCellColor(val) : "transparent",
          textColor: getCellTextColor(val),
          val,
        });
        currentWeekDays.push(new Date(cur));

        if (currentWeekCells.length === 7) {
          let monthLabel = "";
          for (const d of currentWeekDays) {
            if (d >= startDt && d <= endDt && d.getDate() === 1) {
              monthLabel = formatMonthName(d.getMonth());
              break;
            }
          }
          if (!monthLabel && weeks.length === 0) {
            const ref = currentWeekDays.find((d) => d >= startDt && d <= endDt) ?? currentWeekDays[0];
            monthLabel = formatMonthName(ref.getMonth());
          }
          weeks.push({ month: monthLabel, cells: currentWeekCells });
          currentWeekCells = [];
          currentWeekDays = [];
        }
      }
      return { layout, weeks, activeDays, currentStreak, longestStreak, vmax };
    }

    // Week columns (longer periods, weeks as vertical columns, reverse scroll)
    const dow1 = (startDt.getDay() + 6) % 7;
    const firstMonday = new Date(y1, m1 - 1, d1 - dow1);
    const dow2 = (endDt.getDay() + 6) % 7;
    const lastSunday = new Date(y2, m2 - 1, d2 + (6 - dow2));

    const weeks = [];
    let currentWeekCells = [];
    let currentWeekDays: Date[] = [];

    for (let cur = new Date(firstMonday); cur <= lastSunday; cur.setDate(cur.getDate() + 1)) {
      const ymd = formatYMD(cur);
      const inRange = cur >= startDt && cur <= endDt;
      const sum = inRange ? dayMap.get(ymd) : undefined;
      const val = sum ? (m === "tokens" ? sum.tokens : sum.cost) : 0;

      currentWeekCells.push({
        date: ymd,
        dayNum: cur.getDate(),
        inRange,
        color: inRange ? getCellColor(val) : "transparent",
        textColor: getCellTextColor(val),
        val,
      });
      currentWeekDays.push(new Date(cur));

      if (currentWeekCells.length === 7) {
        let monthLabel = "";
        for (const d of currentWeekDays) {
          if (d >= startDt && d <= endDt && d.getDate() === 1) {
            monthLabel = formatMonthName(d.getMonth());
            break;
          }
        }
        if (!monthLabel && weeks.length === 0) {
          const ref = currentWeekDays.find((d) => d >= startDt && d <= endDt) ?? currentWeekDays[0];
          monthLabel = formatMonthName(ref.getMonth());
        }
        weeks.push({ month: monthLabel, cells: currentWeekCells });
        currentWeekCells = [];
        currentWeekDays = [];
      }
    }

    return { layout, weeks, activeDays, currentStreak, longestStreak, vmax };
  });

  const bucketRangeText = () => {
    const b = selectedLegendBucket();
    if (b === null) return "";
    const hm = heatmapData();
    const vmax = hm?.vmax ?? 0;
    const isCost = metric() === "cost";
    const fmt = (v: number) => (isCost ? fmtCost(v) : fmtTokens(v));

    if (b === 0) {
      return `${t("usage.levelEmpty")}: ${isCost ? "$0.00" : "0"}`;
    }

    if (vmax <= 0) {
      return `${t("usage.level", { level: b.toString() })}: ${isCost ? "$0.00" : "0"}`;
    }

    const low = b === 1 ? 0 : vmax * ((b - 1) * 0.2);
    const high = b === 5 ? vmax : vmax * (b * 0.2);

    return `${t("usage.level", { level: b.toString() })}: ${fmt(low)} – ${fmt(high)}`;
  };

  // Table rows: date rows or model rows
  const tableRows = createMemo(() => {
    const rep = usageReport();
    if (!rep) return [];
    const isModel = isSingleDay() || group() === "model";
    const m = metric();

    if (!isModel) {
      // Date rows (newest first, descending)
      const days = [...rep.days].sort((a, b) => b.date.localeCompare(a.date));
      let maxVal = 0;
      for (const d of days) {
        const val = m === "tokens" ? d.tokens : d.cost;
        if (val > maxVal) maxVal = val;
      }

      return days.map((d) => {
        const val = m === "tokens" ? d.tokens : d.cost;
        const [y, mth, dayN] = d.date.split("-").map(Number);
        const dt = new Date(y, mth - 1, dayN);
        const title = `${d.date} ${formatWeekdayShort(dt.getDay())}`;
        const barW = maxVal > 0 ? `${Math.min(100, (val / maxVal) * 100)}%` : "0%";

        return {
          id: d.date,
          type: "date" as const,
          title,
          titleColor: "var(--fg)",
          sub: t("usage.sessionCount", { count: d.sessions.toString() }),
          subColor: "var(--muted)",
          tokens: fmtTokens(d.tokens),
          cost: fmtCost(d.cost),
          barW,
          barColor: m === "tokens" ? "var(--fig-tokens)" : "var(--fig-cost)",
          onTap: () => openDaySheet(d.date),
        };
      });
    }

    // Model rows: sorted strictly by tokens descending
    let models = [...rep.models].sort((a, b) => b.tokens - a.tokens);
    let maxVal = 0;
    for (const mdl of models) {
      const val = m === "tokens" ? mdl.tokens : mdl.cost;
      if (val > maxVal) maxVal = val;
    }

    return models.map((mdl) => {
      const val = m === "tokens" ? mdl.tokens : mdl.cost;
      const agentsStr = mdl.agents.map((ag) => AGENT_NAMES[ag] || ag).join(", ");
      const sessionStr = t("usage.sessionCount", { count: mdl.sessions.toString() });
      const sub = agentsStr ? `${sessionStr} · ${agentsStr}` : sessionStr;
      const barW = maxVal > 0 ? `${Math.min(100, (val / maxVal) * 100)}%` : "0%";

      return {
        id: mdl.model,
        type: "model" as const,
        title: mdl.model,
        titleColor: COMPANY_COLORS[mdl.company] || "var(--co-other)",
        sub,
        subColor: "var(--accent)",
        tokens: fmtTokens(mdl.tokens),
        cost: fmtCost(mdl.cost),
        barW,
        barColor: COMPANY_COLORS[mdl.company] || "var(--co-other)",
        onTap: () => openModelSheet(mdl.model),
      };
    });
  });

  const visibleRows = () => tableRows().slice(0, rowsLimit());

  return (
    <div class="page">
      {/* Shared Header */}
      <div class="hdr" style={{ padding: "12px 12px 8px" }}>
        <button class="cbtn" aria-label={t("common.back")} onClick={() => navigate({ name: backTarget() })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">{t("quota.title")}</div>
          <div class="s">
            {loading()
              ? (usageReport() ? t("quota.refreshing") : t("usage.loading"))
              : usageReport()?.scannedAt
              ? t("quota.scannedTo", {
                  time: new Date(usageReport()!.scannedAt).toTimeString().slice(0, 5),
                })
              : ""}
          </div>
        </div>
        <button class="cbtn" aria-label={t("app.reload")} onClick={() => void loadUsage(true)}>
          <span
            style={{
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              animation: loading() ? "spin .8s linear infinite" : "none",
            }}
          >
            <Icon name="refresh" />
          </span>
        </button>
      </div>

      <div class="scroll">
        <div style={{ padding: "0 16px calc(30px + env(safe-area-inset-bottom))" }}>
          {/* Segmented switch */}
          <div style={{ "margin-top": "6px" }}>
            <div class="seg" style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", padding: "3px" }}>
              <button
                style={{ height: "38px", "font-size": "14.5px" }}
                onClick={() => navigate({ name: "quota", from: backTarget() })}
              >
                {t("quota.tabQuota")}
              </button>
              <button
                class="on"
                style={{ height: "38px", "font-size": "14.5px" }}
              >
                {t("quota.tabUsage")}
              </button>
            </div>
          </div>

          {/* Range Chips */}
          <div style={{ "margin-top": "12px", display: "flex", gap: "6px", "overflow-x": "auto" }}>
            <For
              each={[
                { id: "today" as const, label: t("usage.today") },
                { id: "7d" as const, label: t("usage.7d") },
                { id: "30d" as const, label: t("usage.30d") },
                { id: "year" as const, label: t("usage.year") },
                { id: "all" as const, label: t("usage.all") },
                {
                  id: "custom" as const,
                  label:
                    range() === "custom" && customFrom() && customTo()
                      ? `${customFrom().slice(5)} ~ ${customTo().slice(5)}`
                      : t("usage.custom"),
                },
              ]}
            >
              {(r) => {
                const on = () => range() === r.id;
                return (
                  <button
                    onClick={() => {
                      if (r.id === "custom") {
                        setDraftFrom(customFrom() || todayYMD());
                        setDraftTo(customTo() || todayYMD());
                        setSheet("custom");
                      } else {
                        setRange(r.id);
                      }
                    }}
                    style={{
                      flex: "none",
                      height: "34px",
                      padding: "0 13px",
                      "border-radius": "17px",
                      font: "inherit",
                      "font-size": "13.5px",
                      "font-weight": 550,
                      border: on() ? "1px solid var(--accent)" : "1px solid var(--line2)",
                      background: on() ? "var(--accentbg)" : "var(--surface)",
                      color: on() ? "var(--accent)" : "var(--fg)",
                    }}
                  >
                    {r.label}
                  </button>
                );
              }}
            </For>
          </div>

          {/* Range text */}
          <div style={{ padding: "6px 4px 0", "font-size": "12.5px", color: "var(--faint)", "font-variant-numeric": "tabular-nums" }}>
            {rangeText()}
          </div>

          {/* Metric toggle & Agent Filter button */}
          <div style={{ "margin-top": "8px", display: "flex", "align-items": "center", gap: "8px" }}>
            <div
              style={{
                display: "flex",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                "border-radius": "9px",
                padding: "2px",
              }}
            >
              <button
                onClick={() => setMetric("tokens")}
                style={{
                  height: "30px",
                  padding: "0 12px",
                  "border-radius": "7px",
                  border: 0,
                  font: "inherit",
                  "font-size": "13px",
                  background: metric() === "tokens" ? "var(--code)" : "transparent",
                  color: metric() === "tokens" ? "var(--fg)" : "var(--muted)",
                }}
              >
                {t("usage.byTokens")}
              </button>
              <button
                onClick={() => setMetric("cost")}
                style={{
                  height: "30px",
                  padding: "0 12px",
                  "border-radius": "7px",
                  border: 0,
                  font: "inherit",
                  "font-size": "13px",
                  background: metric() === "cost" ? "var(--code)" : "transparent",
                  color: metric() === "cost" ? "var(--fg)" : "var(--muted)",
                }}
              >
                {t("usage.byCost")}
              </button>
            </div>

            <div style={{ flex: 1 }} />

            <button
              onClick={() => setSheet("filter")}
              aria-label={t("usage.filterTitle")}
              style={{
                height: "34px",
                padding: "0 11px",
                "border-radius": "17px",
                border: "1px solid var(--line2)",
                background: "none",
                color: "var(--fg)",
                font: "inherit",
                "font-size": "12.5px",
                display: "flex",
                "align-items": "center",
                gap: "5px",
              }}
            >
              <Icon name="sliders" sm />
              {activeAgents().size === 5
                ? t("usage.filterAllAgents")
                : t("usage.filterAgentCount", { count: activeAgents().size.toString() })}
            </button>
          </div>

          {/* KPI Figure Cards */}
          <Show
            when={usageReport()}
            fallback={
              <div style={{ "margin-top": "10px", display: "grid", "grid-template-columns": "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
                <For each={[t("usage.cost"), t("usage.tokens"), t("usage.sessions")]}>
                  {(label) => (
                    <div
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--line)",
                        "border-radius": "14px",
                        padding: "10px 12px",
                        display: "flex",
                        "flex-direction": "column",
                        gap: "6px",
                      }}
                    >
                      <div style={{ "font-size": "12px", color: "var(--muted)" }}>{label}</div>
                      <div class="skel" style={{ width: "70%", height: "20px", margin: "2px 0" }} />
                      <Show when={!isSingleDay()}>
                        <div class="skel" style={{ width: "45%", height: "12px" }} />
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <div style={{ "margin-top": "10px", display: "grid", "grid-template-columns": "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
              <For each={kpis()}>
                {(k) => (
                  <div
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--line)",
                      "border-radius": "14px",
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ "font-size": "12px", color: "var(--muted)" }}>{k.label}</div>
                    <div
                      style={{
                        "font-size": "18px",
                        "font-weight": 750,
                        "letter-spacing": "-.02em",
                        color: k.color,
                        "font-variant-numeric": "tabular-nums",
                        "white-space": "nowrap",
                      }}
                    >
                      {k.value}
                    </div>
                    <Show when={!isSingleDay()}>
                      <div
                        style={{
                          "font-size": "11.5px",
                          color: k.delta.color,
                          "font-variant-numeric": "tabular-nums",
                          "white-space": "nowrap",
                        }}
                      >
                        {k.delta.text}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Comparison line (only when multi-day period and data loaded) */}
          <Show when={!isSingleDay() && usageReport()}>
            <div style={{ padding: "6px 4px 0", "font-size": "11.5px", color: "var(--faint)" }}>
              {comparisonNote()}
            </div>
          </Show>

          {/* Heatmap Card Skeleton when loading */}
          <Show when={!isSingleDay() && loading() && !usageReport()}>
            <div
              style={{
                "margin-top": "12px",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                "border-radius": "18px",
                padding: "16px 14px",
                display: "flex",
                "flex-direction": "column",
                gap: "14px",
              }}
            >
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <div class="skel" style={{ width: "110px", height: "16px" }} />
                <div style={{ flex: 1 }} />
                <div class="skel" style={{ width: "90px", height: "14px" }} />
              </div>
              <div
                style={{
                  height: "90px",
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "center",
                  "justify-content": "center",
                  gap: "10px",
                  color: "var(--muted)",
                  "font-size": "13px",
                }}
              >
                <div class="spin" style={{ width: "18px", height: "18px", "border-width": "2px" }} />
                <span>{t("usage.loading")}</span>
              </div>
            </div>
          </Show>

          {/* Heatmap Card (if period > 1 day) */}
          <Show when={!isSingleDay() && heatmapData()}>
            {(() => {
              const hm = heatmapData()!;
              const mName = () => (metric() === "tokens" ? t("usage.tokens") : t("usage.cost"));

              return (
                <div
                  style={{
                    "margin-top": "12px",
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    "border-radius": "18px",
                    padding: "14px 14px 12px",
                  }}
                >
                  {/* Heatmap Header */}
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <div style={{ flex: 1, "min-width": 0 }}>
                      <div style={{ "font-weight": 650, "font-size": "15px" }}>
                        {t("usage.dailyMetric", { metric: mName() })}
                      </div>
                      <div style={{ "font-size": "12px", color: "var(--muted)" }}>
                        {t("usage.heatStats", {
                          active: hm.activeDays.toString(),
                          current: hm.currentStreak.toString(),
                          longest: hm.longestStreak.toString(),
                        })}
                      </div>
                    </div>

                    {/* Zoom buttons for week-columns */}
                    <Show when={hm.layout === "week-columns"}>
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          background: "var(--bg)",
                          border: "1px solid var(--line)",
                          "border-radius": "10px",
                          padding: "2px",
                        }}
                      >
                        <button
                          onClick={() => {
                            const cur = zoomIndex();
                            if (cur === null) setZoomIndex(0);
                            else if (cur > 0) setZoomIndex(cur - 1);
                          }}
                          aria-label={t("usage.zoomOut")}
                          style={{
                            width: "32px",
                            height: "30px",
                            border: 0,
                            "border-radius": "8px",
                            background: "none",
                            color: "var(--fg)",
                            display: "grid",
                            "place-items": "center",
                          }}
                        >
                          −
                        </button>
                        <button
                          onClick={() => setZoomIndex(null)}
                          style={{
                            height: "30px",
                            padding: "0 6px",
                            border: 0,
                            "border-radius": "8px",
                            background: zoomIndex() === null ? "var(--code)" : "none",
                            color: "var(--fg)",
                            font: "inherit",
                            "font-size": "12px",
                          }}
                        >
                          {t("usage.zoomFit")}
                        </button>
                        <button
                          onClick={() => {
                            const cur = zoomIndex();
                            if (cur === null) setZoomIndex(1);
                            else if (cur < ZOOM_LEVELS.length - 1) setZoomIndex(cur + 1);
                          }}
                          aria-label={t("usage.zoomIn")}
                          style={{
                            width: "32px",
                            height: "30px",
                            border: 0,
                            "border-radius": "8px",
                            background: "none",
                            color: "var(--fg)",
                            display: "grid",
                            "place-items": "center",
                          }}
                        >
                          +
                        </button>
                      </div>
                    </Show>
                  </div>

                  {/* Strip layout */}
                  <Show when={hm.layout === "strip" && hm.cells}>
                    <div style={{ "margin-top": "12px" }}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <For each={hm.cells}>
                          {(c) => (
                            <div style={{ flex: 1, "text-align": "center", "font-size": "11px", color: "var(--faint)" }}>
                              {c.weekdayLabel}
                            </div>
                          )}
                        </For>
                      </div>
                      <div style={{ display: "flex", gap: "6px", "margin-top": "6px" }}>
                        <For each={hm.cells}>
                          {(c) => (
                            <button
                              onClick={() => {
                                if (c.val > 0) void openDaySheet(c.date);
                              }}
                              style={{
                                flex: 1,
                                height: "38px",
                                "border-radius": "6px",
                                border: 0,
                                background: c.color,
                                color: c.textColor,
                                font: "inherit",
                                "font-size": "11px",
                                "font-weight": 600,
                                "font-variant-numeric": "tabular-nums",
                                display: "flex",
                                "align-items": "flex-start",
                                "justify-content": "flex-start",
                                padding: "4px 0 0 5px",
                                "box-sizing": "border-box",
                              }}
                            >
                              {c.dayNum}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Week-rows layout */}
                  <Show when={hm.layout === "week-rows" && hm.weeks}>
                    <div style={{ "margin-top": "12px" }}>
                      <div style={{ display: "flex", gap: "5px", "padding-left": "30px", "font-size": "10.5px", color: "var(--faint)" }}>
                        <For each={getWeekdayTop()}>
                          {(w) => <span style={{ flex: 1, "text-align": "center" }}>{w}</span>}
                        </For>
                      </div>
                      <For each={hm.weeks}>
                        {(w) => (
                          <div style={{ display: "flex", gap: "5px", "align-items": "center", "margin-top": "5px" }}>
                            <span style={{ width: "26px", "font-size": "10.5px", color: "var(--faint)", "white-space": "nowrap" }}>
                              {w.month}
                            </span>
                            <For each={w.cells}>
                              {(c) => (
                                <button
                                  onClick={() => {
                                    if (c.val > 0) void openDaySheet(c.date);
                                  }}
                                  style={{
                                    flex: 1,
                                    height: "36px",
                                    "border-radius": "6px",
                                    border: 0,
                                    background: c.color,
                                    color: c.textColor,
                                    font: "inherit",
                                    "font-size": "11px",
                                    "font-weight": 600,
                                    "font-variant-numeric": "tabular-nums",
                                    display: "flex",
                                    "align-items": "flex-start",
                                    "justify-content": "flex-start",
                                    padding: "3px 0 0 5px",
                                    "box-sizing": "border-box",
                                  }}
                                >
                                  {c.inRange ? c.dayNum : ""}
                                </button>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Week-columns layout */}
                  <Show when={hm.layout === "week-columns" && hm.weeks}>
                    {(() => {
                      const cellSz = () => {
                        const zi = zoomIndex();
                        if (zi === null) return 20; // default fit approx
                        return ZOOM_LEVELS[zi];
                      };

                      return (
                        <div style={{ display: "flex", gap: "4px", "margin-top": "12px" }}>
                          <div
                            style={{
                              display: "flex",
                              "flex-direction": "column",
                              gap: "4px",
                              "font-size": "10px",
                              color: "var(--faint)",
                              width: "14px",
                              "padding-top": "16px",
                              flex: "none",
                            }}
                          >
                            <For each={getWeekdaySide()}>
                              {(wl) => (
                                <span style={{ height: `${cellSz()}px`, "line-height": `${cellSz()}px` }}>
                                  {wl}
                                </span>
                              )}
                            </For>
                          </div>

                          <div
                            style={{
                              flex: 1,
                              "min-width": 0,
                              "overflow-x": "auto",
                              display: "flex",
                              "flex-direction": "row-reverse",
                              "touch-action": "pan-x pinch-zoom",
                            }}
                          >
                            <div style={{ display: "flex", gap: "4px", flex: "none", "padding-bottom": "2px" }}>
                              <For each={hm.weeks}>
                                {(w) => (
                                  <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                                    <span
                                      style={{
                                        height: "14px",
                                        "font-size": "10px",
                                        color: "var(--faint)",
                                        "white-space": "nowrap",
                                        width: `${cellSz()}px`,
                                      }}
                                    >
                                      {w.month}
                                    </span>
                                    <For each={w.cells}>
                                      {(c) => (
                                        <button
                                          onClick={() => {
                                            if (c.val > 0) void openDaySheet(c.date);
                                          }}
                                          style={{
                                            width: `${cellSz()}px`,
                                            height: `${cellSz()}px`,
                                            padding: 0,
                                            "border-radius": cellSz() >= 24 ? "5px" : "3px",
                                            border: 0,
                                            background: c.color,
                                            color: c.textColor,
                                            font: "inherit",
                                            "font-size": "10px",
                                            "font-weight": 600,
                                            "font-variant-numeric": "tabular-nums",
                                            display: "flex",
                                            "align-items": "flex-start",
                                            "justify-content": "flex-start",
                                            "box-sizing": "border-box",
                                          }}
                                        >
                                          {cellSz() >= 28 && c.inRange ? c.dayNum : ""}
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </Show>

                  {/* Heatmap Legend */}
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "4px",
                      "margin-top": "10px",
                      "font-size": "11px",
                      color: "var(--faint)",
                      "flex-wrap": "wrap",
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        "min-width": "120px",
                        "font-size": "11.5px",
                        "font-weight": 600,
                        color: "var(--fg)",
                        "font-variant-numeric": "tabular-nums",
                      }}
                    >
                      {bucketRangeText()}
                    </span>
                    <div style={{ display: "flex", "align-items": "center", gap: "3px", "margin-left": "auto" }}>
                      <span style={{ "margin-right": "3px" }}>{t("usage.less")}</span>
                      <button
                        type="button"
                        aria-label={t("usage.levelEmpty")}
                        onClick={() => setSelectedLegendBucket((c) => (c === 0 ? null : 0))}
                        style={{
                          width: "12px",
                          height: "12px",
                          padding: 0,
                          "border-radius": "2px",
                          border: selectedLegendBucket() === 0 ? "1.5px solid var(--fg)" : "1px solid var(--line)",
                          background: "var(--heat-empty)",
                          cursor: "pointer",
                          outline: "none",
                          transform: selectedLegendBucket() === 0 ? "scale(1.25)" : "none",
                          transition: "transform .15s, border-color .15s",
                        }}
                      />
                      <For each={[1, 2, 3, 4, 5]}>
                        {(lvl) => (
                          <button
                            type="button"
                            aria-label={t("usage.level", { level: lvl.toString() })}
                            onClick={() => setSelectedLegendBucket((c) => (c === lvl ? null : lvl))}
                            style={{
                              width: "12px",
                              height: "12px",
                              padding: 0,
                              "border-radius": "2px",
                              border: selectedLegendBucket() === lvl ? "1.5px solid var(--fg)" : "1px solid transparent",
                              background: `var(--heat-${metric()}-${lvl})`,
                              cursor: "pointer",
                              outline: "none",
                              transform: selectedLegendBucket() === lvl ? "scale(1.25)" : "none",
                              transition: "transform .15s, border-color .15s",
                            }}
                          />
                        )}
                      </For>
                      <span style={{ "margin-left": "3px" }}>{t("usage.more")}</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </Show>

          {/* List Card */}
          <div
            style={{
              "margin-top": "12px",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              "border-radius": "18px",
              padding: "12px 0 4px",
            }}
          >
            {/* List Header */}
            <div style={{ display: "flex", "align-items": "center", padding: "0 14px", "min-height": "34px" }}>
              <span style={{ "font-weight": 650, "font-size": "15px", flex: 1 }}>
                {isSingleDay() ? t("usage.byModel") : group() === "date" ? t("usage.byDate") : t("usage.byModel")}
              </span>
              <Show when={!isSingleDay()}>
                <div
                  style={{
                    display: "flex",
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    "border-radius": "8px",
                    padding: "2px",
                  }}
                >
                  <button
                    onClick={() => setGroup("date")}
                    style={{
                      height: "28px",
                      padding: "0 10px",
                      "border-radius": "6px",
                      border: 0,
                      font: "inherit",
                      "font-size": "12.5px",
                      background: group() === "date" ? "var(--code)" : "none",
                      color: group() === "date" ? "var(--fg)" : "var(--muted)",
                    }}
                  >
                    {t("usage.byDate")}
                  </button>
                  <button
                    onClick={() => setGroup("model")}
                    style={{
                      height: "28px",
                      padding: "0 10px",
                      "border-radius": "6px",
                      border: 0,
                      font: "inherit",
                      "font-size": "12.5px",
                      background: group() === "model" ? "var(--code)" : "none",
                      color: group() === "model" ? "var(--fg)" : "var(--muted)",
                    }}
                  >
                    {t("usage.byModel")}
                  </button>
                </div>
              </Show>
            </div>

            {/* Skeleton Rows when loading */}
            <Show when={loading() && !usageReport()}>
              <div style={{ "margin-top": "6px" }}>
                <For each={[1, 2, 3]}>
                  {() => (
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "10px",
                        width: "100%",
                        "min-height": "58px",
                        padding: "10px 14px",
                        "border-top": "1px solid var(--line)",
                      }}
                    >
                      <div style={{ flex: 1, display: "flex", "flex-direction": "column", gap: "6px" }}>
                        <div class="skel" style={{ width: "42%", height: "14px" }} />
                        <div class="skel" style={{ width: "68%", height: "11px" }} />
                      </div>
                      <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-end", gap: "6px" }}>
                        <div class="skel" style={{ width: "56px", height: "14px" }} />
                        <div class="skel" style={{ width: "40px", height: "11px" }} />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Empty state (only when loading finished and no rows) */}
            <Show when={!loading() && tableRows().length === 0}>
              <div
                style={{
                  "border-top": "1px solid var(--line)",
                  "margin-top": "8px",
                  padding: "22px 0",
                  "text-align": "center",
                  color: "var(--muted)",
                  "font-size": "13.5px",
                }}
              >
                {t("usage.empty")}
              </div>
            </Show>

            {/* Rows */}
            <Show when={usageReport()}>
              <div style={{ "margin-top": "6px" }}>
              <For each={visibleRows()}>
                {(r) => (
                  <button
                    onClick={r.onTap}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "10px",
                      width: "100%",
                      "min-height": "58px",
                      padding: "8px 10px 8px 14px",
                      background: "none",
                      border: 0,
                      "border-top": "1px solid var(--line)",
                      color: "var(--fg)",
                      font: "inherit",
                      "text-align": "left",
                      "font-variant-numeric": "tabular-nums",
                    }}
                  >
                    <span style={{ flex: 1, "min-width": 0 }}>
                      <span
                        style={{
                          display: "block",
                          "font-size": "14.5px",
                          "font-weight": 600,
                          color: r.titleColor,
                          "overflow-wrap": "anywhere",
                          "line-height": 1.35,
                        }}
                      >
                        {r.title}
                      </span>
                      <span style={{ display: "flex", gap: "6px", "align-items": "baseline", "margin-top": "3px", "font-size": "12.5px" }}>
                        <span style={{ color: r.subColor, flex: 1, "min-width": 0, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                          {r.sub}
                        </span>
                        <span
                          style={{
                            color: "var(--fig-cost)",
                            "white-space": "nowrap",
                            flex: "none",
                            "text-align": "right",
                            "font-variant-numeric": "tabular-nums",
                          }}
                        >
                          {r.cost}
                        </span>
                        <span
                          style={{
                            color: "var(--fig-tokens)",
                            "white-space": "nowrap",
                            flex: "none",
                            width: "56px",
                            "text-align": "right",
                            "font-variant-numeric": "tabular-nums",
                          }}
                        >
                          {r.tokens}
                        </span>
                      </span>
                      <span
                        style={{
                          display: "block",
                          height: "3px",
                          "border-radius": "2px",
                          background: "var(--line2)",
                          "margin-top": "6px",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "3px",
                            width: r.barW,
                            background: r.barColor,
                          }}
                        />
                      </span>
                    </span>
                    <Icon name="chevR" sm />
                  </button>
                )}
              </For>
            </div>

            {/* Pagination */}
            <Show when={tableRows().length > rowsLimit()}>
              <div style={{ "border-top": "1px solid var(--line)", padding: "12px", "text-align": "center" }}>
                <button
                  onClick={() => setRowsLimit((c) => c + 20)}
                  style={{
                    color: "var(--accent)",
                    "font-size": "13px",
                    "font-weight": 550,
                  }}
                >
                  {t("usage.showMoreRows", { count: (tableRows().length - rowsLimit()).toString() })}
                </button>
              </div>
            </Show>
          </Show>
          </div>

          {/* Bottom notes if unpriced */}
          <Show when={usageReport() && usageReport()!.models.some((m) => m.unpriced)}>
            <div style={{ padding: "12px 8px 0", "font-size": "12px", color: "var(--faint)" }}>
              {t("usage.unpricedNote")}
            </div>
          </Show>
        </div>
      </div>

      {/* Day Sheet */}
      <Show when={sheet() === "day" && selectedDay()}>
        <div style={{ position: "fixed", inset: 0, "z-index": 50, background: "rgba(0,0,0,.5)" }}>
          <button
            onClick={() => setSheet("none")}
            aria-label={t("common.close")}
            style={{ position: "absolute", inset: 0, background: "none", border: 0 }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              background: "var(--surface)",
              "border-top": "1px solid var(--line2)",
              "border-radius": "24px 24px 0 0",
              padding: "10px 18px 40px",
              "max-height": "85vh",
              "overflow-y": "auto",
            }}
          >
            <div style={{ width: "40px", height: "5px", "border-radius": "3px", background: "var(--line2)", margin: "0 auto 10px" }} />
            <div style={{ display: "flex", "align-items": "center" }}>
              <span style={{ "font-weight": 650, "font-size": "17px", flex: 1 }}>
                {selectedDay()}
              </span>
              <button
                class="cbtn"
                aria-label={t("common.close")}
                onClick={() => setSheet("none")}
              >
                <Icon name="x" />
              </button>
            </div>

            <Show when={dayData()} fallback={<div style={{ padding: "20px 0", color: "var(--muted)" }}>{t("common.loading")}</div>}>
              {(() => {
                const d = dayData()!;
                return (
                  <div>
                    {/* Metrics grid */}
                    <div
                      style={{
                        display: "grid",
                        "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                        gap: "4px 14px",
                        "margin-top": "6px",
                        "font-size": "13px",
                        "font-variant-numeric": "tabular-nums",
                      }}
                    >
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cost")}</span><span style={{ color: "var(--fig-cost)" }}>{fmtCost(d.totals.cost)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.tokens")}</span><span style={{ color: "var(--fig-tokens)" }}>{fmtTokens(d.totals.tokens)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.input")}</span><span style={{ color: "var(--fig-input)" }}>{fmtTokens(d.totals.input)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.output")}</span><span style={{ color: "var(--fig-output)" }}>{fmtTokens(d.totals.output)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cacheRead")}</span><span style={{ color: "var(--fig-cache)" }}>{fmtTokens(d.totals.cacheRead)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cacheWrite")}</span><span style={{ color: "var(--fig-cache)" }}>{d.totals.cacheWrite > 0 ? fmtTokens(d.totals.cacheWrite) : "—"}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cacheHit")}</span><span style={{ color: "var(--fig-hit)" }}>{cacheHitPercent(d.totals.cacheRead, d.totals.tokens).toFixed(2)}%</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.messages")}</span><span>{fmtNumber(d.totals.messages)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.sessions")}</span><span>{fmtNumber(d.totals.sessions)}</span></div>
                    </div>

                    {/* Breakdown by Agent */}
                    <div style={{ "font-size": "12.5px", color: "var(--faint)", "margin-top": "12px" }}>
                      {t("usage.agentAndModel")}
                    </div>
                    <For each={d.agents}>
                      {(ag) => (
                        <div style={{ "border-top": "1px solid var(--line)", "margin-top": "8px", "padding-top": "8px" }}>
                          <div style={{ display: "flex", "align-items": "baseline" }}>
                            <span style={{ flex: 1, "font-weight": 650, color: `var(--agent-${ag.agent})` }}>
                              {AGENT_NAMES[ag.agent] || ag.agent}
                            </span>
                            <span style={{ "font-weight": 700, color: `var(--agent-${ag.agent})`, "font-variant-numeric": "tabular-nums" }}>
                              {fmtCost(ag.cost)}
                            </span>
                          </div>
                          <For each={ag.models}>
                            {(m) => (
                              <div style={{ padding: "4px 0 0 12px", "font-variant-numeric": "tabular-nums" }}>
                                <div style={{ display: "flex", gap: "8px", "font-size": "13px" }}>
                                  <span style={{ flex: 1, color: COMPANY_COLORS[m.company || "other"] || "var(--co-other)", "overflow-wrap": "anywhere" }}>
                                    {m.model}
                                  </span>
                                  <span style={{ color: "var(--fig-cost)" }}>{fmtCost(m.cost)}</span>
                                </div>
                                <div style={{ "font-size": "11.5px", color: "var(--faint)" }}>
                                  {t("usage.tokens")} {fmtTokens(m.tokens)} · {t("usage.input")} {fmtTokens(m.input)} · {t("usage.output")} {fmtTokens(m.output)} · {t("usage.cacheRead")} {fmtTokens(m.cacheRead)}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                );
              })()}
            </Show>
          </div>
        </div>
      </Show>

      {/* Model Sheet */}
      <Show when={sheet() === "model" && selectedModel()}>
        <div style={{ position: "fixed", inset: 0, "z-index": 50, background: "rgba(0,0,0,.5)" }}>
          <button
            onClick={() => setSheet("none")}
            aria-label={t("common.close")}
            style={{ position: "absolute", inset: 0, background: "none", border: 0 }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              background: "var(--surface)",
              "border-top": "1px solid var(--line2)",
              "border-radius": "24px 24px 0 0",
              padding: "10px 18px 40px",
              "max-height": "85vh",
              "overflow-y": "auto",
            }}
          >
            <div style={{ width: "40px", height: "5px", "border-radius": "3px", background: "var(--line2)", margin: "0 auto 10px" }} />
            <div style={{ display: "flex", "align-items": "flex-start", gap: "8px" }}>
              <div style={{ flex: 1, "min-width": 0 }}>
                <div
                  style={{
                    "font-weight": 700,
                    "font-size": "17px",
                    color: modelData() ? COMPANY_COLORS[modelData()!.company || "other"] || "var(--co-other)" : "var(--fg)",
                    "overflow-wrap": "anywhere",
                  }}
                >
                  {selectedModel()}
                </div>
                <div style={{ "font-size": "12.5px", color: "var(--faint)" }}>
                  {modelData()?.company ?? ""} · {rangeText()}
                </div>
              </div>
              <button
                class="cbtn"
                aria-label={t("common.close")}
                onClick={() => setSheet("none")}
              >
                <Icon name="x" />
              </button>
            </div>

            <Show when={modelData()} fallback={<div style={{ padding: "20px 0", color: "var(--muted)" }}>{t("common.loading")}</div>}>
              {(() => {
                const mdl = modelData()!;
                const col = COMPANY_COLORS[mdl.company || "other"] || "var(--co-other)";
                let maxDaily = 0;
                for (const d of mdl.perDay) {
                  const v = metric() === "tokens" ? d.tokens : d.cost;
                  if (v > maxDaily) maxDaily = v;
                }

                return (
                  <div>
                    {/* Metrics grid */}
                    <div
                      style={{
                        display: "grid",
                        "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                        gap: "4px 14px",
                        "margin-top": "10px",
                        "font-size": "13px",
                        "font-variant-numeric": "tabular-nums",
                      }}
                    >
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cost")}</span><span style={{ color: "var(--fig-cost)" }}>{fmtCost(mdl.totals.cost)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.tokens")}</span><span style={{ color: "var(--fig-tokens)" }}>{fmtTokens(mdl.totals.tokens)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.input")}</span><span style={{ color: "var(--fig-input)" }}>{fmtTokens(mdl.totals.input)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.output")}</span><span style={{ color: "var(--fig-output)" }}>{fmtTokens(mdl.totals.output)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cacheRead")}</span><span style={{ color: "var(--fig-cache)" }}>{fmtTokens(mdl.totals.cacheRead)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cacheWrite")}</span><span style={{ color: "var(--fig-cache)" }}>{mdl.totals.cacheWrite > 0 ? fmtTokens(mdl.totals.cacheWrite) : "—"}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.cacheHit")}</span><span style={{ color: "var(--fig-hit)" }}>{cacheHitPercent(mdl.totals.cacheRead, mdl.totals.tokens).toFixed(2)}%</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.messages")}</span><span>{fmtNumber(mdl.totals.messages)}</span></div>
                      <div style={{ display: "flex" }}><span style={{ flex: 1, color: "var(--faint)" }}>{t("usage.lastUsed")}</span><span>{mdl.lastUsed || "—"}</span></div>
                    </div>

                    {/* Breakdown by Agent */}
                    <div style={{ "font-size": "12.5px", color: "var(--faint)", "margin-top": "12px" }}>
                      {t("usage.byAgent")}
                    </div>
                    <For each={mdl.agents}>
                      {(ag) => (
                        <div
                          style={{
                            "border-top": "1px solid var(--line)",
                            "margin-top": "8px",
                            "padding-top": "8px",
                            display: "flex",
                            "align-items": "baseline",
                            gap: "6px",
                            "font-variant-numeric": "tabular-nums",
                          }}
                        >
                          <span style={{ width: "9px", height: "9px", "border-radius": "50%", background: `var(--agent-${ag.agent})`, "align-self": "center" }} />
                          <span style={{ flex: 1, "min-width": 0, "font-weight": 600, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                            {AGENT_NAMES[ag.agent] || ag.agent}
                          </span>
                          <span
                            style={{
                              "font-size": "13px",
                              color: "var(--fig-cost)",
                              "white-space": "nowrap",
                              flex: "none",
                              "text-align": "right",
                              "font-variant-numeric": "tabular-nums",
                            }}
                          >
                            {fmtCost(ag.cost)}
                          </span>
                          <span
                            style={{
                              "font-size": "13px",
                              color: "var(--fig-tokens)",
                              "white-space": "nowrap",
                              flex: "none",
                              width: "56px",
                              "text-align": "right",
                              "font-variant-numeric": "tabular-nums",
                            }}
                          >
                            {fmtTokens(ag.tokens)}
                          </span>
                        </div>
                      )}
                    </For>

                    {/* Sparkline (multi-day period only) */}
                    <Show when={!isSingleDay() && mdl.perDay.length > 1}>
                      <div style={{ "font-size": "12.5px", color: "var(--faint)", "margin-top": "12px" }}>
                        {t("usage.modelUsagePerDay")}
                      </div>
                      <div style={{ display: "flex", "align-items": "flex-end", gap: "2px", height: "44px", "margin-top": "6px" }}>
                        <For each={mdl.perDay}>
                          {(d) => {
                            const v = metric() === "tokens" ? d.tokens : d.cost;
                            const h = maxDaily > 0 ? `${Math.max(2, (v / maxDaily) * 44)}px` : "2px";
                            return (
                              <span
                                style={{
                                  flex: 1,
                                  "min-width": 0,
                                  height: h,
                                  "border-radius": "2px 2px 0 0",
                                  background: col,
                                }}
                              />
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              })()}
            </Show>
          </div>
        </div>
      </Show>

      {/* Custom Range Sheet */}
      <Show when={sheet() === "custom"}>
        <div style={{ position: "fixed", inset: 0, "z-index": 50, background: "rgba(0,0,0,.5)" }}>
          <button
            onClick={() => setSheet("none")}
            aria-label={t("common.close")}
            style={{ position: "absolute", inset: 0, background: "none", border: 0 }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              background: "var(--surface)",
              "border-top": "1px solid var(--line2)",
              "border-radius": "24px 24px 0 0",
              padding: "10px 18px 40px",
            }}
          >
            <div style={{ width: "40px", height: "5px", "border-radius": "3px", background: "var(--line2)", margin: "0 auto 10px" }} />
            <div style={{ display: "flex", "align-items": "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ "font-weight": 650, "font-size": "17px" }}>{t("usage.customTitle")}</div>
                <div style={{ "font-size": "12.5px", color: "var(--faint)", "margin-top": "2px" }}>
                  {t("usage.customHint", { from: usageReport()?.firstDay || "2026-01-01" })}
                </div>
              </div>
              <button class="cbtn" aria-label={t("common.close")} onClick={() => setSheet("none")}>
                <Icon name="x" />
              </button>
            </div>
            <div style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "10px", "margin-top": "14px" }}>
              <label style={{ display: "flex", "flex-direction": "column", gap: "4px", "font-size": "12.5px", color: "var(--muted)" }}>
                {t("usage.start")}
                <input
                  type="date"
                  value={draftFrom()}
                  min={usageReport()?.firstDay || "2026-01-01"}
                  max={todayYMD()}
                  onChange={(e) => setDraftFrom(e.currentTarget.value)}
                  style={{
                    height: "44px",
                    "border-radius": "12px",
                    border: "1px solid var(--line2)",
                    background: "var(--bg)",
                    color: "var(--fg)",
                    font: "inherit",
                    "font-size": "15px",
                    padding: "0 10px",
                  }}
                />
              </label>
              <label style={{ display: "flex", "flex-direction": "column", gap: "4px", "font-size": "12.5px", color: "var(--muted)" }}>
                {t("usage.end")}
                <input
                  type="date"
                  value={draftTo()}
                  min={usageReport()?.firstDay || "2026-01-01"}
                  max={todayYMD()}
                  onChange={(e) => setDraftTo(e.currentTarget.value)}
                  style={{
                    height: "44px",
                    "border-radius": "12px",
                    border: "1px solid var(--line2)",
                    background: "var(--bg)",
                    color: "var(--fg)",
                    font: "inherit",
                    "font-size": "15px",
                    padding: "0 10px",
                  }}
                />
              </label>
            </div>
            <button
              onClick={() => {
                setCustomFrom(draftFrom());
                setCustomTo(draftTo());
                setRange("custom");
                setSheet("none");
              }}
              style={{
                "margin-top": "16px",
                width: "100%",
                height: "48px",
                "border-radius": "14px",
                border: 0,
                background: "var(--accent)",
                color: "var(--onaccent)",
                font: "inherit",
                "font-weight": 650,
              }}
            >
              {t("usage.apply")}
            </button>
          </div>
        </div>
      </Show>

      {/* Agent Filter Sheet */}
      <Show when={sheet() === "filter"}>
        <div style={{ position: "fixed", inset: 0, "z-index": 50, background: "rgba(0,0,0,.5)" }}>
          <button
            onClick={() => setSheet("none")}
            aria-label={t("common.close")}
            style={{ position: "absolute", inset: 0, background: "none", border: 0 }}
          />
          <div
            style={{
              position: "absolute",
              left: "8px",
              right: "8px",
              top: "220px",
              background: "var(--surface)",
              border: "1px solid var(--line2)",
              "border-radius": "22px",
              padding: "16px 16px 12px",
            }}
          >
            <div style={{ display: "flex", "align-items": "center" }}>
              <span style={{ "font-weight": 650, "font-size": "16px", flex: 1 }}>{t("usage.filterTitle")}</span>
              <button
                onClick={() => setActiveAgents(new Set(AGENT_KEYS))}
                style={{ height: "32px", padding: "0 10px", border: 0, background: "none", color: "var(--accent)", font: "inherit", "font-size": "14px" }}
              >
                {t("usage.selectAll")}
              </button>
              <button class="cbtn" aria-label={t("common.close")} onClick={() => setSheet("none")}>
                <Icon name="x" />
              </button>
            </div>
            <div style={{ "font-size": "12.5px", color: "var(--faint)", "margin-bottom": "6px" }}>
              {t("usage.filterHint")}
            </div>

            <For each={AGENT_KEYS}>
              {(ag) => {
                const on = () => activeAgents().has(ag);
                const toggle = () => {
                  const s = new Set(activeAgents());
                  if (s.has(ag)) {
                    if (s.size > 1) s.delete(ag);
                  } else {
                    s.add(ag);
                  }
                  setActiveAgents(s);
                };

                return (
                  <button
                    onClick={toggle}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "12px",
                      width: "100%",
                      "min-height": "48px",
                      background: "none",
                      border: 0,
                      "border-top": "1px solid var(--line)",
                      color: "var(--fg)",
                      font: "inherit",
                      "text-align": "left",
                    }}
                  >
                    <span
                      style={{
                        width: "22px",
                        height: "22px",
                        "border-radius": "7px",
                        border: on() ? "2px solid var(--accent)" : "2px solid var(--line2)",
                        background: on() ? "var(--accent)" : "none",
                        display: "grid",
                        "place-items": "center",
                        color: "var(--onaccent)",
                        flex: "none",
                      }}
                    >
                      <Show when={on()}>
                        <Icon name="check" sm />
                      </Show>
                    </span>
                    <span style={{ width: "9px", height: "9px", "border-radius": "50%", background: `var(--agent-${ag})`, flex: "none" }} />
                    <span style={{ flex: 1 }}>{AGENT_NAMES[ag]}</span>
                  </button>
                );
              }}
            </For>

            <button
              onClick={() => setSheet("none")}
              style={{
                "margin-top": "8px",
                width: "100%",
                height: "46px",
                "border-radius": "14px",
                border: 0,
                background: "var(--accent)",
                color: "var(--onaccent)",
                font: "inherit",
                "font-weight": 650,
              }}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
