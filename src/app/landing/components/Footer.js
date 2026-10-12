"use client";

export default function Footer() {
  return (
    <footer className="border-t border-[#123433] bg-[#030808] pt-16 pb-8 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-16">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="size-6 rounded bg-[#00d4d4] flex items-center justify-center text-[#050505]">
                <span className="material-symbols-outlined text-[16px]">hub</span>
              </div>
              <h3 className="text-white text-lg font-bold">AI.Mangso</h3>
            </div>
            <p className="text-gray-500 text-sm max-w-xs mb-6">
              One API endpoint for every AI provider. Connect, route, and manage your models with ease.
            </p>
          </div>
        </div>

        {/* Bottom */}
        <div className="border-t border-[#123433] pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-gray-600 text-sm">
            © 2026 AI.Mangso. Part of{" "}
            <a className="text-gray-500 hover:text-[#00d4d4] transition-colors" href="https://mangso.net" target="_blank" rel="noopener noreferrer">
              mangso.net
            </a>{" "}
            infrastructure.
          </p>
        </div>
      </div>
    </footer>
  );
}
