import { TriangleAlert } from "lucide-react";
import {
  Component,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn.ts";
import { createLoader } from "../lib/loader.ts";
import { Skeleton } from "../ui/skeleton.tsx";

// Parts of the app that load on demand (docs/phase3.md §16): each is a dynamic `import()` chunk
// (Bun.build splitting), so the initial load stays within its budget. `lazyComponent` wraps a
// chunk's component: it starts the import when first rendered, shows a skeleton while it loads
// (after a short delay, so a fast load does not flash), an error with "Retry" when the chunk cannot
// be loaded, and the same error when the loaded part fails to render (an error boundary: one
// broken panel never takes the page down). `preload()` starts the import early (a hover, an idle
// moment); `useLatch` keeps an overlay mounted once it has been opened, so its closing animation
// and focus return still run.
//
//   const PlayerSheet = lazyComponent(
//     () => import("../players/player-sheet.tsx").then((m) => m.PlayerSheet),
//     { what: "the dossier", overlay: true, onClose: () => uiActions.closePlayer() },
//   );

/** How long a load may take before its placeholder shows (ms). */
const PLACEHOLDER_DELAY_MS = 150;

export interface LazyOptions {
  /** What loads, for the viewer: "the dossier" ("Loading the dossier…"). */
  readonly what: string;
  /**
   * Shown while the chunk loads: a skeleton block when left out (`skeletonClassName` sizes it),
   * nothing with `null`, or a node of the caller's.
   */
  readonly fallback?: ReactNode;
  readonly skeletonClassName?: string;
  /**
   * An overlay (a sheet, a dialog, a popover) shows no placeholder by default, and its errors as a
   * small panel fixed at the bottom of the screen with "Close" (calling `onClose`) beside "Retry".
   */
  readonly overlay?: boolean;
  readonly onClose?: () => void;
}

export type LazyComponent<P extends object> = ((props: P) => ReactNode) & {
  /** Starts loading the chunk now (no render needed). */
  readonly preload: () => void;
  displayName?: string;
};

const sentence = (what: string): string => what.charAt(0).toUpperCase() + what.slice(1);

function Delayed({ children }: { readonly children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const h = window.setTimeout(() => setShown(true), PLACEHOLDER_DELAY_MS);
    return () => window.clearTimeout(h);
  }, []);
  return shown ? children : null;
}

function Placeholder({ options }: { readonly options: LazyOptions }) {
  if (options.fallback === null || (options.overlay === true && options.fallback === undefined)) {
    return null;
  }
  return (
    <Delayed>
      {options.fallback === undefined ? (
        <output aria-busy="true" data-lazy-loading="" className="block">
          <span className="sr-only">Loading {options.what}…</span>
          <Skeleton aria-hidden="true" className={cn("h-24 w-full", options.skeletonClassName)} />
        </output>
      ) : (
        options.fallback
      )}
    </Delayed>
  );
}

/** "Could not be loaded" (the chunk) or "failed to show" (a render error), with Retry. */
export function LazyProblem({
  options,
  crashed,
  onRetry,
}: {
  readonly options: LazyOptions;
  readonly crashed: boolean;
  readonly onRetry: () => void;
}) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  const overlay = options.overlay === true;
  return (
    <div
      role="alert"
      data-lazy-error=""
      className={cn(
        "border-destructive/50 bg-popover flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm",
        overlay &&
          "fixed bottom-24 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2 shadow-lg",
      )}
    >
      <TriangleAlert className="text-destructive size-4 shrink-0" aria-hidden="true" />
      <span>
        {sentence(options.what)}{" "}
        {crashed ? "failed to show." : "could not be loaded (the connection, or a newer version)."}
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          className="text-primary hover:text-primary/80 font-medium"
          onClick={onRetry}
        >
          Retry
        </button>
        {crashed ? null : (
          <button
            type="button"
            className="text-primary hover:text-primary/80 font-medium"
            onClick={() => window.location.reload()}
          >
            Reload the page
          </button>
        )}
        {overlay ? (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground font-medium"
            onClick={() => {
              setClosed(true);
              options.onClose?.();
            }}
          >
            Close
          </button>
        ) : null}
      </span>
    </div>
  );
}

interface BoundaryProps {
  readonly options: LazyOptions;
  readonly children: ReactNode;
}

/** Catches a render error of a loaded part: its panel shows the error, the page stays up. */
class Boundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `${sentence(this.props.options.what)} failed to show`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <LazyProblem
        options={this.props.options}
        crashed
        onRetry={() => this.setState({ failed: false })}
      />
    );
  }
}

/** A component of a chunk loaded on first render (or on `preload()`); see the module comment. */
export function lazyComponent<P extends object>(
  importer: () => Promise<ComponentType<P>>,
  options: LazyOptions,
): LazyComponent<P> {
  const loader = createLoader(importer);
  function Lazy(props: P): ReactNode {
    const state = useSyncExternalStore(loader.subscribe, loader.state, loader.state);
    useEffect(() => {
      if (state.status === "idle") void loader.load();
    }, [state.status]);
    if (state.status === "ready") {
      const Loaded = state.value;
      return (
        <Boundary options={options}>
          <Loaded {...props} />
        </Boundary>
      );
    }
    if (state.status === "failed") {
      return <LazyProblem options={options} crashed={false} onRetry={() => void loader.load()} />;
    }
    return <Placeholder options={options} />;
  }
  return Object.assign(Lazy, {
    preload: (): void => {
      void loader.load();
    },
    displayName: `Lazy(${options.what})`,
  });
}

/** True from the first render where `on` is true: an overlay stays mounted once opened. */
export function useLatch(on: boolean): boolean {
  const [latched, setLatched] = useState(on);
  if (on && !latched) setLatched(true);
  return latched || on;
}

/** Preloads chunks when the browser is idle (or after 2 s); returns a cancel function. */
export function preloadWhenIdle(...parts: readonly { readonly preload: () => void }[]): () => void {
  const run = (): void => {
    for (const p of parts) p.preload();
  };
  if (typeof window.requestIdleCallback === "function") {
    const h = window.requestIdleCallback(run, { timeout: 4_000 });
    return () => window.cancelIdleCallback(h);
  }
  const h = window.setTimeout(run, 2_000);
  return () => window.clearTimeout(h);
}
