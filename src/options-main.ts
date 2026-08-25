/**
 * Options page entry point (owns this module + options.html only).
 *
 * Simplified owner UI: the visible form is Name + Template text + Tags only.
 * All other preset fields (description, group, icon, snippet, body mode,
 * excerpt, custom template) are preserved through hidden inputs so editing a
 * legacy or imported preset never silently drops its settings. Thin DOM glue
 * over the Phase-2 `preset-store`; business rules live in `options-crud.ts`;
 * all preset content is painted as untrusted text (no innerHTML — XSS-safe).
 */

import {
  createOrUpdatePreset,
  deletePreset,
  exportPresetsToString,
  importPresetsFromString,
  listViewPresets,
  type OptionsPresetView,
  type OptionsRuntime,
} from './options-crud';
import { PRESET_SCHEMA_VERSION, type Preset } from './preset-schema';
import {
  exportPresets,
  importPresetsIntoStore,
  listPresets,
  loadBundledDefaults,
  savePreset,
} from './preset-store';

/* ------------------------------------------------------------------ */
/* Runtime seam                                                        */
/* ------------------------------------------------------------------ */

export function createOptionsRuntime(): OptionsRuntime {
  return {
    loadPresets: () => listPresets(),
    loadBundledDefaults: () => loadBundledDefaults(),
    savePreset: (input: unknown) => savePreset(input),
    importPresetsIntoStore: (serialized: string) => importPresetsIntoStore(serialized),
    exportPresets: (presets: Preset[]) => exportPresets(presets),
  };
}

/* ------------------------------------------------------------------ */
/* View contract (narrowly typed so tests can inject a fake document)  */
/* ------------------------------------------------------------------ */

export interface OptionsView {
  listEl: RenderEl;
  statusEl: RenderEl;
  /** Inputs for the create/edit form. */
  form: {
    id: RenderInput;
    name: RenderInput;
    title: RenderInput;
    description: RenderInput;
    source: RenderInput;
    mode: RenderInput;
    body: RenderInput;
    snippet: RenderInput;
    group: RenderInput;
    icon: RenderInput;
    tags: RenderInput;
    tagMode: RenderInput;
    excerpt: RenderInput;
    excerptMode: RenderInput;
    customTemplate: RenderInput;
    customTemplateMode: RenderInput;
  };
  bodyLabel?: RenderEl;
  bodyHelp?: RenderEl;
  importArea: RenderInput;
  exportArea: RenderInput;
  document: {
    createElement: (tag: string) => RenderEl;
    getElementById: (id: string) => RenderEl | null;
  };
  /** Trigger a file download of the export blob. */
  download: (filename: string, contents: string) => void;
  /** Reset the form to the "new preset" state. */
  resetForm: () => void;
}

export interface RenderEl {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  appendChild(child: RenderEl): void;
  addEventListener(type: string, cb: (ev?: unknown) => void): void;
  classList?: { add(c: string): void; remove(c: string): void };
}

export interface RenderInput extends RenderEl {
  value: string;
  disabled: boolean;
}

/* ------------------------------------------------------------------ */
/* Rendering helpers (untrusted text only)                             */
/* ------------------------------------------------------------------ */

function setText(el: RenderEl, text: string): void {
  el.textContent = text;
}

/** Build one list row for a preset; `onEdit`/`onDelete` are wired by callers. */
export function renderPresetRow(
  view: OptionsPresetView,
  createEl: (tag: string) => RenderEl,
): { row: RenderEl; editBtn: RenderEl; deleteBtn: RenderEl } {
  const row = createEl('li');
  row.setAttribute('data-preset-id', view.id);

  const label = createEl('span');
  const icon = view.icon ? `${view.icon} ` : '';
  const badge = view.seeded ? ' (default)' : '';
  setText(label, `${icon}${view.name}${badge}`);
  row.appendChild(label);

  const meta = createEl('small');
  const tagCount = view.preset.metadata?.tags?.values.length ?? 0;
  setText(meta, tagCount > 0 ? `${tagCount} tag(s)` : '');
  row.appendChild(meta);

  const editBtn = createEl('button');
  editBtn.setAttribute('type', 'button');
  editBtn.setAttribute('data-action', 'edit');
  setText(editBtn, 'Edit');

  const deleteBtn = createEl('button');
  deleteBtn.setAttribute('type', 'button');
  deleteBtn.setAttribute('data-action', 'delete');
  setText(deleteBtn, view.seeded ? 'Revert' : 'Delete');

  row.appendChild(editBtn);
  row.appendChild(deleteBtn);
  return { row, editBtn, deleteBtn };
}

/* ------------------------------------------------------------------ */
/* ID derivation                                                       */
/* ------------------------------------------------------------------ */

/** Derive a slug id from the visible name ("Review checklist" -> "review-checklist"). */
export function deriveIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : `preset-${Date.now()}`;
}

/**
 * Return the next unused preset id when `base` already exists in `existing`,
 * so a newly-created preset never shadows a name already in the list. Appends
 * an increasing numeric suffix (`...-2`, `...-3`, …) and keeps the result
 * within the 64-char id bound by trimming the stem for the suffix.
 */
export function nextAvailablePresetId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    // Reserve room for `-` + the numeric suffix within the 64-char bound.
    const stem = base.slice(0, 64 - suffix.length - 1);
    const candidate = `${stem}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/* ------------------------------------------------------------------ */
/* Controller wiring                                                   */
/* ------------------------------------------------------------------ */

export interface OptionsControllerDeps {
  rt: OptionsRuntime;
  view: OptionsView;
}

export async function refreshList(deps: OptionsControllerDeps): Promise<void> {
  const { rt, view } = deps;
  const presets = await listViewPresets(rt);
  view.listEl.textContent = '';
  if (presets.length === 0) {
    const empty = view.document.createElement('li');
    setText(empty, 'No presets yet. Create one below.');
    view.listEl.appendChild(empty);
    return;
  }
  for (const preset of presets) {
    const { row, editBtn, deleteBtn } = renderPresetRow(preset, view.document.createElement);
    editBtn.addEventListener('click', () => {
      fillFormForEdit(view, preset);
      setStatus(view, `Editing "${preset.name}".`);
    });
    deleteBtn.addEventListener('click', () => {
      void handleDelete(deps, preset.id, preset.seeded);
    });
    view.listEl.appendChild(row);
  }
}

export function fillFormForEdit(view: OptionsView, item: OptionsPresetView): void {
  const preset = item.preset;
  // Visible fields
  view.form.name.value = preset.name;
  view.form.title.value = preset.metadata?.title?.value ?? '';
  view.form.excerpt.value = preset.metadata?.excerpt?.value ?? '';
  view.form.tags.value = preset.metadata?.tags?.values.join(', ') ?? '';
  view.form.body.value =
    preset.content.source === 'inline-html'
      ? (preset.content.html ?? '')
      : preset.content.source === 'inline-text'
        ? (preset.content.text ?? '')
        : (preset.content.lexical ?? '');
  // Hidden round-trip fields — preserve everything the simplified UI no longer shows
  view.form.id.value = preset.id;
  view.form.id.setAttribute('disabled', 'true'); // id is immutable on edit
  view.form.description.value = preset.description ?? '';
  view.form.source.value = preset.content.source;
  view.form.mode.value = preset.content.mode;
  view.form.snippet.value = preset.content.snippet ?? '';
  view.form.group.value = preset.ui?.group ?? '';
  view.form.icon.value = preset.ui?.icon ?? '';
  view.form.tagMode.value = preset.metadata?.tags?.mode ?? 'merge';
  view.form.excerptMode.value = preset.metadata?.excerpt?.mode ?? 'only-if-empty';
  view.form.customTemplate.value = preset.metadata?.customTemplate?.value ?? '';
  view.form.customTemplateMode.value = preset.metadata?.customTemplate?.mode ?? 'replace';
  updateBodyEditor(view);
}

export function updateBodyEditor(view: OptionsView): void {
  const help =
    view.form.source.value === 'inline-lexical'
      ? 'Advanced source: this template holds serialized Lexical JSON.'
      : view.form.source.value === 'ghost-snippet'
        ? 'This preset uses a Ghost snippet; the text field shows its stored value only.'
        : view.form.source.value === 'inline-html'
          ? 'Legacy HTML source: retained for import/export only; live writes fail closed.'
          : 'Each line becomes a paragraph; blank lines are preserved. HTML is treated as plain text.';
  if (view.bodyHelp) view.bodyHelp.textContent = help;
}

export function readFormPreset(view: OptionsView): unknown {
  const name = view.form.name.value.trim();
  // Editing keeps the loaded id; creating derives one from the name.
  const id =
    view.form.id.getAttribute('disabled') !== null && view.form.id.value.trim()
      ? view.form.id.value.trim()
      : deriveIdFromName(name);
  const source = view.form.source.value.trim();
  const mode = view.form.mode.value.trim();
  const content: Record<string, unknown> = { source, mode };
  if (source === 'ghost-snippet') {
    content['snippet'] = view.form.snippet.value.trim();
  } else if (source === 'inline-html') {
    content['html'] = view.form.body.value;
  } else if (source === 'inline-text') {
    content['text'] = view.form.body.value;
  } else {
    content['lexical'] = view.form.body.value;
  }
  const preset: Record<string, unknown> = {
    schemaVersion: PRESET_SCHEMA_VERSION,
    id,
    name,
    content,
  };
  const description = view.form.description.value.trim();
  if (description) preset['description'] = description;
  const group = view.form.group.value.trim();
  const icon = view.form.icon.value.trim();
  const ui: Record<string, string> = {};
  if (group) ui['group'] = group;
  if (icon) ui['icon'] = icon;
  if (Object.keys(ui).length > 0) preset['ui'] = ui;
  const metadata: Record<string, unknown> = {};
  const title = view.form.title.value.trim();
  if (title.length > 0) {
    metadata['title'] = { mode: 'replace', value: title };
  }
  const excerpt = view.form.excerpt.value;
  if (excerpt.length > 0) {
    metadata['excerpt'] = { mode: view.form.excerptMode.value.trim(), value: excerpt };
  }
  const customTemplate = view.form.customTemplate.value.trim();
  if (customTemplate.length > 0) {
    metadata['customTemplate'] = {
      mode: view.form.customTemplateMode.value.trim(),
      value: customTemplate,
    };
  }
  const tagValues = view.form.tags.value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tagValues.length > 0) {
    metadata['tags'] = { mode: view.form.tagMode.value.trim(), values: tagValues };
  }
  if (Object.keys(metadata).length > 0) preset['metadata'] = metadata;
  return preset;
}

export async function handleSave(deps: OptionsControllerDeps): Promise<void> {
  const { rt, view } = deps;
  const editing = view.form.id.getAttribute('disabled') !== null;
  const preset = readFormPreset(view) as Record<string, unknown>;
  if (!editing) {
    try {
      const used = new Set((await rt.loadPresets()).map((item) => item.id));
      preset['id'] = nextAvailablePresetId(String(preset['id']), used);
    } catch (error) {
      setStatus(
        view,
        `Save failed: ${error instanceof Error ? error.message : 'could not load existing presets'}`,
        true,
      );
      return;
    }
  }
  const outcome = await createOrUpdatePreset(rt, preset);
  if (!outcome.ok) {
    setStatus(view, `Save failed: ${outcome.error ?? 'invalid preset'}`, true);
    return;
  }
  view.resetForm();
  setStatus(view, `Saved "${outcome.preset?.name ?? ''}".`);
  await refreshList(deps);
}

export async function handleDelete(
  deps: OptionsControllerDeps,
  id: string,
  seeded: boolean,
): Promise<void> {
  const { rt, view } = deps;
  try {
    await deletePreset(rt, id);
    setStatus(view, seeded ? `Reverted "${id}" to the bundled default.` : `Deleted "${id}".`);
    await refreshList(deps);
  } catch (error) {
    setStatus(
      view,
      `Delete failed: ${error instanceof Error ? error.message : 'storage unavailable'}`,
      true,
    );
  }
}

export async function handleImport(deps: OptionsControllerDeps): Promise<void> {
  const { rt, view } = deps;
  const serialized = view.importArea.value;
  if (serialized.trim().length === 0) {
    setStatus(view, 'Import area is empty.', true);
    return;
  }
  const outcome = await importPresetsFromString(rt, serialized);
  if (!outcome.ok) {
    setStatus(view, `Import failed: ${outcome.error ?? 'invalid file'}`, true);
    return;
  }
  setStatus(view, `Imported ${outcome.count ?? 0} preset(s).`);
  view.importArea.value = '';
  await refreshList(deps);
}

export async function handleExport(deps: OptionsControllerDeps): Promise<void> {
  const { rt, view } = deps;
  const presets = await rt.loadPresets();
  const json = exportPresetsToString(rt, presets);
  view.exportArea.value = json;
  view.download('ghost-cms-template-injector-presets.json', json);
  setStatus(view, `Exported ${presets.length} preset(s).`);
}

export function setStatus(view: OptionsView, message: string, isError = false): void {
  setText(view.statusEl, message);
  view.statusEl.setAttribute('role', isError ? 'alert' : 'status');
  view.statusEl.classList?.add('visible');
}

/* ------------------------------------------------------------------ */
/* Entry / lifecycle                                                   */
/* ------------------------------------------------------------------ */

/** Wire the options page once the DOM is ready. */
export async function initOptions(deps: OptionsControllerDeps): Promise<void> {
  const { view } = deps;
  view.form.source.addEventListener('change', () => updateBodyEditor(view));
  updateBodyEditor(view);
  // Save/cancel/import/export buttons are resolved by id in the bootstrap.
  const saveBtn = view.document.getElementById('opt-save');
  saveBtn?.addEventListener('click', () => void handleSave(deps));
  const importBtn = view.document.getElementById('opt-import');
  importBtn?.addEventListener('click', () => void handleImport(deps));
  const exportBtn = view.document.getElementById('opt-export');
  exportBtn?.addEventListener('click', () => void handleExport(deps));
  const cancelBtn = view.document.getElementById('opt-cancel');
  cancelBtn?.addEventListener('click', () => {
    view.resetForm();
    setStatus(view, 'Form cleared.');
  });
  await refreshList(deps);
}

/* Browser bootstrap: only runs when a real document is present. */
function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.document !== 'undefined';
}

if (isBrowserContext()) {
  const doc = globalThis.document;
  const el = (id: string) => doc.getElementById(id) as unknown as RenderEl | null;
  const input = (id: string) => doc.getElementById(id) as unknown as RenderInput | null;
  const listEl = el('opt-preset-list');
  const statusEl = el('opt-status');
  const importArea = input('opt-import-area');
  const exportArea = input('opt-export-area');
  if (listEl && statusEl && importArea && exportArea) {
    const form = {
      id: input('opt-id') as RenderInput,
      name: input('opt-name') as RenderInput,
      title: input('opt-title') as RenderInput,
      description: input('opt-description') as RenderInput,
      source: input('opt-source') as RenderInput,
      mode: input('opt-mode') as RenderInput,
      body: input('opt-body') as RenderInput,
      snippet: input('opt-snippet') as RenderInput,
      group: input('opt-group') as RenderInput,
      icon: input('opt-icon') as RenderInput,
      tags: input('opt-tags') as RenderInput,
      tagMode: input('opt-tag-mode') as RenderInput,
      excerpt: input('opt-excerpt') as RenderInput,
      excerptMode: input('opt-excerpt-mode') as RenderInput,
      customTemplate: input('opt-custom-template') as RenderInput,
      customTemplateMode: input('opt-custom-template-mode') as RenderInput,
    };
    void initOptions({
      rt: createOptionsRuntime(),
      view: {
        listEl,
        statusEl,
        form,
        bodyLabel: el('opt-body-label') as RenderEl,
        bodyHelp: el('opt-body-help') as RenderEl,
        importArea,
        exportArea,
        document: {
          createElement: (tag: string) => doc.createElement(tag) as unknown as RenderEl,
          getElementById: (id: string) => el(id),
        },
        download: (filename: string, contents: string) => {
          const blob = new Blob([contents], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = doc.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        },
        resetForm: () => {
          for (const field of Object.values(form)) {
            field.value = '';
            field.removeAttribute('disabled');
          }
          form.source.value = 'inline-text';
          form.mode.value = 'replace';
          form.tagMode.value = 'merge';
          form.excerptMode.value = 'only-if-empty';
          form.customTemplateMode.value = 'replace';
        },
      },
    });
  }
}
