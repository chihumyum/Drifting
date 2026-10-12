import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('TODO card Agent hand-off', () => {
  it('shows a plain hover hint immediately left of the resolve ring', () => {
    const card = read('src/renderer/features/comments/ReviewItemCard.tsx');
    const css = read('src/styles/comments-review.css');

    expect(card).not.toContain('<Bot');
    expect(card).not.toContain('review-card__agent-task"');
    const actions = card.slice(card.indexOf('<span className="review-card__status-actions">'));
    expect(actions.indexOf('{agentHint}')).toBeLessThan(actions.indexOf('<TodoStatusToggle'));
    expect(card).toContain('onClick={() => void handleTodoTask()}');

    expect(css).toMatch(/\.review-card__agent-hint \{[^}]*opacity: 0;[^}]*pointer-events: none;/su);
    expect(css).toContain('.review-card:hover .review-card__agent-hint,');
    expect(css).toMatch(/\.review-card__agent-hint::after \{[^}]*border-left: 4px solid/su);
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.review-card__agent-hint \{\s*opacity: 1;/su);
  });
});
