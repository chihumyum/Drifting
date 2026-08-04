import {
  agentMarkdownInlineText,
  parseAgentProseMarkdown,
  renderAgentProseMarkdownBlock,
} from '../markdown-prose-adapter';

/** Remove the model's duplicated document title only at authored-object creation. */
export function stripRedundantLeadingAuthoredTitle(markdown: string, title: string): string {
  const blocks = parseAgentProseMarkdown(markdown);
  const first = blocks[0];
  const normalize = (value: string) => value.trim().normalize('NFC');
  if (
    first?.type !== 'heading' ||
    first.level !== 1 ||
    normalize(agentMarkdownInlineText(first.inline)) !== normalize(title)
  ) {
    return markdown;
  }
  return blocks.slice(1).map(renderAgentProseMarkdownBlock).join('\n\n');
}
