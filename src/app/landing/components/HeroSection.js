"use client";

export default function HeroSection() {
  return (
    <section className="relative pt-32 pb-20 px-6 min-h-[90vh] flex flex-col items-center justify-center overflow-hidden">
      {/* Glow effect */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-[#00d4d4]/8 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="relative z-10 max-w-4xl w-full text-center flex flex-col items-center gap-8">
        {/* Status badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-[#123433] bg-[#0a1414]/50 px-3 py-1 text-xs font-medium text-[#00d4d4] font-[family-name:var(--font-landing-mono)]">
          <span className="flex h-2 w-2 rounded-full bg-[#00d4d4] animate-pulse"></span>
          API is live
        </div>

        {/* Main heading */}
        <h1 className="text-5xl md:text-7xl font-black leading-[1.1] tracking-tight">
          One Endpoint for <br />
          <span className="text-[#00d4d4]">All AI Providers</span>
        </h1>

        {/* Description */}
        <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto font-light">
          AI.Mangso is a single API endpoint for every model. Point Claude Code, Codex, Antigravity,
          Cursor, or your own app at one URL — we handle the rest.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-4 w-full">
          <button
            onClick={() => (window.location.href = "/dashboard")}
            className="h-12 px-8 rounded-lg bg-[#00d4d4] hover:bg-[#00b8b8] text-[#050505] text-base font-bold transition-all shadow-[0_0_15px_rgba(0,212,212,0.4)] flex items-center gap-2"
          >
            <span className="material-symbols-outlined">rocket_launch</span>
            Get Started
          </button>
        </div>
      </div>
    </section>
  );
}
