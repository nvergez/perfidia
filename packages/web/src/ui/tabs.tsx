import {
  createContext,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { cn } from "../lib/cn.ts";

// The shadcn "tabs" (new-york v4) with the same classes and parts, on a small tabs pattern of our
// own instead of Radix Tabs (docs/phase3.md §16.1): with Radix Tabs, its roving focus, collection
// and presence load with the page, 8.9 KB gzipped more of the initial load. The WAI-ARIA tabs
// pattern as Radix does it (horizontal, automatic activation): a `tablist` of `tab` buttons with
// one tab stop (the selected tab), the arrows move to the previous or next tab and select it
// (wrapping), Home and End to the first and last; only the selected `tabpanel` is mounted,
// labelled by its tab, and focusable.

interface TabsState {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly id: string;
}

const TabsContext = createContext<TabsState | null>(null);

function useTabs(): TabsState {
  const s = useContext(TabsContext);
  if (s === null) throw new Error("tabs parts must be inside <Tabs>");
  return s;
}

/** Ids of a tab and of its panel (values are short words: "feed", "thoughts"). */
const tabId = (s: TabsState, value: string): string => `${s.id}-tab-${value}`;
const panelId = (s: TabsState, value: string): string => `${s.id}-panel-${value}`;

/** The tab a key moves to among `count` tabs from `index` (wrapping); null: not a tabs key. */
export function nextTabIndex(count: number, index: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function Tabs({
  className,
  value,
  onValueChange,
  ...props
}: Omit<ComponentProps<"div">, "defaultValue" | "onChange"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) {
  const id = useId();
  const state = useMemo(() => ({ value, onValueChange, id }), [value, onValueChange, id]);
  return (
    <TabsContext.Provider value={state}>
      <div
        data-slot="tabs"
        data-orientation="horizontal"
        className={cn("flex flex-col gap-2", className)}
        {...props}
      />
    </TabsContext.Provider>
  );
}

function TabsList({ className, onKeyDown, ...props }: ComponentProps<"div">) {
  const onKeys = (e: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const tabs = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
    ];
    const at = tabs.findIndex((t) => t === document.activeElement);
    const next = at < 0 ? null : nextTabIndex(tabs.length, at, e.key);
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[next];
    tab?.focus();
    tab?.click();
  };
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      tabIndex={-1}
      data-slot="tabs-list"
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]",
        className,
      )}
      onKeyDown={onKeys}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  value,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "value"> & { readonly value: string }) {
  const s = useTabs();
  const active = s.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={tabId(s, value)}
      aria-selected={active}
      aria-controls={panelId(s, value)}
      data-state={active ? "active" : "inactive"}
      tabIndex={active ? 0 : -1}
      data-slot="tabs-trigger"
      className={cn(
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && !active) s.onValueChange(value);
      }}
      {...props}
    />
  );
}

function TabsContent({
  className,
  value,
  ...props
}: Omit<ComponentProps<"div">, "value"> & { readonly value: string }) {
  const s = useTabs();
  if (s.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={panelId(s, value)}
      aria-labelledby={tabId(s, value)}
      tabIndex={0}
      data-state="active"
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
