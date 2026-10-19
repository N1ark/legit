<script lang="ts">
  // legit's settings: which files diffs collapse, which tree-sitter grammar highlights which
  // files, and how diffs show lines. Each list has a part for this repo and one for all repos; a change is saved
  // as you type (shortly after), and the open diff is shown again with it. Plus the shortcuts, and the logs.
  import { Button, IconButton, Kbd, Modal, Segmented, SettingGroup, SettingRow, SettingsLayout, ShortcutList, toast, tooltip, type HelpGroup } from 'purr';
  import { ArrowsInLineVertical, Columns, Keyboard, Palette, Plus, Scroll, Warning, X } from 'purr/icons';
  import LogsPane from './LogsPane.svelte';
  import type { Scope, ScopeSettings, SettingsInfo, Wrap } from '../shared/types.ts';
  import { app, request } from './lib/app.svelte.ts';

  let {
    onclose,
    shortcuts,
    section = $bindable('syntax'),
  }: { onclose: () => void; shortcuts: readonly HelpGroup[]; section?: string } = $props();

  let info = $state.raw<SettingsInfo | null>(null);
  /** What's being edited, empty rows included (they're left out when saving). */
  let draft = $state<Record<Scope, ScopeSettings> | null>(null);

  async function load(first = false) {
    try {
      const i = await request<SettingsInfo>('/api/settings');
      info = i;
      if (first) {
        draft = { repo: i.repo, global: i.global };
        guides = { repo: columnsText(i.repo.guides), global: columnsText(i.global.guides) };
      }
    } catch (e) {
      toast.error(e);
      if (first) onclose();
    }
  }
  load(true);

  // Guide columns as typed: "80, 120"; empty is unset (as for all repos), "none" is none.
  let guides = $state<Record<Scope, string>>({ repo: '', global: '' });
  const columnsText = (c: number[] | undefined) => (c === undefined ? '' : c.length ? c.join(', ') : 'none');

  function setGuides(scope: Scope) {
    const text = guides[scope].trim();
    if (!text) delete draft![scope].guides;
    else draft![scope].guides = /^none$/i.test(text) ? [] : text.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    changed(scope);
  }

  const WRAPS: { id: Wrap; label: string }[] = [
    { id: 'none', label: 'No wrap' },
    { id: 'window', label: 'To the window' },
    { id: 'column', label: 'At a column' },
  ];
  const wrapOptions = (scope: Scope) => (scope === 'repo' ? [{ id: 'inherit' as const, label: 'As for all repos' }, ...WRAPS] : WRAPS);

  function setWrap(scope: Scope, w: Wrap | 'inherit') {
    if (w === 'inherit') delete draft![scope].wrap;
    else draft![scope].wrap = w;
    changed(scope);
  }

  function setWrapColumn(scope: Scope, value: string) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) draft![scope].wrapColumn = n;
    else delete draft![scope].wrapColumn;
    changed(scope);
  }

  const timers: Partial<Record<Scope, ReturnType<typeof setTimeout>>> = {};

  function changed(scope: Scope) {
    clearTimeout(timers[scope]);
    timers[scope] = setTimeout(() => save(scope), 500);
  }

  async function save(scope: Scope) {
    delete timers[scope];
    if (!draft) return;
    try {
      await request('/api/saveSettings', { scope, settings: $state.snapshot(draft[scope]) });
      app.settingsChanged();
      await load();
    } catch (e) {
      toast.error(e);
    }
  }

  function close() {
    for (const scope of Object.keys(timers) as Scope[]) {
      clearTimeout(timers[scope]);
      save(scope);
    }
    onclose();
  }

  const SCOPES: { scope: Scope; title: string; description: () => string }[] = [
    { scope: 'repo', title: 'This repo', description: () => `Only in ${app.repo?.name ?? 'this repo'}; overrides all repos` },
    { scope: 'global', title: 'All repos', description: () => 'Every repo legit opens' },
  ];

  const groups = [
    {
      sections: [
        { id: 'syntax', label: 'Syntax highlighting', icon: Palette },
        { id: 'collapse', label: 'Collapsed files', icon: ArrowsInLineVertical },
        { id: 'lines', label: 'Lines', icon: Columns },
      ],
    },
    {
      sections: [
        { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
        { id: 'logs', label: 'Logs', icon: Scroll },
      ],
    },
  ];
</script>

<Modal label="Settings" title="Settings" onclose={close} width="860px" height="min(640px, 85vh)">
  {#if draft && info}
    <SettingsLayout {groups} bind:current={section} navWidth="190px">
      {#if section === 'syntax'}
        <datalist id="zed-grammars">
          {#each info.grammars as g (g.grammar + g.language)}
            <option value={g.grammar}>{g.language}{g.suffixes.length ? ` (.${g.suffixes.join(', .')})` : ''}</option>
          {/each}
        </datalist>
        {#each SCOPES as { scope, title, description } (scope)}
          <SettingGroup {title} description={description()}>
            <div class="rules">
              {#each draft[scope].syntax as rule, k (k)}
                {@const problem = rule.grammar.trim() ? info.problems[rule.grammar.trim()] : undefined}
                <div class="rule">
                  <input
                    class="field-input mono"
                    aria-label="Files"
                    placeholder="*.out"
                    spellcheck="false"
                    bind:value={rule.pattern}
                    oninput={() => changed(scope)}
                  />
                  <span class="muted arrow">→</span>
                  <input
                    class="field-input mono"
                    aria-label="Grammar"
                    placeholder="Zed grammar, or a folder"
                    list="zed-grammars"
                    spellcheck="false"
                    bind:value={rule.grammar}
                    oninput={() => changed(scope)}
                  />
                  <span class="problem" class:on={problem} use:tooltip={problem}>{#if problem}<Warning weight="bold" />{/if}</span>
                  <IconButton
                    label="Remove rule"
                    size="sm"
                    danger
                    onclick={() => {
                      draft![scope].syntax.splice(k, 1);
                      changed(scope);
                    }}><X /></IconButton
                  >
                </div>
              {/each}
              <span class="add">
                <Button size="sm" variant="ghost" onclick={() => draft![scope].syntax.push({ pattern: '', grammar: '' })}>
                  <Plus /> Add rule
                </Button>
              </span>
            </div>
          </SettingGroup>
        {/each}
        <p class="note muted">
          A grammar is one in Zed's installed extensions, or a folder (relative to the repo) with a compiled grammar
          (<code>*.wasm</code>, from <code>tree-sitter build --wasm</code>) and its <code>highlights.scm</code>. Patterns
          without a slash match file names at any depth; the last matching rule wins.
        </p>
      {:else if section === 'lines'}
        {#each SCOPES as { scope, title, description } (scope)}
          <SettingGroup {title} description={description()}>
            <SettingRow label="Long lines" sub="Scroll sideways, or wrap them" stack>
              <Segmented
                label="Long lines"
                size="sm"
                options={wrapOptions(scope)}
                value={draft[scope].wrap ?? (scope === 'repo' ? 'inherit' : 'none')}
                onchange={(w) => setWrap(scope, w)}
              />
            </SettingRow>
            <SettingRow label="Wrap column" sub="Where “At a column” wraps (or the window, if narrower)" for="column-{scope}">
              <input
                class="field-input mono narrow"
                id="column-{scope}"
                type="number"
                min="1"
                placeholder={scope === 'repo' ? 'As for all repos' : '100'}
                value={draft[scope].wrapColumn ?? ''}
                oninput={(e) => setWrapColumn(scope, e.currentTarget.value)}
              />
            </SettingRow>
            <SettingRow label="Guides" sub="Vertical lines at these columns, e.g. 80, 100" for="guides-{scope}">
              <input
                class="field-input mono narrow"
                id="guides-{scope}"
                placeholder={scope === 'repo' ? 'As for all repos' : 'None'}
                spellcheck="false"
                bind:value={guides[scope]}
                oninput={() => setGuides(scope)}
              />
            </SettingRow>
          </SettingGroup>
        {/each}
        <p class="note muted"><code>none</code> turns a setting off for this repo.</p>
      {:else if section === 'shortcuts'}
        <p class="note muted lead"><Kbd hint="?" /> shows these anywhere.</p>
        <ShortcutList groups={shortcuts} />
      {:else if section === 'logs'}
        <LogsPane />
      {:else}
        {#each SCOPES as { scope, title, description } (scope)}
          <SettingGroup {title} description={description()}>
            <div class="rules">
              {#each draft[scope].collapse as _, k (k)}
                <div class="rule">
                  <input
                    class="field-input mono"
                    aria-label="Files"
                    placeholder="docs/*.html"
                    spellcheck="false"
                    bind:value={draft[scope].collapse[k]}
                    oninput={() => changed(scope)}
                  />
                  <IconButton
                    label="Remove pattern"
                    size="sm"
                    danger
                    onclick={() => {
                      draft![scope].collapse.splice(k, 1);
                      changed(scope);
                    }}><X /></IconButton
                  >
                </div>
              {/each}
              <span class="add">
                <Button size="sm" variant="ghost" onclick={() => draft![scope].collapse.push('')}><Plus /> Add pattern</Button>
              </span>
            </div>
          </SettingGroup>
        {/each}
        <p class="note muted">
          On top of the built-in ones: lockfiles, minified bundles, source maps, snapshots, protobuf output and anything
          <code>linguist-generated</code> in <code>.gitattributes</code>. Patterns without a slash match file names at any depth.
        </p>
      {/if}
      {#if section !== 'shortcuts' && section !== 'logs'}
        <p class="note muted files">
          Saved in <code>{info.files.repo}</code> (this repo) and <code>{info.files.global}</code> (all repos).
        </p>
      {/if}
    </SettingsLayout>
  {/if}
</Modal>

<style>
  .rules {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2) 0;
  }

  .rule {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .rule input {
    flex: 1;
    min-width: 0;
  }

  .arrow {
    flex: none;
  }

  .narrow {
    width: 200px;
  }

  .problem {
    display: inline-flex;
    flex: none;
    width: 16px;
    color: var(--warn);
  }

  .add {
    align-self: flex-start;
  }

  .note {
    margin: var(--sp-4) 0 0;
    font-size: var(--fs-xs);
    line-height: 1.5;
  }

  .files {
    margin-top: var(--sp-3);
  }

  .lead {
    margin: 0 0 var(--sp-4);
  }
</style>
