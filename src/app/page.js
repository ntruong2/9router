import LandingPage from "./landing/page";

// Fallback for the root route — the proxy middleware normally rewrites "/" to the
// landing page before this ever runs, but this keeps behavior correct if it ever
// doesn't. Always renders the landing page, signed in or not.
export default function InitPage() {
  return <LandingPage />;
}
