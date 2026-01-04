import { Extension } from '@tiptap/core'
import type { SuggestionOptions } from '@tiptap/suggestion'
import Suggestion from '@tiptap/suggestion'

export type SlashMenuItem = any

export interface SlashMenuOptions<I = SlashMenuItem> {
  pluginKey?: any
  char: string
  allowSpaces: boolean
  allowToIncludeChar: boolean
  startOfLine: boolean
  allowedPrefixes: string[] | null
  decorationTag: string
  decorationClass: string
  decorationContent: string
  decorationEmptyClass: string
  // Provide items and what to do when user selects one
  items: SuggestionOptions<I>['items']
  command: SuggestionOptions<I>['command']
  // Optional custom render lifecycle, usually used by frameworks (React/Vue) via ReactRenderer, etc.
  render?: SuggestionOptions<I>['render']
  allow?: SuggestionOptions<I>['allow']
}

/**
 * A headless Slash Menu extension based on @tiptap/suggestion.
 * It provides the suggestion plumbing (trigger "/", items, command, lifecycle),
 * while leaving the UI to the integrator (React/Vue/vanilla via render()).
 */
export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: 'slashMenu',

  addOptions() {
    return {
      pluginKey: undefined,
      char: '/',
      allowSpaces: false,
      allowToIncludeChar: false,
      startOfLine: false,
      allowedPrefixes: null,
      decorationTag: 'span',
      decorationClass: 'suggestion',
      decorationContent: '',
      decorationEmptyClass: 'is-empty',
      items: () => [],
      command: () => null,
      render: undefined,
      allow: undefined,
    }
  },

  addProseMirrorPlugins() {
    const suggestionOptions: Omit<SuggestionOptions, 'editor'> = {
      pluginKey: this.options.pluginKey,
      char: this.options.char,
      allowSpaces: this.options.allowSpaces,
      allowToIncludeChar: this.options.allowToIncludeChar,
      startOfLine: this.options.startOfLine,
      allowedPrefixes: this.options.allowedPrefixes,
      decorationTag: this.options.decorationTag,
      decorationClass: this.options.decorationClass,
      decorationContent: this.options.decorationContent,
      decorationEmptyClass: this.options.decorationEmptyClass,
      items: this.options.items,
      command: this.options.command,
      render: this.options.render,
      allow: this.options.allow,
    }

    return [Suggestion({ editor: this.editor, ...suggestionOptions })]
  },
})

export default SlashMenu
