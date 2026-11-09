// Lean 4, which Prism has no grammar for: registered on the global Prism, as its own components are.

const Prism = (globalThis as any).Prism;

/** Characters an identifier can go on with (Lean allows primes, subscripts, `!` and `?` at the end). */
const ID = String.raw`[\p{L}\p{N}_'!?₀-₉ₐ-ₜᵢ-ᵪ]`;

const DECLS = 'def|theorem|lemma|abbrev|instance|example|structure|class|inductive|axiom|opaque|macro|syntax|elab';

Prism.languages.lean = {
  comment: [
    { pattern: /\/--[\s\S]*?-\//, greedy: true, alias: 'doc-comment' },
    { pattern: /\/-[\s\S]*?-\//, greedy: true },
    { pattern: /--.*/, greedy: true },
  ],
  string: { pattern: /(?:\b[smf]!)?"(?:\\[\s\S]|[^\\"])*"/, greedy: true },
  char: { pattern: new RegExp(String.raw`(^|[^\p{L}\p{N}_'.])'(?:\\.|[^\\'\n])'`, 'u'), lookbehind: true, greedy: true },
  attribute: { pattern: /@\[[^\]\n]*\]/, alias: 'annotation' },
  function: {
    pattern: new RegExp(String.raw`(\b(?:${DECLS})\s+)(?:«[^»\n]*»|${ID}|\.)+`, 'u'),
    lookbehind: true,
  },
  keyword:
    /\b(?:abbrev|at|attribute|axiom|by|calc|catch|class|decreasing_by|deriving|do|elab|else|end|example|export|extends|finally|for|from|fun|have|if|import|in|inductive|infix|infixl|infixr|instance|lemma|let|local|macro|macro_rules|match|mut|mutual|namespace|noncomputable|notation|opaque|open|partial|postfix|prefix|private|protected|return|scoped|section|set_option|show|structure|suffices|syntax|termination_by|then|theorem|try|universe|unless|unsafe|variable|where|with|def)\b|λ/,
  builtin: /\b(?:Type|Prop|Sort|sorry|rfl)\b/,
  boolean: /\b(?:true|false|True|False)\b/,
  number: /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/,
  operator: /:=|<;>|<\|>|<\||\|>|->|<-|=>|[←→↔∀∃⟹∘≠≤≥∧∨¬×∣⁻¹]|[+\-*/%^<>=!&|$]+/,
  punctuation: /[()[\]{},.:;⟨⟩⦃⦄‹›]/,
};

export {};
