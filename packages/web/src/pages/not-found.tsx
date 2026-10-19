import { AppLink } from "../common/link.tsx";
import { buttonVariants } from "../ui/button.tsx";

export function NotFoundPage({ path }: { readonly path: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-serif text-3xl">Nothing here</h1>
      <p className="text-muted-foreground text-sm break-all">No page at {path}.</p>
      <AppLink href="/" className={buttonVariants({ variant: "secondary" })}>
        All matches
      </AppLink>
    </main>
  );
}
