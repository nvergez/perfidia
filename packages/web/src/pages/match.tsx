import { ArrowLeft, CircleHelp, Hourglass, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { BlocProgress } from "../board/bloc-progress.tsx";
import { Leaderboard } from "../board/leaderboard.tsx";
import { AppLink } from "../common/link.tsx";
import { FakeBadge, StatusBadge } from "../common/status-badge.tsx";
import { FeedPanel } from "../feed/feed-panel.tsx";
import type { PlayerId } from "../lib/ids.ts";
import { cn } from "../lib/cn.ts";
import { isFakeSeat } from "../lib/models.ts";
import { MatchMap } from "../map/match-map.tsx";
import { HowToWatch } from "../onboarding/how-to-watch.tsx";
import { PlayerSheet } from "../players/player-sheet.tsx";
import { PlayersPanel } from "../players/players-panel.tsx";
import { useLayout, useMatch, useUi } from "../store/hooks.ts";
import { closeMatch, openMatch } from "../store/session.ts";
import { isPhoneTab, isSideTab, uiActions } from "../store/ui.ts";
import { StoryStrip } from "../story/story-strip.tsx";
import { ThoughtsPanel } from "../thoughts/thoughts-panel.tsx";
import { KeyMomentsReel } from "../timeline/key-moments-reel.tsx";
import { TimelineBar } from "../timeline/timeline-bar.tsx";
import { Button, buttonVariants } from "../ui/button.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { MomentAnnouncer } from "./announcer.tsx";

// The match view (phase-3 design §4.2.2): the story strip on top, then
// - desktop (≥ 1280 px), three columns: leaderboard and blocs | map and timeline | Feed, Thoughts,
//   Players;
// - tablet (≥ 768 px): map and timeline beside the leaderboard and blocs, the tabs below;
// - phone: the map, then tabs (Board, Feed, Thoughts, Players), the timeline pinned at the bottom.
// One layout is mounted at a time. The panels belong to the view components (`map/`, `timeline/`,
// `board/`, `story/`, `feed/`, `thoughts/`, `players/`), which read the stores themselves.

export interface MatchPageProps {
  readonly id: string;
  readonly pair: readonly [PlayerId, PlayerId] | null;
  readonly reel: boolean;
  readonly start: boolean;
}

/** A column that scrolls on its own (desktop and tablet). */
function Scroller({
  children,
  label,
  className,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:thin]",
        className,
      )}
    >
      {children}
    </section>
  );
}

function Panel({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <Scroller label={label} className="flex-1 p-3">
      {children}
    </Scroller>
  );
}

function SideTabs() {
  const tab = useUi((s) => s.sideTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        if (isSideTab(v)) uiActions.setSideTab(v);
      }}
      className="bg-card min-h-0 flex-1 gap-0 rounded-xl border"
    >
      <TabsList className="m-2 w-[calc(100%-1rem)]">
        <TabsTrigger value="feed">Feed</TabsTrigger>
        <TabsTrigger value="thoughts">Thoughts</TabsTrigger>
        <TabsTrigger value="players">Players</TabsTrigger>
      </TabsList>
      <TabsContent value="feed" className="flex min-h-0 flex-col">
        <Panel label="Feed">
          <FeedPanel />
        </Panel>
      </TabsContent>
      <TabsContent value="thoughts" className="flex min-h-0 flex-col">
        <Panel label="Thoughts">
          <ThoughtsPanel />
        </Panel>
      </TabsContent>
      <TabsContent value="players" className="flex min-h-0 flex-col">
        <Panel label="Players">
          <PlayersPanel />
        </Panel>
      </TabsContent>
    </Tabs>
  );
}

function MapBox({ className }: { readonly className?: string }) {
  const known = useMatch((s) => s.known);
  const waiting = useMatch((s) => s.waiting);
  return (
    <div className={cn("relative", className)}>
      <MatchMap />
      {known ? null : (
        <div className="bg-popover/90 absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1 text-xs">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading this
          part of the match…
        </div>
      )}
      {waiting ? (
        <div className="bg-popover/90 absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1 text-xs">
          <Hourglass className="size-3" aria-hidden="true" /> Waiting for the server…
        </div>
      ) : null}
    </div>
  );
}

function DesktopLayout() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)_minmax(20rem,26rem)] gap-3 px-3 pb-3">
      <Scroller label="Leaderboard and blocs" className="flex flex-col gap-3">
        <Leaderboard />
        <BlocProgress />
      </Scroller>
      <div className="flex min-h-0 flex-col gap-3">
        <MapBox className="min-h-0 flex-1" />
        <TimelineBar />
      </div>
      <div className="flex min-h-0 flex-col">
        <SideTabs />
      </div>
    </div>
  );
}

function TabletLayout() {
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] gap-3">
        <div className="flex flex-col gap-3">
          <MapBox className="aspect-square max-h-[calc(100dvh-11rem)] w-full" />
          <TimelineBar />
        </div>
        <div className="flex flex-col gap-3">
          <Leaderboard />
          <BlocProgress />
        </div>
      </div>
      <div className="flex h-[36rem] flex-col">
        <SideTabs />
      </div>
    </div>
  );
}

function PhoneLayout() {
  const tab = useUi((s) => s.phoneTab);
  return (
    <div className="flex flex-col gap-3 px-3 pb-28">
      <MapBox className="aspect-square w-full" />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (isPhoneTab(v)) uiActions.setPhoneTab(v);
        }}
        className="gap-3"
      >
        <TabsList className="w-full">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="feed">Feed</TabsTrigger>
          <TabsTrigger value="thoughts">Thoughts</TabsTrigger>
          <TabsTrigger value="players">Players</TabsTrigger>
        </TabsList>
        <TabsContent value="board" className="flex flex-col gap-3">
          <Leaderboard />
          <BlocProgress />
        </TabsContent>
        <TabsContent value="feed">
          <FeedPanel />
        </TabsContent>
        <TabsContent value="thoughts">
          <ThoughtsPanel />
        </TabsContent>
        <TabsContent value="players">
          <PlayersPanel />
        </TabsContent>
      </Tabs>
      <div className="bg-background/90 fixed inset-x-0 bottom-0 z-30 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-sm">
        <TimelineBar />
      </div>
    </div>
  );
}

function Header() {
  const meta = useMatch((s) => s.meta);
  const status = useMatch((s) => s.status);
  const mode = useMatch((s) => s.mode);
  const fake = meta?.seats.some((s) => isFakeSeat(s)) ?? false;
  const lockstepLive = meta?.clock.kind === "lockstep" && mode === "live";
  return (
    <header className="flex min-w-0 items-center gap-2 px-3 py-2">
      <AppLink
        href="/"
        aria-label="All matches"
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <ArrowLeft />
      </AppLink>
      <h1 className="min-w-0 truncate font-serif text-lg sm:text-xl">
        <bdi>{meta?.title ?? "Loading…"}</bdi>
      </h1>
      {status === null ? null : <StatusBadge status={status} />}
      {fake ? <FakeBadge /> : null}
      {lockstepLive ? (
        <span className="text-muted-foreground hidden text-xs lg:inline">
          Game time stands still while the agents think.
        </span>
      ) : null}
      <span className="text-muted-foreground ml-auto hidden font-mono text-xs md:inline">
        {meta?.ruleset}
      </span>
      <Button variant="ghost" size="sm" onClick={() => uiActions.openHowToWatch()}>
        <CircleHelp aria-hidden="true" /> <span className="hidden sm:inline">How to watch</span>
      </Button>
    </header>
  );
}

function Banner() {
  const status = useMatch((s) => s.status);
  const verified = useMatch((s) => s.meta?.verified ?? null);
  if (status !== "unverifiable" && verified?.ok !== false) return null;
  return (
    <div
      role="note"
      className="border-destructive/50 bg-destructive/10 mx-3 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <TriangleAlert className="text-destructive size-4 shrink-0" aria-hidden="true" />
      This match's log does not verify: what is shown stops where the replay diverged.
    </div>
  );
}

function ErrorView() {
  const error = useMatch((s) => s.error);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="font-serif text-2xl">This match cannot be shown</h1>
      <p className="text-sm">{error?.message ?? "Something went wrong."}</p>
      {error === null ? null : <p className="text-muted-foreground text-sm">{error.hint}</p>}
      <AppLink href="/" className={buttonVariants({ variant: "secondary" })}>
        All matches
      </AppLink>
    </main>
  );
}

function LoadingView() {
  return (
    <div className="flex flex-col gap-3 px-3 pb-3" aria-busy="true">
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="grid gap-3 xl:grid-cols-[20rem_1fr_26rem]">
        <Skeleton className="hidden h-96 rounded-xl xl:block" />
        <Skeleton className="aspect-square w-full rounded-xl xl:aspect-auto xl:h-[70dvh]" />
        <Skeleton className="hidden h-96 rounded-xl xl:block" />
      </div>
    </div>
  );
}

export function MatchPage({ id, pair, reel, start }: MatchPageProps) {
  const layout = useLayout();
  const phase = useMatch((s) => s.phase);
  const hasFrame = useMatch((s) => s.frame !== null);
  const title = useMatch((s) => s.meta?.title ?? null);
  const seen = useUi((s) => s.onboardingSeen);
  const howOpen = useUi((s) => s.howToWatchOpen);

  useEffect(() => {
    uiActions.resetForMatch();
    openMatch(id, { start });
    return () => closeMatch();
  }, [id, start]);

  useEffect(() => {
    uiActions.syncPair(pair);
  }, [pair]);

  useEffect(() => {
    if (phase === "ready" && !seen) uiActions.openHowToWatch();
  }, [phase, seen]);

  useEffect(() => {
    if (reel && phase === "ready" && !howOpen && seen) uiActions.startReel();
  }, [reel, phase, howOpen, seen]);

  useEffect(() => {
    document.title = title === null ? "Perfidia" : `${title} · Perfidia`;
  }, [title]);

  if (phase === "error") return <ErrorView />;
  return (
    <div className={layout === "desktop" ? "flex h-dvh flex-col" : "flex min-h-dvh flex-col"}>
      <Header />
      <Banner />
      {!hasFrame ? (
        <LoadingView />
      ) : (
        <>
          <div className="px-3 pb-3">
            <StoryStrip />
          </div>
          {layout === "desktop" ? (
            <DesktopLayout />
          ) : layout === "tablet" ? (
            <TabletLayout />
          ) : (
            <PhoneLayout />
          )}
        </>
      )}
      <PlayerSheet />
      <HowToWatch />
      <KeyMomentsReel />
      <MomentAnnouncer />
    </div>
  );
}
