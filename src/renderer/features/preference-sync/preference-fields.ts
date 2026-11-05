import { SUPPORTED_LOCALES } from '../../../shared/ui-locales';
import {
  normalizeEntityLinkBandStyle,
  normalizeEntityLinkColorMode,
  normalizeEntityLinkHighlightMode,
} from '../../lib/entity-link-appearance';
import { normalizeAccentColor } from '../../lib/theme';
import { normalizeCaretColor, useSettingsStore } from '../../store/settings-store';
import { SHORTCUT_ACTIONS, useShortcutsStore, type ShortcutActionId } from '../../store/shortcuts-store';

type Settings = ReturnType<typeof useSettingsStore.getState>;

/**
 * A setting that follows the author's account. `accept` returns the value to
 * store, or undefined for one this version does not understand. Everything not
 * listed stays on the device: prose fonts and interface text size (they depend
 * on the machine), line wrapping, the Agent's provider/model/reasoning (bound
 * to this device's keys), its safety switch and first-run state, crash-report
 * consent and the Markdown folder.
 */
interface PreferenceField {
  key: string;
  read: () => unknown;
  accept: (value: unknown) => unknown;
  write: (value: never) => void;
}

const oneOf = <T extends string>(...values: T[]) => (value: unknown) =>
  values.includes(value as T) ? value : undefined;
const boolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
/** A normalizer that maps anything unknown to a default; only exact round trips are accepted. */
const exact = (normalize: (value: unknown) => unknown) => (value: unknown) =>
  normalize(value) === value ? value : undefined;

function setting<K extends keyof Settings>(
  key: K,
  accept: (value: unknown) => unknown,
  write: (value: Settings[K]) => void = (value) => useSettingsStore.setState({ [key]: value } as Partial<Settings>),
): PreferenceField {
  return { key, read: () => useSettingsStore.getState()[key], accept, write: write as (value: never) => void };
}

const settings = () => useSettingsStore.getState();

export const PREFERENCE_FIELDS: readonly PreferenceField[] = [
  // Appearance
  setting('themeMode', oneOf('light', 'dark', 'system')),
  setting('accentColor', (value) => (value === null ? null : exact(normalizeAccentColor)(value))),
  setting('agentEditRevealAnimation', boolean),
  // Typography; the setters clamp to the editor's ranges.
  setting('bodyFontSize', number, (value) => settings().setBodyFontSize(value)),
  setting('lineHeight', number, (value) => settings().setLineHeight(value)),
  setting('paragraphIndent', oneOf('none', 'one', 'two')),
  setting('editorIndentStep', number, (value) => settings().setEditorIndentStep(value)),
  setting('paragraphSpacing', number, (value) => settings().setParagraphSpacing(value)),
  setting('maxLineWidth', number, (value) => settings().setMaxLineWidth(value)),
  // Writing
  setting('autoImmersiveWriting', boolean),
  setting('typewriterMode', boolean),
  setting('typewriterPosition', number, (value) => settings().setTypewriterPosition(value)),
  setting('caretColor', exact(normalizeCaretColor)),
  setting('entityLinkColorMode', exact(normalizeEntityLinkColorMode)),
  setting('entityLinkHighlightMode', exact(normalizeEntityLinkHighlightMode)),
  setting('entityLinkBandStyle', exact(normalizeEntityLinkBandStyle)),
  setting(
    'entityLinkKindColors',
    (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    (value) => settings().setEntityLinkKindColors(value),
  ),
  setting('autoElementLinkEnabled', boolean),
  // Language and Agent limits
  setting('uiLocale', oneOf(...SUPPORTED_LOCALES)),
  setting(
    'agentTurnIterationLimit',
    (value) => (value === null ? null : number(value)),
    (value) => settings().setAgentTurnIterationLimit(value),
  ),
  // Keyboard
  {
    key: 'shortcutBindings',
    read: () => useShortcutsStore.getState().bindings,
    accept: (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    write: (value: Record<string, unknown>) => {
      const bindings = { ...useShortcutsStore.getState().bindings };
      // Actions this version does not know, and malformed combinations, are ignored.
      for (const action of SHORTCUT_ACTIONS) {
        const accelerator = value[action.id];
        if (typeof accelerator === 'string' && accelerator.length > 0 && accelerator.length <= 64)
          bindings[action.id as ShortcutActionId] = accelerator;
      }
      useShortcutsStore.setState({ bindings });
    },
  },
];

const byKey = new Map(PREFERENCE_FIELDS.map((field) => [field.key, field]));

export const PREFERENCE_KEYS: readonly string[] = PREFERENCE_FIELDS.map((field) => field.key);

export function readPreference(key: string): unknown {
  return byKey.get(key)?.read();
}

/** Applies a value from another device; false when this version does not understand it. */
export function applyPreference(key: string, value: unknown): boolean {
  const field = byKey.get(key);
  if (!field) return false;
  const accepted = field.accept(value);
  if (accepted === undefined) return false;
  field.write(accepted as never);
  return true;
}

/** The JSON form of every synced setting, for spotting what changed. */
export function preferenceSnapshot(): Map<string, string> {
  return new Map(PREFERENCE_FIELDS.map((field) => [field.key, JSON.stringify(field.read())]));
}

export function subscribePreferenceStores(listener: () => void): () => void {
  const stopSettings = useSettingsStore.subscribe(listener);
  const stopShortcuts = useShortcutsStore.subscribe(listener);
  return () => {
    stopSettings();
    stopShortcuts();
  };
}
