// @perfidia/spectator/annotations: the pure fold of the side files (`llm_calls.jsonl`,
// `replies.jsonl`) into per-turn annotations: reasoning, text, tool calls, costs (phase-3 design
// §2.7). Never part of the steps.

export {
  DEFAULT_POLICY,
  createAnnotationFold,
  type AnnotationFold,
  type AnnotationPolicy,
  type Handoff,
} from "./annotations.ts";
