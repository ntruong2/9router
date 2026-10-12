"use client";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const CURL_EXAMPLE = `curl https://ai.mangso.net/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'`;

export default function GetStarted() {
  const { copied, copy } = useCopyToClipboard();

  const handleCopy = () => {
    copy(CURL_EXAMPLE, "landing");
  };

  return (
    <section className="py-24 px-6 bg-[#030808]">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-16 items-start">
          {/* Left: Steps */}
          <div className="flex-1">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Get Your API Key in 30 Seconds</h2>
            <p className="text-gray-400 text-lg mb-8">
              Sign in, copy your key, point any client at one endpoint. No installs, no servers to run.
            </p>

            <div className="flex flex-col gap-6">
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#00d4d4]/20 text-[#00d4d4] flex items-center justify-center font-bold">1</div>
                <div>
                  <h4 className="font-bold text-lg">Sign In</h4>
                  <p className="text-sm text-gray-500 mt-1">Log in to the AI.Mangso dashboard</p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#00d4d4]/20 text-[#00d4d4] flex items-center justify-center font-bold">2</div>
                <div>
                  <h4 className="font-bold text-lg">Copy Your Key</h4>
                  <p className="text-sm text-gray-500 mt-1">Grab your API key and the endpoint URL</p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#00d4d4]/20 text-[#00d4d4] flex items-center justify-center font-bold">3</div>
                <div>
                  <h4 className="font-bold text-lg">Start Calling</h4>
                  <p className="text-sm text-gray-500 mt-1">Point any client at https://ai.mangso.net/v1 — done</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Code block */}
          <div className="flex-1 w-full">
            <div className="rounded-xl overflow-hidden bg-[#1e1e1e] border border-[#123433] shadow-2xl">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-4 py-3 bg-[#252526] border-b border-gray-700">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <div className="ml-2 text-xs text-gray-500 font-[family-name:var(--font-landing-mono)]">terminal</div>
              </div>

              {/* Terminal content */}
              <div className="p-6 font-[family-name:var(--font-landing-mono)] text-sm leading-relaxed overflow-x-auto">
                <div
                  className="flex items-start gap-2 mb-4 group cursor-pointer"
                  onClick={handleCopy}
                >
                  <span className="text-green-400 flex-none">$</span>
                  <pre className="text-white whitespace-pre-wrap break-all m-0">{CURL_EXAMPLE}</pre>
                  <span className="ml-auto flex-none text-gray-500 text-xs opacity-0 group-hover:opacity-100">
                    {copied === "landing" ? "✓ Copied" : "Copy"}
                  </span>
                </div>

                <div className="text-gray-400 border-t border-gray-700 pt-4">
                  <span className="text-[#00d4d4]">&gt;</span> 200 OK — routed to <span className="text-blue-400">claude-sonnet-5</span><br/>
                  <span className="text-[#00d4d4]">&gt;</span> Endpoint: <span className="text-blue-400">https://ai.mangso.net/v1</span><br/>
                  <span className="text-green-400">&gt;</span> Ready ✓
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
