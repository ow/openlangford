import { Link, useLocation, useRouteLoaderData } from "react-router";
import { useState, useEffect } from "react";
import {
  Home,
  Calendar,
  Users,
  Tag,
  Book,
  TrendingUp,
  Scale,
  MessageSquare,
  ChevronDown,
  Building2,
  CheckCircle2,
  Mic,
  Landmark,
  LogOut,
  Menu,
  X,
  Info,
  Bell,
  Settings,
  ArrowLeftRight,
  ShieldCheck,
} from "lucide-react";
import { siteName } from "../lib/site-name";
import { useSiteFlags } from "../lib/use-site-flags";
import { cn } from "../lib/utils";
import { QuickJump } from "./search/quick-jump";
import type { Municipality } from "../lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface NavItemProps {
  name: string;
  href: string;
  icon: React.ElementType;
  isActive?: boolean;
}

function NavLink({ name, href, icon: Icon, isActive }: NavItemProps) {
  return (
    <Link
      to={href}
      prefetch="intent"
      className={cn(
        "px-4 py-2 rounded-full text-sm font-bold transition-all flex items-center gap-2",
        isActive
          ? "bg-zinc-900 text-white shadow-md"
          : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100",
      )}
    >
      {name}
    </Link>
  );
}

function NavDropdown({
  label,
  icon: Icon,
  items,
  isActive,
}: {
  label: string;
  icon: React.ElementType;
  isActive: boolean;
  items: { name: string; href: string; icon: React.ElementType }[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "px-4 py-2 rounded-full text-sm font-bold transition-all flex items-center gap-2 group",
            isActive || isOpen
              ? "bg-zinc-100 text-zinc-900"
              : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100",
          )}
        >
          {label}
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              isOpen && "rotate-180",
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-56 bg-white rounded-xl shadow-xl border-zinc-200 overflow-hidden p-1"
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.href} asChild className="p-0">
            <Link
              to={item.href}
              prefetch="intent"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50 focus:text-zinc-900 focus:bg-zinc-50 transition-colors"
            >
              <div className="p-1.5 rounded-md bg-zinc-100 text-zinc-500">
                <item.icon className="h-4 w-4" />
              </div>
              {item.name}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Navbar() {
  const location = useLocation();
  const rootData = useRouteLoaderData("root") as
    | { user: any; isAdmin?: boolean; municipality?: Municipality }
    | undefined;
  const user = rootData?.user;
  const isAdmin = rootData?.isAdmin;
  const municipality = rootData?.municipality;
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { signupsEnabled } = useSiteFlags();
  const brandName = siteName(municipality);

  const isLinkActive = (href: string) =>
    location.pathname === href ||
    (href !== "/" && location.pathname.startsWith(href));

  // Close mobile menu when location changes
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-zinc-200">
      <div className="container mx-auto px-4 max-w-7xl">
        <div className="flex items-center justify-between h-16">
          <Link to="/" prefetch="intent" className="flex items-center gap-2 group">
            <div className="p-1.5 bg-brand-600 rounded-lg group-hover:rotate-6 transition-transform">
              <Building2 className="h-5 w-5 text-white" />
            </div>
            <span className="font-black text-xl tracking-tight text-zinc-900">
              {brandName}
            </span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-1">
            <NavLink
              name="Meetings"
              href="/meetings"
              icon={Calendar}
              isActive={isLinkActive("/meetings")}
            />
            <NavDropdown
              label="Records"
              icon={Landmark}
              isActive={isLinkActive("/matters") || isLinkActive("/bylaws")}
              items={[
                { name: "Matters", href: "/matters", icon: Tag },
                { name: "Bylaws", href: "/bylaws", icon: Book },
              ]}
            />
            <NavDropdown
              label="Council"
              icon={Users}
              isActive={
                isLinkActive("/people") ||
                isLinkActive("/participants") ||
                isLinkActive("/alignment") ||
                isLinkActive("/compare")
              }
              items={[
                { name: "Members", href: "/people", icon: Users },
                { name: "Participants", href: "/participants", icon: Mic },
                { name: "Alignment", href: "/alignment", icon: Scale },
                { name: "Compare", href: "/compare", icon: ArrowLeftRight },
              ]}
            />
            <NavLink
              name="About"
              href="/about"
              icon={Info}
              isActive={isLinkActive("/about")}
            />
          </div>

          <div className="flex items-center gap-2 md:gap-4">
            <QuickJump />
            {/* Desktop User Menu */}
            {user ? (
              <div className="hidden sm:flex items-center gap-4">
                <div className="h-8 w-px bg-zinc-200" />
                <Link
                  to="/settings"
                  className="text-zinc-400 hover:text-brand-600 transition-colors"
                  title="Settings & Alerts"
                >
                  <Bell className="h-4 w-4" />
                </Link>
                {isAdmin && (
                  <Link
                    to="/admin"
                    className="text-sm font-semibold text-brand-700 transition-colors hover:text-brand-900"
                    aria-label="Admin area"
                  >
                    Admin
                  </Link>
                )}
                <Link
                  to="/logout"
                  className="text-zinc-400 hover:text-red-600 transition-colors"
                  title="Logout"
                >
                  <LogOut className="h-4 w-4" />
                </Link>
              </div>
            ) : signupsEnabled ? (
              <Link
                to="/signup"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-brand-50 text-brand-600 hover:bg-brand-100 transition-colors"
              >
                Get Alerts
              </Link>
            ) : null}

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-full transition-colors"
              aria-label="Toggle menu"
            >
              {isMobileMenuOpen ? (
                <X className="h-5 w-5" />
              ) : (
                <Menu className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden border-t border-zinc-200 bg-white">
          <div className="container mx-auto px-4 py-4 space-y-1">
            <MobileNavLink
              name="Meetings"
              href="/meetings"
              icon={Calendar}
              isActive={isLinkActive("/meetings")}
            />
            <MobileNavLink
              name="Matters"
              href="/matters"
              icon={Tag}
              isActive={isLinkActive("/matters")}
            />
            <MobileNavLink
              name="Bylaws"
              href="/bylaws"
              icon={Book}
              isActive={isLinkActive("/bylaws")}
            />
            <MobileNavLink
              name="Council"
              href="/people"
              icon={Users}
              isActive={isLinkActive("/people")}
            />
            <MobileNavLink
              name="Participants"
              href="/participants"
              icon={Mic}
              isActive={isLinkActive("/participants")}
            />
            <MobileNavLink
              name="Alignment"
              href="/alignment"
              icon={Scale}
              isActive={isLinkActive("/alignment")}
            />
            <MobileNavLink
              name="Compare"
              href="/compare"
              icon={ArrowLeftRight}
              isActive={isLinkActive("/compare")}
            />
            <MobileNavLink
              name="About"
              href="/about"
              icon={Info}
              isActive={isLinkActive("/about")}
            />

            {user ? (
              <>
                <div className="my-2 h-px bg-zinc-100" />
                <MobileNavLink
                  name="Settings & Alerts"
                  href="/settings"
                  icon={Settings}
                  isActive={isLinkActive("/settings")}
                />
                {isAdmin && (
                  <MobileNavLink
                    name="Admin area"
                    href="/admin"
                    icon={ShieldCheck}
                    isActive={isLinkActive("/admin")}
                  />
                )}
                <MobileNavLink
                  name="Logout"
                  href="/logout"
                  icon={LogOut}
                  isActive={false}
                  className="text-red-600 hover:bg-red-50 hover:text-red-700"
                />
              </>
            ) : signupsEnabled ? (
              <>
                <div className="my-2 h-px bg-zinc-100" />
                <MobileNavLink
                  name="Get Alerts"
                  href="/signup"
                  icon={Bell}
                  isActive={isLinkActive("/signup")}
                />
              </>
            ) : null}
          </div>
        </div>
      )}
    </nav>
  );
}

function MobileNavLink({
  name,
  href,
  icon: Icon,
  isActive,
  className,
}: NavItemProps & { className?: string }) {
  return (
    <Link
      to={href}
      prefetch="intent"
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors",
        isActive
          ? "bg-zinc-900 text-white"
          : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900",
        className,
      )}
    >
      {name}
    </Link>
  );
}
