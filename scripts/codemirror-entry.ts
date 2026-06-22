// CodeMirror 6 bundle entry. We re-export just the surface js-tab.js
// uses -- keeps the bundle small and the surface stable.

export { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
export { EditorState, Compartment } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { searchKeymap } from '@codemirror/search';
export {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
export {
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
} from '@codemirror/language';
export { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
export { html, htmlLanguage } from '@codemirror/lang-html';
export { css, cssLanguage } from '@codemirror/lang-css';
export { oneDark } from '@codemirror/theme-one-dark';
