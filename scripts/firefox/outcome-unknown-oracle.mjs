// Pure semantic oracles for Firefox's packaged unknown-outcome test. The
// lifecycle marker is stable; the user-facing explanation is free to change
// wording while preserving the warning and recovery action.

export const hasOutcomeUnknownState = (text) =>
  String(text ?? '').includes('outcome_unknown:');

export const hasAmbiguousOutcomeWarning = (text) =>
  /may have completed|cannot confirm whether[^.]*\b(?:ran|completed)\b|outcome is unknown/i
    .test(String(text ?? ''));

export const advisesCheckingBeforeRetry = (text) => {
  const value = String(text ?? '');
  return /\b(?:check|verify)\b/i.test(value)
    && /\b(?:target|external state|requested action)\b/i.test(value)
    && /\b(?:retry(?:ing)?|repeat(?:ing)?|try(?:ing)?\s+again)\b/i.test(value);
};
