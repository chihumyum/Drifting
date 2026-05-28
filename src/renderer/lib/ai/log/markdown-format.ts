/**
 * Format a request-log entry as a Markdown document. Designed for casual
 * VSCode/text-editor reading: long system + user messages render as
 * properly-wrapped paragraphs inside fenced code blocks instead of
 * single-line "\n"-embedded strings.
 *
 * Fences use 4 backticks so that any natural ``` inside model output
 * (markdown / code snippets from the LLM) doesn't break the outer block.
 */
import type { AIRequestLogEntry } from './request-log';

const FENCE = '````';

function fence(language: string, body: string): string {
  return `${FENCE}${language}\n${body}\n${FENCE}`;
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

function jsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatEntryAsMarkdown(entry: AIRequestLogEntry): string {
  const lines: string[] = [];
  const statusGlyph =
    entry.status === 'success' ? '✓ success' : entry.status === 'error' ? '✗ error' : '⏳ in-flight';

  lines.push(`# ${entry.request.promptId ?? entry.request.feature} · ${isoStamp(entry.startedAt)}`);
  lines.push('');
  lines.push(`- **Status**: ${statusGlyph}`);
  lines.push(`- **Model**: ${entry.request.model}`);
  lines.push(`- **Feature**: ${entry.request.feature}`);
  if (entry.request.promptVersion !== undefined) {
    lines.push(`- **Prompt version**: ${entry.request.promptVersion}`);
  }
  if (entry.durationMs !== undefined) {
    lines.push(`- **Duration**: ${entry.durationMs}ms`);
  }
  if (entry.response?.usage) {
    const u = entry.response.usage;
    const cached = u.cachedTokens ? ` cached=${u.cachedTokens}` : '';
    lines.push(`- **Tokens**: in=${u.inputTokens} out=${u.outputTokens}${cached}`);
  }
  if (entry.request.toolNames.length) {
    lines.push(`- **Tools**: ${entry.request.toolNames.join(', ')}`);
  }
  lines.push(`- **Request ID**: \`${entry.id}\``);
  lines.push('');

  if (entry.request.system) {
    lines.push('## System');
    lines.push('');
    lines.push(fence('text', entry.request.system));
    lines.push('');
  }

  for (const [idx, msg] of entry.request.messages.entries()) {
    const label = entry.request.messages.length > 1 ? ` ${idx + 1}` : '';
    lines.push(`## ${capitalize(msg.role)} message${label}`);
    lines.push('');
    lines.push(fence('text', msg.content));
    lines.push('');
  }

  if (entry.response?.toolCall) {
    lines.push(`## Tool call · \`${entry.response.toolCall.name}\``);
    lines.push('');
    lines.push(fence('json', jsonPretty(entry.response.toolCall.arguments)));
    lines.push('');
  }

  if (entry.response?.text) {
    lines.push('## Raw text response');
    lines.push('');
    lines.push(fence('text', entry.response.text));
    lines.push('');
  }

  if (entry.error) {
    lines.push('## Error');
    lines.push('');
    lines.push(`**${entry.error.name}**: ${entry.error.message}`);
    if (entry.error.stack) {
      lines.push('');
      lines.push(fence('text', entry.error.stack));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Generate a filename safe across macOS/Windows/Linux. Colons (ISO has
 * them) are not allowed in many filesystems' paths, so we strip them.
 */
export function filenameForEntry(entry: AIRequestLogEntry): string {
  const stamp = new Date(entry.startedAt)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/Z$/, 'Z');
  const slug = (entry.request.promptId ?? entry.request.feature ?? 'ai')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${stamp}_${slug}_${entry.id}.md`;
}
