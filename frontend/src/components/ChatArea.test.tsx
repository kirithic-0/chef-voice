import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatArea from './ChatArea';
import { Message, Recipe } from '../types';

/**
 * Recipe suggestions used to live in a fixed tray below the conversation, with its own
 * scrollbar. Because the tray showed one shared list, the recipes from an earlier question
 * stayed on screen underneath a later, unrelated answer.
 *
 * They now hang off the message that found them. These tests pin that down: each reply renders
 * its own results, and a reply with none renders none.
 *
 * Static markup rendering keeps this dependency-free — no jsdom, no testing-library.
 */

const recipe = (id: string, title: string, over: Partial<Recipe> = {}): Recipe => ({
  id,
  title,
  cuisine: 'Italian',
  time: 20,
  difficulty: 'Easy',
  servings: 2,
  ingredients: [],
  steps: [],
  ...over,
});

const render = (messages: Message[]) =>
  renderToStaticMarkup(
    <ChatArea messages={messages} isAiThinking={false} interimTranscript="" onPickRecipe={() => {}} />,
  );

describe('ChatArea recipe suggestions', () => {
  it('renders a reply’s recipes inline beneath it', () => {
    const html = render([
      { id: 'u1', role: 'user', text: 'something italian under 20 minutes' },
      {
        id: 'a1',
        role: 'ai',
        text: 'You could make Spaghetti Aglio e Olio, or the Creamy Tomato Basil Pasta.',
        recipes: [recipe('r1', 'Spaghetti Aglio e Olio'), recipe('r2', 'Creamy Tomato Basil Pasta')],
      },
    ]);

    expect(html).toContain('Spaghetti Aglio e Olio');
    expect(html).toContain('Creamy Tomato Basil Pasta');
    // Metadata line renders from the recipe, not a hardcoded string.
    expect(html).toContain('20 min');
  });

  it('does not carry one reply’s recipes onto the next', () => {
    const html = render([
      {
        id: 'a1',
        role: 'ai',
        text: 'Two Italian options for you.',
        recipes: [recipe('r1', 'Spaghetti Aglio e Olio'), recipe('r2', 'Margherita Flatbread Pizza', { time: 25 })],
      },
      { id: 'u2', role: 'user', text: 'actually something with lettuce' },
      {
        id: 'a2',
        // Deliberately does not name the recipes: the counts below then measure
        // the cards alone, not incidental mentions in the reply text.
        role: 'ai',
        text: 'No problem, here are two salads you might like.',
        recipes: [recipe('r3', 'Healthy Quinoa Salad'), recipe('r4', 'Greek Salad')],
      },
    ]);

    // Each title appears exactly once — the earlier pair is not repeated under the later answer.
    for (const title of [
      'Spaghetti Aglio e Olio',
      'Margherita Flatbread Pizza',
      'Healthy Quinoa Salad',
      'Greek Salad',
    ]) {
      expect(html.split(title).length - 1, `${title} should render once`).toBe(1);
    }
  });

  it('renders no recipe cards for a reply that found none', () => {
    const html = render([{ id: 'a1', role: 'ai', text: 'I could not find anything like that.' }]);
    expect(html).not.toContain('min •');
    expect(html).not.toContain('<button');
  });

  it('renders cards as disabled when no picker is supplied', () => {
    const html = renderToStaticMarkup(
      <ChatArea
        messages={[{ id: 'a1', role: 'ai', text: 'Here you go.', recipes: [recipe('r1', 'Greek Salad')] }]}
        isAiThinking={false}
        interimTranscript=""
      />,
    );
    expect(html).toContain('Greek Salad');
    expect(html).toContain('disabled');
  });
});
