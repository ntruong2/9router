"use client";
import { useEffect, useState } from "react";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { reloadTranslations } from "@/i18n/runtime";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

// Minimal two-way EN/VI switch for the landing page — the full 30+ language
// picker lives in the dashboard; visitors here only need the two used in this
// house's copy.
export default function LandingLanguageToggle() {
  const [locale, setLocale] = useState("en");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setLocale(getLocaleFromCookie());
  }, []);

  const setLang = async (next) => {
    if (next === locale || pending) return;
    setPending(true);
    try {
      await fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      await reloadTranslations();
      setLocale(next);
    } catch (err) {
      console.error("Failed to set locale:", err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="flex items-center rounded-full border border-[#123433] bg-[#0a1414] p-0.5 text-xs font-bold"
      data-i18n-skip="true"
    >
      <button
        type="button"
        onClick={() => setLang("en")}
        disabled={pending}
        className={`px-2.5 py-1 rounded-full transition-colors ${
          locale === "en" ? "bg-[#00d4d4] text-[#050505]" : "text-gray-400 hover:text-white"
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLang("vi")}
        disabled={pending}
        className={`px-2.5 py-1 rounded-full transition-colors ${
          locale === "vi" ? "bg-[#00d4d4] text-[#050505]" : "text-gray-400 hover:text-white"
        }`}
      >
        VI
      </button>
    </div>
  );
}
