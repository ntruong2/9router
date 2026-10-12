"use client";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import Navigation from "./components/Navigation";
import HeroSection from "./components/HeroSection";
import StatusGrid from "./components/StatusGrid";
import HowItWorks from "./components/HowItWorks";
import GetStarted from "./components/GetStarted";
import Footer from "./components/Footer";
import NetworkBackground from "./components/NetworkBackground";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-landing-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-landing-mono",
});

export default function LandingPage() {
  return (
    <div
      className={`${spaceGrotesk.variable} ${plexMono.variable} relative text-white font-[family-name:var(--font-landing-sans)] overflow-x-hidden antialiased selection:bg-[#00d4d4] selection:text-[#050505]`}
    >
      {/* Animated Background */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none bg-[#050505]">
        {/* Constellation network */}
        <NetworkBackground />

        {/* Soft teal glow, single source for cohesion */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-[#00d4d4]/8 rounded-full blur-[140px]"></div>

        {/* Vignette effect */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 0%, rgba(5, 5, 5, 0.55) 100%)",
          }}
        ></div>
      </div>

      <div className="relative z-10">
        <Navigation />

        <main>
          {/* Hero with Flow Animation */}
          <div className="relative">
            <HeroSection />
            <div className="flex justify-center pb-20 px-6">
              <StatusGrid />
            </div>
          </div>

          <GetStarted />
          <HowItWorks />
        </main>

        <Footer />
      </div>

      {/* Global styles for keyframes */}
      <style jsx global>{`
        @keyframes float {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-10px);
          }
        }
        @keyframes dash {
          to {
            stroke-dashoffset: -20;
          }
        }
      `}</style>
    </div>
  );
}
