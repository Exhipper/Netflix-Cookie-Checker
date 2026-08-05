import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, ScanLine, Settings as SettingsIcon, Menu, X, Loader2, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCheckRun } from "@/hooks/useCheckRun";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/checker", label: "Checker", icon: ScanLine },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isRunning, progress, liveResults } = useCheckRun();

  const processed = progress?.processed || 0;
  const total = progress?.total || 0;
  const counts = progress?.counts;

  return (
    <div className="min-h-screen bg-background bg-grid">
      {/* Sidebar - Desktop */}
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center gap-2 border-b border-border px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary font-bold text-white text-sm">
              N
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">Cookie Checker</div>
              <div className="text-xs text-muted-foreground">Netflix Tool v4.5</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => {
            const isActive = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all",
                  isActive
                    ? "bg-primary/10 text-primary glow-red"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Active check indicator */}
        {isRunning && (
          <div className="border-t border-border p-3">
            <button
              onClick={() => navigate("/checker")}
              className="w-full rounded-md bg-green-500/10 border border-green-500/20 p-3 text-left transition-all hover:bg-green-500/15"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-green-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Check Running
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">
                {processed}/{total} processed
                {counts && counts.hits > 0 && ` · ${counts.hits} hits`}
                {liveResults.length > 0 && ` · ${liveResults.length} results`}
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-green-500 transition-all duration-300"
                  style={{ width: `${total > 0 ? (processed / total) * 100 : 0}%` }}
                />
              </div>
              <div className="mt-1.5 text-[10px] text-muted-foreground/70 flex items-center gap-1">
                <Activity className="h-2.5 w-2.5" />
                Click to view live results
              </div>
            </button>
          </div>
        )}

        <div className="border-t border-border p-4">
          <div className="text-xs text-muted-foreground">
            Forked from{" "}
            <a
              href="https://github.com/harshitkamboj/Netflix-Cookie-Checker"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              harshitkamboj
            </a>
          </div>
        </div>
      </aside>

      {/* Mobile Header */}
      <div className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-sm lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary font-bold text-white text-sm">
            N
          </div>
          <span className="text-sm font-semibold">Cookie Checker</span>
        </div>
        <div className="flex items-center gap-2">
          {isRunning && (
            <button
              onClick={() => navigate("/checker")}
              className="flex items-center gap-1.5 rounded-md bg-green-500/10 px-2.5 py-1.5 text-xs font-medium text-green-500"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {processed}/{total}
            </button>
          )}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Nav */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <nav className="absolute left-0 top-16 w-full space-y-1 border-b border-border bg-background p-3 animate-slide-up">
            {navItems.map((item) => {
              const isActive = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}

      {/* Main Content */}
      <div className="lg:pl-64">
        <main className="min-h-screen">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
