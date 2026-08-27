// @ts-check

/** @typedef {[string, string, string, Record<string, string>, Record<string, string | boolean>?]} ToolPolicyRow */
/** @type {ReadonlyArray<ToolPolicyRow>} */
const TOOL_POLICY_ROWS = Object.freeze([
  ["inspect","inspect","read",{"kind":"none"}],
  ["actor_list","spawned","read",{"kind":"none"}],
  ["open_tab","tab","mutate_external",{"kind":"url-field","field":"url","mode":"display"}],
  ["read_page","tab","read",{"kind":"active-tab"}],
  ["snapshot","tab","read",{"kind":"active-tab"}],
  ["read_state","tab","read",{"kind":"active-tab"}],
  ["watch_changes","tab","read",{"kind":"active-tab"}],
  ["query_dom","tab","read",{"kind":"active-tab"}],
  ["page_eval","tab","write",{"kind":"active-tab"}],
  ["page_exec","tab","write",{"kind":"active-tab"}],
  ["page_keys","tab","write",{"kind":"active-tab"}],
  ["navigate","tab","write",{"kind":"active-plus-url","field":"url","mode":"display"}],
  ["type","tab","write",{"kind":"active-tab"}],
  ["click","tab","write",{"kind":"active-tab"}],
  ["login","tab","write",{"kind":"active-tab"}],
  ["read_doc","web","read",{"kind":"url-or-active","field":"url","mode":"display"}],
  ["fetch_url","web","read",{"kind":"url-field","field":"url","mode":"display"}],
  ["page_code","web","write",{"kind":"none"}],
  ["read_web_cache","web","read",{"kind":"none"}],
  ["site_client_run","web","read",{"kind":"site-origin-field","field":"origin"}],
  ["site_client_read","web","read",{"kind":"site-origin-field","field":"origin"}],
  ["site_client_write","web","write",{"kind":"site-origin-field","field":"origin"}],
  ["site_capture","web","read",{"kind":"none"}],
  ["sandbox_create","engine","write",{"kind":"url-field","field":"gitUrl","mode":"standard"}],
  ["vm_boot","webvm","write",{"kind":"none"}],
  ["vm_import","webvm","write",{"kind":"url-field","field":"url","mode":"standard"}],
  ["vm_write_file","webvm","write",{"kind":"none"}],
  ["vm_delete","webvm","destructive",{"kind":"none"}],
  ["js_notebook","notebook","write",{"kind":"none"}],
  ["script","notebook","write",{"kind":"none"}],
  ["read_run_cache","notebook","read",{"kind":"none"}],
  ["js_write_file","notebook","write",{"kind":"none"}],
  ["js_read_file","notebook","read",{"kind":"none"}],
  ["js_delete","notebook","destructive",{"kind":"none"}],
  ["pod_exec","pod","write",{"kind":"https-command","field":"command"},{"retryClass":"E"}],
  ["pod_status","pod","read",{"kind":"none"}],
  ["pod_cancel","pod","write",{"kind":"none"}],
  ["pod_read","pod","read",{"kind":"none"}],
  ["pod_write","pod","write",{"kind":"none"}],
  ["pod_destroy","pod","destructive",{"kind":"none"}],
  ["app_update","app","write",{"kind":"none"}],
  ["app_open","app","write",{"kind":"none"}],
  ["app_search","app","read",{"kind":"none"}],
  ["app_delete","app","destructive",{"kind":"none"}],
  ["app_write_file","app","write",{"kind":"none"}],
  ["app_read_file","app","read",{"kind":"none"}],
  ["app_list_files","app","read",{"kind":"none"}],
  ["app_delete_file","app","destructive",{"kind":"none"}],
  ["app_code","app","write",{"kind":"none"}],
  ["app_observe","app","read",{"kind":"none"}],
  ["app_act","app","write",{"kind":"none"}],
  ["repo_history","engine","read",{"kind":"none"}],
  ["repo_version","engine","write",{"kind":"none"}],
  ["repo_remote","engine","write",{"kind":"url-field","field":"url","mode":"standard"}],
  ["edit_file","app","write",{"kind":"none"}],
  ["toolbox_write","notebook","write",{"kind":"none"}],
  ["toolbox_list","notebook","read",{"kind":"none"}],
  ["toolbox_delete","notebook","destructive",{"kind":"none"}],
  ["actor_create","spawned","write",{"kind":"none"}],
  ["actor_tasks","spawned","read",{"kind":"none"}],
  ["actor_cancel","spawned","write",{"kind":"none"}],
  ["message_actor","spawned","write",{"kind":"none"}],
  ["read_memory","memory","read",{"kind":"none"}],
  ["remember","memory","write",{"kind":"none"}],
  ["complete_goal","goal","read",{"kind":"none"}],
  ["schedule_create","schedule","write",{"kind":"none"}],
  ["schedule_list","schedule","read",{"kind":"none"}],
  ["schedule_cancel","schedule","write",{"kind":"none"}],
  ["todo_init","goal","read",{"kind":"none"}],
  ["todo_check","goal","read",{"kind":"none"}],
  ["todo_add","goal","read",{"kind":"none"}],
  ["dweb_discover","dweb","read",{"kind":"none"},{"dweb":true}],
  ["dweb_share","dweb","mutate_external",{"kind":"none"},{"dweb":true}],
  ["dweb_install","dweb","mutate_external",{"kind":"none"},{"dweb":true}],
  ["dweb_peers","dweb","read",{"kind":"none"},{"dweb":true}],
  ["dweb_block","dweb","write",{"kind":"none"},{"dweb":true}],
  ["dweb_discovery","dweb","write",{"kind":"none"},{"dweb":true}],
  ["dweb_guide","dweb","read",{"kind":"none"},{"dweb":true}],
  ["a2a_run","dweb","write",{"kind":"none"},{"dweb":true}],
  ["now","time","read",{"kind":"none"}],
  ["wait_until","time","write",{"kind":"none"}],
  ["capture","tab","read",{"kind":"active-tab"}],
  ["view","tab","read",{"kind":"active-tab"}],
  ["load_skill","inspect","read",{"kind":"none"}],
]);

/** @template T @param {T} value @returns {T} */
const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

export const TOOL_POLICY_ORDER = Object.freeze(TOOL_POLICY_ROWS.map(([name]) => name));

export const TOOL_POLICY_RECORDS = Object.fromEntries(TOOL_POLICY_ROWS.map((row) => {
  const [name, primitive, sideEffect, originRule, extras = {}] = row;
  return [name, { name, primitive, sideEffect, originRule, ...extras }];
}));

deepFreeze(TOOL_POLICY_RECORDS);

/** @param {string} name */
export const getToolPolicy = (name) => /** @type {Record<string, any>} */ (
  TOOL_POLICY_RECORDS
)[name];

export const listToolPolicies = () => TOOL_POLICY_ORDER.map((name) => {
  const policy = getToolPolicy(name);
  if (!policy) throw new Error(`tool policy missing: ${name}`);
  return policy;
});
