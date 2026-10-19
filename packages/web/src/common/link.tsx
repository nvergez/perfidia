import type * as React from "react";
import { navigate } from "../lib/router.ts";

// An in-app link: a real `<a href>` (open in a new tab, copy the link) that navigates without a
// page load on a plain left click.

export function AppLink({
  href,
  onClick,
  children,
  ...props
}: React.ComponentProps<"a"> & { readonly href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        e.preventDefault();
        navigate(href);
        window.scrollTo(0, 0);
      }}
      {...props}
    >
      {children}
    </a>
  );
}
