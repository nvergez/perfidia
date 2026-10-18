// The playback keyboard shortcuts (phase-3 design §4.3 "Timeline"), pure: Space plays or pauses,
// ← and → go to the previous and next key moment, + and − change the speed. A key typed into a
// text field, pressed on a control that uses it itself (Space on a button, arrows on a slider, a
// tab list or a radio group), inside a dialog, or with Ctrl, Alt or Meta is left alone.

export type KeyCommand = "toggle" | "prev" | "next" | "faster" | "slower";

/** What has the focus, as far as the shortcuts care. */
export type FocusKind =
  /** Typing: input, textarea, select, contenteditable. */
  | "text"
  /** A control activated by Space or Enter: button, link, checkbox, summary. */
  | "control"
  /** A control that uses the arrow keys: slider, tab, radio, menu, listbox. */
  | "arrows"
  /** Inside a dialog or another modal layer. */
  | "dialog"
  | "none";

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export function keyCommand(e: KeyLike, focus: FocusKind): KeyCommand | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (focus === "text" || focus === "dialog") return null;
  switch (e.key) {
    case " ":
    case "Spacebar":
      return focus === "control" || focus === "arrows" ? null : "toggle";
    case "ArrowLeft":
      return focus === "arrows" ? null : "prev";
    case "ArrowRight":
      return focus === "arrows" ? null : "next";
    case "+":
    case "=":
      return "faster";
    case "-":
    case "_":
      return "slower";
    default:
      return null;
  }
}

/** The element-like facts `focusKind` reads (an `Element` has them). */
export interface FocusTarget {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
}

const ARROW_ROLES = new Set([
  "slider",
  "tab",
  "radio",
  "menuitem",
  "menuitemradio",
  "option",
  "spinbutton",
  "listbox",
  "tablist",
  "radiogroup",
]);
const CONTROL_ROLES = new Set(["button", "link", "checkbox", "switch", "menuitemcheckbox"]);

export function focusKind(el: FocusTarget | null): FocusKind {
  if (el === null) return "none";
  if (el.closest('[role="dialog"],[role="alertdialog"]') !== null) return "dialog";
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "range") return "arrows";
    if (type === "checkbox" || type === "radio" || type === "button" || type === "submit") {
      return type === "radio" ? "arrows" : "control";
    }
    return "text";
  }
  if (tag === "textarea" || tag === "select" || el.isContentEditable === true) return "text";
  const role = el.getAttribute("role");
  if (role !== null && ARROW_ROLES.has(role)) return "arrows";
  if (tag === "button" || tag === "a" || tag === "summary") return "control";
  if (role !== null && CONTROL_ROLES.has(role)) return "control";
  if (el.closest('[role="tablist"],[role="radiogroup"],[role="toolbar"]') !== null) return "arrows";
  return "none";
}
