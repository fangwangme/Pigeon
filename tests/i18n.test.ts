import { describe, expect, test } from "bun:test";
import { en } from "../src/client/src/i18n/en";
import { LOCALES, relativeTime, resolveLocale, translate, withFallback, type MessageId } from "../src/client/src/i18n";

// mobile-ui-and-themes.md §10.
const placeholders = (v: string | Record<string, string>): string[] =>
  [...new Set(Object.values(typeof v === "string" ? { other: v } : v).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();

describe("choosing the language (mobile-ui-and-themes.md §10.1)", () => {
  test("follow-system takes the first preferred language Pigeon has", () => {
    expect(resolveLocale("system", ["zh-TW", "en-US"])).toBe("zh");
    expect(resolveLocale("system", ["ja-JP", "en-GB", "zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["fr-FR", "zh-Hans-CN"])).toBe("zh");
  });

  test("a system language Pigeon does not have falls back to English", () => {
    expect(resolveLocale("system", ["ja-JP"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
  });

  test("an explicit choice overrides the system language", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh", ["en-US"])).toBe("zh");
  });
});

describe("dictionaries (mobile-ui-and-themes.md §10.3)", () => {
  test("Chinese has every English message", () => {
    expect(Object.keys(LOCALES.zh.messages).sort()).toEqual(Object.keys(en).sort());
  });

  test("no language has a message English lacks, and each uses English's placeholders", () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      for (const [id, msg] of Object.entries(locale.messages) as Array<[MessageId, string | Record<string, string>]>) {
        expect({ code, id, known: id in en }).toEqual({ code, id, known: true });
        expect({ code, id, names: placeholders(msg) }).toEqual({ code, id, names: placeholders(en[id]) });
      }
    }
  });

  test("a message a language lacks shows the English text, not the id", () => {
    const partial = withFallback({});
    for (const id of Object.keys(en) as MessageId[]) expect(partial[id]).toEqual(en[id]);
  });

  test("named placeholders are filled and counts pick the plural form", () => {
    expect(translate("en", "transcript.readFiles", { count: 1 })).toBe("Read 1 file");
    expect(translate("en", "transcript.readFiles", { count: 3 })).toBe("Read 3 files");
    expect(translate("zh", "transcript.readFiles", { count: 3 })).toBe("读取了 3 个文件");
  });

  test("relative times are written in the chosen language", () => {
    const now = Date.now();
    expect(relativeTime("en", now - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(relativeTime("zh", now - 2 * 3_600_000, now)).toBe("2小时前");
  });
});
