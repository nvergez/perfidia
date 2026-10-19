# `src/ui`: shadcn/ui components, copied by hand

These are the [shadcn/ui](https://ui.shadcn.com) "new-york" (v4, Tailwind 4) components the
spectator uses: button, badge, card, tabs, sheet, dialog, skeleton. (Tooltip, hover-card and
popover are not used: `players/hover-panel.tsx` and `map/city-popover.tsx` position their own
panels, since Radix's positioning library, floating-ui, costs about 10 KB gzipped of the 200 KB
budget. Unused copies were removed.) They are copied by hand rather than with the `shadcn`
CLI, which would pull a second TypeScript compiler (through `ts-morph`) and Zod 3 (phase-3 design
§1.3, §5.4). Changes from upstream: primitives are imported from the `radix-ui` package, `cn()` from
`../lib/cn.ts` with relative `.ts`/`.tsx` imports, and the few props passed as `undefined` are
spread conditionally so the components type-check under `exactOptionalPropertyTypes`. `select` is
left out: a native `<select>` avoids `@radix-ui/react-select` and its `.d.ts` that fails TS2320.

Theme tokens (colors, radius) live in `../app.css` ("Aegean night", dark only).

## License

shadcn/ui is distributed under the MIT License:

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
