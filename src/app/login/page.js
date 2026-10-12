"use client";

import { useState, useEffect } from "react";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import NetworkBackground from "../landing/components/NetworkBackground";

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

function TealButton({ children, className = "", variant = "primary", ...props }) {
  const base =
    "w-full h-11 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-[#00d4d4] hover:bg-[#00b8b8] text-[#050505] shadow-[0_0_15px_rgba(0,212,212,0.35)]"
      : "border border-[#123433] bg-[#0a1414] hover:bg-[#123433] text-white";
  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {props.loading ? (
        <span className="inline-block h-4 w-4 rounded-full border-2 border-[#050505]/40 border-t-[#050505] animate-spin" />
      ) : (
        children
      )}
    </button>
  );
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [authMode, setAuthMode] = useState("password");
  const [ssoType, setSsoType] = useState("oidc");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [samlConfigured, setSamlConfigured] = useState(false);
  const [samlLoginLabel, setSamlLoginLabel] = useState("Sign in with SAML SSO");
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  // Countdown for rate-limit
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.authenticated === true || data.requireLogin === false) {
            window.location.assign("/dashboard");
            return;
          }
          setHasPassword(!!data.hasPassword);
          setAuthMode(data.authMode || "password");
          setSsoType(data.ssoType || "oidc");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setSamlConfigured(data.samlConfigured === true);
          setSamlLoginLabel(data.samlLoginLabel || "Sign in with SAML SSO");
        } else {
          // Safe fallback on non-OK response to avoid infinite loading state.
          setHasPassword(true);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        setHasPassword(true);
      }
    }
    checkAuth();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.mustChangePassword) {
          setMustChange(true);
          return;
        }
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Invalid password");
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Force a new password before entering the dashboard (default + remote).
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      if (res.ok) {
        window.location.assign("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to set password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  const handleSamlLogin = () => {
    window.location.href = "/api/auth/saml/start";
  };

  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

  const samlAvailable = isSsoEnabled && activeSsoType === "saml" && samlConfigured;
  const oidcAvailable = isSsoEnabled && activeSsoType === "oidc" && oidcConfigured;
  const ssoAvailable = samlAvailable || oidcAvailable;

  const passwordAvailable = authMode === "password" || authMode === "both" || !ssoAvailable;

  const shellClass = `${spaceGrotesk.variable} ${plexMono.variable} font-[family-name:var(--font-landing-sans)] min-h-screen flex items-center justify-center bg-[#050505] p-4 relative overflow-hidden text-white`;

  // Show loading state while checking password
  if (hasPassword === null) {
    return (
      <div className={shellClass}>
        <div className="text-center relative z-10">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#00d4d4]"></div>
          <p className="text-gray-400 mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      {/* Background — same constellation network as the landing page */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <NetworkBackground />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-[#00d4d4]/8 rounded-full blur-[140px]"></div>
        <div
          className="absolute inset-0"
          style={{
            background: "radial-gradient(ellipse at center, transparent 0%, rgba(5, 5, 5, 0.55) 100%)",
          }}
        ></div>
      </div>

      <div className="relative z-10 w-full max-w-md">
        <a
          href="/"
          className="flex items-center justify-center gap-3 mb-8 group"
          data-i18n-skip="true"
        >
          <div className="size-8 rounded bg-linear-to-br from-[#00d4d4] to-[#007575] flex items-center justify-center text-[#050505]">
            <span className="material-symbols-outlined text-[20px]">hub</span>
          </div>
          <span className="text-xl font-bold tracking-tight group-hover:text-[#00d4d4] transition-colors">
            AI.Mangso
          </span>
        </a>

        <div className="text-center mb-8">
          <p className="text-gray-400">
            {samlAvailable
              ? "Sign in with SAML 2.0 Single Sign-On"
              : oidcAvailable
              ? "Sign in with your OIDC provider to access the dashboard"
              : "Enter your password to access the dashboard"}
          </p>
        </div>

        <div className="rounded-xl border border-[#123433] bg-[#0a1414]/80 backdrop-blur-md shadow-2xl p-6">
          {mustChange ? (
            <form onSubmit={handleSetNewPassword} className="flex flex-col gap-4">
              <p className="text-sm text-amber-400 text-center">
                Set a new password before accessing the dashboard remotely.
              </p>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">New password</label>
                <input
                  type="password"
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoFocus
                  className="h-11 rounded-lg border border-[#123433] bg-[#050505] px-3 text-sm text-white placeholder:text-gray-600 outline-none focus:border-[#00d4d4] transition-colors"
                />
                {error && <p className="text-xs text-red-400">{error}</p>}
              </div>
              <TealButton type="submit" loading={loading} disabled={!newPassword}>
                Set password
              </TealButton>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              {samlAvailable && (
                <TealButton type="button" onClick={handleSamlLogin}>
                  {samlLoginLabel}
                </TealButton>
              )}

              {oidcAvailable && (
                <TealButton type="button" onClick={handleOidcLogin}>
                  {oidcLoginLabel}
                </TealButton>
              )}

              {ssoAvailable && passwordAvailable && <div className="h-px bg-[#123433]" />}

              {passwordAvailable ? (
                <form onSubmit={handleLogin} className="flex flex-col gap-4">
                  {isSsoEnabled && !ssoAvailable && (
                    <p className="text-xs text-amber-400 text-center">
                      {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login is enabled, but configuration is incomplete. Password login is still available for recovery.
                    </p>
                  )}

                  {authMode === "both" && ssoAvailable && (
                    <p className="text-xs text-gray-400 text-center">
                      Password and {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login are both enabled.
                    </p>
                  )}

                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Password</label>
                    <input
                      type="password"
                      placeholder="Enter password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoFocus={!oidcAvailable}
                      className="h-11 rounded-lg border border-[#123433] bg-[#050505] px-3 text-sm text-white placeholder:text-gray-600 outline-none focus:border-[#00d4d4] transition-colors"
                    />
                    {error && <p className="text-xs text-red-400">{error}</p>}
                    {retryAfter > 0 && (
                      <p className="text-xs text-amber-400">
                        Locked. Retry in{" "}
                        <span className="font-[family-name:var(--font-landing-mono)]">{retryAfter}s</span>.
                      </p>
                    )}
                    {resetHint && (
                      <p className="text-xs text-gray-500">
                        Forgot password? Open{" "}
                        <code className="bg-[#123433] px-1 rounded font-[family-name:var(--font-landing-mono)]">9router</code>{" "}
                        CLI on the host → <b>Settings</b> → <b>Reset Password to Default</b>.
                      </p>
                    )}
                  </div>

                  <TealButton type="submit" loading={loading} disabled={retryAfter > 0}>
                    {retryAfter > 0 ? `Wait ${retryAfter}s` : "Login"}
                  </TealButton>

                  {hasPassword === false && (
                    <p className="text-xs text-center text-amber-400">
                      Security risk: no password set. You will be asked to set one when logging in remotely.
                    </p>
                  )}
                </form>
              ) : (
                error && <p className="text-xs text-red-400">{error}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
