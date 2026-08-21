/**
 * Phase-4 options page entry point (owns this module + options.html only).
 *
 * Thin DOM glue: builds an `OptionsRuntime` over the Phase-2 `preset-store`
 * (so the validated storage/schema/import-bounds contracts stay owned by that
 * module), drives the pure `options-crud` controller, and renders an
 * accessible CRUD + import/export surface. All business rules live in
 * `options-crud.ts`; this file only wires seams and paints validated data as
 * untrusted text (no innerHTML with preset content — XSS-safe by construction).
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
    description: RenderInput;
    source: RenderInput;
    mode: RenderInput;
    html: RenderInput;
    snippet: RenderInput;
    group: RenderInput;
    icon: RenderInput;
  };
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
  const group = view.group ? ` · ${view.group}` : '';
  setText(label, `${icon}${view.name}${badge}${group}`);
  row.appendChild(label);

  const meta = createEl('small');
  setText(meta, `${view.source} / ${view.mode}`);
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
    setText(empty, 'No presets. Create one below or import a collection.');
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

function fillFormForEdit(view: OptionsView, preset: OptionsPresetView): void {
  view.form.id.value = preset.id;
  view.form.id.setAttribute('disabled', 'true'); // id is immutable on edit
  view.form.name.value = preset.name;
  if (preset.description !== undefined) view.form.description.value = preset.description;
  if (preset.group !== undefined) view.form.group.value = preset.group;
  if (preset.icon !== undefined) view.form.icon.value = preset.icon;
}

export function readFormPreset(view: OptionsView): unknown {
  const id = view.form.id.value.trim();
  const name = view.form.name.value.trim();
  const source = view.form.source.value.trim();
  const mode = view.form.mode.value.trim();
  const content: Record<string, unknown> = { source, mode };
  if (source === 'ghost-snippet') {
    content['snippet'] = view.form.snippet.value.trim();
  } else if (source === 'inline-html') {
    content['html'] = view.form.html.value;
  } else {
    content['lexical'] = view.form.html.value;
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
  return preset;
}

export async function handleSave(deps: OptionsControllerDeps): Promise<void> {
  const { rt, view } = deps;
  const preset = readFormPreset(view);
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
  await deletePreset(rt, id);
  setStatus(view, seeded ? `Reverted "${id}" to the bundled default.` : `Deleted "${id}".`);
  await refreshList(deps);
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
  const presets = await listPresets();
  const json = exportPresetsToString(rt, presets);
  view.exportArea.value = json;
  view.download('ghost-preset-toolbar-presets.json', json);
  setStatus(view, `Exported ${presets.length} preset(s).`);
}

export function setStatus(view: OptionsView, message: string, isError = false): void {
  setText(view.statusEl, message);
  view.statusEl.setAttribute('role', isError ? 'alert' : 'status');
}

/* ------------------------------------------------------------------ */
/* Entry / lifecycle                                                   */
/* ------------------------------------------------------------------ */

/** Wire the options page once the DOM is ready. */
export async function initOptions(deps: OptionsControllerDeps): Promise<void> {
  const { view } = deps;
  view.form.id.addEventListener('input', () => {
    // Clear any lingering disabled state left by a previous edit so a new id
    // can be typed (HTML boolean attribute: only absence enables).
    if (view.form.id.getAttribute('disabled') !== null) view.form.id.removeAttribute('disabled');
  });
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
      description: input('opt-description') as RenderInput,
      source: input('opt-source') as RenderInput,
      mode: input('opt-mode') as RenderInput,
      html: input('opt-html') as RenderInput,
      snippet: input('opt-snippet') as RenderInput,
      group: input('opt-group') as RenderInput,
      icon: input('opt-icon') as RenderInput,
    };
    void initOptions({
      rt: createOptionsRuntime(),
      view: {
        listEl,
        statusEl,
        form,
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
          form.source.value = 'inline-html';
          form.mode.value = 'replace';
        },
      },
    });
  }
}
