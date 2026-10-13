<script lang="ts">
  // legit's settings: which files diffs collapse, which tree-sitter grammar highlights which
  // files, and how diffs show lines. Each list has a part for this repo and one for all repos; a change is saved
  // as you type (shortly after), and the open diff is shown again with it.
  import { Button, IconButton, Modal, SettingGroup, SettingRow, SettingsLayout, toast } from 'purr';
  import { ArrowsInLineVertical, Columns, Palette, Plus, Warning, X } from 'purr/icons';
  import type { Scope, ScopeSettings, SettingsInfo } from '../shared/types.ts';
  import { app, request } from './lib/app.svelte.ts';

  let { onclose }: { onclose: () => void } = $props();

  let section = $state('syntax');
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
    { scope: 'repo', title: 'This repo', description: () => `Only in ${app.repo?.name ?? 'this repo'}; these win over the ones for all repos.` },
    { scope: 'global', title: 'All repos', description: () => 'In every repo legit opens.' },
  ];

  const groups = [
    {
      sections: [
        { id: 'syntax', label: 'Syntax highlighting', icon: Palette },
        { id: 'collapse', label: 'Collapsed files', icon: ArrowsInLineVertical },
        { id: 'lines', label: 'Lines', icon: Columns },
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
                  <span class="problem" class:on={problem} title={problem}>{#if problem}<Warning weight="bold" />{/if}</span>
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
          Files without a rule are highlighted by their extension. A grammar is the name of one in Zed's installed
          extensions{info.grammars.length ? ` (${info.grammars.map((g) => g.grammar).join(', ')})` : ''}, or a folder with a
          compiled grammar (<code>*.wasm</code>, from <code>tree-sitter build --wasm</code>) and its
          <code>highlights.scm</code>; a relative one is in the repo. Patterns without a slash match the file name at any
          depth; the last matching rule wins.
        </p>
      {:else if section === 'lines'}
        {#each SCOPES as { scope, title, description } (scope)}
          <SettingGroup {title} description={description()}>
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
        <p class="note muted">Leave a field empty for this repo to use the one for all repos; <code>none</code> turns it off here.</p>
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
          Generated files start collapsed in diffs: built in, lockfiles, minified bundles, source maps, snapshots and
          protobuf output, and anything marked <code>linguist-generated</code> in <code>.gitattributes</code>. These add
          to them. Patterns without a slash match the file name at any depth.
        </p>
      {/if}
      <p class="note muted files">
        Saved in <code>{info.files.repo}</code> (this repo) and <code>{info.files.global}</code> (all repos).
      </p>
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
</style>
