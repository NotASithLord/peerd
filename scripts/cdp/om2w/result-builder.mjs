// scripts/cdp/om2w/result-builder.mjs — build + validate an Online-Mind2Web
// schema-v2 result.json (the offline artifact WebJudge scores).
//
// Ground truth: OSU-NLP-Group/Online-Mind2Web data/schema_v2/README.md and the
// reference submission data/example/example_v2/1b86…/result.json. Per task the
// judge reads `<task_id>/result.json` + `trajectory/<zero-padded>.{png,jpg}`:
//   result.json: schema_version "online-mind2web-v2", task_id, reference_length
//   (the HUMAN reference step count from the dataset, not ours), agent_final_answer,
//   action_history[] of { step (== index), action, screenshot, thought (key
//   required, null ok), url (recommended), action_status (optional, must agree
//   with the action string's " | SUCCESS/FAILED" suffix) }. Final step must be
//   "TASK_COMPLETE -> ANSWER: …" matching agent_final_answer modulo whitespace.
// Pure (values in, values out) — bun-tested; the run-om2w driver does the IO.

import { taskComplete } from '../../../extension/eval/om2w-actions.js';

/** Zero-padded screenshot basename for a step. */
export const shotName = (step, ext = 'jpg') => `${String(step).padStart(4, '0')}.${ext}`;

/**
 * Assemble the result.json object for one task.
 * @param {{ task_id: string, task_description: string, reference_length: number }} task
 * @param {Array<{ action: string, url?: string | null, status?: 'SUCCESS' | 'FAILED' | null, screenshotExt?: string }>} actions
 *   the recorded page actions IN ORDER (step 0 = the initial navigation), each
 *   with the screenshot extension it was saved under (default jpg)
 * @param {string | null} finalAnswer  the agent's final answer text
 * @param {{ finalScreenshotExt?: string }} [opts]
 */
export const buildResult = (task, actions, finalAnswer, { finalScreenshotExt = 'jpg' } = {}) => {
  const answer = (finalAnswer ?? '').trim();
  const history = actions.map((a, i) => ({
    step: i,
    screenshot: shotName(i, a.screenshotExt ?? 'jpg'),
    url: a.url ?? null,
    action: a.action,
    action_status: a.status ?? null,
    thought: null,
  }));
  history.push({
    step: history.length,
    screenshot: shotName(history.length, finalScreenshotExt),
    url: actions.length ? (actions[actions.length - 1].url ?? null) : null,
    action: taskComplete(answer || '(no final answer)'),
    action_status: null,
    thought: null,
  });
  return {
    schema_version: 'online-mind2web-v2',
    task: task.task_description,
    task_id: task.task_id,
    agent_final_answer: answer || null,
    reference_length: task.reference_length,
    action_history: history,
  };
};

const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;
const SHOT_RE = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i;

/**
 * Validate a result object against the v2 rules we know (schema README +
 * reference example). Returns a list of problems — empty means valid. Pure.
 * @param {any} r
 * @returns {string[]}
 */
export const validateResult = (r) => {
  const errs = [];
  if (r?.schema_version !== 'online-mind2web-v2') errs.push('schema_version must be "online-mind2web-v2"');
  if (typeof r?.task_id !== 'string' || !TASK_ID_RE.test(r.task_id)) errs.push('task_id must match ^[A-Za-z0-9_-]+$');
  if (!Number.isInteger(r?.reference_length)) errs.push('reference_length must be an integer');
  if (!(typeof r?.agent_final_answer === 'string' || r?.agent_final_answer === null)) errs.push('agent_final_answer must be string|null');
  if (!Array.isArray(r?.action_history) || r.action_history.length === 0) { errs.push('action_history must be a non-empty array'); return errs; }
  r.action_history.forEach((s, i) => {
    if (s.step !== i) errs.push(`step ${i}: step field (${s.step}) must equal its index`);
    if (typeof s.action !== 'string' || !s.action) errs.push(`step ${i}: action must be a non-empty string`);
    if (typeof s.screenshot !== 'string' || !SHOT_RE.test(s.screenshot)) errs.push(`step ${i}: screenshot must be a plain image filename`);
    if (!('thought' in s)) errs.push(`step ${i}: thought key is required (null ok)`);
    if (s.action_status != null && !['SUCCESS', 'FAILED'].includes(s.action_status)) errs.push(`step ${i}: action_status must be SUCCESS|FAILED|null`);
    const suffix = /\|\s*(SUCCESS|FAILED)\s*$/.exec(s.action || '');
    if (suffix && s.action_status !== suffix[1]) errs.push(`step ${i}: action suffix ${suffix[1]} disagrees with action_status ${s.action_status}`);
    if (!suffix && (s.action_status === 'SUCCESS' || s.action_status === 'FAILED')) errs.push(`step ${i}: action_status set but action lacks the | suffix`);
  });
  const last = r.action_history[r.action_history.length - 1];
  if (!/^TASK_COMPLETE -> ANSWER: /.test(last.action)) errs.push('final step must begin "TASK_COMPLETE -> ANSWER: "');
  else if (typeof r.agent_final_answer === 'string') {
    const norm = (x) => x.replace(/\s+/g, ' ').trim();
    if (norm(last.action.slice('TASK_COMPLETE -> ANSWER: '.length)) !== norm(r.agent_final_answer)) {
      errs.push('TASK_COMPLETE answer must match agent_final_answer (modulo whitespace)');
    }
  }
  return errs;
};
